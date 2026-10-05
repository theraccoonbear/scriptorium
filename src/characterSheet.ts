import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { replay } from "./bible.ts";
import { mimeForPath } from "./cast.ts";
import type { EventLog } from "./eventlog.ts";
import { refAppearances } from "./visualrefs.ts";
import type { AuthorCharactersData, Character, SheetCharacter, SheetReference, StoryEvent } from "./types.ts";

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
// portrait is out of date. (The reference joins only when there is one, so
// portraits made before references existed aren't suddenly out of date.)
export function lookOf(c: Pick<Character, "appearance" | "background" | "gender" | "reference"> | undefined): string | undefined {
  if (!c || !(c.appearance || c.background || c.reference)) return undefined;
  return JSON.stringify({ appearance: c.appearance ?? "", background: c.background ?? "", gender: c.gender ?? "", ...(c.reference ? { reference: c.reference.hash } : {}) });
}

// The reference images the run last recorded.
export function recordedReferences(events: StoryEvent[]): Record<string, SheetReference> {
  const e = events.filter((x) => x.type === "author_characters").at(-1);
  return e ? (e.data as AuthorCharactersData).references ?? {} : {};
}

// Copies each character's reference image into the run (references/<id>.<ext>),
// so the run stands on its own, and hashes it, so a new image at the same path
// counts as an edit. Paths are relative to characters.json.
export async function syncReferences(runDir: string, characters: Record<string, SheetCharacter>): Promise<Record<string, SheetReference>> {
  const out: Record<string, SheetReference> = {};
  for (const [id, s] of Object.entries(characters)) {
    const ref = s.reference?.trim();
    if (!ref) continue;
    const source = isAbsolute(ref) ? ref : resolve(runDir, ref);
    try { mimeForPath(source); } catch { throw new Error(`${SHEET_FILE}: ${id}'s reference ${ref} must be a .png, .jpg or .webp image`); }
    let bytes: Buffer;
    try { bytes = await readFile(source); } catch { throw new Error(`${SHEET_FILE}: ${id}'s reference ${ref} not found (paths are relative to ${join(runDir, SHEET_FILE)})`); }
    const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
    const file = `references/${id}${extname(source).toLowerCase()}`;
    const current = await readFile(join(runDir, file)).catch(() => undefined);
    if (!current?.equals(bytes)) {
      await mkdir(join(runDir, "references"), { recursive: true });
      await writeFile(join(runDir, file), bytes);
    }
    out[id] = { file, hash };
  }
  return out;
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
  const references = await syncReferences(runDir, sheet.characters);
  const before = recordedSheet(log.events);
  const recorded = JSON.stringify(before ?? null) !== JSON.stringify(sheet.characters)
    || JSON.stringify(recordedReferences(log.events)) !== JSON.stringify(references);
  if (recorded) await log.append("author_characters", { characters: sheet.characters, ...(Object.keys(references).length ? { references } : {}) } satisfies AuthorCharactersData);
  return { file, created, added: created ? [] : added, recorded };
}

// Characters the author wants portraits of (all but portrait: false).
export function portraitIds(events: StoryEvent[]): string[] {
  const sheet = recordedSheet(events) ?? {};
  return Object.keys(replay(events).characters).filter((id) => sheet[id]?.portrait !== false).sort();
}
