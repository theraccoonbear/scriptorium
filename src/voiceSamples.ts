import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildScenes, voicedBible } from "./audiobook.ts";
import { encodeWav } from "./geminiBatch.ts";
import { buildTtsPrompt } from "./geminiTts.ts";
import type { Speak } from "./geminiTts.ts";
import type { StoryEvent } from "./types.ts";

// A short sample of every cast voice reading its own lines from the story, for
// the author to sign off on before the whole audiobook is voiced. Kept in
// <run>/audiobook/samples/<id>.wav; a sample is only remade when its voice or
// text changes.

export interface VoiceSample { id: string; name: string; voice: string; text: string; file: string; made: boolean }

// The speaker's first lines, about two sentences' worth (the narrator's first passage).
export function sampleText(events: StoryEvent[], speaker: string, maxChars = 280): string | undefined {
  const lines = buildScenes(events).flatMap((s) => s.segments).filter((g) => g.speaker === speaker).flatMap((g) => g.text.split("\n\n"));
  let text = "";
  for (const line of lines) {
    if (text.length >= maxChars * 0.4) break;
    text = text ? `${text} ${line}` : line;
  }
  if (!text) return undefined;
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "), cut.lastIndexOf('." '));
  return end > maxChars * 0.4 ? cut.slice(0, end + 1).trim() : `${cut.trim()}…`;
}

export async function renderVoiceSamples(events: StoryEvent[], opts: {
  runDir: string;
  voices: Record<string, string>;   // speaker id (and "narrator") -> Gemini voice
  speak: Speak;
  only?: string[];                  // just these speakers
}): Promise<VoiceSample[]> {
  const dir = join(opts.runDir, "audiobook", "samples");
  await mkdir(dir, { recursive: true });
  const indexFile = join(dir, "samples.json");
  let index: Record<string, { voice: string; text: string }> = {};
  try { index = JSON.parse(await readFile(indexFile, "utf8")); } catch { /* first samples */ }
  const bible = voicedBible(events);
  const out: VoiceSample[] = [];
  for (const [id, voice] of Object.entries(opts.voices).sort(([a], [b]) => (a === "narrator" ? -1 : b === "narrator" ? 1 : a.localeCompare(b)))) {
    if (opts.only && !opts.only.includes(id)) continue;
    const text = sampleText(events, id);
    if (!text) continue;
    const c = bible.characters[id];
    const name = id === "narrator" ? "Narrator" : c?.name ?? id;
    const file = join(dir, `${id}.wav`);
    if (index[id]?.voice === voice && index[id]?.text === text) {
      out.push({ id, name, voice, text, file, made: false });
      continue;
    }
    const profile = id === "narrator" ? "The storyteller of this tale." : [c?.vocal, c?.traits].filter(Boolean).join(". ");
    const audio = await opts.speak(buildTtsPrompt({ name, profile, line: text }), voice);
    await writeFile(file, encodeWav(audio.samples, audio.sampleRate));
    index[id] = { voice, text };
    await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
    out.push({ id, name, voice, text, file, made: true });
  }
  return out;
}
