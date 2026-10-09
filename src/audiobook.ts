// Turns a run's committed scenes into audio. Two shapes of input, one tool:
// - Untagged prose (speakerTags off, or any pre-existing run): one narrator
//   voice reads the whole scene.
// - Tagged prose (speakerTags on, see src/roles.ts write()): paragraphs start
//   with `narrator:` or a bible character id, and each speaker gets their own
//   voice. Detection is per scene, not per run — a run can mix both.
import { createHash } from "node:crypto";
import type { Pronunciations } from "./geminiTts.ts";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { replay } from "./bible.ts";
import { batchKey, fileBatchCache, planBatches, voiceBatch } from "./geminiBatch.ts";
import type { Batch, BatchCache, BatchPiece, GeminiMode } from "./geminiBatch.ts";
import { paletteToneFor } from "./tagging.ts";
import type { TonePaletteData } from "./tagging.ts";
import { applyTags, performed, renderScript, sceneTags, speakerAliases, taggedCharacters, vocalTags, voicingProblems } from "./tagging.ts";
import type { VocalTag } from "./tagging.ts";
import { buildTtsPrompt, DEFAULT_GEMINI_TTS_MODEL, GEMINI_VOICES, geminiSpeaker } from "./geminiTts.ts";
import type { SpeechInput, SpeechPart } from "./geminiTts.ts";
import type { CheckReport } from "./speechCheck.ts";
import { speechCheckRound } from "./rounds.ts";
import type { Speak } from "./geminiTts.ts";
import { geminiBatchSpeaker, isTtsRateLimit, readsVerbatim } from "./geminiTts.ts";
import { geminiBatchJobs } from "./batchJobs.ts";
import { isBudgetError } from "./usage.ts";
import type { Bible, SceneCommittedData, StoryEvent } from "./types.ts";

const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// Where downloaded TTS models live. transformers.js defaults to a folder inside
// its own node_modules package, so every checkout (and every fresh install)
// re-downloads the model; one shared folder outside the repo avoids that.
export function modelCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SCRIPTORIUM_MODEL_CACHE || join(env.XDG_CACHE_HOME || join(homedir(), ".cache"), "scriptorium", "models");
}
const SAMPLE_RATE = 24000;

export interface SpeakerSegment {
  speaker: string; // "narrator" or a bible character id
  text: string;
  // Scene paragraph index (see sceneParagraphs) of each "\n\n"-separated piece
  // of `text`, so audio timings can be mapped back to paragraphs.
  paragraphs: number[];
}

export interface Scene {
  index: number;
  tagged: boolean;
  segments: SpeakerSegment[];
  // How a paragraph's speaker performs it (from the voice director), by paragraph index.
  delivery?: Record<number, { speaker: string; note: string }>;
  // Sounds to perform in a paragraph's spoken words (#71), by paragraph index.
  vocal?: Record<number, { speaker: string; tags: VocalTag[] }>;
}

const TAG_LINE = /^([a-z][a-z0-9_]*):\s+([\s\S]+)$/;

function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/(?<![a-zA-Z0-9])_(.*?)_(?![a-zA-Z0-9])/g, "$1");
}

// Consecutive same-speaker paragraphs become one TTS call instead of many —
// fewer seams in the audio, fewer round trips through the model.
function mergeConsecutive(segments: SpeakerSegment[]): SpeakerSegment[] {
  const merged: SpeakerSegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (last && last.speaker === seg.speaker) {
      last.text = `${last.text}\n\n${seg.text}`;
      last.paragraphs = [...last.paragraphs, ...seg.paragraphs];
    } else {
      merged.push({ ...seg, paragraphs: [...seg.paragraphs] });
    }
  }
  return merged;
}

// Attribution ("Riggins said", "she whispered") is never inside the quote
// marks — that boundary already exists unambiguously in standard prose, so
// there is no need for a human or an LLM to pre-split narration from dialogue
// by hand. A paragraph tagged for a character still gets its unquoted spans
// (action, attribution) read by the narrator; only the quoted spans are
// voiced as that character. Quotes are paired by position, not nesting —
// adequate for standard double-quoted dialogue, not for quotes-within-quotes.
// A `"` straight after a digit is an inch mark (4'8", a 7" bell), not a quote.
function quoteMark(text: string, from: number): number {
  for (let k = text.indexOf('"', from); k !== -1; k = text.indexOf('"', k + 1)) {
    if (!/\d/.test(text[k - 1] ?? "")) return k;
  }
  return -1;
}

// A quote with nothing speakable in it ("" or "—") is not a line.
const speakable = (t: string) => /[\p{L}\p{N}]/u.test(t);

function splitByQuotes(speaker: string, text: string, paragraph: number): SpeakerSegment[] {
  const parts: Array<{ speaker: string; text: string }> = [];
  let i = 0;
  while (i < text.length) {
    const open = quoteMark(text, i);
    if (open === -1) {
      parts.push({ speaker: "narrator", text: text.slice(i) });
      break;
    }
    if (open > i) parts.push({ speaker: "narrator", text: text.slice(i, open) });
    const close = quoteMark(text, open + 1);
    if (close === -1) {
      // Unterminated quote (truncated draft) — treat the rest as spoken rather than drop it.
      parts.push({ speaker, text: text.slice(open) });
      break;
    }
    parts.push({ speaker, text: text.slice(open, close + 1) });
    i = close + 1;
  }
  return parts
    .map((p) => ({ ...p, text: p.text.trim(), paragraphs: [paragraph] }))
    .filter((p) => speakable(p.text));
}

// The book-markdown renderer for tagged prose: strip the leading `speaker: `
// off each paragraph and nothing else — the prose underneath was never
// altered to make it audio-ready, so recovering reader-facing text needs no
// reconstruction (no re-inserted attribution, no reflowed paragraphs).
// Untagged prose (speakerTags off) passes through unchanged.
export function stripSpeakerTags(prose: string, knownSpeakers: ReadonlySet<string>): string {
  return prose
    .split(/\n{2,}/)
    .map((para) => {
      const trimmed = para.trim();
      const m = trimmed.match(TAG_LINE);
      if (m && (m[1] === "narrator" || knownSpeakers.has(m[1]))) {
        return m[2].trim();
      }
      return para;
    })
    .join("\n\n");
}

// Non-blocking: flags paragraphs that don't start with a known tag so a
// speakerTags run can be checked for writer compliance without a full gate.
// parseScene already falls back such paragraphs to narrator, so this never
// breaks a run — it's a quality signal, not a correctness requirement.
export function findUntaggedParagraphs(prose: string, knownSpeakers: ReadonlySet<string>): string[] {
  return prose
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .filter((para) => {
      const m = para.match(TAG_LINE);
      return !(m && (m[1] === "narrator" || knownSpeakers.has(m[1])));
    });
}

