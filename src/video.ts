import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replay } from "./bible.ts";
import { sceneParagraphs } from "./audiobook.ts";
import type { SceneTiming } from "./audiobook.ts";
import type { ArtManifest } from "./artist.ts";
import { decodeWav } from "./geminiTts.ts";
import { romanNumeral } from "./titles.ts";
import type { MusicMix } from "./music.ts";
import type { TitleCards } from "./titles.ts";
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
  maxMoveSec?: number;  // a shot held longer than this gets several camera moves on its image, default 25
  introSec?: number;    // cover card before the first scene, default 6 (8 with a title)
  gapSec?: number;      // black pause between scenes without scene cards, default 1.5
  // The cards (title, scene cards, ending, credits). Without them the video is
  // the plain cut: cover, scenes, black between them.
  titles?: TitleCards;
  narrationSec?: number;  // length of the narrated title (titles.narration)
  cardSec?: number;       // a scene card, black included, default 4
  music?: MusicMix;       // the score, prepared under the narration (music.ts)
  holdSec?: number;       // the last shot held after the narration ends, default 2
}

// When the narrated title starts within the opening.
const NARRATION_AT = 1.8;

export type Move = "zoom_in" | "zoom_out" | "pan_right" | "pan_left" | "zoom_in_left" | "zoom_in_right";
const MOVES: Move[] = ["zoom_in", "pan_right", "zoom_out", "pan_left", "zoom_in_left", "zoom_in_right"];

export interface TimelineShot {
  key: string;             // art key, plus "#2", "#3"... for extra moves on a long-held image
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
  audioFrames: number;     // the narration, frame-rounded
  frames: number;          // scene length: the narration plus a pad to fade out over (and the hold, last scene)
  shots: TimelineShot[];
}

// One clip of the finished video, in order. Every length is in whole frames,
// and the picture, the sound and the subtitles are all laid out from this list.
export type PartKind = "rating" | "intro" | "crawl" | "gap" | "card" | "scene" | "end" | "credits" | "next";
export interface TimelinePart {
  kind: PartKind;
  file: string;            // in video/parts/
  frames: number;
  scene?: number;          // scene: its position in scenes; card: the scene it introduces
  page?: number;           // credits: which page
}

export interface Timeline {
  fps: number;
  fadeFrames: number;
  introFrames: number;
  gapFrames: number;
  cardFrames: number;
  padFrames: number;
  holdFrames: number;
  cover?: string;
  scenes: TimelineScene[];
  parts: TimelinePart[];
  narration?: string;      // the narrated title's WAV under the opening, relative to the run dir
  narrationSec?: number;
  music?: MusicMix;
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
  const maxMoveFrames = Math.max(toFrames(opts.maxMoveSec ?? 25), minFrames);
  const warnings: string[] = [];
  const entries = Object.entries(manifest);
  const coverEntry = manifest.cover;

  for (const [key, e] of entries) {
    if (!e.accepted) warnings.push(`${key} (${e.file}) was never accepted by the inspector: ${e.issues.join("; ") || "no detail"}`);
  }

  const titles = opts.titles;
  // With cards, every scene gets a pad of silence to fade out over, so the
  // fade never eats the last words; the last shot also holds after the end.
  const padFrames = titles ? toFrames(0.75) : 0;
  const holdFrames = titles ? toFrames(opts.holdSec ?? 2) : 0;
  const ordered = [...timings.scenes].sort((a, b) => a.index - b.index);
  const scenes: TimelineScene[] = [];
  let previousMove: Move | undefined;
  for (const [k, t] of ordered.entries()) {
    const audioFrames = toFrames(t.durationSec);
    const frames = audioFrames + padFrames + (k === ordered.length - 1 ? holdFrames : 0);
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

    // A long-held image gets several equal camera moves (crossfading between
    // them) so the picture keeps changing even while one shot owns the screen.
    const segments: Array<(typeof kept)[number]> = [];
    kept.forEach((c, k) => {
      const end = k + 1 < kept.length ? kept[k + 1].startFrame : frames;
      const n = Math.max(1, Math.ceil((end - c.startFrame) / maxMoveFrames));
      for (let m = 0; m < n; m++) {
        segments.push({ ...c, key: m === 0 ? c.key : `${c.key}#${m + 1}`, startFrame: c.startFrame + Math.round(((end - c.startFrame) * m) / n) });
      }
    });
    const shots: TimelineShot[] = segments.map((c, k) => {
      const next = k + 1 < segments.length ? segments[k + 1].startFrame : frames;
      const slotFrames = next - c.startFrame;
      const move = moveFor(c.key, previousMove);
      previousMove = move;
      return { ...c, slotFrames, clipFrames: k + 1 < segments.length ? slotFrames + fadeFrames : slotFrames, move };
    });
    scenes.push({ index: t.index, audio: `audiobook/${t.file}`, audioFrames, frames, shots });
  }
  if (scenes.length === 0) throw new Error("timings.json has no scenes");

