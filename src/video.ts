import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replay } from "./bible.ts";
import { sceneParagraphs } from "./audiobook.ts";
import type { SceneTiming } from "./audiobook.ts";
import type { ArtManifest } from "./artist.ts";
import type { SceneCommittedData, StoryEvent } from "./types.ts";

// Turns a finished run (art shots + audiobook) into a narrated video: each
// shot is a slow Ken Burns zoom/pan that crossfades into the next when the
// narration reaches that shot's paragraph.
//
// Everything that decides WHAT the video looks like (timeline, moves, filter
// graphs, subtitles) is pure and unit-tested; renderVideo() only shells out to
// ffmpeg with what they produce.

export const FPS = 30;
const WIDTH = 1920;
const HEIGHT = 1080;

export interface VideoOptions {
  fadeSec?: number;     // crossfade between shots, default 1.5
  minShotSec?: number;  // shots on screen for less than this are dropped, default 6
  introSec?: number;    // cover card before the first scene, default 6
  gapSec?: number;      // black pause between scenes, default 1.5
}

export type Move = "zoom_in" | "zoom_out" | "pan_right" | "pan_left";
const MOVES: Move[] = ["zoom_in", "zoom_out", "pan_right", "pan_left"];

export interface TimelineShot {
  key: string;
  file: string;            // relative to the run dir
  startParagraph: number;
  startFrame: number;      // when it comes on screen, from scene start
  slotFrames: number;      // how long it owns the screen
  clipFrames: number;      // slot + crossfade into the next shot (last shot: slot only)
  move: Move;
}

export interface TimelineScene {
  index: number;
  audio: string;           // relative to the run dir
  frames: number;          // scene length, frame-rounded from the audio
  shots: TimelineShot[];
}

export interface Timeline {
  fps: number;
  fadeFrames: number;
  introFrames: number;
  gapFrames: number;
  cover?: string;
  scenes: TimelineScene[];
  totalFrames: number;
  warnings: string[];
}

export interface Timings {
  sampleRate: number;
  scenes: SceneTiming[];
}

const sec = (frames: number) => frames / FPS;
const toFrames = (s: number) => Math.round(s * FPS);

// Deterministic per key, and never the same move twice in a row.
export function moveFor(key: string, previous?: Move): Move {
  const h = createHash("sha1").update(key).digest()[0];
  let move = MOVES[h % MOVES.length];
  if (move === previous) move = MOVES[(MOVES.indexOf(move) + 1) % MOVES.length];
  return move;
}

