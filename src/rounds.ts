import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { montageArgs } from "./reviewSheets.ts";
import type { ArtManifest } from "./artist.ts";

// Review rounds: every look the author is asked to take that isn't the current
// state (auditions, redos, retakes) goes in its own numbered folder,
// <run>/review/rounds/NN-<kind>-<subject>/, holding one file to look at (a
// contact sheet or one joined MP3), a legend.txt and a round.json. The newest
// round is the highest number; review/ itself holds only the current state.

export interface RoundInfo { kind: string; subject: string; [key: string]: unknown }
export interface Round { number: number; dir: string; name: string }

const run = promisify(execFile);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "round";
const roundsDir = (runDir: string) => join(runDir, "review", "rounds");

export async function listRounds(runDir: string): Promise<Round[]> {
  let names: string[] = [];
  try { names = await readdir(roundsDir(runDir)); } catch { return []; }
  return names.map((name) => ({ name, number: Number(name.match(/^(\d+)-/)?.[1]) }))
    .filter((r) => Number.isFinite(r.number))
    .map((r) => ({ ...r, dir: join(roundsDir(runDir), r.name) }))
    .sort((a, b) => a.number - b.number);
}

export async function newRound(runDir: string, info: RoundInfo): Promise<Round> {
  const number = ((await listRounds(runDir)).at(-1)?.number ?? 0) + 1;
  const name = `${String(number).padStart(2, "0")}-${slug(info.kind)}-${slug(info.subject)}`;
  const dir = join(roundsDir(runDir), name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "round.json"), JSON.stringify(info, null, 2) + "\n");
  return { number, dir, name };
}

export async function readRound<T extends RoundInfo>(round: Round): Promise<T> {
  return JSON.parse(await readFile(join(round.dir, "round.json"), "utf8")) as T;
}

// The newest round of a kind (and subject), or a given number.
export async function findRound(runDir: string, kind: string, subject?: string, number?: number): Promise<Round | undefined> {
  const rounds = await listRounds(runDir);
  if (number !== undefined) return rounds.find((r) => r.number === number);
  const rest = (r: Round) => r.name.slice(r.name.indexOf("-") + 1);
  return rounds.filter((r) => (subject ? rest(r) === `${slug(kind)}-${slug(subject)}` : rest(r).startsWith(`${slug(kind)}-`))).at(-1);
}

// ---- images: what an art run changed ----

export type ArtSnapshot = Map<string, string>;  // key -> its file's size and time

export async function snapshotArt(runDir: string): Promise<ArtSnapshot> {
  const out: ArtSnapshot = new Map();
  let manifest: ArtManifest = {};
  try { manifest = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8")); } catch { return out; }
  for (const [key, e] of Object.entries(manifest)) {
    try { const s = await stat(join(runDir, "art", e.file)); out.set(key, `${s.size}:${s.mtimeMs}`); } catch { /* not on disk */ }
  }
  return out;
}

export function changedKeys(before: ArtSnapshot, after: ArtSnapshot): string[] {
  return [...after.keys()].filter((k) => before.get(k) !== after.get(k)).sort();
}

// A round showing just the images an art run made or remade.
export async function imageRound(runDir: string, keys: string[], info: RoundInfo & { note?: string }): Promise<Round | undefined> {
  if (keys.length === 0) return undefined;
  const manifest: ArtManifest = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));
  const round = await newRound(runDir, { ...info, keys });
  await writeFile(join(round.dir, "legend.txt"), [
    `${info.kind}: ${info.subject} — ${keys.length} image${keys.length === 1 ? "" : "s"} (changed.jpg)`,
    ...(info.note ? [`note: ${info.note}`] : []),
    "",
    ...keys.map((k) => `${k}${manifest[k] && !manifest[k].accepted ? "  (kept after its retries ran out)" : ""}`)
  ].join("\n") + "\n");
  const tiles = keys.filter((k) => manifest[k]).map((k) => ({ label: k, file: join(runDir, "art", manifest[k].file) }));
  try {
    await run("magick", montageArgs(tiles, join(round.dir, "changed.jpg")));
  } catch (err) {
    console.error(`[scriptorium] review round ${round.name}: no contact sheet (${(err as Error).message.split("\n")[0]}) — the images are in art/`);
  }
  return round;
}
