import { encodeWav } from "./geminiBatch.ts";
import { postJson, requireKey } from "./providers.ts";

// The speech check: every Gemini take is listened to against its script before
// it's kept. The speech model sometimes says a different word than it was given
// — a rare name swapped for a common one ("Liam McPoyle" → "Liam McCord"), a
// word added or dropped — and nothing about the request prevents it. So a take
// with a wrong word is redone; every rejected take is kept in a review round,
// so the author can hear whether the check was right.

export interface Heard { ok: boolean; heard: string; problems: string[] }
export type HeardCheck = (audio: { samples: Float32Array; sampleRate: number }, script: string) => Promise<Heard>;

export const CHECK_SYSTEM = `You check an audiobook recording against its script, listening for real mistakes only. Listen to the audio and compare it with the SCRIPT.

Output ONLY JSON:
{"heard":string,"problems":[{"script":string,"heard":string}]}

- heard: what was actually said, verbatim.
- problems: ONLY these mistakes:
  1. A name said as a different name ("McCoy" or "McCord" for "McPoyle"; "Tancred" for "Tankard").
  2. Words spoken that aren't in the script at all: an invented sentence or phrase, someone's line made up around a dialogue tag.
  3. Part of the script left out: a phrase of several words or more, or a name.
- NOT mistakes, never report them: a small word swapped, added or dropped (him/them, it, the, and, a); contractions ("the day's" for "the day is"); fillers and sounds (huh, ah, hm, breaths, laughs); a name said any reasonable way for its spelling; punctuation, pauses, emphasis, accent, tone, speed.
- When unsure, it's not a mistake. No mistakes: "problems":[].`;

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

type Audio = { samples: Float32Array; sampleRate: number };

// A line where a take failed the check: every take, what was heard in each, and
// whether a later one passed (then the last take is the one kept); if none did,
// the closest (fewest problems) was kept.
export interface CheckReport { script: string; ok: boolean; kept: number; takes: { audio: Audio; heard: string; problems: string[] }[] }

// A speaker whose takes are checked: up to `tries` takes, the first clean one
// kept; with none clean, the one with the fewest problems. Any line with a
// failed take is reported, rejected takes included, so the author can hear
// whether the check was right.
export function checkedSpeaker<I extends { text: string }>(
  speak: (input: I, voice: string) => Promise<Audio>,
  check: HeardCheck,
  opts: { tries?: number; onReport?: (r: CheckReport) => void; onRetake?: (problems: string[]) => void } = {}
): (input: I, voice: string) => Promise<Audio> {
  const tries = opts.tries ?? 3;
  return async (input, voice) => {
    const takes: CheckReport["takes"] = [];
    for (let i = 0; i < tries; i++) {
      const audio = await speak(input, voice);
      let heard: Heard;
      try { heard = await check(audio, input.text); } catch (err) { heard = { ok: false, heard: "", problems: [`check failed: ${(err as Error).message.slice(0, 120)}`] }; }
      takes.push({ audio, heard: heard.heard, problems: heard.problems });
      if (heard.ok) {
        if (takes.length > 1) opts.onReport?.({ script: input.text, ok: true, kept: i, takes });
        return audio;
      }
      if (i < tries - 1) opts.onRetake?.(heard.problems);
    }
    const kept = takes.reduce((best, t, i) => (t.problems.length < takes[best].problems.length ? i : best), 0);
    opts.onReport?.({ script: input.text, ok: false, kept, takes });
    return takes[kept].audio;
  };
}
