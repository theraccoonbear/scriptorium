import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readApprovals } from "./approvals.ts";
import { decodeWav } from "./geminiTts.ts";
import { encodeWav } from "./geminiBatch.ts";
import type { ArtManifest } from "./artist.ts";
import { staleShots } from "./artist.ts";
import { voicedBible } from "./audiobook.ts";
import type { SampleIndexEntry } from "./voiceSamples.ts";
import { EventLog } from "./eventlog.ts";

// Review sheets for the author, one file per phase in <run>/review/, small
// enough to send to a phone: a labeled contact sheet of the reference
// portraits or of each scene's shots, and one reel of every voice sample with
// a legend of who speaks when. Approved work is marked ✓.

const run = promisify(execFile);
export type ReviewKind = "refs" | "shots" | "extras" | "voices" | "music";
export const REVIEW_KINDS: readonly ReviewKind[] = ["refs", "shots", "extras", "voices", "music"];

export interface SheetTile { label: string; file: string }

// The tiles of each contact sheet: one each for the character, location and
// prop references, one per scene of shots (the cover on its own), in art.json order.
export function contactSheets(manifest: ArtManifest, kind: "refs" | "shots" | "extras", approved: ReadonlySet<string>, artDir: string, stale: ReadonlySet<string> = new Set()): Map<string, SheetTile[]> {
  const sheets = new Map<string, SheetTile[]>();
  // ✓ approved; ⟳ drawn from a reference that has changed since (a reshoot).
  const tile = (key: string): SheetTile => ({ label: `${approved.has(key) ? "✓ " : ""}${stale.has(key) ? "⟳ " : ""}${key}`, file: join(artDir, manifest[key].file) });
  const keys = Object.keys(manifest);
  if (kind === "refs") {
    for (const kind of ["character", "location", "prop"] as const) {
      const refs = keys.filter((k) => manifest[k].refKind === kind).sort();
      if (refs.length) sheets.set(`refs-${kind === "character" ? "characters" : kind === "location" ? "locations" : "props"}`, refs.map(tile));
    }
    return sheets;
  }
  if (kind === "extras") {
    // Key art (each shape) and the cast photo, on one sheet.
    const extras = keys.filter((k) => k.startsWith("extra-")).sort();
    if (extras.length) sheets.set("extras", extras.map(tile));
    return sheets;
  }
  const shots = keys.filter((k) => /^scene-\d+/.test(k)).sort();
  for (const k of shots) {
    const scene = k.match(/^scene-(\d+)/)![1];
    const name = `shots-scene-${scene}`;
    sheets.set(name, [...(sheets.get(name) ?? []), tile(k)]);
  }
  if (manifest.cover) sheets.set("cover", [tile("cover")]);
  return sheets;
}

// ImageMagick montage arguments: each tile labeled, four across, large enough
// to judge a face or a prop on a phone (up to 960 px a tile).
export function montageArgs(tiles: SheetTile[], out: string): string[] {
  return ["montage", ...tiles.flatMap((t) => ["-label", t.label, t.file]), "-tile", `${Math.min(4, tiles.length)}x`, "-geometry", "960x960>+12+12", "-pointsize", "30", "-background", "#1e1e1e", "-fill", "#f0f0f0", "-quality", "88", out];
}

export interface ReelEntry { id: string; start: number; seconds: number; voice: string; approved: boolean; name?: string; source?: "story" | "audition"; description?: string }

export interface ReelSample {
  id: string;
  voice: string;
  audio: { samples: Float32Array; sampleRate: number };
  slate?: { samples: Float32Array; sampleRate: number };  // the narrator announcing the name
  name?: string;
  source?: "story" | "audition";
  description?: string;
}