function rawParagraphs(prose: string): string[] {
  return prose.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map(stripMarkdown);
}

// The scene's paragraphs as read aloud, speaker tags removed. This numbering is
// shared by the art director (shots anchor to a paragraph) and the audiobook
// (timings.json gives each paragraph's start time), so the two line up.
export function sceneParagraphs(prose: string, knownSpeakers: ReadonlySet<string>): string[] {
  return rawParagraphs(prose).map((para) => {
    const m = para.match(TAG_LINE);
    return m && (m[1] === "narrator" || knownSpeakers.has(m[1])) ? m[2].trim() : para;
  });
}

export function parseScene(index: number, prose: string, knownSpeakers: ReadonlySet<string>): Scene {
  const paragraphs = rawParagraphs(prose);
  const segments: SpeakerSegment[] = [];
  let tagged = false;
  for (const [p, para] of paragraphs.entries()) {
    const m = para.match(TAG_LINE);
    if (m && m[1] === "narrator") {
      tagged = true;
      segments.push({ speaker: "narrator", text: m[2].trim(), paragraphs: [p] });
    } else if (m && knownSpeakers.has(m[1])) {
      tagged = true;
      segments.push(...splitByQuotes(m[1], m[2].trim(), p));
    } else {
      segments.push({ speaker: "narrator", text: para, paragraphs: [p] });
    }
  }
  if (!tagged) {
    return { index, tagged: false, segments: [{ speaker: "narrator", text: paragraphs.join("\n\n"), paragraphs: paragraphs.map((_, p) => p) }] };
  }
  return { index, tagged: true, segments: mergeConsecutive(segments) };
}

// FNV-1a — fast, stable across runs/platforms, good enough dispersion for a
// cast list of a handful to a few dozen characters.
function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export interface VoiceAssignment {
  narrator: string;
  characters: Record<string, string>;
  // Gemini voices, when narration or dialogue is voiced by Gemini TTS.
  gemini?: { narrator: string; characters: Record<string, string> };
  // The gender each character's voice was matched to (absent = any voice).
  genders: Record<string, Gender>;
}

export type Gender = "female" | "male";

// Maps free-text gender (bible field, CLI flag, Kokoro's "Female"/"Male") to
// the two voice pools. Anything else is unspecified: any voice will do.
export function normalizeGender(value: string | undefined): Gender | undefined {
  const v = (value ?? "").trim().toLowerCase();
  if (["female", "f", "woman", "girl"].includes(v)) return "female";
  if (["male", "m", "man", "boy"].includes(v)) return "male";
  return undefined;
}

export interface VoiceGenderOptions {
  genders?: Readonly<Record<string, string | undefined>>;      // character id -> gender
  voiceGenders?: Readonly<Record<string, string | undefined>>; // voice id -> gender
  pinned?: Readonly<Record<string, string>>;                    // character id -> voice the author chose
}

export function assignVoices(
  characterIds: readonly string[],
  voices: readonly string[],
  narratorVoice?: string,
  { genders = {}, voiceGenders = {}, pinned = {} }: VoiceGenderOptions = {}
): VoiceAssignment {
  if (voices.length === 0) throw new Error("no voices available to assign");
  const narrator = narratorVoice && voices.includes(narratorVoice) ? narratorVoice : voices[0];
  const pool = voices.filter((v) => v !== narrator);
  const available = pool.length > 0 ? pool : voices;
  const byGender = (g: Gender) => available.filter((v) => normalizeGender(voiceGenders[v]) === g);
  const used = new Set<string>();
  const characters: Record<string, string> = {};
  const matched: Record<string, Gender> = {};
  // The author's choices go first, so no one else is handed those voices.
  for (const id of characterIds) {
    if (pinned[id]) {
      characters[id] = pinned[id];
      used.add(pinned[id]);
    }
  }
  // Characters with a known gender pick first so unspecified ones can't use up
  // the smaller same-gender pool; order within each group stays sorted.
  const ids = [...characterIds].sort();
  const ordered = [...ids.filter((id) => normalizeGender(genders[id])), ...ids.filter((id) => !normalizeGender(genders[id]))];
  for (const id of ordered) {
    if (characters[id]) continue;
    const gender = normalizeGender(genders[id]);
    const gendered = gender ? byGender(gender) : [];
    // No voice of that gender in this language: any voice beats none.
    const candidates = gendered.length > 0 ? gendered : available;
    if (gender && gendered.length > 0) matched[id] = gender;
    const base = hashString(id) % candidates.length;
    // First unused voice from the base; if the pool is exhausted, share one
    // (a matching gender matters more than a unique voice).
    let assigned = candidates[base];
    for (let offset = 0; used.has(assigned) && offset < candidates.length; offset++) {
      assigned = candidates[(base + offset + 1) % candidates.length];
    }
    if (used.has(assigned)) assigned = candidates[base];
    used.add(assigned);
    characters[id] = assigned;
  }
  return { narrator, characters, genders: matched };
}

// Kokoro is multi-lingual: each voice is paired with a specific language's
// phonemizer (the id's prefix — af/am = American English, bf/bm = British
// English, jf/jm = Japanese, zf/zm = Mandarin, etc). Feeding English text
// through a voice tagged for another language runs it through that
// language's phonemization rules, producing garbled, mispronounced output —
// not an accent, just the wrong letter-to-sound mapping. Filter to the
// requested language's voices before assigning any.
// Curate Kokoro's voices: an include list wins; otherwise drop the excluded ones.
export function curateVoices(voiceIds: string[], curation: { include?: string[]; exclude?: string[] } = {}): string[] {
  if (curation.include?.length) return voiceIds.filter((v) => curation.include!.includes(v));
  return voiceIds.filter((v) => !curation.exclude?.includes(v));
}

export function filterVoicesByLanguage(
  voices: Readonly<Record<string, { language: string }>>,
  languagePrefix: string
): string[] {
  return Object.entries(voices)
    .filter(([, v]) => v.language.startsWith(languagePrefix))
    .map(([id]) => id);
}

