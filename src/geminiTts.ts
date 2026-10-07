import { postJson, requireKey } from "./providers.ts";
import { c } from "./colors.ts";
import { checkedSpeaker, geminiHeardCheck } from "./speechCheck.ts";
import type { CheckReport, HeardCheck } from "./speechCheck.ts";
import { microBatcher } from "./batchJobs.ts";
import type { BatchJobs } from "./batchJobs.ts";

// Gemini TTS for acted lines. Gemini 3.8 TTS reads its text verbatim, so a
// request carries only the words as text and the direction as a style
// annotation (#114); and since it can still say a different word than it was
// given, every take is checked against its script (speechCheck.ts).

export const DEFAULT_GEMINI_TTS_MODEL = "gemini-3.8-flash-tts";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Gemini's prebuilt voices with their usual gender presentation, for matching
// characters with a recorded gender. Override per character with geminiVoices.
export const GEMINI_VOICES: Readonly<Record<string, "Female" | "Male">> = {
  Zephyr: "Female", Kore: "Female", Leda: "Female", Aoede: "Female", Callirrhoe: "Female", Autonoe: "Female",
  Despina: "Female", Erinome: "Female", Laomedeia: "Female", Achernar: "Female", Gacrux: "Female",
  Pulcherrima: "Female", Vindemiatrix: "Female", Sulafat: "Female",
  Puck: "Male", Charon: "Male", Fenrir: "Male", Orus: "Male", Enceladus: "Male", Iapetus: "Male", Umbriel: "Male",
  Algieba: "Male", Algenib: "Male", Rasalgethi: "Male", Alnilam: "Male", Schedar: "Male", Achird: "Male",
  Zubenelgenubi: "Male", Sadachbia: "Male", Sadaltager: "Male"
};

export interface LineDirection {
  name: string;      // who is speaking ("Narrator" for narration)
  profile: string;   // who they are and how they sound (traits, voice sheet)
  scene?: string;    // what's happening around the line (preceding narration)
  notes?: string;    // delivery direction
  line: string;      // exactly what to speak
}

// What a speech request carries: the words to speak, and how to speak them.
// Gemini 3.8 TTS reads its text verbatim — direction in the text gets read
// aloud now and then (#114) — so the direction travels separately, as the
// request's style annotation. The scene isn't sent: there's no field for it.
// parts: a passage in two voices, one request (a quote and its "he said",
// #124) — each part with its speaker's voice and style; text is all of it.
export interface SpeechPart { speaker: string; voice: string; text: string; style?: string }
export interface SpeechInput { text: string; style?: string; parts?: SpeechPart[] }

export function buildTtsPrompt(d: LineDirection): SpeechInput {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim().replace(/[.;,\s]+$/, "");
  const style = [d.notes, d.profile].map((x) => (x ? flat(x) : "")).filter(Boolean).join(". ");
  return { text: d.line.trim(), ...(style ? { style } : {}) };
}

// Gemini 3.8 TTS (and later) reads its text verbatim: direction can only ride
// as a live request's style annotation. Batch Mode only takes generateContent,
// where it would have to sit in the text, so these models are voiced live.
// The preview models before them took direction in the text.
export function readsVerbatim(model: string = DEFAULT_GEMINI_TTS_MODEL): boolean {
  return !/gemini-2\.5-.*tts|gemini-3\.1-flash-tts-preview/.test(model);
}

// The old single-text form (direction above a transcript), for the preview
// models and Batch Mode, which only take generateContent requests.
export function legacyPrompt(input: SpeechInput): string {
  return input.style ? `### DIRECTOR'S NOTES\n${input.style}\n\n#### TRANSCRIPT\n${input.text}` : input.text;
}

// Gemini returns 16-bit PCM WAV; the audiobook works in Float32 samples.
export function decodeWav(buf: Buffer): { samples: Float32Array; sampleRate: number } {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = buf.readUInt16LE(body + 2);
      sampleRate = buf.readUInt32LE(body + 4);
      bits = buf.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) throw new Error(`unsupported WAV sample size ${bits}`);
      // Some encoders write 0 or 0xFFFFFFFF for a streamed data size: read to the end.
      const end = size === 0 || size === 0xffffffff || body + size > buf.length ? buf.length : body + size;
      const frames = Math.floor((end - body) / (2 * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let ch = 0; ch < channels; ch++) sum += buf.readInt16LE(body + (i * channels + ch) * 2);
        samples[i] = sum / channels / 32768;
      }
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export interface GeminiTtsSpec {
  // Each take is listened to against its script and redone when a word comes
  // out wrong (speechCheck.ts); false turns that off.
  check?: HeardCheck | false;
  onReport?: (r: CheckReport) => void;  // a line with a failed take, every take included (default: a warning when none passed)
  // How to say the story's hard words ("McPoyle": "mick-POYL, rhymes with boil"):
  // a line with one gets "Pronounce McPoyle as …" added to its direction.
  pronunciations?: Pronunciations;
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  retries?: number;  // immediate HTTP retries per call (default 2)
  minIntervalMs?: number;  // least time between requests (pacing for a requests-per-minute cap)
}