// One WAV of every sample (narrator first), a second of silence between.
// One reel: for each voice, its name announced, a short pause, the sample,
// then a longer pause before the next, so the voices never run together.
export function buildReel(samples: ReelSample[], approved: ReadonlySet<string>, gap = 2, afterSlate = 0.6): { audio: Float32Array; sampleRate: number; legend: ReelEntry[] } {
  const sampleRate = samples[0]?.audio.sampleRate ?? 24000;
  const quiet = (sec: number) => new Float32Array(Math.round(sec * sampleRate));
  const legend: ReelEntry[] = [];
  const parts: Float32Array[] = [];
  let at = 0;
  const push = (a: Float32Array) => { parts.push(a); at += a.length; };
  for (const [i, s] of samples.entries()) {
    if (i > 0) push(quiet(gap));
    const start = at / sampleRate;
    if (s.slate) { push(resampleTo(s.slate, sampleRate)); push(quiet(afterSlate)); }
    legend.push({ id: s.id, start, seconds: s.audio.samples.length / sampleRate, voice: s.voice, approved: approved.has(s.id), ...(s.name ? { name: s.name } : {}), ...(s.source ? { source: s.source } : {}), ...(s.description ? { description: s.description } : {}) });
    push(resampleTo(s.audio, sampleRate));
  }
  const audio = new Float32Array(at);
  let o = 0;
  for (const p of parts) { audio.set(p, o); o += p.length; }
  return { audio, sampleRate, legend };
}