// The run's scenes as the audiobook reads them. A scene written without speaker
// tags uses the voice director's labels (scene_tags) when it has them.
export function buildScenes(events: StoryEvent[], opts: { vocal?: readonly string[] } = {}): Scene[] {
  const bible = voicedBible(events);
  const knownIds = new Set(Object.keys(bible.characters));
  const tags = sceneTags(events);
  const aliases = speakerAliases(events);
  const vocals = opts.vocal ? vocalTags(events, opts.vocal) : undefined;
  return events
    .filter((e) => e.type === "scene_committed")
    .map((e) => {
      const d = e.data as SceneCommittedData;
      const t = tags.get(d.index);
      if (!t) return parseScene(d.index, d.prose, knownIds);
      const speakers = t.tags.map((tag) => aliases.get(tag) ?? tag);
      const scene = parseScene(d.index, applyTags(d.prose, speakers), knownIds);
      const delivery: Record<number, { speaker: string; note: string }> = {};
      t.delivery.forEach((note, p) => { if (note) delivery[p] = { speaker: speakers[p], note }; });
      const vocal: Record<number, { speaker: string; tags: VocalTag[] }> = {};
      vocals?.get(d.index)?.vocal.forEach((v, p) => { if (v?.length) vocal[p] = { speaker: speakers[p], tags: v }; });
      return { ...scene, ...(Object.keys(delivery).length > 0 ? { delivery } : {}), ...(Object.keys(vocal).length > 0 ? { vocal } : {}) };
    });
}

// The bible plus any speakers the voice director found that it doesn't have.
export function voicedBible(events: StoryEvent[]): Bible {
  const bible = replay(events);
  const extra = taggedCharacters(events, new Set(Object.keys(bible.characters)));
  return Object.keys(extra).length > 0 ? { ...bible, characters: { ...bible.characters, ...extra } } : bible;
}

export interface AudiobookOptions {
  runDir: string;
  narratorVoice?: string;
  dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  device?: "wasm" | "webgpu" | "cpu";
  modelId?: string;
  language?: string;
  // Overrides/sets character genders for voice matching (e.g. runs made before
  // the bible recorded gender): character id -> "female" | "male".
  characterGenders?: Record<string, string>;
  // Which engine voices what: Kokoro (local, free) or Gemini TTS (acted, paid).
  narration?: TtsEngine;  // default "kokoro"
  dialogue?: TtsEngine;   // default "kokoro"
  geminiModel?: string;
  geminiVoices?: Record<string, string>;  // character id (or "narrator") -> Gemini voice name
  narratorReads?: string[];  // walk-on parts read in the narrator's voice (see casting.ts narratorReads)
  pronunciations?: Pronunciations;  // how to say the story's hard words (see geminiTts.ts)
  // How Gemini lines are requested: "line" (one request each, own direction — the
  // default), "palette" (batched by speaker and palette tone), "speaker" (batched by
  // speaker, no direction). See geminiBatch.ts.
  geminiMode?: GeminiMode;
  palette?: TonePaletteData;  // palette mode: the story's tone palettes (made by the audiobook step)
  geminiRpm?: number;          // Gemini TTS requests per minute (default 9; Tier 1 allows 10)
  geminiFallback?: "kokoro" | "gemini";  // see hybridVoicing
  pauseScale?: number;  // batched modes: scales the silences put back between pieces (default 1)
  geminiConcurrency?: number;  // batched modes: batches in flight at once (default 2; 1 = one at a time)
  // Batched modes through Gemini Batch Mode: a scene's voice batches go out as
  // one batch job at half price (minutes, not seconds). Line mode stays live.
  geminiBatch?: boolean;
  audioTags?: readonly string[];  // perform the voice director's marked sounds (#71), from this list
  characterVoices?: Record<string, string>;  // character id -> Kokoro voice, chosen by the author
  // Kokoro voices to use or avoid (e.g. weak or overused ones), by id.
  kokoroVoices?: { include?: string[]; exclude?: string[] };
  speak?: Speak;    // Gemini TTS call; injectable for tests
  force?: boolean;  // re-render scenes whose text and voice settings are unchanged
  onProgress?: (event: AudiobookProgress) => void;
}

export type AudiobookProgress =
  | { type: "model_loading" }
  | { type: "model_ready" }
  | { type: "scene_skipped"; index: number; path: string }
  | { type: "line_fallback"; speaker: string; error: string }
  | { type: "line_kept_long"; speaker: string; seconds: number }
  | { type: "batch_done"; sceneIndex: number; batch: number; batches: number; speaker: string; lines: number; tone?: string; cached: boolean }
  | { type: "batch_failed"; sceneIndex: number; speaker: string; lines: number; error: string; split: boolean }
  | { type: "scene_start"; index: number; total: number; segments: number }
  | { type: "chunk_done"; sceneIndex: number; segmentIndex: number; segments: number; speaker: string; text: string }
  | { type: "segment_done"; sceneIndex: number; segmentIndex: number; segments: number; speaker: string }
  | { type: "scene_done"; index: number; path: string };

export interface AudiobookResult {
  outDir: string;
  scenes: number;
  rendered: number;
  skipped: number;
  voices: VoiceAssignment;
}

// audiobook/audio.json: what each scene's WAV was made from, so a re-run can
// skip scenes that would come out the same — without loading the model.
export interface AudioManifest {
  scenes: Record<string, string>;  // WAV file -> render key
  voices?: VoiceAssignment;
}

// Everything that determines a scene's audio: its speakers and text, and the
// voice settings (narrator, language, character genders, model).
export function sceneRenderKey(scene: Scene, settings: Record<string, unknown>): string {
  return createHash("sha1").update(JSON.stringify({ segments: scene.segments.map((s) => [s.speaker, s.text]), settings, ...(scene.delivery ? { delivery: scene.delivery } : {}), ...(scene.vocal ? { vocal: scene.vocal } : {}) })).digest("hex");
}