export function buildTimeline(manifest: ArtManifest, timings: Timings, opts: VideoOptions = {}): Timeline {
  const fadeFrames = toFrames(opts.fadeSec ?? 1.5);
  const minFrames = Math.max(toFrames(opts.minShotSec ?? 6), fadeFrames + 1);
  const warnings: string[] = [];
  const entries = Object.entries(manifest);
  const coverEntry = manifest.cover;

  for (const [key, e] of entries) {
    if (!e.accepted) warnings.push(`${key} (${e.file}) was never accepted by the inspector: ${e.issues.join("; ") || "no detail"}`);
  }

  const scenes: TimelineScene[] = [];
  let previousMove: Move | undefined;
  for (const t of [...timings.scenes].sort((a, b) => a.index - b.index)) {
    const frames = toFrames(t.durationSec);
    const starts = t.paragraphStarts.length > 0 ? t.paragraphStarts : [0];
    const candidates = entries
      .filter(([, e]) => e.sceneIndex === t.index)
      .map(([key, e]) => {
        const p = Math.min(Math.max(e.startParagraph ?? 0, 0), starts.length - 1);
        return { key, file: `art/${e.file}`, startParagraph: p, startFrame: toFrames(starts[p]) };
      })
      .sort((a, b) => a.startFrame - b.startFrame || a.key.localeCompare(b.key));

    if (candidates.length === 0) {
      if (!coverEntry) throw new Error(`scene ${t.index + 1} has no art and there is no cover to stand in`);
      warnings.push(`scene ${t.index + 1} has no art; using the cover`);
      candidates.push({ key: "cover", file: `art/${coverEntry.file}`, startParagraph: 0, startFrame: 0 });
    }
    candidates[0].startFrame = 0;

    // Drop shots that would flash by: keep a shot only if it gets minFrames
    // before the next kept shot (the previous shot holds instead).
    const kept = [candidates[0]];
    for (const c of candidates.slice(1)) {
      if (c.startFrame - kept[kept.length - 1].startFrame >= minFrames) kept.push(c);
      else warnings.push(`${c.key} dropped: on screen < ${sec(minFrames)}s`);
    }
    while (kept.length > 1 && frames - kept[kept.length - 1].startFrame < minFrames) {
      warnings.push(`${kept.pop()!.key} dropped: on screen < ${sec(minFrames)}s at scene end`);
    }

    const shots: TimelineShot[] = kept.map((c, k) => {
      const next = k + 1 < kept.length ? kept[k + 1].startFrame : frames;
      const slotFrames = next - c.startFrame;
      const move = moveFor(c.key, previousMove);
      previousMove = move;
      return { ...c, slotFrames, clipFrames: k + 1 < kept.length ? slotFrames + fadeFrames : slotFrames, move };
    });
    scenes.push({ index: t.index, audio: `audiobook/${t.file}`, frames, shots });
  }
  if (scenes.length === 0) throw new Error("timings.json has no scenes");

  const introFrames = coverEntry ? toFrames(opts.introSec ?? 6) : 0;
  const gapFrames = toFrames(opts.gapSec ?? 1.5);
  const totalFrames = introFrames + scenes.reduce((n, s) => n + s.frames, 0) + gapFrames * (scenes.length - 1);
  return {
    fps: FPS,
    fadeFrames,
    introFrames,
    gapFrames,
    cover: coverEntry ? `art/${coverEntry.file}` : undefined,
    scenes,
    totalFrames,
    warnings
  };
}

