import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { encodeWav } from "./geminiBatch.ts";
import { montageArgs } from "./reviewSheets.ts";
import type { CheckReport } from "./speechCheck.ts";
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
    ...keys.map((k) => `${k}${manifest[k] && !manifest[k].accepted ? "  (kept after its retries ran out)" : ""}`),
    "",
    "The images these replaced are kept in art/previous/<key>/."
  ].join("\n") + "\n");
  const tiles = keys.filter((k) => manifest[k]).map((k) => ({ label: k, file: join(runDir, "art", manifest[k].file) }));
  try {
    await run("magick", montageArgs(tiles, join(round.dir, "changed.jpg")));
  } catch (err) {
    console.error(`[scriptorium] review round ${round.name}: no contact sheet (${(err as Error).message.split("\n")[0]}) — the images are in art/`);
  }
  return round;
}

// Every line the speech check flagged, with each take as audio: what the
// script says, what the check heard, and which take was kept — so the author
// can hear whether the check was right.
export async function speechCheckRound(runDir: string, subject: string, reports: CheckReport[]): Promise<Round | undefined> {
  if (reports.length === 0) return undefined;
  const round = await newRound(runDir, { kind: "speech-check", subject, lines: reports.map((r) => ({ script: r.script, ok: r.ok, kept: r.kept, takes: r.takes.map((t) => ({ heard: t.heard, problems: t.problems })) })) });
  const legend: string[] = [
    `speech check: ${reports.length} line${reports.length === 1 ? "" : "s"} flagged; ${reports.filter((r) => !r.ok).length} still flagged after every take (the closest was kept).`,
    "Each take is here as NN-T.mp3 (line NN, take T). Listen to the flagged ones: if the check was wrong, say so.",
    ""
  ];
  for (const [i, r] of reports.entries()) {
    const n = String(i + 1).padStart(2, "0");
    legend.push(`${n}. ${r.ok ? `fixed on take ${r.kept + 1}` : `STILL FLAGGED — kept take ${r.kept + 1}`}`, `    script: ${r.script.replace(/\s+/g, " ")}`);
    for (const [t, take] of r.takes.entries()) {
      const file = join(round.dir, `${n}-${t + 1}`);
      await writeFile(`${file}.wav`, encodeWav(take.audio.samples, take.audio.sampleRate));
      try { await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", `${file}.wav`, "-codec:a", "libmp3lame", "-q:a", "4", `${file}.mp3`]); await rm(`${file}.wav`, { force: true }); } catch { /* keep the wav */ }
      legend.push(`    take ${t + 1}${t === r.kept ? " (kept)" : ""}: ${take.problems.length ? take.problems.join("; ") : "passed"}`, `      heard: ${take.heard.replace(/\s+/g, " ")}`);
    }
    legend.push("");
  }
  await writeFile(join(round.dir, "legend.txt"), legend.join("\n"));
  return round;
}
