import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { replay } from "./bible.ts";
import type { EventLog } from "./eventlog.ts";
import { refAppearances } from "./visualrefs.ts";
import type { AuthorCharactersData, Character, SheetCharacter, StoryEvent } from "./types.ts";

// The author's character sheet: <run>/characters.json, one entry per
// character, drafted from the bible and then edited by the author (or with
// Claude Code). Filled fields override the generated bible for portraits and
// voice casting; every saved version is recorded as an author_characters
// event, so replay holds and later steps see exactly what the author approved.

export const SHEET_FILE = "characters.json";

export interface CharacterSheet {
  characters: Record<string, SheetCharacter>;
}

// The latest sheet the run has recorded, if any.
export function recordedSheet(events: StoryEvent[]): Record<string, SheetCharacter> | undefined {
  const e = events.filter((x) => x.type === "author_characters").at(-1);
  return e ? (e.data as AuthorCharactersData).characters : undefined;
}

// A draft from what the run knows: the bible's characters, their recorded
// gender and vocal, and the look their reference portrait already has.
export function draftSheet(events: StoryEvent[]): CharacterSheet {
  const bible = replay(events);
  const looks = refAppearances(events).characters;
  const characters: Record<string, SheetCharacter> = {};
  for (const c of Object.values(bible.characters).sort((a, b) => a.id.localeCompare(b.id))) characters[c.id] = draftEntry(c, looks[c.id]);
  return { characters };
}

function draftEntry(c: Character, look?: string): SheetCharacter {
  return { name: c.name, gender: c.gender ?? "", appearance: c.appearance ?? look ?? "", background: c.background ?? "", vocal: c.vocal ?? "" };
}

// What a character's portrait is made from on the sheet: when it changes, the
// portrait is out of date.
export function lookOf(c: Pick<Character, "appearance" | "background" | "gender"> | undefined): string | undefined {
  if (!c || !(c.appearance || c.background)) return undefined;
  return JSON.stringify({ appearance: c.appearance ?? "", background: c.background ?? "", gender: c.gender ?? "" });
}

export interface SheetSync {
  file: string;
  created: boolean;     // the sheet was drafted just now
  added: string[];      // characters new to the story, added to the sheet
  recorded: boolean;    // the author's edits were recorded as a new version
}

// Drafts the sheet if the run has none, adds characters the story has gained
// since, and records the author's version when it changed. Never overwrites
// what the author wrote.
export async function syncCharacterSheet(runDir: string, log: EventLog): Promise<SheetSync> {
  const file = join(runDir, SHEET_FILE);
  let sheet: CharacterSheet | undefined;
  try {
    sheet = JSON.parse(await readFile(file, "utf8")) as CharacterSheet;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const created = !sheet;
  const draft = draftSheet(log.events);
  sheet ??= { characters: {} };
  sheet.characters ??= {};
  const added = Object.keys(draft.characters).filter((id) => !sheet!.characters[id]);
  for (const id of added) sheet.characters[id] = draft.characters[id];
  if (created || added.length > 0) await writeFile(file, JSON.stringify(sheet, null, 2) + "\n");
  const before = recordedSheet(log.events);
  const recorded = JSON.stringify(before ?? null) !== JSON.stringify(sheet.characters);
  if (recorded) await log.append("author_characters", { characters: sheet.characters } satisfies AuthorCharactersData);
  return { file, created, added: created ? [] : added, recorded };
}

// Characters the author wants portraits of (all but portrait: false).
export function portraitIds(events: StoryEvent[]): string[] {
  const sheet = recordedSheet(events) ?? {};
  return Object.keys(replay(events).characters).filter((id) => sheet[id]?.portrait !== false).sort();
}
