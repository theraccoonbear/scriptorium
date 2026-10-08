import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readApprovals } from "./approvals.ts";
import { listRounds } from "./rounds.ts";
import type { Round, RoundInfo } from "./rounds.ts";

// What's waiting on the author (#137). A review round is a folder of things to
// look at; this works out from the run whether each one is dealt with, so a
// review request lists what's open, with the exact files to look at (#123):
// - images (a round with keys): done when every image is approved, or redone in a later round;
// - auditions: done when a voice is picked (or the speaker's voice approved, or a newer audition);
// - a canon check: done when applied;
// - a speech check: done when nothing is still flagged, or a newer check of the same subject;
// - any round: done when the author closes it (`review <story> done <N>`).
// A folder made by hand (no round.json) is tracked by the image keys in its name.

export interface Closed { at: string; note?: string }
export interface RoundStatus {
  round: Round;
  kind: string;
  subject: string;
  done: boolean;
  why: string;        // why it's done, or what it waits on
  look: string[];     // the files to look at, most useful first (absolute paths)
}

const KEY = /\b(scene-\d{2}-\d{2}|cover|extra-[a-z0-9]+(?:-[a-z0-9]+)*|character-[a-z0-9_]+|location-[a-z0-9_]+|prop-[a-z0-9_]+)\b/g;
// The image keys a hand-made folder's name mentions: "29-retake-scene-03-10",
// or bare shot numbers as in "35-fixes-06-04-03-10" (scene 6 shot 4, scene 3 shot 10).
export function keysInName(name: string): string[] {
  const rest = name.replace(/^\d+-/, "");
  const named = rest.match(KEY) ?? [];
  const bare = [...rest.replace(KEY, " ").matchAll(/(?:^|-)(\d{2})-(\d{2})(?=-|$)/g)].map((m) => `scene-${m[1]}-${m[2]}`);
  return [...new Set([...named, ...bare])];
}

const LOOK_FIRST = ["changed.jpg", "before-after.jpg", "all.mp3", "inputs.jpg", "legend.txt"];

async function info(round: Round): Promise<(RoundInfo & Record<string, unknown>) | undefined> {
  try { return JSON.parse(await readFile(join(round.dir, "round.json"), "utf8")); } catch { return undefined; }
}

async function lookFiles(round: Round): Promise<string[]> {
  const files = (await readdir(round.dir).catch(() => [] as string[])).filter((f) => f !== "round.json");
  const ranked = [...LOOK_FIRST.filter((f) => files.includes(f)), ...files.filter((f) => /^before-after.*\.jpg$/.test(f) && !LOOK_FIRST.includes(f)).sort()];
  return (ranked.length ? ranked : files.slice(0, 1)).map((f) => join(round.dir, f));
}

export async function roundStatuses(runDir: string): Promise<RoundStatus[]> {
  const rounds = await listRounds(runDir);
  const infos = await Promise.all(rounds.map(info));
  const approved = await readApprovals(runDir);
  const art = new Set(approved.art);
  const keysOf = (k: number) => {
    const i = infos[k];
    if (Array.isArray(i?.keys)) return i!.keys as string[];
    return i ? [] : keysInName(rounds[k].name);
  };
  const kindOf = (k: number) => String(infos[k]?.kind ?? "note");
  const subjectOf = (k: number) => String(infos[k]?.subject ?? rounds[k].name.replace(/^\d+-/, ""));
  const later = (k: number, test: (j: number) => boolean) => rounds.some((_, j) => j > k && test(j));
  const out: RoundStatus[] = [];
  for (const [k, round] of rounds.entries()) {
    const i = infos[k];
    const kind = kindOf(k);
    const subject = subjectOf(k);
    const status = (done: boolean, why: string) => ({ round, kind, subject, done, why });
    let s: Omit<RoundStatus, "look">;
    const closed = i?.closed as Closed | undefined;
    const keys = keysOf(k);
    if (closed) s = status(true, `closed${closed.note ? `: ${closed.note}` : ""}`);
    else if (kind === "auditions") {
      s = i?.picked ? status(true, `picked ${i.picked}`)
        : approved.voices.includes(subject) ? status(true, `voice:${subject} approved`)
        : later(k, (j) => kindOf(j) === "auditions" && subjectOf(j) === subject) ? status(true, "a newer audition replaced it")
        : status(false, `pick a voice: npm run audition -- <story.json> ${subject} --pick N`);
    } else if (kind === "canon") {
      s = i?.applied ? status(true, "applied") : status(false, "choose the fixes, then: npm run canon -- <story.json> --apply [--skip N,…]");
    } else if (kind === "speech-check") {
      const lines = Array.isArray(i?.lines) ? (i!.lines as { ok?: boolean }[]) : [];
      const flagged = lines.filter((l) => l.ok === false).length;
      s = later(k, (j) => kindOf(j) === "speech-check" && subjectOf(j) === subject) ? status(true, "a newer speech check replaced it")
        : flagged === 0 ? status(true, "nothing still flagged")
        : status(false, `listen to ${flagged} line${flagged === 1 ? "" : "s"} still flagged, then close it`);
    } else if (keys.length > 0) {
      const open = keys.filter((key) => !art.has(key) && !later(k, (j) => keysOf(j).includes(key)));
      s = open.length === 0 ? status(true, "every image approved or redone since") : status(false, `approve or redo: ${open.join(", ")}`);
    } else if (i?.migrated) {
      s = status(true, "from before rounds were tracked");
    } else {
      s = status(false, "look, then close it");
    }
    out.push({ ...s, look: await lookFiles(round) });
  }
  return out;
}

export function formatPending(statuses: RoundStatus[], storyFile: string): string {
  const open = statuses.filter((s) => !s.done);
  if (open.length === 0) return "Nothing waiting on you: every review round is dealt with.";
  return [
    `${open.length} review round${open.length === 1 ? "" : "s"} waiting on you:`,
    "",
    ...open.flatMap((s) => [
      `${s.round.name}: ${s.why.replace(/<story\.json>/g, storyFile)}`,
      ...s.look.map((f) => `   ${f}`),
      ""
    ]),
    `Close a round once seen: npm run review -- ${storyFile} done <number> [--note "…"]`
  ].join("\n");
}

// Marks rounds dealt with by hand (a speech check listened to, a note seen).
export async function closeRounds(runDir: string, numbers: number[], note?: string): Promise<string[]> {
  const rounds = await listRounds(runDir);
  const closed: string[] = [];
  for (const n of numbers) {
    const matching = rounds.filter((r) => r.number === n);
    if (matching.length === 0) throw new Error(`no review round ${n}`);
    for (const round of matching) {
      const file = join(round.dir, "round.json");
      const current = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : { kind: "note", subject: round.name.replace(/^\d+-/, "") };
      await writeFile(file, JSON.stringify({ ...current, closed: { at: new Date().toISOString(), ...(note ? { note } : {}) } satisfies Closed }, null, 2) + "\n");
      closed.push(round.name);
    }
  }
  return closed;
}

// Records on a round what was done with it (a pick, an apply).
export async function markRound(round: Round, fields: Record<string, unknown>): Promise<void> {
  const file = join(round.dir, "round.json");
  const current = existsSync(file) ? JSON.parse(await readFile(file, "utf8")) : {};
  await writeFile(file, JSON.stringify({ ...current, ...fields }, null, 2) + "\n");
}
