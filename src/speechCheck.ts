import { encodeWav } from "./geminiBatch.ts";
import { postJson, requireKey } from "./providers.ts";

// The speech check: every Gemini take is listened to against its script before
// it's kept. The speech model sometimes says a different word than it was given
// — a rare name swapped for a common one ("Liam McPoyle" → "Liam McCord"), a
// word added or dropped — and nothing about the request prevents it. So a take
// with a wrong word is redone; one still wrong after its tries is kept but
// reported, for the author to hear.

export interface Heard { ok: boolean; heard: string; problems: string[] }
export type HeardCheck = (audio: { samples: Float32Array; sampleRate: number }, script: string) => Promise<Heard>;

export const CHECK_SYSTEM = `You check an audiobook recording against its script. Listen to the audio and compare it with the SCRIPT, word by word.

Output ONLY JSON:
{"heard":string,"problems":[{"script":string,"heard":string}]}

- heard: what was actually said, verbatim.
- problems: every place the speech differs from the script: a word or name replaced by a different one ("McCoy" for "McPoyle"), a word added, a word left out, or anything spoken that isn't in the script.
- A name or unusual word is fine when it's said any reasonable way for its spelling; report it only when it's said as a different name or word.
- Ignore punctuation, pauses, emphasis, accent, tone and speed. Ignore sounds that aren't words (breaths, laughs, sighs), and contractions of the same words ("the day's" for "the day is").
- No problems: "problems":[].`;

const CHECK_MODEL = "gemini-3.8-flash";

export function geminiHeardCheck(spec: { model?: string; apiKeyEnv?: string } = {}): HeardCheck {
  const model = spec.model ?? CHECK_MODEL;
  return async (audio, script) => {
    const data = await postJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { "x-goog-api-key": requireKey(spec.apiKeyEnv ?? "GEMINI_API_KEY") },
      {
        systemInstruction: { parts: [{ text: CHECK_SYSTEM }] },
        contents: [{ parts: [{ inlineData: { mimeType: "audio/wav", data: encodeWav(audio.samples, audio.sampleRate).toString("base64") } }, { text: `SCRIPT:\n${script}` }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0 }
      },
      { type: "gemini", model, role: "speechcheck", timeoutMs: 60000, retries: 1 }
    );
    return parseHeard(data?.candidates?.[0]?.content?.parts?.[0]?.text);
  };
}

export function parseHeard(text: string | undefined): Heard {
  let r: { heard?: unknown; problems?: unknown } = {};
  try { r = JSON.parse(text ?? ""); } catch { /* unreadable: not a pass */ }
  if (!Array.isArray(r.problems)) return { ok: false, heard: "", problems: ["the check's reply was unreadable"] };
  const problems = (r.problems as { script?: unknown; heard?: unknown }[]).map((p) => `"${String(p.script ?? "")}" → "${String(p.heard ?? "")}"`);
  return { ok: problems.length === 0, heard: String(r.heard ?? ""), problems };
}

export interface Unverified { script: string; heard: string; problems: string[] }

type Audio = { samples: Float32Array; sampleRate: number };

// A speaker whose takes are checked: up to `tries` takes, the first clean one
// kept; with none clean, the one with the fewest problems, reported.
export function checkedSpeaker<I extends { text: string }>(
  speak: (input: I, voice: string) => Promise<Audio>,
  check: HeardCheck,
  opts: { tries?: number; onUnverified?: (u: Unverified) => void; onRetake?: (problems: string[]) => void } = {}
): (input: I, voice: string) => Promise<Audio> {
  const tries = opts.tries ?? 3;
  return async (input, voice) => {
    let best: { audio: Audio; heard: Heard } | undefined;
    for (let i = 0; i < tries; i++) {
      const audio = await speak(input, voice);
      let heard: Heard;
      try { heard = await check(audio, input.text); } catch (err) { heard = { ok: false, heard: "", problems: [`check failed: ${(err as Error).message.slice(0, 120)}`] }; }
      if (heard.ok) return audio;
      if (!best || heard.problems.length < best.heard.problems.length) best = { audio, heard };
      if (i < tries - 1) opts.onRetake?.(heard.problems);
    }
    opts.onUnverified?.({ script: input.text, heard: best!.heard.heard, problems: best!.heard.problems });
    return best!.audio;
  };
}