// Every voice in one reel shares a sample rate (Gemini's is 24 kHz; resample anything else).
function resampleTo(a: { samples: Float32Array; sampleRate: number }, rate: number): Float32Array {
  if (a.sampleRate === rate) return a.samples;
  const ratio = a.sampleRate / rate;
  const out = new Float32Array(Math.floor(a.samples.length / ratio));
  for (let i = 0; i < out.length; i++) out[i] = a.samples[Math.min(a.samples.length - 1, Math.round(i * ratio))];
  return out;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function formatLegend(legend: ReelEntry[], names: Record<string, string> = {}): string {
  return legend.map((e) => {
    const head = `${clock(e.start)}  ${e.approved ? "✓ " : ""}${names[e.id] ?? e.name ?? e.id} (voice:${e.id}) — ${e.voice}${e.source === "audition" ? " — audition line, not from the story" : ""}`;
    return e.description ? `${head}\n       ${e.description}` : head;
  }).join("\n");
}

// The reel's cast list for people outside the production: who speaks when.
export function formatShareList(legend: ReelEntry[], narrated: string[] = []): string {
  return [
    "Voice casting",
    "",
    ...legend.map((e) => `${clock(e.start)}  ${e.name ?? e.id}${e.source === "audition" ? " (a test line, not from the story)" : ""}`),
    ...(narrated.length ? ["", `Read by the narrator, in character: ${narrated.join(", ")}`] : [])
  ].join("\n");
}

// Builds the review files for one phase; returns their paths and, for voices, the legend.
export async function buildReview(runDir: string, kind: ReviewKind): Promise<{ files: string[]; legend?: string }> {
  const outDir = join(runDir, "review");
  await mkdir(outDir, { recursive: true });
  const approvals = await readApprovals(runDir);
  if (kind === "music") {
    // Every clean cue in order, theme first, a second apart.
    let index: Record<string, { file: string; model: string; takes: number; clean: boolean }> = {};
    try { index = JSON.parse(await readFile(join(runDir, "music", "cues.json"), "utf8")); } catch { throw new Error(`no music in ${join(runDir, "music")} — run make --only music first`); }
    const ids = Object.keys(index).filter((id) => index[id].clean).sort((a, b) => (a === "theme" ? -1 : b === "theme" ? 1 : a.localeCompare(b)));
    if (ids.length === 0) throw new Error("no clean cues to review");
    const legend: string[] = [];
    let at = 0;
    for (const id of ids) {
      const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(runDir, index[id].file)]);
      legend.push(`${clock(at)}  ${id} — ${index[id].model}, ${index[id].takes} take${index[id].takes === 1 ? "" : "s"}`);
      at += Number(stdout.trim()) + 1;
    }
    const inputs = ids.flatMap((id) => ["-i", join(runDir, index[id].file)]);
    const graph = ids.map((_, k) => `[${k}:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=pad_dur=1[c${k}]`).join(";") + `;${ids.map((_, k) => `[c${k}]`).join("")}concat=n=${ids.length}:v=0:a=1[out]`;
    const mp3 = join(outDir, "music.mp3");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", graph, "-map", "[out]", "-codec:a", "libmp3lame", "-q:a", "4", mp3]);
    await writeFile(join(outDir, "music.txt"), legend.join("\n") + "\n");
    return { files: [mp3], legend: legend.join("\n") };
  }
  if (kind === "voices") {
    const dir = join(runDir, "audiobook", "samples");
    let index: Record<string, SampleIndexEntry> = {};
    try { index = JSON.parse(await readFile(join(dir, "samples.json"), "utf8")); } catch { throw new Error(`no voice samples in ${dir} — run make --only voices first`); }
    const bible = voicedBible(await new EventLog(runDir).load());
    // In the order the voices phase set: the narrator, then whoever speaks most.
    const ids = Object.keys(index).sort((a, b) => (index[a].order ?? 999) - (index[b].order ?? 999) || a.localeCompare(b));
    const wav = async (f: string) => readFile(f).then((b) => decodeWav(b), () => undefined);
    const samples: ReelSample[] = [];
    for (const id of ids) {
      const audio = await wav(join(dir, `${id}.wav`));
      if (!audio) continue;
      const slate = await wav(join(dir, "slates", `${id}.wav`));
      const description = id === "narrator" ? undefined : [bible.characters[id]?.vocal, bible.characters[id]?.traits, bible.characters[id]?.voice].find((d) => d?.trim());
      samples.push({ id, voice: index[id].voice, audio, ...(slate ? { slate } : {}), ...(index[id].name ? { name: index[id].name } : {}), ...(index[id].source ? { source: index[id].source } : {}), ...(description ? { description } : {}) });
    }
    const reel = buildReel(samples, new Set(approvals.voices));
    const wavFile = join(outDir, "voices.wav");
    await writeFile(wavFile, encodeWav(reel.audio, reel.sampleRate));
    const mp3 = join(outDir, "voices.mp3");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wavFile, "-codec:a", "libmp3lame", "-q:a", "4", mp3]);
    await rm(wavFile, { force: true });
    // And one file per voice, numbered in reel order, to skip around on a phone.
    const each = join(outDir, "voices");
    await rm(each, { recursive: true, force: true });  // no files left over from voices no longer cast
    await mkdir(each, { recursive: true });
    for (const [n, s] of samples.entries()) {
      const one = buildReel([s], new Set(approvals.voices));
      const file = join(each, `${String(n + 1).padStart(2, "0")}-${s.id}-${s.voice}`);
      await writeFile(`${file}.wav`, encodeWav(one.audio, one.sampleRate));
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", `${file}.wav`, "-codec:a", "libmp3lame", "-q:a", "4", `${file}.mp3`]);
      await rm(`${file}.wav`);
    }
    let narrated: { id: string; name: string }[] = [];
    try { narrated = JSON.parse(await readFile(join(dir, "narrated.json"), "utf8")); } catch { /* samples made before #105 */ }
    const legend = formatLegend(reel.legend) + (narrated.length ? `\n\nRead by the narrator, in character (too little to cast): ${narrated.map((n) => n.name).join(", ")}` : "");
    await writeFile(join(outDir, "voices.txt"), legend + "\n");
    // The same, for sharing: names and times only.
    await writeFile(join(outDir, "voices-share.txt"), formatShareList(reel.legend, narrated.map((n) => n.name)) + "\n");
    return { files: [mp3], legend };
  }
  const artDir = join(runDir, "art");
  let manifest: ArtManifest;
  try { manifest = JSON.parse(await readFile(join(artDir, "art.json"), "utf8")); } catch { throw new Error(`no images in ${artDir} — run make --only ${kind === "refs" ? "refs" : kind === "extras" ? "extras" : "art"} first`); }
  const present = new Set(await readdir(artDir));
  for (const k of Object.keys(manifest)) if (!present.has(manifest[k].file)) delete manifest[k];
  const files: string[] = [];
  const stale = kind === "shots" ? new Set((await staleShots(await new EventLog(runDir).load(), runDir)).map((s) => s.key)) : new Set<string>();
  for (const [name, tiles] of contactSheets(manifest, kind, new Set(approvals.art), artDir, stale)) {
    const out = join(outDir, `${name}.jpg`);
    await run("magick", montageArgs(tiles, out));
    files.push(out);
  }
  if (files.length === 0) throw new Error(`no ${kind} images yet in ${artDir}`);
  return { files };
}
