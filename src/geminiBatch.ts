import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildTtsPrompt, decodeWav } from "./geminiTts.ts";
import type { Speak } from "./geminiTts.ts";
import { maxLineSeconds, resample } from "./audiobook.ts";

// Batched Gemini voicing. Gemini TTS allows few requests (Tier 1: 10 a minute,
// 100 a day), so instead of one request per line, a speaker's lines go in one
// request, separated by long pauses, and the audio is cut back into lines at
// the longest silences. Three modes, from best to fewest requests:
//   line    — one request per line, with that line's own direction (the default)
//   palette — one request per speaker and tone, from a small per-speaker tone palette
//   speaker — one request per speaker, no direction
export const GEMINI_MODES = ["line", "palette", "speaker"] as const;
export type GeminiMode = (typeof GEMINI_MODES)[number];

export interface BatchPiece {
  order: number;    // position in the scene's voicing order
  speaker: string;
  text: string;
  tone?: string;    // palette mode: the tone this line is performed in
}

export interface Batch {
  speaker: string;
  tone?: string;
  pieces: BatchPiece[];
}

// Groups pieces by speaker (and tone), in story order, capped so one request's
// audio stays a few minutes long and a failed batch is cheap to redo.
export function planBatches(pieces: BatchPiece[], maxChars = 1400, maxLines = 12, maxNarratorLines = 8): Batch[] {
  const groups = new Map<string, Batch[]>();
  const out: Batch[] = [];
  for (const p of pieces) {
    const key = `${p.speaker}\u0000${p.tone ?? ""}`;
    const list = groups.get(key) ?? groups.set(key, []).get(key)!;
    let current = list.at(-1);
    const size = current ? current.pieces.reduce((n, x) => n + x.text.length, 0) : 0;
    const cap = p.speaker === "narrator" ? Math.min(maxLines, maxNarratorLines) : maxLines;
    if (!current || current.pieces.length >= cap || size + p.text.length > maxChars) {
      current = { speaker: p.speaker, ...(p.tone ? { tone: p.tone } : {}), pieces: [] };
      list.push(current);
      out.push(current);
    }
    current.pieces.push(p);
  }
  return out;
}

export const BATCH_PAUSE_NOTE = "These are separate lines, not one speech. After each line, stop and stay completely silent for two full seconds before the next line.";

export function batchPrompt(batch: Batch, who: { name: string; profile: string }): string {
  return buildTtsPrompt({
    name: who.name,
    profile: who.profile,
    notes: [batch.tone ? `Perform every line ${batch.tone}.` : "", BATCH_PAUSE_NOTE].filter(Boolean).join(" "),
    line: batch.pieces.map((p) => p.text).join("\n\n")
  });
}

// Frame loudness and the silences inside the speech (not the padding at either end).
function silences(samples: Float32Array, rate: number): { frame: number; first: number; last: number; runs: { start: number; end: number }[] } {
  const frame = Math.max(1, Math.round(rate * 0.02));
  const rms: number[] = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let k = i; k < end; k++) sum += samples[k] * samples[k];
    rms.push(Math.sqrt(sum / Math.max(1, end - i)));
  }
  const peak = Math.max(...rms, 1e-9);
  const quiet = (v: number) => v < Math.max(1e-4, peak * 0.03);
  const first = rms.findIndex((v) => !quiet(v));
  const last = rms.length - 1 - [...rms].reverse().findIndex((v) => !quiet(v));
  const runs: { start: number; end: number }[] = [];
  let runStart = -1;
  rms.forEach((v, f) => {
    if (quiet(v)) { if (runStart < 0) runStart = f; }
    else if (runStart >= 0) { runs.push({ start: runStart, end: f }); runStart = -1; }
  });
  return { frame, first, last, runs: runs.filter((r) => r.start > first && r.end <= last && (r.end - r.start) * frame >= rate * 0.12) };
}

// How long a line takes to say is roughly proportional to its letters.
const sayable = (t: string) => Math.max(1, t.replace(/[^\p{L}\p{N}]/gu, "").length);

