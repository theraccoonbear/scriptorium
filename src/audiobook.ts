// Turns a run's committed scenes into audio. Two shapes of input, one tool:
// - Untagged prose (speakerTags off, or any pre-existing run): one narrator
//   voice reads the whole scene.
// - Tagged prose (speakerTags on, see src/roles.ts write()): paragraphs start
//   with `narrator:` or a bible character id, and each speaker gets their own
//   voice. Detection is per scene, not per run — a run can mix both.
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { replay } from "./bible.ts";
import { buildTtsPrompt, DEFAULT_GEMINI_TTS_MODEL, GEMINI_VOICES, geminiSpeaker } from "./geminiTts.ts";
import type { Speak } from "./geminiTts.ts";
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
  // Which engine voices what: Kokoro (local, free) or Gemini TTS (acted, paid).
  narration?: TtsEngine;  // default "kokoro"
  dialogue?: TtsEngine;   // default "kokoro"
  geminiModel?: string;
  geminiVoices?: Record<string, string>;  // character id (or "narrator") -> Gemini voice name
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
  return createHash("sha1").update(JSON.stringify({ segments: scene.segments.map((s) => [s.speaker, s.text]), settings })).digest("hex");
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
export type Synthesize = (text: string, voice: string, ctx?: { speaker: string; context: string }) => AsyncIterable<{ text: string; audio: Float32Array }>;

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
  const recent: string[] = [];  // the last few pieces spoken, as context for acted lines
  for (const [s, seg] of scene.segments.entries()) {
    const pieces = seg.text.split("\n\n");
    const aligned = pieces.length === seg.paragraphs.length;
    const work = aligned ? pieces.map((text, k) => ({ text, paragraph: seg.paragraphs[k] })) : [{ text: seg.text, paragraph: seg.paragraphs[0] }];
    for (const { text, paragraph } of work) {
      if (paragraph !== undefined && starts[paragraph] === undefined) starts[paragraph] = samples / SAMPLE_RATE;
      const context = recent.join(" ").slice(-500);
      for await (const chunk of synth(text, voiceFor(seg.speaker), { speaker: seg.speaker, context })) {
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
export function hybridVoicing(p: {
  bible: Bible;
  assignment: VoiceAssignment;
  narration: TtsEngine;
  dialogue: TtsEngine;
  kokoroSynth: Synthesize;
  speak: Speak;
  onFallback?: (speaker: string, error: string) => void;
}): { voiceFor: (speaker: string) => string; synth: Synthesize } {
  const { bible, assignment, narration, dialogue, kokoroSynth, speak } = p;
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
    const ch = bible.characters[speaker];
    const scene = sceneContext(ctx?.context ?? "");
    const prompt = buildTtsPrompt(speaker === "narrator" || !ch
      ? { name: "Narrator", profile: `The narrator of a story. Tone: ${bible.tone || "measured, warm storytelling"}.`, scene, notes: "Storytelling narration: clear, engaged, natural pace; let the drama of the moment color the read without over-acting.", line: text }
      : { name: ch.name, profile: [ch.traits, ch.voice && `Voice: ${ch.voice}`].filter(Boolean).join(" "), scene, line: text });
    try {
      // A reply far longer than the line could take means the model spoke
      // something else too (direction, context): retry once, then fall back.
      let audio: Float32Array | undefined;
      for (let attempt = 0; attempt < 2 && !audio; attempt++) {
        const { samples, sampleRate } = await speak(prompt, voice.slice("gemini:".length));
        if (samples.length / sampleRate <= maxLineSeconds(text)) audio = resample(samples, sampleRate, SAMPLE_RATE);
      }
      if (!audio) throw new Error(`audio far longer than the line (over ${maxLineSeconds(text)}s) on both attempts`);
      yield { text, audio };
    } catch (err) {
      if (isBudgetError(err)) throw err;  // a spent budget stops the audiobook; it never quietly switches engines
      p.onFallback?.(speaker, err instanceof Error ? err.message : String(err));
      yield* kokoroSynth(text, kokoroVoiceFor(speaker));
    }
  };
  return { voiceFor, synth };
}

// Synthesizes one WAV per scene under `<runDir>/audiobook/`. Long text always
// goes through tts.stream() — tts.generate() silently truncates anything past
// ~509 tokens, which would drop the tail of a full-length scene.
export async function generateAudiobook(events: StoryEvent[], opts: AudiobookOptions): Promise<AudiobookResult> {
  const bible = replay(events);
  const scenes = buildScenes(events);
  const onProgress = opts.onProgress ?? (() => {});
  const outDir = `${opts.runDir}/audiobook`;
  await mkdir(outDir, { recursive: true });

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
    ...(usesGemini ? { narration, dialogue, geminiModel: opts.geminiModel ?? DEFAULT_GEMINI_TTS_MODEL, geminiVoices: opts.geminiVoices ?? {} } : {}),
    ...(opts.kokoroVoices ? { kokoroVoices: opts.kokoroVoices } : {}),
    ...(opts.characterVoices ? { characterVoices: opts.characterVoices } : {})
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
    const g = assignVoices(Object.keys(bible.characters), Object.keys(GEMINI_VOICES), opts.geminiVoices?.narrator ?? "Charon", { genders, voiceGenders: GEMINI_VOICES });
    for (const [id, v] of Object.entries(opts.geminiVoices ?? {})) {
      if (id !== "narrator" && GEMINI_VOICES[v]) g.characters[id] = v;
    }
    assignment.gemini = { narrator: g.narrator, characters: g.characters };
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
  const { voiceFor, synth } = hybridVoicing({
    bible, assignment, narration, dialogue, kokoroSynth,
    speak: opts.speak ?? geminiSpeaker({ model: opts.geminiModel }),
    onFallback: (speaker, error) => onProgress({ type: "line_fallback", speaker, error })
  });

  for (const scene of todo) {
    const segments = scene.segments.length;
    onProgress({ type: "scene_start", index: scene.index, total: scenes.length, segments });
    const { audio, paragraphStarts } = await synthesizeScene(
      scene,
      voiceFor,
      synth,
      (segmentIndex, speaker, text) => onProgress({ type: "chunk_done", sceneIndex: scene.index, segmentIndex, segments, speaker, text }),
      (segmentIndex, speaker) => onProgress({ type: "segment_done", sceneIndex: scene.index, segmentIndex, segments, speaker })
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