export function sceneFile(index: number): string {
  return `scene-${String(index + 1).padStart(2, "0")}.wav`;
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

export type TtsEngine = "kokoro" | "gemini";

// One TTS pass over `text`, yielding audio per sentence-ish chunk. `context` is
// the text just before this piece (for engines that act the line).
// ctx.performed: the text with sounds placed (#71), for the voice model only.
export type Synthesize = (text: string, voice: string, ctx?: { speaker: string; context: string; delivery?: string; piece?: number; performed?: string }) => AsyncIterable<{ text: string; audio: Float32Array }>;

// Linear resample for engines whose output rate differs from the audiobook's.
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const out = new Float32Array(Math.round((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) {
    const x = (i * from) / to;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0);
  }
  return out;
}

export interface SynthesizedScene {
  audio: Float32Array;
  paragraphStarts: number[]; // seconds from scene start, indexed by scene paragraph
}

// Synthesizes a scene piece by piece (one piece = one paragraph's share of a
// segment) so each paragraph's start offset in the audio is known exactly.
// Kokoro already synthesizes sentence by sentence, so splitting at paragraph
// boundaries costs nothing extra.
// A scene's voiced pieces in voicing order: each segment's "\n\n"-separated
// parts, with the paragraph each comes from. Batched Gemini voicing and
// synthesizeScene both use this, so piece numbers line up.
// What the voice model reads for a piece: its text with the paragraph's sounds
// placed, when the piece is the paragraph's speaker's (never the narration around a quote).
export function performedPiece(scene: Scene, x: { speaker: string; text: string; paragraph: number | undefined }): string {
  const v = x.paragraph !== undefined ? scene.vocal?.[x.paragraph] : undefined;
  return v && v.speaker === x.speaker ? performed(x.text, v.tags) : x.text;
}

export function scenePieces(scene: Scene): { segment: number; speaker: string; text: string; paragraph: number | undefined }[] {
  return scene.segments.flatMap((seg, s) => {
    const parts = seg.text.split("\n\n");
    const aligned = parts.length === seg.paragraphs.length;
    return aligned
      ? parts.map((text, k) => ({ segment: s, speaker: seg.speaker, text, paragraph: seg.paragraphs[k] }))
      : [{ segment: s, speaker: seg.speaker, text: seg.text, paragraph: seg.paragraphs[0] }];
  });
}

// Paragraphs voiced as one two-voice request (#124): a character's quoted line
// with the narrator's short pieces around it ("he said, an octave above his
// own voice."). A dialogue tag voiced on its own, with its quote cut out, gets
// the missing line invented ("How do you do? he said"); with the quote beside
// it, it doesn't. Returns each group's piece numbers, in order.
export const TAG_MAX_CHARS = 120;
export function twoVoiceGroups(scene: Scene): number[][] {
  const pieces = scenePieces(scene).map((x, piece) => ({ ...x, piece }));
  const byParagraph = new Map<number, typeof pieces>();
  for (const x of pieces) if (x.paragraph !== undefined) byParagraph.set(x.paragraph, [...(byParagraph.get(x.paragraph) ?? []), x]);
  const groups: number[][] = [];
  for (const ps of byParagraph.values()) {
    const narration = ps.filter((x) => x.speaker === "narrator");
    const speakers = new Set(ps.filter((x) => x.speaker !== "narrator").map((x) => x.speaker));
    if (narration.length && speakers.size === 1 && narration.every((x) => x.text.trim().length <= TAG_MAX_CHARS)) groups.push(ps.map((x) => x.piece));
  }
  return groups;
}

// Voices each two-voice paragraph (twoVoiceGroups) as one request — the
// quote in its speaker's voice, the narrator's pieces in the narrator's, each
// with its own direction. The audio goes on the paragraph's first piece (the
// rest get none). Cached like the batches; a group not wholly in Gemini voices
// is left to the usual path.
export async function voiceConversations(scene: Scene, p: {
  bible: Bible;
  voiceFor: (speaker: string) => string;
  speak: Speak;
  byNarrator?: ReadonlySet<string>;
  toneOf?: (scene: number, paragraph: number, speaker: string) => string | undefined;
  cache?: BatchCache;
  model?: string;
  concurrency?: number;
}): Promise<Map<number, Float32Array>> {
  const pieces = scenePieces(scene);
  const out = new Map<number, Float32Array>();
  const jobs = twoVoiceGroups(scene).flatMap((group) => {
    if (!group.every((i) => p.voiceFor(pieces[i].speaker).startsWith("gemini:"))) return [];
    const parts: SpeechPart[] = group.map((i) => {
      const x = pieces[i];
      const who = ttsSpeaker(p.bible, x.speaker, p.byNarrator);
      const d = x.paragraph !== undefined ? scene.delivery?.[x.paragraph] : undefined;
      const tone = x.paragraph !== undefined ? p.toneOf?.(scene.index, x.paragraph, x.speaker) : undefined;
      const style = [d && d.speaker === x.speaker ? d.note : "", tone ?? "", who.profile].filter(Boolean).join(". ");
      return { speaker: who.narrating ? "Narrator" : who.name, voice: p.voiceFor(x.speaker).slice("gemini:".length), text: performedPiece(scene, x).trim(), ...(style ? { style } : {}) };
    });
    return [{ group, parts }];
  });
  let next = 0;
  const work = async () => {
    for (let j = next++; j < jobs.length; j = next++) {
      const { group, parts } = jobs[j];
      const key = batchKey(JSON.stringify(parts), "conversation", p.model ?? "");
      let audio = p.cache ? await p.cache.get(key) : undefined;
      if (!audio) {
        const r = await p.speak({ text: parts.map((x) => x.text).join(" "), parts }, parts[0].voice);
        audio = resample(r.samples, r.sampleRate, SAMPLE_RATE);
        await p.cache?.put(key, audio);
      }
      out.set(group[0], audio);
      for (const i of group.slice(1)) out.set(i, new Float32Array(0));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, p.concurrency ?? 2) }, work));
  return out;
}

// Silence before a piece, by the kind of join: within a paragraph (a quote and
// its "she said"), a new paragraph by the same speaker, or a change of speaker.
// Batched Gemini pieces are trimmed tight, so without this a reply starts the
// instant the previous line ends.
export type PieceGap = (prev: { speaker: string; paragraph: number | undefined; piece: number }, next: { speaker: string; paragraph: number | undefined; piece: number }) => number;

export function naturalGaps(scale = 1, applies: (piece: number) => boolean = () => true): PieceGap {
  return (prev, next) => {
    if (!applies(prev.piece) && !applies(next.piece)) return 0;
    const seconds = prev.paragraph === next.paragraph ? 0.15 : prev.speaker === next.speaker ? 0.35 : 0.5;
    return seconds * scale;
  };
}

export async function synthesizeScene(
  scene: Scene,
  voiceFor: (speaker: string) => string,
  synth: Synthesize,
  onChunk: (segmentIndex: number, speaker: string, text: string) => void = () => {},
  onSegment: (segmentIndex: number, speaker: string) => void = () => {},
  gap?: PieceGap
): Promise<SynthesizedScene> {
  const chunks: Float32Array[] = [];
  const starts: Array<number | undefined> = [];
  let samples = 0;
  const recent: string[] = [];  // the last few pieces spoken, as context for acted lines
  const all = scenePieces(scene);
  let prev: { speaker: string; paragraph: number | undefined; piece: number } | undefined;
  for (const [s, seg] of scene.segments.entries()) {
    for (const { text, paragraph, piece } of all.map((x, piece) => ({ ...x, piece })).filter((x) => x.segment === s)) {
      const here = { speaker: seg.speaker, paragraph, piece };
      const silence = prev && gap ? Math.round(gap(prev, here) * SAMPLE_RATE) : 0;
      if (silence > 0) { chunks.push(new Float32Array(silence)); samples += silence; }
      prev = here;
      if (paragraph !== undefined && starts[paragraph] === undefined) starts[paragraph] = samples / SAMPLE_RATE;
      const context = recent.join(" ").slice(-500);
      const d = paragraph !== undefined ? scene.delivery?.[paragraph] : undefined;
      const delivery = d && d.speaker === seg.speaker ? d.note : undefined;
      const acted = performedPiece(scene, { speaker: seg.speaker, text, paragraph });
      for await (const chunk of synth(text, voiceFor(seg.speaker), { speaker: seg.speaker, context, piece, ...(delivery ? { delivery } : {}), ...(acted !== text ? { performed: acted } : {}) })) {
        chunks.push(chunk.audio);
        samples += chunk.audio.length;
        onChunk(s, seg.speaker, chunk.text);
      }
      recent.push(text);
      if (recent.length > 3) recent.shift();
    }
    onSegment(s, seg.speaker);
  }
  // A paragraph with no audio of its own (shouldn't happen) starts where the previous one did.
  const paragraphStarts: number[] = [];
  let last = 0;
  for (let p = 0; p < starts.length; p++) {
    last = starts[p] ?? last;
    paragraphStarts.push(Math.round(last * 1000) / 1000);
  }
  return { audio: concatFloat32(chunks), paragraphStarts };
}

