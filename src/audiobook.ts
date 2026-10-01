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
  // Scene paragraph index (see sceneParagraphs) of each "\n\n"-separated piece
  // of `text`, so audio timings can be mapped back to paragraphs.
  paragraphs: number[];
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
function splitByQuotes(speaker: string, text: string, paragraph: number): SpeakerSegment[] {
  const parts: Array<{ speaker: string; text: string }> = [];
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
    .map((p) => ({ ...p, text: p.text.trim(), paragraphs: [paragraph] }))
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
}

export function assignVoices(
  characterIds: readonly string[],
  voices: readonly string[],
  narratorVoice?: string,
  { genders = {}, voiceGenders = {} }: VoiceGenderOptions = {}
): VoiceAssignment {
  if (voices.length === 0) throw new Error("no voices available to assign");
  const narrator = narratorVoice && voices.includes(narratorVoice) ? narratorVoice : voices[0];
  const pool = voices.filter((v) => v !== narrator);
  const available = pool.length > 0 ? pool : voices;
  const byGender = (g: Gender) => available.filter((v) => normalizeGender(voiceGenders[v]) === g);
  const used = new Set<string>();
  const characters: Record<string, string> = {};
  const matched: Record<string, Gender> = {};
  // Characters with a known gender pick first so unspecified ones can't use up
  // the smaller same-gender pool; order within each group stays sorted.
  const ids = [...characterIds].sort();
  const ordered = [...ids.filter((id) => normalizeGender(genders[id])), ...ids.filter((id) => !normalizeGender(genders[id]))];
  for (const id of ordered) {
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
  // Overrides/sets character genders for voice matching (e.g. runs made before
  // the bible recorded gender): character id -> "female" | "male".
  characterGenders?: Record<string, string>;
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

// One TTS pass over `text`, yielding audio per sentence-ish chunk.
export type Synthesize = (text: string, voice: string) => AsyncIterable<{ text: string; audio: Float32Array }>;

export interface SynthesizedScene {
  audio: Float32Array;
  paragraphStarts: number[]; // seconds from scene start, indexed by scene paragraph
}

// Synthesizes a scene piece by piece (one piece = one paragraph's share of a
// segment) so each paragraph's start offset in the audio is known exactly.
// Kokoro already synthesizes sentence by sentence, so splitting at paragraph
// boundaries costs nothing extra.
export async function synthesizeScene(
  scene: Scene,
  voiceFor: (speaker: string) => string,
  synth: Synthesize,
  onChunk: (segmentIndex: number, speaker: string, text: string) => void = () => {},
  onSegment: (segmentIndex: number, speaker: string) => void = () => {}
): Promise<SynthesizedScene> {
  const chunks: Float32Array[] = [];
  const starts: Array<number | undefined> = [];
  let samples = 0;
  for (const [s, seg] of scene.segments.entries()) {
    const pieces = seg.text.split("\n\n");
    const aligned = pieces.length === seg.paragraphs.length;
    const work = aligned ? pieces.map((text, k) => ({ text, paragraph: seg.paragraphs[k] })) : [{ text: seg.text, paragraph: seg.paragraphs[0] }];
    for (const { text, paragraph } of work) {
      if (paragraph !== undefined && starts[paragraph] === undefined) starts[paragraph] = samples / SAMPLE_RATE;
      for await (const chunk of synth(text, voiceFor(seg.speaker))) {
        chunks.push(chunk.audio);
        samples += chunk.audio.length;
        onChunk(s, seg.speaker, chunk.text);
      }
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
  const genders: Record<string, string | undefined> = {};
  for (const ch of Object.values(bible.characters)) genders[ch.id] = ch.gender;
  Object.assign(genders, opts.characterGenders);
  const voiceGenders = Object.fromEntries(voiceIds.map((id) => [id, (tts.voices as Record<string, { gender?: string }>)[id]?.gender]));
  const assignment = assignVoices(Object.keys(bible.characters), voiceIds, opts.narratorVoice, { genders, voiceGenders });

  const outDir = `${opts.runDir}/audiobook`;
  await mkdir(outDir, { recursive: true });

  // tts.stream(text, opts) — the plain-string convenience form — pushes text
  // into an internal TextSplitterStream but never closes it, so the final
  // sentence in any fixed string never flushes: the for-await hangs on it, and
  // Node silently exits once nothing else holds the event loop open. Build and
  // close our own stream instead.
  const synth: Synthesize = async function* (text, voice) {
    const splitter = new TextSplitterStream();
    splitter.push(text);
    splitter.close();
    for await (const { text: said, audio } of tts.stream(splitter, { voice: voice as VoiceId })) {
      yield { text: said, audio: audio.audio };
    }
  };
  const voiceFor = (speaker: string) => speaker === "narrator"
    ? assignment.narrator
    : (assignment.characters[speaker] ?? assignment.narrator);

  const timings: SceneTiming[] = [];
  for (const scene of scenes) {
    const segments = scene.segments.length;
    onProgress({ type: "scene_start", index: scene.index, total: scenes.length, segments });
    const { audio, paragraphStarts } = await synthesizeScene(
      scene,
      voiceFor,
      synth,
      (segmentIndex, speaker, text) => onProgress({ type: "chunk_done", sceneIndex: scene.index, segmentIndex, segments, speaker, text }),
      (segmentIndex, speaker) => onProgress({ type: "segment_done", sceneIndex: scene.index, segmentIndex, segments, speaker })
    );
    const file = `scene-${String(scene.index + 1).padStart(2, "0")}.wav`;
    const path = `${outDir}/${file}`;
    await new RawAudio(audio, SAMPLE_RATE).save(path);
    timings.push({ index: scene.index, file, durationSec: Math.round((audio.length / SAMPLE_RATE) * 1000) / 1000, paragraphStarts });
    // Written after every scene so a partial run still has usable timings.
    await writeFile(`${outDir}/timings.json`, JSON.stringify({ sampleRate: SAMPLE_RATE, scenes: timings }, null, 2) + "\n", "utf8");
    onProgress({ type: "scene_done", index: scene.index, path });
  }

  return { outDir, scenes: scenes.length, voices: assignment };
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
