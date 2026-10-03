import { buildTtsPrompt } from "./geminiTts.ts";
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
export function planBatches(pieces: BatchPiece[], maxChars = 1400, maxLines = 16): Batch[] {
  const groups = new Map<string, Batch[]>();
  const out: Batch[] = [];
  for (const p of pieces) {
    const key = `${p.speaker}\u0000${p.tone ?? ""}`;
    const list = groups.get(key) ?? groups.set(key, []).get(key)!;
    let current = list.at(-1);
    const size = current ? current.pieces.reduce((n, x) => n + x.text.length, 0) : 0;
    if (!current || current.pieces.length >= maxLines || size + p.text.length > maxChars) {
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

// Cuts audio into `count` pieces at the count-1 longest silences, each piece
// trimmed of leading and trailing silence (keeping a short pad). A dramatic
// pause inside a line is shorter than the requested two-second gap, so it is
// never chosen over a real boundary. Undefined when there aren't enough silences.
export function splitOnSilences(samples: Float32Array, rate: number, count: number): Float32Array[] | undefined {
  if (count <= 1) return [trimSilence(samples, rate)];
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
  const runs: { start: number; end: number }[] = [];
  let runStart = -1;
  rms.forEach((v, f) => {
    if (quiet(v)) { if (runStart < 0) runStart = f; }
    else if (runStart >= 0) { runs.push({ start: runStart, end: f }); runStart = -1; }
  });
  // Silences at the very start and end are padding, not boundaries.
  const firstSound = rms.findIndex((v) => !quiet(v));
  const lastSound = rms.length - 1 - [...rms].reverse().findIndex((v) => !quiet(v));
  const inner = runs.filter((r) => r.start > firstSound && r.end <= lastSound && (r.end - r.start) * frame >= rate * 0.25);
  if (inner.length < count - 1) return undefined;
  const cuts = [...inner].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, count - 1)
    .sort((a, b) => a.start - b.start)
    .map((r) => Math.round(((r.start + r.end) / 2) * frame));
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

// Voices a batch and cuts it into its lines (at `rate`), redoing the request
// when the cut doesn't hold up. Throws after `attempts` tries; the caller then
// voices those lines one by one.
export async function voiceBatch(speak: Speak, batch: Batch, voice: string, who: { name: string; profile: string }, rate: number, attempts = 3): Promise<Float32Array[]> {
  const prompt = batchPrompt(batch, who);
  const texts = batch.pieces.map((p) => p.text);
  let problem = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await speak(prompt, voice);
    const samples = resample(r.samples, r.sampleRate, rate);
    const pieces = splitOnSilences(samples, rate, texts.length);
    if (!pieces) { problem = `found fewer than ${texts.length - 1} pauses between ${texts.length} lines`; continue; }
    problem = splitProblem(pieces, texts, rate) ?? "";
    if (!problem) return pieces;
  }
  throw new Error(`batch of ${texts.length} lines for ${batch.speaker}${batch.tone ? ` (${batch.tone})` : ""}: ${problem}`);
}