export interface SceneTiming {
  index: number;
  file: string;
  durationSec: number;
  paragraphStarts: number[];
}

// Generous upper bound for speaking a line: ~1s per word plus room for a
// dramatic pause or a sigh. Anything longer spoke more than the line.
export function maxLineSeconds(line: string): number {
  return Math.round(line.split(/\s+/).filter(Boolean).length * 1 + 3);
}

// The scene context for an acted line: the narration just before it, without
// any quoted dialogue (Gemini performs quoted lines it sees in its prompt as
// if they were part of the script), trimmed to the most recent ~300 chars.
export function sceneContext(text: string): string {
  const narration = text.replace(/"[^"]*"/g, " ").replace(/\s+/g, " ").trim();
  return narration.length > 300 ? `…${narration.slice(-300).replace(/^\S*\s/, "")}` : narration;
}

// Routes each speaker to an engine — Kokoro, or Gemini TTS acting the line —
// and builds the synthesizer that voices them. Voices are "gemini:<Name>" for
// Gemini lines and Kokoro ids otherwise. A Gemini line is acted: who is
// speaking (from the bible), what just happened (the preceding text), then the
// line. A failed Gemini line falls back to the speaker's Kokoro voice, so one
// bad request never sinks the audiobook.
// Who a Gemini line is read as: the narrator, a character, or the narrator
// voicing a walk-on part (#105) — in the narrator's voice, lightly in character.
export function ttsSpeaker(bible: Bible, speaker: string, byNarrator?: ReadonlySet<string>): { name: string; profile: string; narrating: boolean } {
  const ch = bible.characters[speaker];
  const narrator = `The narrator of a story. Tone: ${bible.tone || "measured, warm storytelling"}.`;
  if (speaker === "narrator" || !ch) return { name: "Narrator", profile: narrator, narrating: true };
  // How they sound (the author's sheet, else the writer's line) as well as how they talk.
  const desc = [ch.traits, ch.voice && `Voice: ${ch.voice}`, ch.vocal && `Sounds: ${ch.vocal}`].filter(Boolean).join(" ");
  if (byNarrator?.has(speaker)) return { name: "Narrator", profile: `${narrator} Here the narrator voices a minor character, ${ch.name}${desc ? ` (${desc})` : ""}: suggest them with a light shift in delivery, in the narrator's own voice.`, narrating: false };
  return { name: ch.name, profile: desc, narrating: false };
}

export function hybridVoicing(p: {
  bible: Bible;
  assignment: VoiceAssignment;
  narration: TtsEngine;
  dialogue: TtsEngine;
  kokoroSynth: Synthesize;
  speak: Speak;
  byNarrator?: ReadonlySet<string>;  // walk-on parts the narrator reads
  onFallback?: (speaker: string, error: string) => void;
  // A Gemini line that keeps failing: "kokoro" reads it with Kokoro; "gemini"
  // keeps it in Gemini (a bare retry, then the best take). Default: kokoro when
  // the story uses Kokoro anyway, gemini for an all-Gemini story.
  fallback?: "kokoro" | "gemini";
  onKeptLong?: (speaker: string, seconds: number) => void;
}): { voiceFor: (speaker: string) => string; synth: Synthesize } {
  const { bible, assignment, narration, dialogue, kokoroSynth, speak } = p;
  const fallback = p.fallback ?? (narration === "kokoro" || dialogue === "kokoro" ? "kokoro" : "gemini");
  const kokoroVoiceFor = (speaker: string) => speaker === "narrator"
    ? assignment.narrator
    : (assignment.characters[speaker] ?? assignment.narrator);
  const voiceFor = (speaker: string) => {
    const engine = speaker === "narrator" ? narration : dialogue;
    if (engine !== "gemini" || !assignment.gemini) return kokoroVoiceFor(speaker);
    const g = speaker === "narrator" ? assignment.gemini.narrator : assignment.gemini.characters[speaker];
    return g ? `gemini:${g}` : kokoroVoiceFor(speaker);
  };
  const synth: Synthesize = async function* (text, voice, ctx) {
    if (!voice.startsWith("gemini:")) {
      yield* kokoroSynth(text, voice);
      return;
    }
    const speaker = ctx?.speaker ?? "narrator";
    const who = ttsSpeaker(bible, speaker, p.byNarrator);
    const scene = sceneContext(ctx?.context ?? "");
    const line = ctx?.performed ?? text;
    const prompt = buildTtsPrompt(who.narrating
      ? { name: who.name, profile: who.profile, scene, notes: ctx?.delivery ? `Storytelling narration, ${ctx.delivery}.` : "Storytelling narration: clear, engaged, natural pace; let the drama of the moment color the read without over-acting.", line }
      : { name: who.name, profile: who.profile, scene, ...(ctx?.delivery ? { notes: ctx.delivery } : {}), line });
    // A reply far longer than the line could take means the model spoke
    // something else too (direction, context): retry, then fall back.
    const geminiVoice = voice.slice("gemini:".length);
    let best: Float32Array | undefined;
    const take = async (pr: SpeechInput): Promise<Float32Array | undefined> => {
      const { samples, sampleRate } = await speak(pr, geminiVoice);
      const audio = resample(samples, sampleRate, SAMPLE_RATE);
      if (!best || audio.length < best.length) best = audio;
      return samples.length / sampleRate <= maxLineSeconds(text) ? audio : undefined;
    };
    try {
      let audio: Float32Array | undefined;
      for (let attempt = 0; attempt < 2 && !audio; attempt++) audio = await take(prompt);
      // Staying in Gemini: the line with no direction at all (and no sounds: a tag read aloud is one way a line runs long).
      if (!audio && fallback === "gemini") for (let attempt = 0; attempt < 2 && !audio; attempt++) audio = await take({ text });
      if (!audio && fallback === "gemini" && best) {
        p.onKeptLong?.(speaker, best.length / SAMPLE_RATE);
        audio = best;
      }
      if (!audio) throw new Error(`audio far longer than the line (over ${maxLineSeconds(text)}s) on both attempts`);
      yield { text, audio };
    } catch (err) {
      if (isBudgetError(err) || isTtsRateLimit(err)) throw err;  // a spent budget or quota stops the audiobook; it never quietly switches engines
      if (fallback === "gemini") throw err;
      p.onFallback?.(speaker, err instanceof Error ? err.message : String(err));
      yield* kokoroSynth(text, kokoroVoiceFor(speaker));
    }
  };
  return { voiceFor, synth };
}

