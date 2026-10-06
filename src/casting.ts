import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildScenes, voicedBible } from "./audiobook.ts";
import { recordedSheet } from "./characterSheet.ts";
import { castVoices } from "./roles.ts";
import { lineCounts } from "./voiceSamples.ts";
import { designVoice, fetchLibrary, voiceLine } from "./voiceLibrary.ts";
import type { LibraryVoice } from "./voiceLibrary.ts";
import type { Role, StoryEvent } from "./types.ts";

// Voice casting: each speaking character gets a voice from Gemini's library
// (or a voice designed for them), recorded in a cast list. The cast list is
// kept — a run's audiobook/casting.json, or a castingFile shared by every
// chapter of a series — so a character sounds the same every time, and only
// new speakers are cast.

// Who gets a voice of their own (#105). A walk-on part is read by the narrator,
// in character, as a human narrator would: a cast voice for two words costs the
// author a review and the listener a stranger. A speaker gets their own voice
// when the author's sheet says voiced: true, when the story file pins one, or
// when they say at least `min` characters in the whole story (a fair sample's
// worth). voiced: false always goes to the narrator.
export const CAST_MIN = 120;

export function narratorReads(events: StoryEvent[], opts: { min?: number; pinned?: Record<string, string> } = {}): string[] {
  const sheet = recordedSheet(events) ?? {};
  const counts = lineCounts(events);
  // Not a vocal line on the sheet: the writer gives every speaker one, and the
  // sheet is drafted (and later bibles re-recorded) from it, so it can't say who the author meant.
  const own = (id: string) => sheet[id]?.voiced ?? (Boolean(opts.pinned?.[id]) || (counts.get(id) ?? 0) >= (opts.min ?? CAST_MIN));
  return [...counts.keys()].filter((id) => id !== "narrator" && !own(id)).sort();
}

export interface VoiceCastEntry { voice: string; name?: string; reason?: string; designed?: boolean }
export interface VoiceCastSheet { narrator?: VoiceCastEntry; characters: Record<string, VoiceCastEntry> }

export interface VoiceCastOptions {
  events: StoryEvent[];
  role: Role;                          // the voice director
  runDir: string;
  language?: string;                   // "en"
  castingFile?: string;                // shared cast list (default: <runDir>/audiobook/casting.json)
  designVoices?: string[];             // character ids to give a designed voice
  pinned?: Record<string, string>;     // geminiVoices from the story file: always win
  recast?: string[];                   // speaker ids (or "narrator") to cast afresh
  castMin?: number;                    // characters spoken to earn a voice of their own (default CAST_MIN)
  library?: () => Promise<LibraryVoice[]>;                              // injectable
  design?: typeof designVoice;                                          // injectable
  log?: (msg: string) => void;
}

export async function loadVoiceCastSheet(path: string): Promise<VoiceCastSheet> {
  try { return JSON.parse(await readFile(path, "utf8")) as VoiceCastSheet; } catch { return { characters: {} }; }
}

// Casts whoever needs a voice; returns speaker id (and "narrator") -> Gemini voice.
export async function castVoiceRun(o: VoiceCastOptions): Promise<Record<string, string>> {
  const log = o.log ?? ((m) => console.error(m));
  const file = o.castingFile ?? join(o.runDir, "audiobook", "casting.json");
  const sheet = await loadVoiceCastSheet(file);
  const pinned = o.pinned ?? {};
  const bible = voicedBible(o.events);
  const byNarrator = new Set(narratorReads(o.events, { min: o.castMin, pinned }));
  const speakers = [...new Set(buildScenes(o.events).flatMap((s) => s.segments.map((x) => x.speaker)))].filter((id) => id !== "narrator" && !byNarrator.has(id));
  let changed = false;
  for (const id of o.recast ?? []) {
    if (id === "narrator") delete sheet.narrator;
    else delete sheet.characters[id];
    changed = true;
  }

  // Designed voices for the listed leads (once; the id is kept in the cast list).
  for (const id of (o.designVoices ?? []).filter((id) => speakers.includes(id) && !pinned[id] && !sheet.characters[id]?.designed)) {
    const ch = bible.characters[id];
    if (!ch) continue;
    const description = [ch.vocal, ch.gender && `${ch.gender} voice`, ch.voice && `Speaks: ${ch.voice}`, ch.traits && `Character: ${ch.traits}`].filter(Boolean).join(". ");
    const made = await (o.design ?? designVoice)({ name: ch.name, description });
    sheet.characters[id] = { voice: made.id, name: ch.name, designed: true, reason: "designed from the character's vocal description" };
    if (made.preview) {
      await mkdir(join(o.runDir, "audiobook", "voices"), { recursive: true });
      await writeFile(join(o.runDir, "audiobook", "voices", `${id}.wav`), made.preview);
    }
    log(`[scriptorium] voice designed for ${ch.name}: ${made.id}`);
    changed = true;
  }

  const toCast = speakers.filter((id) => !pinned[id] && !sheet.characters[id]);
  const needNarrator = !pinned.narrator && !sheet.narrator;
  if (toCast.length > 0 || needNarrator) {
    const library = (await (o.library ?? (() => fetchLibrary(o.language ?? "en")))()).filter((v) => v.language_code.startsWith(o.language ?? "en"));
    const taken = [...Object.values(sheet.characters).map((c) => c.voice), ...(sheet.narrator ? [sheet.narrator.voice] : []), ...Object.values(pinned)];
    const out = await castVoices(o.role, {
      characters: toCast.map((id) => {
        const ch = bible.characters[id];
        return { id, name: ch?.name ?? id, ...(ch?.gender ? { gender: ch.gender } : {}), ...(ch?.vocal ? { vocal: ch.vocal } : {}), traits: ch?.traits ?? "", voice: ch?.voice ?? "" };
      }),
      narrator: needNarrator,
      tone: bible.tone,
      library: library.map((v) => ({ id: v.id, gender: v.gender, line: voiceLine(v) })),
      taken
    });
    for (const [id, voice] of Object.entries(out.result.characters)) {
      sheet.characters[id] = { voice, name: bible.characters[id]?.name ?? id, ...(out.result.reasons[id] ? { reason: out.result.reasons[id] } : {}) };
      log(`[scriptorium] cast ${sheet.characters[id].name} as ${voice}${out.result.reasons[id] ? ` — ${out.result.reasons[id]}` : ""}`);
    }
    if (out.result.narrator) {
      sheet.narrator = { voice: out.result.narrator, ...(out.result.reasons.narrator ? { reason: out.result.reasons.narrator } : {}) };
      log(`[scriptorium] cast the narrator as ${out.result.narrator}${out.result.reasons.narrator ? ` — ${out.result.reasons.narrator}` : ""}`);
    }
    changed = true;
  }
  if (changed) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(sheet, null, 2) + "\n");
  }
  // A cast list shared across chapters keeps everyone's voice; walk-on parts here go to the narrator.
  const voices: Record<string, string> = Object.fromEntries(Object.entries(sheet.characters).filter(([id]) => !byNarrator.has(id)).map(([id, c]) => [id, c.voice]));
  if (sheet.narrator) voices.narrator = sheet.narrator.voice;
  return { ...voices, ...pinned };
}
