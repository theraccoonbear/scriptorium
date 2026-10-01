import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { replay } from "./bible.ts";
import type { Image } from "./artist.ts";
import type { StoryEvent } from "./types.ts";

// A cast: real people and animals (the author, friends, pets) who star in a
// story, given as photos. Each member is described once from their photos
// (the "cast" event), joins the author context so the story writes them in
// under their own names, and gets a reference portrait made from their photos,
// so every image of them carries their likeness.

export interface CastMember {
  name: string;
  photos: string[];  // absolute paths
  notes?: string;    // who they are in the story, pronouns, anything the photos don't show
}

export interface CastEntry {
  name: string;
  notes?: string;
  photos: string[];  // copies inside the run directory, relative to it (cast/<slug>-N.jpg)
  hash: string;      // name + notes + photo bytes: re-described only when this changes
  kind: "person" | "animal";
  appearance: string;
}

export interface CastData {
  members: CastEntry[];
}

export const CAST_SYSTEM = `You are a casting director. You describe a real person or animal from their photos so an illustrator can draw them recognizably, again and again, in any costume and setting.

Output ONLY JSON:
{"kind":"person"|"animal","appearance":string}

appearance: two to four sentences of what stays the same from picture to picture — never clothing, background, pose or expression.
- A person: apparent age range, build and rough height, skin tone, hair (color, length, texture, style, hairline), facial hair, face shape, and the distinctive features that make them THEM (eyes, brows, nose, glasses, freckles, scars, ears, smile).
- An animal: species and breed (or best guess), size, coat color, length and markings (where exactly), eyes, ears, tail, and anything distinctive.
Be concrete and specific; do not flatter or judge. Never name the person, and never compare them to anyone famous.`;

// Describes one cast member from their photos (Gemini vision in practice).
export interface CastDescriber {
  describe(member: { name: string; notes?: string }, photos: Image[]): Promise<{ kind: "person" | "animal"; appearance: string }>;
}

export function toCastDescription(raw: unknown): { kind: "person" | "animal"; appearance: string } {
  const r = (raw ?? {}) as { kind?: unknown; appearance?: unknown };
  const appearance = typeof r.appearance === "string" ? r.appearance.trim() : "";
  if (!appearance) throw new Error("casting returned no appearance");
  return { kind: r.kind === "animal" ? "animal" : "person", appearance };
}

export function mimeForPath(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  throw new Error(`cast photo ${path}: use a .jpg, .png or .webp file`);
}

export async function loadImage(path: string): Promise<Image> {
  return { data: await readFile(path), mimeType: mimeForPath(path) };
}

export function slug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "member";
}

export function latestCast(events: StoryEvent[]): CastEntry[] {
  const last = [...events].reverse().find((e) => e.type === "cast");
  return last ? (last.data as CastData).members : [];
}

// Describes each member (reusing an earlier description when nothing changed)
// and copies their photos into the run, so the run stays self-contained.
// Returns the entries, and whether they differ from the run's last cast event.
export async function castRun(
  runDir: string,
  members: CastMember[],
  describer: CastDescriber,
  events: StoryEvent[],
  shrink: (img: Image) => Promise<Image> = async (img) => img
): Promise<{ entries: CastEntry[]; changed: boolean }> {
  const names = new Set<string>();
  for (const m of members) {
    if (!m.name?.trim()) throw new Error("cast: every member needs a name");
    if (!m.photos?.length) throw new Error(`cast: ${m.name} needs at least one photo`);
    const key = m.name.trim().toLowerCase();
    if (names.has(key)) throw new Error(`cast: ${m.name} is listed twice`);
    names.add(key);
  }
  const previous = new Map(latestCast(events).map((e) => [e.name, e]));
  await mkdir(join(runDir, "cast"), { recursive: true });
  const entries: CastEntry[] = [];
  for (const m of members) {
    const name = m.name.trim();
    const photos = await Promise.all(m.photos.map(loadImage));
    const h = createHash("sha1").update(name).update("\0").update(m.notes ?? "");
    for (const p of photos) h.update("\0").update(p.data);
    const hash = h.digest("hex");
    const files = m.photos.map((p, n) => `cast/${slug(name)}-${n + 1}${extname(p).toLowerCase()}`);
    await Promise.all(m.photos.map((p, n) => copyFile(p, join(runDir, files[n]))));
    const before = previous.get(name);
    if (before && before.hash === hash) {
      entries.push({ ...before, photos: files });
      continue;
    }
    const described = await describer.describe({ name, notes: m.notes }, await Promise.all(photos.map(shrink)));
    entries.push({ name, ...(m.notes ? { notes: m.notes } : {}), photos: files, hash, ...described });
  }
  const was = latestCast(events);
  const changed = JSON.stringify(was.map((e) => [e.name, e.hash])) !== JSON.stringify(entries.map((e) => [e.name, e.hash]));
  return { entries, changed };
}

// The cast as author context, so the story writes them in by name.
export function castContext(entries: CastEntry[]): string {
  if (entries.length === 0) return "";
  const lines = entries.map((e) => `* ${e.name} (${e.kind === "animal" ? "an animal" : "a person"}): ${e.appearance}${e.notes ? ` Author's note: ${e.notes}` : ""}`);
  return [
    "THE CAST — real people and animals who star in this story. Each one MUST be a character in the story under exactly this name (a character's name may add a title or surname, but must contain this name), and must look as described. The author's notes say who they are; everything else about their role is up to the story.",
    ...lines
  ].join("\n");
}

// Which bible characters are cast members: a character whose name contains a
// member's name as a whole word ("Don" matches "Don Smith", "Sir Don").
export function castCharacters(events: StoryEvent[]): Record<string, CastEntry> {
  const entries = latestCast(events);
  if (entries.length === 0) return {};
  const bible = replay(events);
  const out: Record<string, CastEntry> = {};
  for (const ch of Object.values(bible.characters)) {
    const member = entries.find((e) => {
      const word = new RegExp(`(^|[^\\p{L}\\p{N}])${e.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "iu");
      return word.test(ch.name) || ch.id.toLowerCase() === slug(e.name).replace(/-/g, "_");
    });
    if (member) out[ch.id] = member;
  }
  return out;
}