// Cast or chosen Gemini voices over the automatic assignment. Any voice id is
// accepted — one of the 30 prebuilt voices, a library voice (en-gb-advisor-9),
// or a designed voice (voice_...).
export function applyGeminiVoices(auto: { narrator: string; characters: Record<string, string> }, chosen: Record<string, string>): { narrator: string; characters: Record<string, string> } {
  const characters = { ...auto.characters };
  for (const [id, v] of Object.entries(chosen)) if (id !== "narrator" && v) characters[id] = v;
  return { narrator: chosen.narrator || auto.narrator, characters };
}

// Voices a scene's Gemini pieces in batches (palette or speaker mode), returning
// each piece's audio by its number. A batch that fails is left out, and its lines
// are voiced one by one as in line mode.
export async function voiceSceneBatches(scene: Scene, mode: GeminiMode, p: {
  bible: Bible;
  voiceFor: (speaker: string) => string;
  speak: Speak;
  byNarrator?: ReadonlySet<string>;  // walk-on parts the narrator reads
  exclude?: ReadonlySet<number>;     // pieces voiced another way (two-voice paragraphs)
  toneOf?: (scene: number, paragraph: number, speaker: string) => string | undefined;
  cache?: BatchCache;   // takes already paid for (see geminiBatch.ts)
  model?: string;
  concurrency?: number; // batches in flight at once (default 1)
  onProgress: (event: AudiobookProgress) => void;
}): Promise<Map<number, Float32Array>> {
  const pieces: BatchPiece[] = scenePieces(scene).flatMap((x, order) => {
    if (p.exclude?.has(order) || !p.voiceFor(x.speaker).startsWith("gemini:") || !speakable(x.text)) return [];
    const tone = mode === "palette" && x.paragraph !== undefined ? p.toneOf?.(scene.index, x.paragraph, x.speaker) : undefined;
    const acted = performedPiece(scene, x);
    return [{ order, speaker: x.speaker, text: x.text, ...(acted !== x.text ? { performed: acted } : {}), ...(tone ? { tone } : {}) }];
  });
  const out = new Map<number, Float32Array>();
  const queue = planBatches(pieces);
  let done = 0;
  // A batch that won't cut cleanly is halved and each half tried again (two
  // requests, not one per line); a single line that still fails is voiced in line mode.
  // Several batches can be in flight; the speaker paces the requests.
  const voiceNext = async (batch: Batch) => {
    const i = done++;
    const batches = done + queue.length;
    const { name, profile } = ttsSpeaker(p.bible, batch.speaker, p.byNarrator);
    const who = { name, profile };
    try {
      let cached = false;
      const audio = await voiceBatch(p.speak, batch, p.voiceFor(batch.speaker).slice("gemini:".length), who, SAMPLE_RATE, 3, { cache: p.cache, model: p.model, onCached: () => { cached = true; } });
      batch.pieces.forEach((piece, k) => out.set(piece.order, audio[k]));
      p.onProgress({ type: "batch_done", sceneIndex: scene.index, batch: i + 1, batches, speaker: batch.speaker, lines: batch.pieces.length, cached, ...(batch.tone ? { tone: batch.tone } : {}) });
    } catch (err) {
      if (isBudgetError(err) || isTtsRateLimit(err)) throw err;
      const halves = batch.pieces.length > 1
        ? [batch.pieces.slice(0, Math.ceil(batch.pieces.length / 2)), batch.pieces.slice(Math.ceil(batch.pieces.length / 2))].map((ps) => ({ ...batch, pieces: ps }))
        : [];
      queue.unshift(...halves);
      p.onProgress({ type: "batch_failed", sceneIndex: scene.index, speaker: batch.speaker, lines: batch.pieces.length, error: err instanceof Error ? err.message : String(err), split: halves.length > 0 });
    }
  };
  // Workers keep going while a halved batch adds work to the queue.
  const running = new Set<Promise<void>>();
  const limit = Math.max(1, p.concurrency ?? 1);
  try {
    while (queue.length > 0 || running.size > 0) {
      while (queue.length > 0 && running.size < limit) {
        const job = voiceNext(queue.shift()!).finally(() => running.delete(job));
        running.add(job);
      }
      if (running.size > 0) await Promise.race(running);
    }
  } catch (err) {
    // A budget or quota stop: let the batches in flight settle, then stop.
    queue.length = 0;
    await Promise.allSettled([...running]);
    throw err;
  }
  return out;
}

