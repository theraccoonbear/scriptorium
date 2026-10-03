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
}

export type Speak = (prompt: string, voice: string) => Promise<{ samples: Float32Array; sampleRate: number }>;

export function geminiSpeaker(spec: GeminiTtsSpec = {}): Speak {
  const model = spec.model ?? DEFAULT_GEMINI_TTS_MODEL;
  return async (prompt, voice) => {
    const data = await postJson(
      `${GEMINI_BASE}/models/${model}:generateContent`,
      { "x-goog-api-key": requireKey(spec.apiKeyEnv ?? "GEMINI_API_KEY") },
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } }
      },
      { type: "gemini", model, role: "tts", timeoutMs: spec.timeoutMs ?? 60000, retries: 2 }
    );
    const part = (data.candidates?.[0]?.content?.parts ?? []).find((p: { inlineData?: unknown }) => p.inlineData);
    if (!part) throw new Error(`Gemini TTS returned no audio (${data.candidates?.[0]?.finishReason ?? data.promptFeedback?.blockReason ?? "no candidates"})`);
    return decodeWav(Buffer.from(part.inlineData.data, "base64"));
  };
}
