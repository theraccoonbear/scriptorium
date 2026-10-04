import { postJson, requireKey } from "./providers.ts";

// Gemini TTS for acted lines. Gemini TTS is an LLM that reads its whole prompt
// as context, so direction must be fenced off: an AUDIO PROFILE / THE SCENE /
// DIRECTOR'S NOTES preamble and a "#### TRANSCRIPT" delimiter. Without that
// structure it reads the direction aloud (verified: "Say …:" prefixes and
// [bracketed] notes were both spoken).

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

// One-line sections keep the preamble compact; the transcript is the only
// part the model speaks.
export function buildTtsPrompt(d: LineDirection): string {
  const flat = (s: string) => s.replace(/\s+/g, " ").trim();
  return [
    `# AUDIO PROFILE: ${flat(d.name)}`,
    flat(d.profile),
    ...(d.scene?.trim() ? ["", "## THE SCENE", flat(d.scene)] : []),
    "",
    "### DIRECTOR'S NOTES",
    flat(d.notes?.trim() || "Perform the line in character, with the emotion the scene calls for. Natural pace."),
    "",
    "#### TRANSCRIPT",
    d.line.trim()
  ].join("\n");
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
  model?: string;
  apiKeyEnv?: string;
  timeoutMs?: number;
  retries?: number;  // immediate HTTP retries per call (default 2)
  minIntervalMs?: number;  // least time between requests (pacing for a requests-per-minute cap)
}

export type Speak = (prompt: string, voice: string) => Promise<{ samples: Float32Array; sampleRate: number }>;

// The speechConfig for a voice. Prebuilt and library voices are named in
// prebuiltVoiceConfig; a designed or cloned voice (voice_...) only works as
// voiceConfig.voice (prebuiltVoiceConfig rejects it: "No matching speaker voice").
export function speechConfigFor(voice: string): Record<string, unknown> {
  return voice.startsWith("voice_")
    ? { voiceConfig: { voice } }
    : { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
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

export function geminiSpeaker(spec: GeminiTtsSpec = {}, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Speak {
  const model = spec.model ?? DEFAULT_GEMINI_TTS_MODEL;
  const call = geminiCall(spec, model);
  let last = 0;
  return async (prompt, voice) => {
    for (let wait = 0; ; wait++) {
      const gap = (spec.minIntervalMs ?? 0) - (Date.now() - last);
      if (gap > 0) await sleep(gap);
      last = Date.now();
      try {
        return await call(prompt, voice);
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

function geminiCall(spec: GeminiTtsSpec, model: string): Speak {
  return async (prompt, voice) => {
    const data = await postJson(
      `${GEMINI_BASE}/models/${model}:generateContent`,
      { "x-goog-api-key": requireKey(spec.apiKeyEnv ?? "GEMINI_API_KEY") },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: speechConfigFor(voice) }
      },
      { type: "gemini", model, role: "tts", timeoutMs: spec.timeoutMs ?? 60000, retries: spec.retries ?? 1 }
    );
    const part = (data.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown }) => p.inlineData);
    if (!part) throw new Error(`Gemini TTS returned no audio (${data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? "no candidates"})`);
    return decodeWav(Buffer.from(part.inlineData.data, "base64"));
  };
}