export type Speak = (input: SpeechInput, voice: string) => Promise<{ samples: Float32Array; sampleRate: number }>;

// The speechConfig for a voice. Prebuilt and library voices are named in
// prebuiltVoiceConfig; a designed or cloned voice (voice_...) only works as
// voiceConfig.voice (prebuiltVoiceConfig rejects it: "No matching speaker voice").
export function speechConfigFor(voice: string): Record<string, unknown> {
  return voice.startsWith("voice_")
    ? { voiceConfig: { voice } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
}

// Pacing that holds with requests in flight at once: each request books the
// next free slot (intervalMs after the last one booked) before it goes out.
export function slotLimiter(intervalMs: number, sleep: (ms: number) => Promise<void>, now: () => number = Date.now): () => Promise<void> {
  let nextSlot = 0;
  return async () => {
    const t = now();
    const at = Math.max(t, nextSlot);
    nextSlot = at + intervalMs;
    if (at > t) await sleep(at - t);
  };
}

// Gemini TTS rate limits ran out after waiting: the per-minute or (more often)
// the per-day cap. It stops the audiobook — never a reason to retake, re-cut,
// or fall back to another engine. Finished scenes are kept; re-run later.
export class TtsRateLimitError extends Error {
  constructor(detail: string) {
    super(`Gemini TTS rate limit reached (on Tier 1: 10 requests a minute, 100 a day) — finished scenes are kept; re-run later to continue. ${detail}`);
    this.name = "TtsRateLimitError";
  }
}

export function isTtsRateLimit(err: unknown): boolean {
  return err instanceof TtsRateLimitError;
}

// Gemini TTS has a low requests-per-minute cap. A rate-limited line waits and
// tries again (up to about two minutes) instead of falling back to Kokoro.
const RATE_LIMIT_WAITS_MS = [15000, 20000, 30000, 30000, 30000];

// How to say the story's hard words. A string is a hint added to the line's
// direction ("mick-POYL (rhymes with boil)"): the words stay as written. When
// the model still reads the spelling, { say: "Ryan" } replaces the word in what
// is spoken (only there: the story and subtitles keep it), and the speech
// check compares against what was said.
export type Pronunciations = Record<string, string | { say: string }>;

export function withPronunciations(input: SpeechInput, guide: Pronunciations = {}): SpeechInput {
  if (input.parts) {
    const parts = input.parts.map((p) => ({ ...p, ...withPronunciations({ text: p.text, ...(p.style ? { style: p.style } : {}) }, guide) }));
    return { ...input, parts, text: parts.map((p) => p.text).join(" ") };
  }
  const pattern = (word: string) => new RegExp(`(^|[^\\p{L}])(${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?='s|’s|s?(?:$|[^\\p{L}]))`, "giu");
  let text = input.text;
  const hints: string[] = [];
  for (const [word, how] of Object.entries(guide)) {
    if (!pattern(word).test(text)) continue;
    if (typeof how === "string") { if (how.trim()) hints.push(`Pronounce ${word} as ${how.trim()}`); }
    else if (how?.say?.trim()) text = text.replace(pattern(word), (_m, pre: string) => `${pre}${how.say.trim()}`);
  }
  if (text === input.text && hints.length === 0) return input;
  return { ...input, text, ...(hints.length || input.style ? { style: [input.style, ...hints].filter(Boolean).join(". ") } : {}) };
}

export function geminiSpeaker(spec: GeminiTtsSpec = {}, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Speak {
  const paced = pacedSpeaker(spec, sleep);
  // Pronunciations first, so the check hears against what was asked for.
  const guided = (speak: Speak): Speak => (spec.pronunciations ? (input, voice) => speak(withPronunciations(input, spec.pronunciations), voice) : speak);
  if (spec.check === false) return guided(paced);
  return guided(checkedSpeaker(paced, spec.check ?? geminiHeardCheck({ ...(spec.apiKeyEnv ? { apiKeyEnv: spec.apiKeyEnv } : {}) }), {
    onRetake: (problems) => console.error(`[scriptorium]   ${c.retry(`speech check: ${problems.join("; ")} — retaking`)}`),
    onReport: spec.onReport ?? ((r) => { if (!r.ok) console.error(`[scriptorium]   ${c.retry(`speech check: still flagged after ${r.takes.length} takes, kept the closest — "${r.script.slice(0, 80)}": ${r.takes[r.kept].problems.join("; ")}`)}`); })
  }));
}

function pacedSpeaker(spec: GeminiTtsSpec, sleep: (ms: number) => Promise<void>): Speak {
  const model = spec.model ?? DEFAULT_GEMINI_TTS_MODEL;
  const call = geminiCall(spec, model);
  const reserve = slotLimiter(spec.minIntervalMs ?? 0, sleep);
  return async (input, voice) => {
    for (let wait = 0; ; wait++) {
      await reserve();
      try {
        return await call(input, voice);
      } catch (err) {
        const limited = /\b429\b|RESOURCE_EXHAUSTED/.test(err instanceof Error ? err.message : String(err));
        if (!limited) throw err;
        if (wait >= RATE_LIMIT_WAITS_MS.length) throw new TtsRateLimitError((err instanceof Error ? err.message : String(err)).slice(0, 160));
        console.error(`[scriptorium]   Gemini TTS rate limit — waiting ${RATE_LIMIT_WAITS_MS[wait] / 1000}s`);
        await sleep(RATE_LIMIT_WAITS_MS[wait]);
      }
    }
  };
}

// A live speech request (the Interactions API): the transcript as text, the
// direction as its speech_metadata style.
export function speechRequest(input: SpeechInput, voice: string, model: string): Record<string, unknown> {
  if (input.parts?.length) {
    // One label per voice (a walk-on read by the narrator shares the narrator's).
    const labels = new Map<string, string>();
    for (const p of input.parts) if (!labels.has(p.voice)) labels.set(p.voice, p.speaker);
    return {
      model,
      input: [{ type: "user_input", content: input.parts.map((p) => ({ type: "text", text: p.text, annotations: [{ type: "speech_metadata", ...(labels.size > 1 ? { speaker: labels.get(p.voice) } : {}), ...(p.style ? { style: p.style } : {}) }] })) }],
      response_format: { type: "audio" },
      generation_config: { speech_config: labels.size > 1 ? { mode: "conversational", speakers: [...labels].map(([v, speaker]) => ({ speaker, voice: v })) } : [{ voice: input.parts[0].voice }] }
    };
  }
  return {
    model,
    input: [{ type: "user_input", content: [{ type: "text", text: input.text, ...(input.style ? { annotations: [{ type: "speech_metadata", style: input.style }] } : {}) }] }],
    response_format: { type: "audio" },
    generation_config: { speech_config: [{ voice }] }
  };
}

export function speechAudio(data: any): { samples: Float32Array; sampleRate: number } {
  const audio = (data?.steps ?? []).filter((s: { type?: string }) => s.type === "model_output")
    .flatMap((s: { content?: { type?: string; data?: string }[] }) => s.content ?? []).filter((c: { type?: string }) => c.type === "audio").at(-1);
  if (!audio?.data) throw new Error(`Gemini TTS returned no audio (${data?.status ?? "no output"})`);
  return decodeWav(Buffer.from(audio.data, "base64"));
}

// A Batch Mode request body (generateContent), and the audio out of its response.
export function ttsRequest(prompt: string, voice: string): Record<string, unknown> {
  return { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["AUDIO"], speechConfig: speechConfigFor(voice) } };
}

export function audioFrom(data: any): { samples: Float32Array; sampleRate: number } {
  const part = (data?.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown }) => p.inlineData);
  if (!part) throw new Error(`Gemini TTS returned no audio (${data?.candidates?.[0]?.finishReason ?? data?.promptFeedback?.blockReason ?? "no candidates"})`);
  return decodeWav(Buffer.from(part.inlineData.data, "base64"));
}