// Cuts a batch's audio into its lines. Each candidate cut is a silence inside the
// speech; the chosen cuts are the ones whose pieces best match each line's
// expected length (from its letters and the take's own pace), with a bonus for
// longer silences. So a short line can't swallow a long one, and a long dramatic
// pause inside a line isn't mistaken for a boundary. Undefined when there are
// fewer silences than boundaries.
export function splitOnSilences(samples: Float32Array, rate: number, count: number, texts?: string[]): Float32Array[] | undefined {
  if (count <= 1) return [trimSilence(samples, rate)];
  const { frame, first, last, runs } = silences(samples, rate);
  if (runs.length < count - 1 || first < 0) return undefined;
  const sec = (frames: number) => (frames * frame) / rate;
  const total = sec(last + 1 - first);
  const lens = runs.map((r) => sec(r.end - r.start));
  // Pause estimate: the typical length of the count-1 longest silences.
  const gap = [...lens].sort((a, b) => b - a).slice(0, count - 1).reduce((a, b) => a + b, 0) / (count - 1);
  const weights = (texts ?? Array(count).fill("x")).map(sayable);
  const pace = Math.max(0.01, (total - gap * (count - 1)) / weights.reduce((a, b) => a + b, 0));
  const expected = weights.map((w, i) => w * pace + gap * ((i === 0 || i === count - 1) ? 0.5 : 1));
  const mids = runs.map((r) => sec((r.start + r.end) / 2 - first));
  // cost[k][j]: best cost of the first k+1 pieces, with cut k at silence j.
  const pieceCost = (d: number, i: number) => ((d - expected[i]) / Math.max(expected[i], 0.6)) ** 2;
  const bonus = (j: number) => 0.15 * Math.min(lens[j], 2.5);
  const M = runs.length;
  const cost: number[][] = [];
  const from: number[][] = [];
  for (let k = 0; k < count - 1; k++) {
    cost.push(Array(M).fill(Infinity));
    from.push(Array(M).fill(-1));
    for (let j = k; j < M - (count - 2 - k); j++) {
      if (k === 0) { cost[k][j] = pieceCost(mids[j], 0) - bonus(j); continue; }
      for (let i = k - 1; i < j; i++) {
        if (cost[k - 1][i] === Infinity) continue;
        const c = cost[k - 1][i] + pieceCost(mids[j] - mids[i], k) - bonus(j);
        if (c < cost[k][j]) { cost[k][j] = c; from[k][j] = i; }
      }
    }
  }
  let best = -1;
  let bestCost = Infinity;
  for (let j = count - 2; j < M; j++) {
    const c = cost[count - 2][j] + pieceCost(total - mids[j], count - 1);
    if (c < bestCost) { bestCost = c; best = j; }
  }
  if (best < 0) return undefined;
  const chosen: number[] = [];
  for (let k = count - 2, j = best; k >= 0; j = from[k][j], k--) chosen.unshift(j);
  const cuts = chosen.map((j) => Math.round(((runs[j].start + runs[j].end) / 2) * frame));
  const bounds = [0, ...cuts, samples.length];
  return bounds.slice(1).map((end, i) => trimSilence(samples.subarray(bounds[i], end), rate));
}

function trimSilence(s: Float32Array, rate: number): Float32Array {
  const peak = s.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const floor = Math.max(1e-3, peak * 0.03);
  let a = 0;
  let b = s.length - 1;
  while (a < b && Math.abs(s[a]) < floor) a++;
  while (b > a && Math.abs(s[b]) < floor) b--;
  const pad = Math.round(rate * 0.08);
  return s.slice(Math.max(0, a - pad), Math.min(s.length, b + 1 + pad));
}

// Why a split can't be trusted, or undefined: every piece must be a plausible
// length for its words — not longer than the line could take (the model read
// something else too), and not so short it must be a fragment of another line.
export function splitProblem(pieces: Float32Array[], texts: string[], rate: number): string | undefined {
  for (const [i, p] of pieces.entries()) {
    const secs = p.length / rate;
    const words = texts[i].split(/\s+/).filter(Boolean).length;
    if (secs > maxLineSeconds(texts[i])) return `line ${i + 1} runs ${secs.toFixed(1)}s for ${words} words`;
    if (secs < Math.min(0.4, words * 0.12)) return `line ${i + 1} is only ${secs.toFixed(1)}s for ${words} words`;
  }
  return undefined;
}

// ---- batch cache: a take is paid for once ----
// Each take that cuts cleanly is kept, keyed by exactly what was asked (prompt,
// voice, model). A re-run — after a quota stop, a crash, or a change elsewhere in
// the story — cuts the kept take again instead of asking Gemini again.
export interface BatchCache {
  get(key: string): Promise<Float32Array | undefined>;
  put(key: string, samples: Float32Array): Promise<void>;
}

export function batchKey(prompt: string, voice: string, model: string): string {
  return createHash("sha1").update(JSON.stringify({ prompt, voice, model })).digest("hex");
}

// Takes as 16-bit WAV files (playable) under `dir`.
export function fileBatchCache(dir: string, rate: number): BatchCache {
  return {
    async get(key) {
      try {
        const { samples, sampleRate } = decodeWav(await readFile(join(dir, `${key}.wav`)));
        return resample(samples, sampleRate, rate);
      } catch { return undefined; }
    },
    async put(key, samples) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${key}.wav`), encodeWav(samples, rate));
    }
  };
}

export function encodeWav(samples: Float32Array, rate: number): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Voices a batch and cuts it into its lines (at `rate`), redoing the request
// when the cut doesn't hold up. Throws after `attempts` tries; the caller then
// voices those lines one by one.
export async function voiceBatch(
  speak: Speak, batch: Batch, voice: string, who: { name: string; profile: string }, rate: number, attempts = 3,
  opts: { cache?: BatchCache; model?: string; onCached?: () => void } = {}
): Promise<Float32Array[]> {
  const prompt = batchPrompt(batch, who);
  const texts = batch.pieces.map((p) => p.text);
  const key = batchKey(prompt, voice, opts.model ?? "");
  const cut = (samples: Float32Array): { pieces?: Float32Array[]; problem: string } => {
    const pieces = splitOnSilences(samples, rate, texts.length, texts);
    if (!pieces) return { problem: `found fewer than ${texts.length - 1} pauses between ${texts.length} lines` };
    const problem = splitProblem(pieces, texts, rate) ?? "";
    return problem ? { problem } : { pieces, problem };
  };
  const kept = opts.cache ? await opts.cache.get(key) : undefined;
  if (kept) {
    const { pieces } = cut(kept);
    if (pieces) { opts.onCached?.(); return pieces; }
  }
  let problem = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await speak(prompt, voice);
    const samples = resample(r.samples, r.sampleRate, rate);
    const result = cut(samples);
    problem = result.problem;
    if (result.pieces) {
      await opts.cache?.put(key, samples);
      return result.pieces;
    }
  }
  throw new Error(`batch of ${texts.length} lines for ${batch.speaker}${batch.tone ? ` (${batch.tone})` : ""}: ${problem}`);
}
