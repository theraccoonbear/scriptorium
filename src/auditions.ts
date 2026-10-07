import { execFile } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { voicedBible } from "./audiobook.ts";
import { recordedSheet } from "./characterSheet.ts";
import { encodeWav } from "./geminiBatch.ts";
import { buildTtsPrompt } from "./geminiTts.ts";
import type { Speak } from "./geminiTts.ts";
import { suggestVoices } from "./roles.ts";
import { findRound, newRound, readRound } from "./rounds.ts";
import type { Round, RoundInfo } from "./rounds.ts";
import { voiceLine } from "./voiceLibrary.ts";
import type { LibraryVoice } from "./voiceLibrary.ts";
import type { SampleIndexEntry } from "./voiceSamples.ts";
import type { Role, StoryEvent } from "./types.ts";

// Auditions: one character's reel line read by a handful of voices, for the
// author to pick from — their current voice first, then candidates (the
// author's, or the voice director's from the library). Each audition is a
// review round (review/rounds/NN-auditions-<id>/); picking one pins the voice
// in the story file and, when the audition had a new direction, writes it to
// the character sheet as their vocal line.

export interface AuditionCandidate { n: number; voice: string; reason?: string; start: number; seconds: number }
export interface AuditionRound extends RoundInfo { kind: "auditions"; subject: string; name: string; line: string; direction: string; candidates: AuditionCandidate[] }

const GAP = 2;  // seconds between voices

// What a speaker reads in an audition (their reel line) and how they're directed.
async function auditionLine(runDir: string, events: StoryEvent[], id: string): Promise<{ line: string; current?: string; name: string; gender?: string; vocal: string; others: string[] }> {
  let index: Record<string, SampleIndexEntry> = {};
  try { index = JSON.parse(await readFile(join(runDir, "audiobook", "samples", "samples.json"), "utf8")); } catch { /* no reel yet */ }
  const entry = index[id];
  if (!entry) throw new Error(`no reel sample for "${id}" — run make --only voices first (speakers: ${Object.keys(index).join(", ") || "none"})`);
  const ch = voicedBible(events).characters[id];
  const sheet = recordedSheet(events)?.[id];
  return {
    line: entry.text, current: entry.voice, name: ch?.name ?? entry.name ?? id, ...(ch?.gender ? { gender: ch.gender } : {}),
    vocal: sheet?.vocal?.trim() || ch?.vocal || ch?.traits || "",
    others: Object.entries(index).filter(([k]) => k !== id).map(([, e]) => e.voice)
  };
}