  // The opening: the cover (or black, for a title without a cover), long
  // enough for the title to fade up and out, and for the narrated title.
  let introFrames = 0;
  if (coverEntry || titles?.title) {
    introFrames = toFrames(opts.introSec ?? (titles?.title ? 8 : 6));
    if (titles?.narration && opts.narrationSec) introFrames = Math.max(introFrames, Math.ceil((NARRATION_AT + opts.narrationSec + 2) * FPS));
  }
  const gapFrames = toFrames(opts.gapSec ?? 1.5);
  const cardFrames = titles?.sceneCards ? toFrames(opts.cardSec ?? 4) : 0;

  const parts: TimelinePart[] = [];
  // A rated story opens on its rating card (#88), before anything else.
  if (titles?.rating) parts.push({ kind: "rating", file: "rating.mp4", frames: toFrames(6) });
  if (introFrames > 0) parts.push({ kind: "intro", file: "intro.mp4", frames: introFrames });
  if (titles?.crawl?.length) parts.push({ kind: "crawl", file: "crawl.mp4", frames: toFrames(crawlSec(titles.crawl)) });
  scenes.forEach((s, k) => {
    const nn = String(s.index + 1).padStart(2, "0");
    if (cardFrames > 0) parts.push({ kind: "card", file: `card-${nn}.mp4`, frames: cardFrames, scene: k });
    else if (k > 0 && gapFrames > 0) parts.push({ kind: "gap", file: "", frames: gapFrames });
    parts.push({ kind: "scene", file: `scene-${nn}.mp4`, frames: s.frames, scene: k });
  });
  if (titles?.ending) parts.push({ kind: "end", file: "end.mp4", frames: toFrames(4) });
  titles?.credits.forEach((_, p) => parts.push({ kind: "credits", file: `credits-${p + 1}.mp4`, frames: toFrames(5), page: p }));
  if (titles?.next) parts.push({ kind: "next", file: "next.mp4", frames: toFrames(3.5) });

  return {
    fps: FPS,
    fadeFrames,
    introFrames,
    gapFrames,
    cardFrames,
    padFrames,
    holdFrames,
    cover: coverEntry ? `art/${coverEntry.file}` : undefined,
    scenes,
    parts,
    narration: introFrames > 0 && titles?.narration && opts.narrationSec ? titles.narration : undefined,
    ...(introFrames > 0 && titles?.narration && opts.narrationSec ? { narrationSec: opts.narrationSec } : {}),
    ...(opts.music ? { music: opts.music } : {}),
    totalFrames: parts.reduce((n, p) => n + p.frames, 0),
    warnings
  };
}

