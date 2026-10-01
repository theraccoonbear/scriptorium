// Turns a run's committed scenes into audio. Two shapes of input, one tool:
// - Untagged prose (speakerTags off, or any pre-existing run): one narrator
//   voice reads the whole scene.
// - Tagged prose (speakerTags on, see src/roles.ts write()): paragraphs start
//   with `narrator:` or a bible character id, and each speaker gets their own
//   voice. Detection is per scene, not per run — a run can mix both.
import { mkdir, writeFile } from "node:fs/promises";
import { replay } from "./bible.ts";
import type { SceneCommittedData, StoryEvent } from "./types.ts";

const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const SAMPLE_RATE = 24000;

export interface SpeakerSegment {
  speaker: string; // "narrator" or a bible character id
  text: string;
}

export interface Scene {
  index: number;
  tagged: boolean;
  segments: SpeakerSegment[];
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
    } else {
      merged.push({ ...seg });
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
function splitByQuotes(speaker: string, text: string): SpeakerSegment[] {
  const parts: SpeakerSegment[] = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('"', i);
    if (open === -1) {
      parts.push({ speaker: "narrator", text: text.slice(i) });
      break;
    }
    if (open > i) parts.push({ speaker: "narrator", text: text.slice(i, open) });
    const close = text.indexOf('"', open + 1);
    if (close === -1) {
      // Unterminated quote (truncated draft) — treat the rest as spoken rather than drop it.
      parts.push({ speaker, text: text.slice(open) });
      break;
    }
    parts.push({ speaker, text: text.slice(open, close + 1) });
    i = close + 1;
  }
  return parts
    .map((p) => ({ ...p, text: p.text.trim() }))
    .filter((p) => p.text.length > 0);
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

export function parseScene(index: number, prose: string, knownSpeakers: ReadonlySet<string>): Scene {
  const paragraphs = prose.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map(stripMarkdown);
  const segments: SpeakerSegment[] = [];
  let tagged = false;
  for (const para of paragraphs) {
    const m = para.match(TAG_LINE);
    if (m && m[1] === "narrator") {
      tagged = true;
      segments.push({ speaker: "narrator", text: m[2].trim() });
    } else if (m && knownSpeakers.has(m[1])) {
      tagged = true;
      segments.push(...splitByQuotes(m[1], m[2].trim()));
    } else {
      segments.push({ speaker: "narrator", text: para });
    }
  }
  if (!tagged) {
    return { index, tagged: false, segments: [{ speaker: "narrator", text: paragraphs.join("\n\n") }] };
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
}

// Deterministic: the same character id always lands on the same voice across
// runs and re-synthesis, without persisting a mapping anywhere.
export function assignVoices(
  characterIds: readonly string[],
  voices: readonly string[],
  narratorVoice?: string
): VoiceAssignment {
  if (voices.length === 0) throw new Error("no voices available to assign");
  const narrator = narratorVoice && voices.includes(narratorVoice) ? narratorVoice : voices[0];
  const pool = voices.filter((v) => v !== narrator);
  const available = pool.length > 0 ? pool : voices;
  const used = new Set<string>();
  const characters: Record<string, string> = {};
  for (const id of [...characterIds].sort()) {
    const base = hashString(id) % available.length;
    let assigned = available[base];
    for (let offset = 0; used.has(assigned) && offset < available.length; offset++) {
      assigned = available[(base + offset + 1) % available.length];
    }
    used.add(assigned);
    characters[id] = assigned;
  }
  return { narrator, characters };
}

// Kokoro is multi-lingual: each voice is paired with a specific language's
// phonemizer (the id's prefix — af/am = American English, bf/bm = British
// English, jf/jm = Japanese, zf/zm = Mandarin, etc). Feeding English text
// through a voice tagged for another language runs it through that
// language's phonemization rules, producing garbled, mispronounced output —
// not an accent, just the wrong letter-to-sound mapping. Filter to the
// requested language's voices before assigning any.
export function filterVoicesByLanguage(
  voices: Readonly<Record<string, { language: string }>>,
  languagePrefix: string
): string[] {
  return Object.entries(voices)
    .filter(([, v]) => v.language.startsWith(languagePrefix))
    .map(([id]) => id);
}

export function buildScenes(events: StoryEvent[]): Scene[] {
  const bible = replay(events);
  const knownIds = new Set(Object.keys(bible.characters));
  return events
    .filter((e) => e.type === "scene_committed")
    .map((e) => {
      const d = e.data as SceneCommittedData;
      return parseScene(d.index, d.prose, knownIds);
    });
}

export interface AudiobookOptions {
  runDir: string;
  narratorVoice?: string;
  dtype?: "fp32" | "fp16" | "q8" | "q4" | "q4f16";
  device?: "wasm" | "webgpu" | "cpu";
  modelId?: string;
  language?: string;
  onProgress?: (event: AudiobookProgress) => void;
}

export type AudiobookProgress =
  | { type: "model_loading" }
  | { type: "model_ready" }
  | { type: "scene_start"; index: number; total: number; segments: number }
  | { type: "chunk_done"; sceneIndex: number; segmentIndex: number; segments: number; speaker: string; text: string }
  | { type: "segment_done"; sceneIndex: number; segmentIndex: number; segments: number; speaker: string }
  | { type: "scene_done"; index: number; path: string };

export interface AudiobookResult {
  outDir: string;
  scenes: number;
  voices: VoiceAssignment;
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

// Synthesizes one WAV per scene under `<runDir>/audiobook/`. Long text always
// goes through tts.stream() — tts.generate() silently truncates anything past
// ~509 tokens, which would drop the tail of a full-length scene.
export async function generateAudiobook(events: StoryEvent[], opts: AudiobookOptions): Promise<AudiobookResult> {
  const bible = replay(events);
  const scenes = buildScenes(events);
  const onProgress = opts.onProgress ?? (() => {});

  onProgress({ type: "model_loading" });
  const { KokoroTTS, TextSplitterStream } = await import("kokoro-js");
  const { RawAudio } = await import("@huggingface/transformers");
  // kokoro-js types `voice` as a literal union of its bundled voice ids, but we
  // discover the set at runtime (Object.keys widens to string[]) so we can stay
  // decoupled from that list — see assignVoices, which is plain-string in/out.
  type VoiceId = keyof InstanceType<typeof KokoroTTS>["voices"];
  const tts = await KokoroTTS.from_pretrained(opts.modelId ?? DEFAULT_MODEL_ID, {
    dtype: opts.dtype ?? "q8",
    device: opts.device ?? "cpu"
  });
  onProgress({ type: "model_ready" });
  const voiceIds = filterVoicesByLanguage(tts.voices, opts.language ?? "en");
  if (voiceIds.length === 0) {
    throw new Error(`no voices found for language prefix "${opts.language ?? "en"}"`);
  }
  const assignment = assignVoices(Object.keys(bible.characters), voiceIds, opts.narratorVoice);

  const outDir = `${opts.runDir}/audiobook`;
  await mkdir(outDir, { recursive: true });

  for (const scene of scenes) {
    onProgress({ type: "scene_start", index: scene.index, total: scenes.length, segments: scene.segments.length });
    const chunks: Float32Array[] = [];
    for (let s = 0; s < scene.segments.length; s++) {
      const seg = scene.segments[s];
      const voice = seg.speaker === "narrator"
        ? assignment.narrator
        : (assignment.characters[seg.speaker] ?? assignment.narrator);
      // tts.stream(text, opts) — the plain-string convenience form — pushes
      // text into an internal TextSplitterStream but never closes it, so the
      // final sentence in any fixed string never flushes: the for-await below
      // hangs on it, and Node silently exits once nothing else holds the event
      // loop open. Build and close our own stream instead.
      const splitter = new TextSplitterStream();
      splitter.push(seg.text);
      splitter.close();
      for await (const { text, audio } of tts.stream(splitter, { voice: voice as VoiceId })) {
        chunks.push(audio.audio);
        onProgress({ type: "chunk_done", sceneIndex: scene.index, segmentIndex: s, segments: scene.segments.length, speaker: seg.speaker, text });
      }
      onProgress({ type: "segment_done", sceneIndex: scene.index, segmentIndex: s, segments: scene.segments.length, speaker: seg.speaker });
    }
    const combined = new RawAudio(concatFloat32(chunks), SAMPLE_RATE);
    const path = `${outDir}/scene-${String(scene.index + 1).padStart(2, "0")}.wav`;
    await combined.save(path);
    onProgress({ type: "scene_done", index: scene.index, path });
  }

  return { outDir, scenes: scenes.length, voices: assignment };
}

// writeFile import kept for callers that want to persist the voice map
// alongside the audio (e.g. the CLI) without recomputing it.
export async function writeVoiceMap(outDir: string, assignment: VoiceAssignment): Promise<void> {
  await writeFile(`${outDir}/voices.json`, JSON.stringify(assignment, null, 2), "utf8");
}
