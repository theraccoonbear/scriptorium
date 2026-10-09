import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { readApprovals } from "./approvals.ts";
import { roundStatuses } from "./pending.ts";

// Clears what a run no longer needs (#130), once it's settled: review rounds
// already dealt with, the images a redo replaced once the shot is approved,
// samples of speakers no longer cast — and, on request, review sheets (rebuilt
// for free) and old logs. A dry run by default; --apply moves everything to
// runs/_trash/<run>/<time>/ (not deleted), and --purge empties that.
// Never touched: canon (events.jsonl, characters.json, approvals, the ledger,
// art.json and every image it points to, casting), the finished audiobook,
// music and video, notes/, backups/, and the voice batch cache (its takes are
// what let an edit re-voice only the changed lines).

export type CleanupKind = "rounds" | "previous" | "samples" | "sheets" | "logs";
export const DEFAULT_KINDS: readonly CleanupKind[] = ["rounds", "previous", "samples"];
export const ALL_KINDS: readonly CleanupKind[] = ["rounds", "previous", "samples", "sheets", "logs"];

export interface Removable { kind: CleanupKind; path: string; bytes: number; why: string }

async function size(path: string): Promise<number> {
  const s = await stat(path).catch(() => undefined);
  if (!s) return 0;
  if (!s.isDirectory()) return s.size;
  let n = 0;
  for (const e of await readdir(path)) n += await size(join(path, e));
  return n;
}

export async function findRemovable(runDir: string, o: { kinds?: readonly CleanupKind[]; keepLast?: boolean; keepLogs?: number } = {}): Promise<Removable[]> {
  const kinds = new Set(o.kinds ?? DEFAULT_KINDS);
  const out: Removable[] = [];
  const add = async (kind: CleanupKind, path: string, why: string) => out.push({ kind, path, bytes: await size(path), why });

  if (kinds.has("rounds")) {
    for (const s of await roundStatuses(runDir)) if (s.done) await add("rounds", s.round.dir, s.why);
  }

  if (kinds.has("previous")) {
    const approved = new Set((await readApprovals(runDir)).art);
    const dir = join(runDir, "art", "previous");
    for (const key of await readdir(dir).catch(() => [] as string[])) {
      if (!approved.has(key)) continue;
      const takes = (await readdir(join(dir, key)).catch(() => [] as string[])).sort();
      const drop = o.keepLast ? takes.slice(0, -1) : takes;
      if (drop.length === takes.length) await add("previous", join(dir, key), `${key} is approved; replaced take${takes.length === 1 ? "" : "s"}`);
      else for (const t of drop) await add("previous", join(dir, key, t), `${key} is approved; an older replaced take`);
    }
  }

  if (kinds.has("samples")) {
    const cast = await readFile(join(runDir, "audiobook", "casting.json"), "utf8").then((t) => new Set(Object.keys((JSON.parse(t) as { characters?: object }).characters ?? {})), () => undefined);
    const dir = join(runDir, "audiobook", "samples");
    // Only a speaker's sample audio: the reel's metadata and slates stay.
    if (cast) for (const f of (await readdir(dir).catch(() => [] as string[])).filter((x) => /\.(wav|mp3)$/i.test(x))) {
      const id = f.replace(/\.(wav|mp3)$/i, "");
      if (id !== "narrator" && !cast.has(id)) await add("samples", join(dir, f), `${id} is no longer cast`);
    }
  }

  if (kinds.has("sheets")) {
    const dir = join(runDir, "review");
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      if (/\.(jpg|png|mp3|txt)$/i.test(f)) await add("sheets", join(dir, f), "a review sheet: npm run review rebuilds it");
    }
  }

  if (kinds.has("logs")) {
    const keep = o.keepLogs ?? 10;
    for (const sub of ["logs", "threads"]) {
      const dir = join(runDir, sub);
      const files = await readdir(dir).catch(() => [] as string[]);
      const dated = await Promise.all(files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })));
      for (const { f } of dated.sort((a, b) => b.t - a.t).slice(keep)) await add("logs", join(dir, f), `older than the newest ${keep} in ${sub}/`);
    }
  }
  return out;
}

const mb = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

export function formatRemovable(items: Removable[], runDir: string, applied: boolean): string {
  if (items.length === 0) return "Nothing to clean up.";
  const total = items.reduce((n, i) => n + i.bytes, 0);
  const groups = [...new Set(items.map((i) => i.kind))];
  return [
    `${applied ? "Moved to the trash" : "Would clean up"}: ${items.length} item${items.length === 1 ? "" : "s"}, ${mb(total)} (${runDir})`,
    "",
    ...groups.flatMap((g) => {
      const these = items.filter((i) => i.kind === g);
      return [`${g} — ${mb(these.reduce((n, i) => n + i.bytes, 0))}`, ...these.map((i) => `   ${i.path}  (${mb(i.bytes)}; ${i.why})`), ""];
    }),
    applied ? "" : "Run again with --apply to move these to the trash (runs/_trash/); --purge empties it."
  ].filter((l, k, all) => !(l === "" && k === all.length - 1)).join("\n");
}

// The trash for a run: runs/_trash/<run name>/, beside the run.
export function trashDir(runDir: string): string {
  return join(dirname(runDir), "_trash", relative(dirname(runDir), runDir));
}

// Moves the items into the run's trash, keeping their paths under it.
export async function moveToTrash(runDir: string, items: Removable[], now = new Date()): Promise<string> {
  const dest = join(trashDir(runDir), now.toISOString().replace(/[:.]/g, "-"));
  for (const i of items) {
    if (!existsSync(i.path)) continue;
    const to = join(dest, relative(runDir, i.path));
    await mkdir(dirname(to), { recursive: true });
    await rename(i.path, to);
  }
  return dest;
}

export async function purgeTrash(runDir: string): Promise<number> {
  const dir = trashDir(runDir);
  const bytes = await size(dir);
  await rm(dir, { recursive: true, force: true });
  return bytes;
}
