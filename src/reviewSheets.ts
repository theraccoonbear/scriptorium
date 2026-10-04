import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { readApprovals } from "./approvals.ts";
import { decodeWav } from "./geminiTts.ts";
import { encodeWav } from "./geminiBatch.ts";
import type { ArtManifest } from "./artist.ts";

// Review sheets for the author, one file per phase in <run>/review/, small
// enough to send to a phone: a labeled contact sheet of the reference
// portraits or of each scene's shots, and one reel of every voice sample with
// a legend of who speaks when. Approved work is marked ✓.

const run = promisify(execFile);
export type ReviewKind = "refs" | "shots" | "voices";
export const REVIEW_KINDS: readonly ReviewKind[] = ["refs", "shots", "voices"];

export interface SheetTile { label: string; file: string }

// The tiles of each contact sheet: one for the references, one per scene of
// shots (the cover with the last), in art.json order.
export function contactSheets(manifest: ArtManifest, kind: "refs" | "shots", approved: ReadonlySet<string>, artDir: string): Map<string, SheetTile[]> {
  const sheets = new Map<string, SheetTile[]>();
  const tile = (key: string): SheetTile => ({ label: `${approved.has(key) ? "✓ " : ""}${key}`, file: join(artDir, manifest[key].file) });
  const keys = Object.keys(manifest);
  if (kind === "refs") {
    const refs = keys.filter((k) => manifest[k].refKind).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    if (refs.length) sheets.set("refs", refs.map(tile));
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

function order(key: string): number {
  return key.startsWith("character-") ? 0 : key.startsWith("location-") ? 1 : 2;
}

// ImageMagick montage arguments: each tile labeled, four across.
export function montageArgs(tiles: SheetTile[], out: string): string[] {
  return ["montage", ...tiles.flatMap((t) => ["-label", t.label, t.file]), "-tile", `${Math.min(4, tiles.length)}x`, "-geometry", "480x480>+8+8", "-pointsize", "18", "-background", "#1e1e1e", "-fill", "#f0f0f0", out];
}

export interface ReelEntry { id: string; start: number; seconds: number; voice: string; approved: boolean }

// One WAV of every sample (narrator first), a second of silence between.
export function buildReel(samples: { id: string; voice: string; audio: { samples: Float32Array; sampleRate: number } }[], approved: ReadonlySet<string>, gap = 1): { audio: Float32Array; sampleRate: number; legend: ReelEntry[] } {
  const sampleRate = samples[0]?.audio.sampleRate ?? 24000;
  const silence = Math.round(gap * sampleRate);
  const legend: ReelEntry[] = [];
  const parts: Float32Array[] = [];
  let at = 0;
  for (const [i, s] of samples.entries()) {
    if (i > 0) { parts.push(new Float32Array(silence)); at += silence; }
    legend.push({ id: s.id, start: at / sampleRate, seconds: s.audio.samples.length / sampleRate, voice: s.voice, approved: approved.has(s.id) });
    parts.push(s.audio.samples);
    at += s.audio.samples.length;
  }
  const audio = new Float32Array(at);
  let o = 0;
  for (const p of parts) { audio.set(p, o); o += p.length; }
  return { audio, sampleRate, legend };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function formatLegend(legend: ReelEntry[], names: Record<string, string> = {}): string {
  return legend.map((e) => `${clock(e.start)}  ${e.approved ? "✓ " : ""}${names[e.id] ?? e.id} — ${e.voice}`).join("\n");
}

// Builds the review files for one phase; returns their paths and, for voices, the legend.
export async function buildReview(runDir: string, kind: ReviewKind): Promise<{ files: string[]; legend?: string }> {
  const outDir = join(runDir, "review");
  await mkdir(outDir, { recursive: true });
  const approvals = await readApprovals(runDir);
  if (kind === "voices") {
    const dir = join(runDir, "audiobook", "samples");
    let index: Record<string, { voice: string; text: string }> = {};
    try { index = JSON.parse(await readFile(join(dir, "samples.json"), "utf8")); } catch { throw new Error(`no voice samples in ${dir} — run make --only voices first`); }
    const ids = Object.keys(index).sort((a, b) => (a === "narrator" ? -1 : b === "narrator" ? 1 : a.localeCompare(b)));
    const samples = await Promise.all(ids.map(async (id) => ({ id, voice: index[id].voice, audio: decodeWav(await readFile(join(dir, `${id}.wav`))) })));
    const reel = buildReel(samples, new Set(approvals.voices));
    const wav = join(outDir, "voices.wav");
    await writeFile(wav, encodeWav(reel.audio, reel.sampleRate));
    const mp3 = join(outDir, "voices.mp3");
    await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "4", mp3]);
    const legend = formatLegend(reel.legend);
    await writeFile(join(outDir, "voices.txt"), legend + "\n");
    return { files: [mp3], legend };
  }
  const artDir = join(runDir, "art");
  let manifest: ArtManifest;
  try { manifest = JSON.parse(await readFile(join(artDir, "art.json"), "utf8")); } catch { throw new Error(`no images in ${artDir} — run make --only ${kind === "refs" ? "refs" : "art"} first`); }
  const present = new Set(await readdir(artDir));
  for (const k of Object.keys(manifest)) if (!present.has(manifest[k].file)) delete manifest[k];
  const files: string[] = [];
  for (const [name, tiles] of contactSheets(manifest, kind, new Set(approvals.art), artDir)) {
    const out = join(outDir, `${name}.jpg`);
    await run("magick", montageArgs(tiles, out));
    files.push(out);
  }
  if (files.length === 0) throw new Error(`no ${kind} images yet in ${artDir}`);
  return { files };
}
