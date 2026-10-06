import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildScenes, voicedBible } from "./audiobook.ts";
import { encodeWav } from "./geminiBatch.ts";
import { buildTtsPrompt } from "./geminiTts.ts";
import type { Speak } from "./geminiTts.ts";
import type { StoryEvent } from "./types.ts";

// The casting reel: every cast voice reading a fair sample, announced by name,
// for the author to sign off on before the whole audiobook is voiced. Samples
// are about the same length (8-15 seconds): a continuous stretch of the
// speaker's own lines when the story gives them enough, else a short audition
// line written in character. Kept in <run>/audiobook/samples/<id>.wav, with the
// narrator's announcement of each name in samples/slates/<id>.wav; each is
// remade only when its voice or words change.

export const SAMPLE_MIN = 120;   // characters: about 8 seconds of speech
export const SAMPLE_MAX = 300;   // about 15 seconds

export interface VoiceSample {
  id: string;
  name: string;
  voice: string;
  text: string;
  source: "story" | "audition";
  file: string;
  slate?: string;
  made: boolean;
}

export interface SampleIndexEntry { voice: string; text: string; source?: "story" | "audition"; name?: string; order?: number; slate?: string; slateVoice?: string }

// A spoken piece without its quotation marks and dialogue tags' leftovers.
function spoken(text: string): string {
  return text.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
}

// A continuous stretch of the speaker's own lines, SAMPLE_MIN-SAMPLE_MAX
// characters, cut at a sentence; undefined when the story gives them less.
export function sampleText(events: StoryEvent[], speaker: string, min = SAMPLE_MIN, max = SAMPLE_MAX): string | undefined {
  const lines = buildScenes(events).flatMap((s) => s.segments).filter((g) => g.speaker === speaker)
    .flatMap((g) => g.text.split("\n\n")).map(speaker === "narrator" ? (t: string) => t.trim() : spoken).filter(Boolean)
    // The narrator's pieces between quotes are often bare dialogue tags ("Lemuel said."): not a sample.
    .filter((t) => speaker !== "narrator" || !(t.length < 40 && /\b(said|asked|replied|told|called|answered|whispered|shouted)\b/i.test(t)));
  // Start where a stretch long enough begins, from the first line.
  for (let start = 0; start < lines.length; start++) {
    let text = "";
    for (const line of lines.slice(start)) {
      text = text ? `${text} ${line}` : line;
      if (text.length >= min) break;
    }
    if (text.length < min) break;
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
    if (end >= min - 1) return cut.slice(0, end + 1).trim();
  }
  return undefined;
}

// How much each speaker says in the story (narration included), for the reel's order.
export function lineCounts(events: StoryEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of buildScenes(events)) for (const g of s.segments) counts.set(g.speaker, (counts.get(g.speaker) ?? 0) + g.text.length);
  return counts;
}

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

export async function renderVoiceSamples(events: StoryEvent[], opts: {
  runDir: string;
  voices: Record<string, string>;     // speaker id (and "narrator") -> Gemini voice
  speak: Speak;
  only?: string[];                    // just these speakers
  auditions?: Record<string, string>; // audition lines for speakers the story gives too little
}): Promise<VoiceSample[]> {
  const dir = join(opts.runDir, "audiobook", "samples");
  await mkdir(join(dir, "slates"), { recursive: true });
  const indexFile = join(dir, "samples.json");
  let index: Record<string, SampleIndexEntry> = {};
  try { index = JSON.parse(await readFile(indexFile, "utf8")); } catch { /* first samples */ }
  const bible = voicedBible(events);
  const counts = lineCounts(events);
  const narrator = opts.voices.narrator;
  // The narrator first, then whoever speaks most.
  const ids = Object.keys(opts.voices).sort((a, b) => (a === "narrator" ? -1 : b === "narrator" ? 1 : (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b)));
  const out: VoiceSample[] = [];
  for (const [order, id] of ids.entries()) {
    const voice = opts.voices[id];
    // The narrator is always in the reel: with too little narration for a full sample, whatever there is.
    const story = sampleText(events, id) ?? (id === "narrator" ? sampleText(events, id, 1) : undefined);
    const text = story ?? opts.auditions?.[id];
    if (!text) continue;
    const source = story ? "story" : "audition";
    const c = bible.characters[id];
    const name = id === "narrator" ? "The narrator" : c?.name || id.replace(/[_-]+/g, " ").replace(/^\w/, (ch) => ch.toUpperCase());
    const file = join(dir, `${id}.wav`);
    const prev = index[id];
    let made = false;
    if (!(opts.only && !opts.only.includes(id)) && !(prev?.voice === voice && prev?.text === text)) {
      const profile = id === "narrator" ? "The storyteller of this tale." : [c?.vocal, c?.traits].filter(Boolean).join(". ");
      const audio = await opts.speak(buildTtsPrompt({ name, profile, line: text }), voice);
      await writeFile(file, encodeWav(audio.samples, audio.sampleRate));
      made = true;
    }
    // The narrator announces each name: who you're about to hear.
    let slate: string | undefined;
    if (narrator) {
      slate = join(dir, "slates", `${id}.wav`);
      if (!(prev?.slate === hash(name) && prev?.slateVoice === narrator)) {
        const audio = await opts.speak(buildTtsPrompt({ name: "Narrator", profile: "Announcing the next voice in a casting reel, plainly.", line: `${name}.` }), narrator);
        await writeFile(slate, encodeWav(audio.samples, audio.sampleRate));
      }
    }
    index[id] = { voice, text, source, name, order, ...(slate ? { slate: hash(name), slateVoice: narrator } : {}) };
    await writeFile(indexFile, JSON.stringify(index, null, 2) + "\n");
    out.push({ id, name, voice, text, source, file, ...(slate ? { slate } : {}), made });
  }
  return out;
}

// Speakers the story gives too little to judge a voice by: they get an audition line.
export function needAuditions(events: StoryEvent[], ids: string[]): string[] {
  return ids.filter((id) => id !== "narrator" && !sampleText(events, id));
}