export async function runAudition(o: {
  runDir: string;
  events: StoryEvent[];
  id: string;
  speak: Speak;
  direction?: string;            // how they should sound now (default: their vocal line)
  voices?: string[];             // the author's candidates (else the voice director's)
  count?: number;                // candidates to suggest (default 5)
  role?: Role;                   // the voice director
  library?: () => Promise<LibraryVoice[]>;
  encodeMp3?: (wav: string, mp3: string) => Promise<void>;
}): Promise<{ round: Round; info: AuditionRound }> {
  const a = await auditionLine(o.runDir, o.events, o.id);
  const direction = o.direction?.trim() || a.vocal;
  let picks: { id: string; reason?: string }[] = (o.voices ?? []).map((id) => ({ id }));
  if (picks.length === 0) {
    if (!o.role || !o.library) throw new Error("no voices given (--voices) and no voice director to suggest some (needs a config)");
    picks = await suggestVoices(o.role, { name: a.name, ...(a.gender ? { gender: a.gender } : {}), direction, library: (await o.library()).map((v) => ({ id: v.id, gender: v.gender, line: voiceLine(v) })), exclude: [...(a.current ? [a.current] : []), ...a.others], count: o.count ?? 5 });
  }
  const voices = [...(a.current ? [{ id: a.current, reason: "current voice" }] : []), ...picks.filter((p) => p.id !== a.current)];
  const round = await newRound(o.runDir, { kind: "auditions", subject: o.id });
  const encode = o.encodeMp3 ?? (async (wav: string, mp3: string) => { await promisify(execFile)("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", wav, "-codec:a", "libmp3lame", "-q:a", "4", mp3]); });
  const candidates: AuditionCandidate[] = [];
  const parts: Float32Array[] = [];
  let rate = 24000;
  let start = 0;
  for (const [i, v] of voices.entries()) {
    const audio = await o.speak(buildTtsPrompt({ name: a.name, profile: direction, line: a.line }), v.id);
    rate = audio.sampleRate;
    const seconds = audio.samples.length / audio.sampleRate;
    candidates.push({ n: i + 1, voice: v.id, ...(v.reason ? { reason: v.reason } : {}), start, seconds });
    parts.push(audio.samples, new Float32Array(Math.round(GAP * rate)));
    start += seconds + GAP;
    const file = join(round.dir, `${i + 1}-${v.id}`);
    await writeFile(`${file}.wav`, encodeWav(audio.samples, audio.sampleRate));
    await encode(`${file}.wav`, `${file}.mp3`);
    await rm(`${file}.wav`, { force: true });
  }
  const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (all.set(p, at), at + p.length), 0);
  await writeFile(join(round.dir, "all.wav"), encodeWav(all, rate));
  await encode(join(round.dir, "all.wav"), join(round.dir, "all.mp3"));
  await rm(join(round.dir, "all.wav"), { force: true });
  const info: AuditionRound = { kind: "auditions", subject: o.id, name: a.name, line: a.line, direction, candidates };
  await writeFile(join(round.dir, "round.json"), JSON.stringify(info, null, 2) + "\n");
  await writeFile(join(round.dir, "legend.txt"), formatAudition(info, round.number) + "\n");
  return { round, info };
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export function formatAudition(info: AuditionRound, number: number): string {
  return [
    `Round ${number}: auditions for ${info.name} — their reel line in each voice, ${GAP} s apart (all.mp3)`,
    `Directed as: ${info.direction}`,
    "",
    ...info.candidates.map((c) => `${clock(c.start)}  ${c.n}  ${c.voice}${c.reason ? `: ${c.reason}` : ""}`),
    "",
    `Pick one: npm run audition -- <story.json> ${info.subject} --pick <n>`
  ].join("\n");
}

// Picking a candidate: pin the voice in the story file; a new direction becomes
// the character's vocal line on the sheet. Returns what changed.
export async function pickAudition(o: { storyFile: string; runDir: string; id: string; pick: number; round?: number }): Promise<{ voice: string; vocal?: string; round: Round }> {
  const round = await findRound(o.runDir, "auditions", o.id, o.round);
  if (!round) throw new Error(`no auditions for "${o.id}" yet — run: npm run audition -- ${o.storyFile} ${o.id}`);
  const info = await readRound<AuditionRound>(round);
  if (info.subject !== o.id) throw new Error(`round ${round.name} auditions "${info.subject}", not "${o.id}"`);
  if (!Array.isArray(info.candidates)) throw new Error(`round ${round.name} has no candidates to pick from (made by hand before auditions were a command) — run a new audition`);
  const c = info.candidates.find((x) => x.n === o.pick);
  if (!c) throw new Error(`round ${round.name} has candidates 1-${info.candidates.length}`);
  const story = JSON.parse(await readFile(o.storyFile, "utf8"));
  story.audiobook = { ...story.audiobook, geminiVoices: { ...story.audiobook?.geminiVoices, [o.id]: c.voice } };
  await writeFile(o.storyFile, JSON.stringify(story, null, 2) + "\n");
  const sheetFile = join(o.runDir, "characters.json");
  let vocal: string | undefined;
  try {
    const sheet = JSON.parse(await readFile(sheetFile, "utf8"));
    if (sheet.characters?.[o.id] && sheet.characters[o.id].vocal !== info.direction) {
      sheet.characters[o.id].vocal = vocal = info.direction;
      await writeFile(sheetFile, JSON.stringify(sheet, null, 2) + "\n");
    }
  } catch { /* no sheet: the voice alone */ }
  return { voice: c.voice, ...(vocal ? { vocal } : {}), round };
}