function geminiCall(spec: GeminiTtsSpec, model: string): Speak {
  return async (input, voice) => {
    if (!readsVerbatim(model)) {
      const data = await postJson(`${GEMINI_BASE}/models/${model}:generateContent`, { "x-goog-api-key": requireKey(spec.apiKeyEnv ?? "GEMINI_API_KEY") }, ttsRequest(legacyPrompt(input), voice),
        { type: "gemini", model, role: "tts", timeoutMs: spec.timeoutMs ?? 60000, retries: spec.retries ?? 1 });
      return audioFrom(data);
    }
    const data = await postJson(
      `${GEMINI_BASE}/interactions`,
      { "x-goog-api-key": requireKey(spec.apiKeyEnv ?? "GEMINI_API_KEY") },
      speechRequest(input, voice, model),
      { type: "gemini", model, role: "tts", timeoutMs: spec.timeoutMs ?? 60000, retries: spec.retries ?? 1 }
    );
    return speechAudio(data);
  };
}

// Speech through Batch Mode: calls made together (a scene's voice batches)
// go out as one batch job at half price.
export function geminiBatchSpeaker(jobs: BatchJobs, spec: GeminiTtsSpec = {}): Speak {
  const model = spec.model ?? DEFAULT_GEMINI_TTS_MODEL;
  const send = microBatcher<{ input: SpeechInput; voice: string }, { samples: Float32Array; sampleRate: number }>(async (reqs) => {
    const items = await jobs.run(model, "tts", reqs.map((r) => ttsRequest(legacyPrompt(r.input), r.voice)));
    return items.map((item) => {
      try { return item.response ? audioFrom(item.response) : new Error(`batch: ${item.error}`); } catch (err) { return err as Error; }
    });
  });
  return (input, voice) => send({ input, voice });
}