// Synthesizes one WAV per scene under `<runDir>/audiobook/`. Long text always
// goes through tts.stream() — tts.generate() silently truncates anything past
// ~509 tokens, which would drop the tail of a full-length scene.
export async function generateAudiobook(events: StoryEvent[], opts: AudiobookOptions): Promise<AudiobookResult> {
  const bible = voicedBible(events);
  const scenes = buildScenes(events, opts.audioTags ? { vocal: opts.audioTags } : {});
  const onProgress = opts.onProgress ?? (() => {});
  const outDir = `${opts.runDir}/audiobook`;
  await mkdir(outDir, { recursive: true });
  // What will be voiced, readable: who reads each piece, and how.
  await writeFile(`${outDir}/script.md`, renderScript(scenes), "utf8");
  for (const problem of voicingProblems(scenes)) console.error(`[scriptorium] ✗ narrator would read a spoken line — ${problem}`);

  const genders: Record<string, string | undefined> = {};
  for (const ch of Object.values(bible.characters)) genders[ch.id] = ch.gender;
  Object.assign(genders, opts.characterGenders);
  const modelId = opts.modelId ?? DEFAULT_MODEL_ID;
  const dtype = opts.dtype ?? "q8";
  const narration: TtsEngine = opts.narration ?? "kokoro";
  const dialogue: TtsEngine = opts.dialogue ?? "kokoro";
  const usesGemini = narration === "gemini" || dialogue === "gemini";
  const settings = {
    narratorVoice: opts.narratorVoice ?? null, language: opts.language ?? "en", genders, modelId, dtype,
    // Only part of the key when set, so audiobooks made before these options stay current.
    // twoVoice: quotes and their tags voiced together (#124); scenes made before are redone.
    ...(usesGemini ? { narration, dialogue, geminiModel: opts.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL, geminiVoices: opts.geminiVoices ?? {}, twoVoice: 1 } : {}),
    ...(usesGemini && (opts.geminiMode ?? "line") !== "line" ? { geminiMode: opts.geminiMode, pauseScale: opts.pauseScale ?? 1, ...(opts.geminiMode === "palette" ? { palette: opts.palette?.source ?? null } : {}) } : {}),
    ...(opts.kokoroVoices ? { kokoroVoices: opts.kokoroVoices } : {}),
    ...(opts.characterVoices ? { characterVoices: opts.characterVoices } : {}),
    ...(opts.narratorReads?.length ? { narratorReads: [...opts.narratorReads].sort() } : {})
  };

  // Skip scenes whose WAV exists and was made from the same text and settings.
  let manifest: AudioManifest | undefined;
  try { manifest = JSON.parse(await readFile(`${outDir}/audio.json`, "utf8")); } catch { /* first render, or made before audio.json */ }
  let previous: SceneTiming[] = [];
  try { previous = (JSON.parse(await readFile(`${outDir}/timings.json`, "utf8")) as { scenes: SceneTiming[] }).scenes; } catch { /* none yet */ }
  const exists = async (f: string) => stat(`${outDir}/${f}`).then(() => true, () => false);
  const keys = new Map(scenes.map((sc) => [sc.index, sceneRenderKey(sc, settings)]));
  if (!manifest) {
    manifest = { scenes: {} };
    // An audiobook made before audio.json existed: adopt its finished scenes
    // (WAV + timing + voice map) as current rather than re-render them all.
    // Voice settings changed since? --force re-renders.
    let voices: VoiceAssignment | undefined;
    try { voices = JSON.parse(await readFile(`${outDir}/voices.json`, "utf8")); } catch { /* none */ }
    if (voices) {
      manifest.voices = voices;
      for (const scene of scenes) {
        const file = sceneFile(scene.index);
        if (previous.some((t) => t.index === scene.index) && (await exists(file))) manifest.scenes[file] = keys.get(scene.index)!;
      }
    }
  }
  const todo: Scene[] = [];
  const timings = new Map<number, SceneTiming>();
  for (const scene of scenes) {
    const file = sceneFile(scene.index);
    const timing = previous.find((t) => t.index === scene.index);
    if (!opts.force && manifest.scenes[file] === keys.get(scene.index) && timing && (await exists(file))) {
      timings.set(scene.index, timing);
      onProgress({ type: "scene_skipped", index: scene.index, path: `${outDir}/${file}` });
    } else {
      todo.push(scene);
    }
  }
  const writeTimings = () => writeFile(`${outDir}/timings.json`, JSON.stringify({ sampleRate: SAMPLE_RATE, scenes: [...timings.values()].sort((a, b) => a.index - b.index) }, null, 2) + "\n", "utf8");
  const writeManifest = () => writeFile(`${outDir}/audio.json`, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  if (todo.length === 0) {
    // Nothing to render: don't load the model at all.
    await writeTimings();
    await writeManifest();  // persists an adopted pre-manifest audiobook
    if (!manifest.voices) throw new Error(`${outDir}/audio.json has no voice map — re-run with --force`);
    return { outDir, scenes: scenes.length, rendered: 0, skipped: scenes.length, voices: manifest.voices };
  }

  onProgress({ type: "model_loading" });
  const { KokoroTTS, TextSplitterStream } = await import("kokoro-js");
  const { RawAudio, env: transformersEnv } = await import("@huggingface/transformers");
  // kokoro-js shares this transformers.js instance, so this applies to its model download too.
  transformersEnv.cacheDir = modelCacheDir();
  // kokoro-js types `voice` as a literal union of its bundled voice ids, but we
  // discover the set at runtime (Object.keys widens to string[]) so we can stay
  // decoupled from that list — see assignVoices, which is plain-string in/out.
  type VoiceId = keyof InstanceType<typeof KokoroTTS>["voices"];
  const tts = await KokoroTTS.from_pretrained(modelId, { dtype, device: opts.device ?? "cpu" });
  onProgress({ type: "model_ready" });
  const voiceIds = curateVoices(filterVoicesByLanguage(tts.voices, opts.language ?? "en"), opts.kokoroVoices);
  if (voiceIds.length === 0) {
    throw new Error(`no Kokoro voices left for language "${opts.language ?? "en"}" after include/exclude`);
  }
  const voiceGenders = Object.fromEntries(voiceIds.map((id) => [id, (tts.voices as Record<string, { gender?: string }>)[id]?.gender]));
  const pinned = opts.characterVoices ?? {};
  const languageVoices = filterVoicesByLanguage(tts.voices, opts.language ?? "en");
  for (const [id, voice] of Object.entries(pinned)) {
    if (!languageVoices.includes(voice)) throw new Error(`characterVoices: "${voice}" (for ${id}) is not a Kokoro voice for language "${opts.language ?? "en"}"`);
    if (!bible.characters[id]) console.error(`[scriptorium] characterVoices: no character "${id}" in this story (characters: ${Object.keys(bible.characters).join(", ")}) — ignored`);
  }
  const assignment: VoiceAssignment = assignVoices(Object.keys(bible.characters), voiceIds, opts.narratorVoice, { genders, voiceGenders, pinned });
  if (usesGemini) {
    const g = assignVoices(Object.keys(bible.characters), Object.keys(GEMINI_VOICES), "Charon", { genders, voiceGenders: GEMINI_VOICES });
    assignment.gemini = applyGeminiVoices(g, opts.geminiVoices ?? {});
  }
  // Walk-on parts are read in the narrator's voice.
  const byNarrator = new Set(opts.narratorReads ?? []);
  for (const id of byNarrator) {
    assignment.characters[id] = assignment.narrator;
    if (assignment.gemini) assignment.gemini.characters[id] = assignment.gemini.narrator;
  }
  manifest.voices = assignment;

  // tts.stream(text, opts) — the plain-string convenience form — pushes text
  // into an internal TextSplitterStream but never closes it, so the final
  // sentence in any fixed string never flushes: the for-await hangs on it, and
  // Node silently exits once nothing else holds the event loop open. Build and
  // close our own stream instead.
  const kokoroSynth: Synthesize = async function* (text, voice) {
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close();
    for await (const { text: said, audio } of tts.stream(splitter, { voice: voice as VoiceId })) {
      yield { text: said, audio: audio.audio };
    }
  };
  // Lines the speech check couldn't get right in three takes: kept, and listed in a review round.
  // Lines the speech check flagged, every take kept for the author to hear.
  const flagged: CheckReport[] = [];
  const speak = opts.speak ?? geminiSpeaker({ model: opts.geminiModel, minIntervalMs: Math.ceil(60000 / (opts.geminiRpm ?? 9)), ...(opts.pronunciations ? { pronunciations: opts.pronunciations } : {}), onReport: (r) => {
    flagged.push(r);
    if (!r.ok) console.error(`[scriptorium]   speech check: still flagged after ${r.takes.length} takes, kept the closest — "${r.script.slice(0, 80)}": ${r.takes[r.kept].problems.join("; ")}`);
  } });
  const { voiceFor, synth: lineSynth } = hybridVoicing({
    bible, assignment, narration, dialogue, kokoroSynth, speak, byNarrator, fallback: opts.geminiFallback,
    onFallback: (speaker, error) => onProgress({ type: "line_fallback", speaker, error }),
    onKeptLong: (speaker, seconds) => onProgress({ type: "line_kept_long", speaker, seconds })
  });
  const mode: GeminiMode = usesGemini ? opts.geminiMode ?? "line" : "line";
  const toneOf = mode === "palette" && opts.palette ? paletteToneFor(events, opts.palette) : undefined;
  // Batch Mode only for the batched modes: line mode voices one line at a time,
  // so each line would wait minutes for a job of one. Single-line fallbacks stay live.
  if (opts.geminiBatch && mode === "line") console.error("[scriptorium] geminiBatch applies to geminiMode \"palette\" or \"speaker\" — voicing live");
  const verbatim = readsVerbatim(opts.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL);
  if (opts.geminiBatch && mode !== "line" && verbatim) console.error(`[scriptorium] geminiBatch: ${opts.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL} takes direction only in a live request — voicing live (full price)`);
  const batchSpeak = opts.geminiBatch && mode !== "line" && !verbatim && !opts.speak
    ? geminiBatchSpeaker(geminiBatchJobs({ stateFile: `${outDir}/batch-jobs.json`, log: (m) => console.error(`[scriptorium] ${m}`) }), { model: opts.geminiModel })
    : undefined;
  // Batched modes voice each scene's Gemini pieces up front; synth hands them out
  // by piece number, and anything a batch couldn't voice goes line by line.
  let batched = new Map<number, Float32Array>();
  let grouped = new Set<number>();  // pieces voiced in a two-voice paragraph
  const synth: Synthesize = async function* (text, voice, ctx) {
    const audio = ctx?.piece !== undefined ? batched.get(ctx.piece) : undefined;
    if (audio) { yield { text, audio }; return; }
    yield* lineSynth(text, voice, ctx);
  };

  for (const scene of todo) {
    const segments = scene.segments.length;
    onProgress({ type: "scene_start", index: scene.index, total: scenes.length, segments });
    // Quotes with their tags, two voices at once (#124): voiced first, then left out of the batches.
    const conversations = await voiceConversations(scene, { bible, voiceFor, speak, byNarrator, toneOf, cache: fileBatchCache(`${outDir}/batches`, SAMPLE_RATE), model: opts.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL, concurrency: opts.geminiConcurrency ?? 2 });
    grouped = new Set(conversations.keys());
    batched = new Map(conversations);
    if (mode !== "line") for (const [k, v] of await voiceSceneBatches(scene, mode, { bible, voiceFor, speak: batchSpeak ?? speak, byNarrator, exclude: grouped, toneOf, onProgress, cache: fileBatchCache(`${outDir}/batches`, SAMPLE_RATE), model: opts.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL, concurrency: batchSpeak ? 10000 : opts.geminiConcurrency ?? 2 })) batched.set(k, v);
    const { audio, paragraphStarts } = await synthesizeScene(
      scene,
      voiceFor,
      synth,
      (segmentIndex, speaker, text) => onProgress({ type: "chunk_done", sceneIndex: scene.index, segmentIndex, segments, speaker, text }),
      (segmentIndex, speaker) => onProgress({ type: "segment_done", sceneIndex: scene.index, segmentIndex, segments, speaker }),
      // Batched pieces are trimmed tight; put natural pauses back between them.
      // No pause inside a two-voice paragraph: it's one take.
      ((g) => (prev: Parameters<PieceGap>[0], next: Parameters<PieceGap>[1]) => (grouped.has(prev.piece) && grouped.has(next.piece) && prev.paragraph === next.paragraph ? 0 : g ? g(prev, next) : 0))(mode !== "line" ? naturalGaps(opts.pauseScale ?? 1, (piece) => batched.has(piece)) : undefined)
    );
    const file = sceneFile(scene.index);
    const path = `${outDir}/${file}`;
    await new RawAudio(audio, SAMPLE_RATE).save(path);
    timings.set(scene.index, { index: scene.index, file, durationSec: Math.round((audio.length / SAMPLE_RATE) * 1000) / 1000, paragraphStarts });
    manifest.scenes[file] = keys.get(scene.index)!;
    // Written after every scene so an interrupted run resumes where it stopped.
    await writeTimings();
    await writeManifest();
    onProgress({ type: "scene_done", index: scene.index, path });
  }

  const checked = await speechCheckRound(opts.runDir, "audiobook", flagged);
  if (checked) console.error(`[scriptorium] speech check flagged ${flagged.length} line${flagged.length === 1 ? "" : "s"} (${flagged.filter((r) => !r.ok).length} still flagged) — every take to listen to: ${checked.dir}/legend.txt`);
  return { outDir, scenes: scenes.length, rendered: todo.length, skipped: scenes.length - todo.length, voices: assignment };
}

// writeFile import kept for callers that want to persist the voice map
// alongside the audio (e.g. the CLI) without recomputing it.
export async function writeVoiceMap(outDir: string, assignment: VoiceAssignment): Promise<void> {
  await writeFile(`${outDir}/voices.json`, JSON.stringify(assignment, null, 2), "utf8");
}

// Parses `--voice-gender osmagus=male,merta=female`.
export function parseVoiceGenders(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (spec ?? "").split(",").map((p) => p.trim()).filter(Boolean)) {
    const [id, gender] = part.split("=").map((x) => x?.trim());
    if (!id || !gender) throw new Error(`--voice-gender expects id=gender pairs, got "${part}"`);
    if (!normalizeGender(gender)) throw new Error(`--voice-gender: "${gender}" for ${id} is not female or male`);
    out[id] = gender;
  }
  return out;
}