// Crops to 16:9, upscales (zoompan rounds its crop to whole pixels; doing that
// on a 4K source keeps the motion smooth at 1080p), then moves the camera.
export function kenBurnsFilter(move: Move, frames: number): string {
  const n = Math.max(frames - 1, 1);
  const t = `(on/${n})`;
  const center = { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  const motion: Record<Move, { z: string; x: string; y: string }> = {
    zoom_in: { z: `1+0.15*${t}`, ...center },
    zoom_out: { z: `1.15-0.15*${t}`, ...center },
    pan_right: { z: "1.12", x: `(iw-iw/zoom)*${t}`, y: center.y },
    pan_left: { z: "1.12", x: `(iw-iw/zoom)*(1-${t})`, y: center.y }
  };
  const m = motion[move];
  return [
    "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)'",
    `scale=${WIDTH * 2}:${HEIGHT * 2}:flags=lanczos`,
    `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${FPS}`,
    "setsar=1",
    "format=yuv420p"
  ].join(",");
}

// One ffmpeg pass per scene: every shot's Ken Burns clip, chained with xfade.
// Shot k's crossfade starts exactly when the narration reaches it, so the
// chained length equals the scene's audio length.
export function sceneFilterGraph(scene: TimelineScene, fadeFrames: number): string {
  const lines: string[] = scene.shots.map((s, k) => `[${k}:v]${kenBurnsFilter(s.move, s.clipFrames)},settb=1/${FPS}[v${k}]`);
  let last = "v0";
  for (let k = 1; k < scene.shots.length; k++) {
    const out = `x${k}`;
    lines.push(`[${last}][v${k}]xfade=transition=fade:duration=${sec(fadeFrames)}:offset=${sec(scene.shots[k].startFrame)}[${out}]`);
    last = out;
  }
  const edge = Math.min(0.75, sec(scene.frames) / 4);
  lines.push(`[${last}]fade=t=in:d=${edge},fade=t=out:st=${sec(scene.frames) - edge}:d=${edge},trim=end_frame=${scene.frames}[out]`);
  return lines.join(";\n");
}

export function introFilterGraph(introFrames: number): string {
  const edge = Math.min(0.75, sec(introFrames) / 4);
  return `[0:v]${kenBurnsFilter("zoom_in", introFrames)},fade=t=in:d=${edge},fade=t=out:st=${sec(introFrames) - edge}:d=${edge}[out]`;
}

// Narration track matching the video: silence under the intro and the gaps,
// each scene's audio trimmed/padded to its frame-rounded length so 60 minutes
// of video can't drift from the voice. Input k+1 is scene k's WAV (input 0 is the video).
export function audioFilterGraph(timeline: Timeline): string {
  const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
  const silence = (label: string, frames: number) => `anullsrc=r=48000:cl=stereo,atrim=end=${sec(frames)}[${label}]`;
  const lines: string[] = [];
  const parts: string[] = [];
  if (timeline.introFrames > 0) {
    lines.push(silence("intro", timeline.introFrames));
    parts.push("[intro]");
  }
  timeline.scenes.forEach((s, k) => {
    if (k > 0) {
      lines.push(silence(`gap${k}`, timeline.gapFrames));
      parts.push(`[gap${k}]`);
    }
    const d = sec(s.frames);
    lines.push(`[${k + 1}:a]${fmt},apad=whole_dur=${d},atrim=end=${d}[a${k}]`);
    parts.push(`[a${k}]`);
  });
  lines.push(`${parts.join("")}concat=n=${parts.length}:v=0:a=1[aout]`);
  return lines.join(";\n");
}

function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const sc = Math.floor((ms % 60000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(sc)},${pad(ms % 1000, 3)}`;
}

// Subtitles: one cue per sentence, timed by splitting each paragraph's
// narration window in proportion to sentence length.
export function buildSrt(timeline: Timeline, timings: Timings, paragraphsByScene: Map<number, string[]>): string {
  const cues: string[] = [];
  let sceneStart = sec(timeline.introFrames);
  for (const scene of timeline.scenes) {
    const t = timings.scenes.find((x) => x.index === scene.index);
    const paragraphs = paragraphsByScene.get(scene.index) ?? [];
    const sceneEnd = sec(scene.frames);
    paragraphs.forEach((para, p) => {
      const start = t?.paragraphStarts[p] ?? 0;
      const end = t?.paragraphStarts[p + 1] ?? sceneEnd;
      const sentences = para.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [para];
      const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
      let at = start;
      for (const s of sentences) {
        const next = at + ((end - start) * s.length) / total;
        cues.push(`${cues.length + 1}\n${srtTime(sceneStart + at)} --> ${srtTime(sceneStart + next)}\n${s}\n`);
        at = next;
      }
    });
    sceneStart += sceneEnd + sec(timeline.gapFrames);
  }
  return cues.join("\n");
}

// ---- rendering ----

export type Runner = (args: string[]) => Promise<void>;

export const ffmpegRunner: Runner = (args) => new Promise((resolve, reject) => {
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-stats", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });
  child.on("error", (err) => reject(new Error(`could not run ffmpeg: ${err.message}`)));
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
});

const ENCODE = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-r", String(FPS)];

export type VideoProgress =
  | { type: "warning"; message: string }
  | { type: "part_start"; label: string; seconds: number }
  | { type: "part_skipped"; label: string }
  | { type: "part_done"; label: string; elapsedMs: number }
  | { type: "muxing" };

export interface RenderOptions extends VideoOptions {
  runDir: string;
  run?: Runner;
  force?: boolean;
  onProgress?: (event: VideoProgress) => void;
}

export interface RenderResult {
  outDir: string;
  video: string;
  durationSec: number;
}

async function fingerprint(runDir: string, files: string[], extra: string): Promise<string> {
  const h = createHash("sha1").update(extra);
  for (const f of files) {
    const s = await stat(join(runDir, f));
    h.update(`${f}:${s.size}:${s.mtimeMs}`);
  }
  return h.digest("hex");
}

export async function renderVideo(events: StoryEvent[], opts: RenderOptions): Promise<RenderResult> {
  const { runDir } = opts;
  const run = opts.run ?? ffmpegRunner;
  const emit = opts.onProgress ?? (() => {});
  const outDir = join(runDir, "video");
  await mkdir(outDir, { recursive: true });

  const manifest: ArtManifest = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8").catch(() => {
    throw new Error(`no art/art.json in ${runDir} — render the art first (art --out ${runDir})`);
  }));
  const timings: Timings = JSON.parse(await readFile(join(runDir, "audiobook", "timings.json"), "utf8").catch(() => {
    throw new Error(`no audiobook/timings.json in ${runDir} — generate the audio first (audiobook --out ${runDir})`);
  }));
  const committed = events.filter((e) => e.type === "scene_committed").length;
  if (timings.scenes.length < committed) {
    emit({ type: "warning", message: `audio covers ${timings.scenes.length} of ${committed} scenes — the video will stop there` });
  }

  const timeline = buildTimeline(manifest, timings, opts);
  for (const w of timeline.warnings) emit({ type: "warning", message: w });
  await writeFile(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 2) + "\n", "utf8");

  // Cache rendered parts: a part is redone only when its inputs or filter change.
  const cachePath = join(outDir, "cache.json");
  let cache: Record<string, string> = {};
  try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch { /* first render */ }
  const renderPart = async (label: string, file: string, inputs: string[], filter: string, frames: number) => {
    const key = await fingerprint(runDir, inputs, filter);
    const exists = await stat(join(outDir, file)).then(() => true, () => false);
    if (!opts.force && exists && cache[file] === key) {
      emit({ type: "part_skipped", label });
      return;
    }
    emit({ type: "part_start", label, seconds: sec(frames) });
    const t0 = Date.now();
    await run([
      ...inputs.flatMap((f) => ["-i", join(runDir, f)]),
      "-filter_complex", filter,
      "-map", "[out]",
      "-frames:v", String(frames),
      ...ENCODE,
      "-an",
      join(outDir, file)
    ]);
    cache[file] = key;
    await writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8");
    emit({ type: "part_done", label, elapsedMs: Date.now() - t0 });
  };

  const parts: string[] = [];
  if (timeline.cover && timeline.introFrames > 0) {
    await renderPart("intro", "intro.mp4", [timeline.cover], introFilterGraph(timeline.introFrames), timeline.introFrames);
    parts.push("intro.mp4");
  }
  for (const [k, scene] of timeline.scenes.entries()) {
    if (k > 0 && timeline.gapFrames > 0) {
      const gap = `gap-${String(timeline.gapFrames)}.mp4`;
      if (!(await stat(join(outDir, gap)).then(() => true, () => false))) {
        await run(["-f", "lavfi", "-i", `color=black:s=${WIDTH}x${HEIGHT}:r=${FPS}`, "-frames:v", String(timeline.gapFrames), ...ENCODE, "-an", join(outDir, gap)]);
      }
      parts.push(gap);
    }
    const file = `scene-${String(scene.index + 1).padStart(2, "0")}.mp4`;
    await renderPart(`scene ${scene.index + 1} (${scene.shots.length} shots)`, file, scene.shots.map((s) => s.file), sceneFilterGraph(scene, timeline.fadeFrames), scene.frames);
    parts.push(file);
  }

  // Join the parts without re-encoding and lay the narration under them.
  emit({ type: "muxing" });
  await writeFile(join(outDir, "parts.txt"), parts.map((p) => `file '${p}'`).join("\n") + "\n", "utf8");
  const video = join(outDir, "story.mp4");
  await run([
    "-f", "concat", "-safe", "0", "-i", join(outDir, "parts.txt"),
    ...timeline.scenes.flatMap((s) => ["-i", join(runDir, s.audio)]),
    "-filter_complex", audioFilterGraph(timeline),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    video
  ]);

  if (timeline.cover) {
    await run(["-i", join(runDir, timeline.cover), "-vf", "crop='min(iw,ih*16/9)':'min(ih,iw*9/16)',scale=1280:720:flags=lanczos", "-frames:v", "1", "-q:v", "2", join(outDir, "thumbnail.jpg")]);
  }

  const bible = replay(events);
  const known = new Set(Object.keys(bible.characters));
  const paragraphsByScene = new Map<number, string[]>();
  for (const e of events) {
    if (e.type !== "scene_committed") continue;
    const d = e.data as SceneCommittedData;
    paragraphsByScene.set(d.index, sceneParagraphs(d.prose, known));
  }
  await writeFile(join(outDir, "story.srt"), buildSrt(timeline, timings, paragraphsByScene), "utf8");

  return { outDir, video, durationSec: sec(timeline.totalFrames) };
}