// Crops to 16:9, upscales (zoompan rounds its crop to whole pixels; doing that
// on a 4K source keeps the motion smooth at 1080p), then moves the camera.
// Moves ease in and out (smoothstep) and travel far enough to read clearly:
// zooms span 1.0-1.35x, pans cross ~25% of the frame at 1.35x.
export function kenBurnsFilter(move: Move, frames: number): string {
  const n = Math.max(frames - 1, 1);
  const lin = `(on/${n})`;
  const t = `(${lin}*${lin}*(3-2*${lin}))`;
  const Z = "1.35";
  const ZD = "0.35"; // Z - 1, as a literal so the ffmpeg expression stays exact
  const zIn = `1+${ZD}*${t}`;
  const cx = "iw/2-(iw/zoom/2)";
  const cy = "ih/2-(ih/zoom/2)";
  const motion: Record<Move, { z: string; x: string; y: string }> = {
    zoom_in: { z: zIn, x: cx, y: cy },
    zoom_out: { z: `${Z}-${ZD}*${t}`, x: cx, y: cy },
    pan_right: { z: Z, x: `(iw-iw/zoom)*${t}`, y: `(ih-ih/zoom)*(0.35+0.3*${t})` },
    pan_left: { z: Z, x: `(iw-iw/zoom)*(1-${t})`, y: `(ih-ih/zoom)*(0.65-0.3*${t})` },
    // Push in toward the left/right third of the frame.
    zoom_in_left: { z: zIn, x: "(iw-iw/zoom)*0.15", y: cy },
    zoom_in_right: { z: zIn, x: "(iw-iw/zoom)*0.85", y: cy }
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

// ---- cards ----

// One line of text on a card: centered, faded up at `in` and out by `out` (seconds into the card).
export interface CardText { text: string; font: string; size: number; y: number; in: number; out: number }
// `art`: the image behind the card (default the cover); `logo`: the title logo
// (alpha) over it; `crawl`: text scrolling up the frame for the card's length.
// `box`: an outlined panel (the rating card's frame), in 1920×1080 pixels.
export interface CardSpec { cover: boolean; texts: CardText[]; art?: string; logo?: string; crawl?: { text: string; font: string; size: number }; box?: { x: number; y: number; w: number; h: number } }

// The crawl reads at an easy pace, ~2.5 words a second, with time to settle in.
export function crawlSec(paragraphs: string[]): number {
  const words = paragraphs.join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(12, words / 2.5 + 5);
}

// Paragraphs wrapped to lines of at most `width` characters, a blank line between.
export function wrapCrawl(paragraphs: string[], width = 46): string {
  return paragraphs.map((p) => {
    const lines: string[] = [];
    let line = "";
    for (const w of p.split(/\s+/)) {
      if (line && (line + " " + w).length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(line);
    return lines.join("\n");
  }).join("\n\n");
}

const TEXT_FADE = 0.7;
const TEXT_MAX_WIDTH = 1680;

// Shrinks a line that would run off the frame (an estimate from its length:
// display capitals run wider than body text).
export function fitSize(text: string, size: number, wide: boolean): number {
  const width = text.length * size * (wide ? 0.66 : 0.46);
  return width <= TEXT_MAX_WIDTH ? size : Math.floor((size * TEXT_MAX_WIDTH) / width);
}

// What each card says, where and when. Pure: the words come from the titles,
// the times from the part's length.
export function cardSpec(part: TimelinePart, timeline: Timeline, titles: TitleCards): CardSpec {
  const len = sec(part.frames);
  const out = len - 0.5;
  const line = (text: string, wide: boolean, size: number, y: number, at: number, until = out): CardText =>
    ({ text, font: wide ? titles.titleFont : titles.font, size: fitSize(text, size, wide), y, in: at, out: until });
  switch (part.kind) {
    case "intro": {
      const texts: CardText[] = [];
      // The title logo over the key art (the subtitle beneath it), when the extras made them.
      if (titles.logo) {
        if (titles.subtitle) texts.push(line(titles.subtitle, false, 60, 800, 2.2, len - 1.2));
        return { cover: Boolean(titles.openingArt ?? timeline.cover), texts, ...(titles.openingArt ? { art: titles.openingArt } : {}), logo: titles.logo };
      }
      if (titles.title) {
        const until = len - 1.2;
        texts.push(line(titles.title, true, 112, titles.subtitle ? 490 : 540, 1.2, until));
        if (titles.subtitle) texts.push(line(titles.subtitle, false, 60, 620, 1.9, until));
      }
      return { cover: Boolean(timeline.cover), texts };
    }
    case "card": {
      const scene = timeline.scenes[part.scene!];
      const numeral = romanNumeral(scene.index + 1);
      const title = titles.sceneTitles[scene.index];
      return { cover: false, texts: title ? [line(numeral, true, 60, 470, 0.5), line(title, false, 84, 590, 0.9)] : [line(numeral, true, 96, 540, 0.5)] };
    }
    case "rating": {
      // Black, the rating in an outlined panel, the tagline under it, then why
      // and for whom, and a small note that it's the author's own rating.
      const r = titles.rating!;
      const texts: CardText[] = [
        line(r.rating, true, 150, 330, 0.3),
        line(r.tagline, false, 46, 520, 0.6),
        ...(r.reasons ? [line(r.reasons, false, 42, 640, 0.9)] : []),
        ...(r.age ? [line(r.age, false, 42, 720, 1.1)] : []),
        line(r.note, false, 26, 960, 1.3)
      ];
      return { cover: false, texts, box: { x: 760, y: 230, w: 400, h: 200 } };
    }
    case "crawl":
      return { cover: Boolean(titles.openingArt ?? timeline.cover), texts: [], ...(titles.openingArt ? { art: titles.openingArt } : {}), crawl: { text: wrapCrawl(titles.crawl ?? []), font: titles.font, size: 58 } };
    case "end":
      return { cover: false, texts: [line(titles.ending!, true, 96, 540, 0.6)] };
    case "credits": {
      const lines = titles.credits[part.page!];
      const spacing = 80;
      const top = 540 - ((lines.length - 1) * spacing) / 2;
      return { cover: false, texts: lines.map((l, k) => line(l, false, 52, top + k * spacing, 0.4)) };
    }
    case "next":
      return { cover: false, texts: [line(titles.next!, false, 72, 540, 0.5)] };
    default:
      throw new Error(`${part.kind} is not a card`);
  }
}

// A filtergraph value in single quotes (paths with spaces, colons, commas).
const quoted = (v: string) => `'${v.replace(/'/g, "'\\''")}'`;

// Fades a line in at `in` and out by `out` with drawtext's alpha expression.
function drawText(t: CardText, textFile: string): string {
  const f = TEXT_FADE;
  const a = t.in;
  const b = t.out - f;
  const alpha = `if(lt(t,${a}),0,if(lt(t,${a + f}),(t-${a})/${f},if(lt(t,${b}),1,if(lt(t,${t.out}),(${t.out}-t)/${f},0))))`;
  return `drawtext=fontfile=${quoted(t.font)}:textfile=${quoted(textFile)}:expansion=none:fontsize=${t.size}:fontcolor=0xF2E8D5:shadowcolor=black@0.85:shadowx=3:shadowy=3:x=(w-text_w)/2:y=${Math.round(t.y)}-text_h/2:alpha='${alpha}'`;
}

// A card: black (or the cover, slowly pushing in and dimmed under the title),
// its lines of text, and a fade up from and down to black at the edges.
// `textFile` maps a line to the file drawtext reads it from (no escaping of the words).
export function cardFilterGraph(spec: CardSpec, frames: number, textFile: (text: string) => string): string {
  const len = sec(frames);
  const edge = Math.min(0.75, len / 4);
  // Dimmed under words: a little under the logo, more under the crawl.
  const dim = spec.crawl ? 0.62 : spec.logo ? 0.2 : spec.texts.length ? 0.4 : 0;
  let base = spec.cover
    ? `[0:v]${kenBurnsFilter("zoom_in", frames)}${dim ? `,drawbox=x=0:y=0:w=iw:h=ih:color=black@${dim}:t=fill` : ""}`
    : `color=black:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${len},format=yuv420p`;
  // The logo fades in and settles, then fades before the card does.
  if (spec.logo) {
    const logoIn = spec.cover ? 1 : 0;
    base = `${base}[bg];[${logoIn}:v]loop=loop=-1:size=1,setpts=N/${FPS}/TB,format=rgba,scale=w='min(1500,560*iw/ih)':h=-1,fade=t=in:st=1.0:d=1.6:alpha=1,fade=t=out:st=${Math.max(2.6, len - 1.8)}:d=1.0:alpha=1[logo];[bg][logo]overlay=x=(W-w)/2:y=H*0.2-h/2:format=auto,format=yuv420p`;
  }
  // The crawl scrolls from below the frame to above it over the card's length.
  if (spec.crawl) {
    base += `,drawtext=fontfile=${quoted(spec.crawl.font)}:textfile=${quoted(textFile(spec.crawl.text))}:expansion=none:fontsize=${spec.crawl.size}:line_spacing=${Math.round(spec.crawl.size * 0.45)}:text_align=C:fontcolor=0xF2E8D5:shadowcolor=black@0.85:shadowx=3:shadowy=3:x=(w-text_w)/2:y='h-(h+text_h)*t/${len}'`;
  }
  if (spec.box) base += `,drawbox=x=${spec.box.x}:y=${spec.box.y}:w=${spec.box.w}:h=${spec.box.h}:color=0xF2E8D5:t=6`;
  const text = spec.texts.map((t) => `,${drawText(t, textFile(t.text))}`).join("");
  return `${base}${text},fade=t=in:d=${edge},fade=t=out:st=${len - edge}:d=${edge},trim=end_frame=${frames}[out]`;
}

// Narration track matching the video, part by part: each scene's audio
// trimmed/padded to its frame length (so an hour of video can't drift from
// the voice), the narrated title under the opening, and silence under
// everything else. Input k+1 is scene k's WAV (input 0 is the video); the
// narrated title, if any, comes after the scenes.
export function audioFilterGraph(timeline: Timeline): string {
  const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
  const silence = (label: string, frames: number) => `anullsrc=r=48000:cl=stereo,atrim=end=${sec(frames)}[${label}]`;
  const lines: string[] = [];
  const labels: string[] = [];
  const narrated = timeline.narration !== undefined;
  for (const part of timeline.parts) {
    const d = sec(part.frames);
    let label: string;
    if (part.kind === "scene") {
      label = `a${part.scene}`;
      lines.push(`[${part.scene! + 1}:a]${fmt},apad=whole_dur=${d},atrim=end=${d}[${label}]`);
    } else if (part.kind === "intro" && narrated) {
      label = "intro";
      const ms = Math.round(NARRATION_AT * 1000);
      lines.push(`[${timeline.scenes.length + 1}:a]${fmt},adelay=${ms}|${ms},apad=whole_dur=${d},atrim=end=${d}[${label}]`);
    } else {
      const next = timeline.parts[timeline.parts.indexOf(part) + 1];
      label = part.kind === "intro" ? "intro"
        : part.kind === "gap" ? `gap${next?.scene}`
        : part.kind === "card" ? `card${part.scene}`
        : part.kind === "credits" ? `credits${part.page! + 1}`
        : part.kind;
      lines.push(silence(label, part.frames));
    }
    labels.push(`[${label}]`);
  }
  const music = musicInputs(timeline);
  lines.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[${music.length ? "voice" : "aout"}]`);
  if (music.length) {
    lines.push(...musicGraph(timeline, music, timeline.scenes.length + 1 + (narrated ? 1 : 0)));
    lines.push("[voice][music]amix=inputs=2:normalize=0:duration=first[aout]");
  }
  return lines.join(";\n");
}

// The score's input files, after the scenes' WAVs and the narrated title: the
// theme under the opening, the theme again under the closing cards, then each
// scene's bed in order.
export function musicInputs(timeline: Timeline): Array<{ file: string; use: "intro" | "closing" | number }> {
  const m = timeline.music;
  if (!m) return [];
  const out: Array<{ file: string; use: "intro" | "closing" | number }> = [];
  if (m.theme && timeline.parts.some((p) => p.kind === "intro")) out.push({ file: m.theme, use: "intro" });
  if (m.theme && timeline.parts.some((p) => CLOSING.has(p.kind))) out.push({ file: m.theme, use: "closing" });
  timeline.scenes.forEach((s, k) => { if (m.beds[s.index]) out.push({ file: m.beds[s.index], use: k }); });
  return out;
}

const CLOSING = new Set<PartKind>(["end", "credits", "next"]);

// The music track, part by part like the narration: the theme under the
// opening (dipped under a narrated title), each scene's bed (already ducked
// under its narration) faded out over the scene's pad, silence under the scene
// cards, and the theme again under the ending and credits.
function musicGraph(timeline: Timeline, inputs: ReturnType<typeof musicInputs>, first: number): string[] {
  const fmt = "aformat=sample_rates=48000:channel_layouts=stereo";
  const at = (use: "intro" | "closing" | number) => {
    const k = inputs.findIndex((i) => i.use === use);
    return k === -1 ? undefined : first + k;
  };
  const lines: string[] = [];
  const labels: string[] = [];
  let k = 0;
  const parts = timeline.parts;
  while (k < parts.length) {
    const part = parts[k];
    const label = `m${k}`;
    // Consecutive closing cards share one stretch of the theme.
    if (CLOSING.has(part.kind)) {
      let frames = 0;
      while (k < parts.length && CLOSING.has(parts[k].kind)) frames += parts[k++].frames;
      const d = sec(frames);
      const input = at("closing");
      lines.push(input === undefined
        ? `anullsrc=r=48000:cl=stereo,atrim=end=${d}[${label}]`
        : `[${input}:a]${fmt},apad=whole_dur=${d},atrim=end=${d},afade=t=in:d=1,afade=t=out:st=${Math.max(0, d - 3)}:d=3[${label}]`);
      labels.push(`[${label}]`);
      continue;
    }
    // The opening's crawl shares the theme with the title: one stretch of it.
    let frames = part.frames;
    if (part.kind === "intro") while (parts[k + 1]?.kind === "crawl") frames += parts[++k].frames;
    const d = sec(frames);
    const input = part.kind === "intro" ? at("intro") : part.kind === "scene" ? at(part.scene!) : undefined;
    if (input === undefined) lines.push(`anullsrc=r=48000:cl=stereo,atrim=end=${d}[${label}]`);
    else if (part.kind === "intro") {
      const dip = timeline.narration && timeline.narrationSec
        ? `,volume=-${timeline.music!.duck}dB:enable='between(t,${NARRATION_AT - 0.3},${NARRATION_AT + timeline.narrationSec + 0.5})'`
        : "";
      lines.push(`[${input}:a]${fmt},apad=whole_dur=${d},atrim=end=${d}${dip},afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, d - 1.5)}:d=1.5[${label}]`);
    } else {
      const fade = Math.min(1.5, d / 4);
      lines.push(`[${input}:a]${fmt},apad=whole_dur=${d},atrim=end=${d},afade=t=out:st=${d - fade}:d=${fade}[${label}]`);
    }
    labels.push(`[${label}]`);
    k++;
  }
  lines.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[music]`);
  return lines;
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
  let partStart = 0;
  for (const part of timeline.parts) {
    const at0 = sec(partStart);
    partStart += part.frames;
    if (part.kind !== "scene") continue;
    const scene = timeline.scenes[part.scene!];
    const t = timings.scenes.find((x) => x.index === scene.index);
    const paragraphs = paragraphsByScene.get(scene.index) ?? [];
    // Captions end with the narration, never over the fade or the hold.
    const sceneEnd = sec(scene.audioFrames);
    paragraphs.forEach((para, p) => {
      const start = t?.paragraphStarts[p] ?? 0;
      const end = t?.paragraphStarts[p + 1] ?? sceneEnd;
      const sentences = para.match(/[^.!?]+[.!?]+["”’)]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [para];
      const total = sentences.reduce((n, s) => n + s.length, 0) || 1;
      let at = start;
      for (const s of sentences) {
        const next = at + ((end - start) * s.length) / total;
        cues.push(`${cues.length + 1}\n${srtTime(at0 + at)} --> ${srtTime(at0 + next)}\n${s}\n`);
        at = next;
      }
    });
  }
  return cues.join("\n");
}

// ---- rendering ----

// onProgress: seconds of output rendered so far (and ffmpeg's speed), from its
// machine-readable -progress stream — works with several ffmpegs at once (#131).
export type Runner = (args: string[], opts?: { quiet?: boolean; onProgress?: (doneSec: number, speed?: number) => void }) => Promise<void>;

export function parseProgress(chunk: string, report: (doneSec: number, speed?: number) => void): void {
  let done: number | undefined;
  let speed: number | undefined;
  for (const line of chunk.split("\n")) {
    const [k, v] = line.trim().split("=");
    if (k === "out_time_us" && /^\d+$/.test(v ?? "")) done = Number(v) / 1e6;
    else if (k === "speed" && v && v !== "N/A") speed = parseFloat(v);
    else if (k === "progress" && done !== undefined) { report(done, speed); done = undefined; }
  }
}

export const ffmpegRunner: Runner = (args, { quiet = false, onProgress } = {}) => new Promise((resolve, reject) => {
  const progress = onProgress ? ["-progress", "pipe:1", "-nostats"] : [quiet ? "-nostats" : "-stats"];
  const child = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", ...progress, "-y", ...args], { stdio: ["ignore", onProgress ? "pipe" : "inherit", quiet || onProgress ? "ignore" : "inherit"] });
  if (onProgress) child.stdout?.on("data", (d: Buffer) => parseProgress(d.toString(), onProgress));
  child.on("error", (err) => reject(new Error(`could not run ffmpeg: ${err.message}`)));
  child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
});

// H.264 encoders. NVENC (NVIDIA's hardware encoder) is ~3x faster for the same
// size and quality on slow Ken Burns footage; x264 runs anywhere.
export type Encoder = "nvenc" | "x264";
export type EncoderChoice = Encoder | "auto";

export function encodeArgs(encoder: Encoder): string[] {
  const codec = encoder === "nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", "26", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "medium", "-crf", "18"];
  return [...codec, "-pix_fmt", "yuv420p", "-r", String(FPS)];
}

// "auto" uses NVENC if a one-frame test encode works (an NVIDIA GPU, a driver
// and an ffmpeg built with it), and x264 otherwise.
export async function resolveEncoder(choice: EncoderChoice, run: Runner): Promise<Encoder> {
  if (choice !== "auto") return choice;
  try {
    await run(["-f", "lavfi", "-i", "color=black:s=256x256:r=30", "-frames:v", "1", "-c:v", "h264_nvenc", "-f", "null", "-"], { quiet: true });
    return "nvenc";
  } catch {
    return "x264";
  }
}

// Runs tasks with at most `limit` in flight, in order of submission.
async function pool(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
}

export type VideoProgress =
  | { type: "warning"; message: string }
  | { type: "encoder"; encoder: Encoder; parallel: number }
  | { type: "plan"; parts: { label: string; seconds: number }[] }   // everything to render, up front
  | { type: "part_start"; label: string; seconds: number }
  | { type: "part_progress"; label: string; done: number; seconds: number; speed?: number }
  | { type: "part_skipped"; label: string }
  | { type: "part_done"; label: string; elapsedMs: number }
  | { type: "muxing" };

// Counts a clip's video frames and measures its audio, to prove the parts
// add up before they're joined and that picture and sound end together.
export type Probe = (file: string) => Promise<{ frames?: number; audioSec?: number }>;

export const ffprobe: Probe = (file) => new Promise((resolve, reject) => {
  execFile("ffprobe", ["-v", "error", "-count_packets", "-show_entries", "stream=codec_type,nb_read_packets,duration", "-of", "json", file], (err, out) => {
    if (err) return reject(new Error(`could not probe ${file}: ${err.message}`));
    const streams = (JSON.parse(out).streams ?? []) as Array<{ codec_type: string; nb_read_packets?: string; duration?: string }>;
    const v = streams.find((x) => x.codec_type === "video");
    const a = streams.find((x) => x.codec_type === "audio");
    resolve({ frames: v?.nb_read_packets ? Number(v.nb_read_packets) : undefined, audioSec: a?.duration ? Number(a.duration) : undefined });
  });
});

export interface RenderOptions extends VideoOptions {
  runDir: string;
  run?: Runner;
  probe?: Probe;            // default ffprobe with the real ffmpeg; off with an injected runner unless given
  force?: boolean;
  encoder?: EncoderChoice;  // default "auto"
  parallel?: number;        // scenes rendered at once, default 3
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
  // Silent intermediate clips (intro, scenes, gaps) live apart from the deliverables.
  const partsDir = join(outDir, "parts");
  await mkdir(partsDir, { recursive: true });

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

  const narrationSec = opts.titles?.narration
    ? await readFile(join(runDir, opts.titles.narration)).then((b) => { const w = decodeWav(b); return w.samples.length / w.sampleRate; }, () => undefined)
    : undefined;
  if (opts.titles?.narration && narrationSec === undefined) emit({ type: "warning", message: `no ${opts.titles.narration} — the opening runs without the narrated title` });
  const timeline = buildTimeline(manifest, timings, { ...opts, narrationSec });
  for (const w of timeline.warnings) emit({ type: "warning", message: w });
  await writeFile(join(outDir, "timeline.json"), JSON.stringify(timeline, null, 2) + "\n", "utf8");

  const encoder = await resolveEncoder(opts.encoder ?? "auto", run);
  const parallel = Math.max(1, Math.floor(opts.parallel ?? 3));
  const ENCODE = encodeArgs(encoder);
  emit({ type: "encoder", encoder, parallel });

  // Cache rendered parts: a part is redone only when its inputs, filter or
  // encoder change (parts from different encoders are never joined together).
  const cachePath = join(partsDir, "cache.json");
  let cache: Record<string, string> = {};
  try { cache = JSON.parse(await readFile(cachePath, "utf8")); } catch { /* first render */ }
  // Parts finish out of order when rendered in parallel: serialize the cache writes.
  let saving: Promise<void> = Promise.resolve();
  const saveCache = () => (saving = saving.then(() => writeFile(cachePath, JSON.stringify(cache, null, 2) + "\n", "utf8")));
  const renderPart = async (label: string, file: string, inputs: string[], filter: string, frames: number, quiet = false) => {
    const key = await fingerprint(runDir, inputs, `${filter}|${encoder}`);
    const exists = await stat(join(partsDir, file)).then(() => true, () => false);
    if (!opts.force && exists && cache[file] === key) {
      emit({ type: "part_skipped", label });
      return;
    }
    emit({ type: "part_start", label, seconds: sec(frames) });
    const t0 = Date.now();
    const onProgress = (done: number, speed?: number) => emit({ type: "part_progress", label, done: Math.min(done, sec(frames)), seconds: sec(frames), ...(speed ? { speed } : {}) });
    await run([
      ...inputs.flatMap((f) => ["-i", join(runDir, f)]),
      "-filter_complex", filter,
      "-map", "[out]",
      "-frames:v", String(frames),
      ...ENCODE,
      "-an",
      join(partsDir, file)
    ], { quiet, onProgress });
    cache[file] = key;
    await saveCache();
    emit({ type: "part_done", label, elapsedMs: Date.now() - t0 });
  };

  // The words on each card go in text files that drawtext reads as they are;
  // named by their content, so a changed title is a changed filter (and a re-render).
  const textDir = join(partsDir, "text");
  const texts = new Map<string, string>();
  const textFile = (text: string) => {
    const file = join(textDir, `${createHash("sha1").update(text).digest("hex").slice(0, 16)}.txt`);
    texts.set(file, text);
    return file;
  };
  const graphs = new Map<TimelinePart, { inputs: string[]; filter: string }>();
  for (const part of timeline.parts) {
    if (part.kind === "scene" || part.kind === "gap") continue;
    if (part.kind === "intro" && !opts.titles) {
      graphs.set(part, { inputs: [timeline.cover!], filter: introFilterGraph(part.frames) });
      continue;
    }
    const spec = cardSpec(part, timeline, opts.titles!);
    graphs.set(part, { inputs: [...(spec.cover ? [spec.art ?? timeline.cover!] : []), ...(spec.logo ? [spec.logo] : [])], filter: cardFilterGraph(spec, part.frames, textFile) });
  }
  if (texts.size) {
    await mkdir(textDir, { recursive: true });
    for (const [file, text] of texts) await writeFile(file, text, "utf8");
  }

  const gap = `gap-${String(timeline.gapFrames)}-${encoder}.mp4`;
  const files = timeline.parts.map((p) => (p.kind === "gap" ? gap : p.file));
  // Cards are quick: one at a time, in order. Scenes are independent: render
  // several at once. The zoom filter is single-threaded, so this is what puts
  // the other cores to work.
  const cardLabel = (part: TimelinePart) => (part.kind === "credits" ? `credits ${part.page! + 1}` : part.kind === "card" ? `scene ${timeline.scenes[part.scene!].index + 1} card` : part.kind);
  const sceneLabel = (part: TimelinePart) => { const sc = timeline.scenes[part.scene!]; return `scene ${sc.index + 1} (${sc.shots.length} shots)`; };
  emit({ type: "plan", parts: [
    ...[...graphs.keys()].map((p) => ({ label: cardLabel(p), seconds: sec(p.frames) })),
    ...timeline.parts.filter((p) => p.kind === "scene").map((p) => ({ label: sceneLabel(p), seconds: sec(timeline.scenes[p.scene!].frames) }))
  ] });
  for (const [part, g] of graphs) {
    await renderPart(part.kind === "credits" ? `credits ${part.page! + 1}` : part.kind === "card" ? `scene ${timeline.scenes[part.scene!].index + 1} card` : part.kind, part.file, g.inputs, g.filter, part.frames);
  }
  if (timeline.parts.some((p) => p.kind === "gap") && !(await stat(join(partsDir, gap)).then(() => true, () => false))) {
    await run(["-f", "lavfi", "-i", `color=black:s=${WIDTH}x${HEIGHT}:r=${FPS}`, "-frames:v", String(timeline.gapFrames), ...ENCODE, "-an", join(partsDir, gap)]);
  }
  const sceneJobs = timeline.parts.filter((p) => p.kind === "scene").map((p) => {
    const scene = timeline.scenes[p.scene!];
    return () => renderPart(`scene ${scene.index + 1} (${scene.shots.length} shots)`, p.file, scene.shots.map((s) => s.file), sceneFilterGraph(scene, timeline.fadeFrames), scene.frames, parallel > 1);
  });
  await pool(sceneJobs, parallel);

  // Every part must be exactly as long as the timeline says: the narration is
  // laid out from the timeline, so a frame lost in one part would put the
  // picture behind the voice for the rest of the video.
  const probe = opts.probe ?? (opts.run ? undefined : ffprobe);
  if (probe) {
    const checked = new Set<string>();
    for (const [k, part] of timeline.parts.entries()) {
      if (checked.has(files[k])) continue; // the black gap is one clip, used between every scene
      checked.add(files[k]);
      const { frames } = await probe(join(partsDir, files[k]));
      if (frames !== part.frames) {
        delete cache[files[k]];
        await saveCache();
        throw new Error(`video/parts/${files[k]} has ${frames} frames where the timeline needs ${part.frames} — it will be re-rendered on the next run`);
      }
    }
  }

  // Join the parts without re-encoding and lay the narration under them.
  emit({ type: "muxing" });
  await writeFile(join(partsDir, "parts.txt"), files.map((p) => `file '${p}'`).join("\n") + "\n", "utf8");
  const video = join(outDir, "story.mp4");
  await run([
    "-f", "concat", "-safe", "0", "-i", join(partsDir, "parts.txt"),
    ...timeline.scenes.flatMap((s) => ["-i", join(runDir, s.audio)]),
    ...(timeline.narration ? ["-i", join(runDir, timeline.narration)] : []),
    ...musicInputs(timeline).flatMap((m) => ["-i", join(runDir, m.file)]),
    "-filter_complex", audioFilterGraph(timeline),
    "-map", "0:v", "-map", "[aout]",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    video
  ]);
  if (probe) {
    const { frames, audioSec } = await probe(video);
    if (frames !== timeline.totalFrames) emit({ type: "warning", message: `story.mp4 has ${frames} frames where the timeline has ${timeline.totalFrames}` });
    // AAC pads its last packet: allow a frame and a little.
    if (audioSec !== undefined && Math.abs(audioSec - sec(timeline.totalFrames)) > 1 / FPS + 0.05) {
      emit({ type: "warning", message: `the sound runs ${audioSec.toFixed(2)}s and the picture ${sec(timeline.totalFrames).toFixed(2)}s — they've drifted apart` });
    }
  }

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
