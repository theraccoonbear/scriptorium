import { copyFile, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { BUDGET_KINDS, LEDGER_FILE, formatSummary, isScratchRun, kindOf, readLedger, summarize, usd } from "./usage.ts";
import type { CostKind, LedgerEntry } from "./usage.ts";

// Spend across runs, by what it was for (#148): `spend <story>` for one run,
// `spend --all` for every ledger under runs/ (scratch runs included), and
// `--retag` to mark a stretch of a run's history as dev (or any kind) after the fact.

export interface SpendFilter { since?: string; kind?: CostKind; tag?: string }

// A run's ledger; older entries without a kind count as experiment in a scratch run.
export function ledgerFor(runDir: string): LedgerEntry[] {
  const scratch = isScratchRun(runDir);
  return readLedger(runDir).map((e) => (e.kind || !scratch ? e : { ...e, kind: "experiment" as const }));
}

export function filterEntries(entries: LedgerEntry[], f: SpendFilter = {}): LedgerEntry[] {
  return entries.filter((e) => (!f.since || e.ts >= f.since) && (!f.kind || kindOf(e) === f.kind) && (!f.tag || e.tag === f.tag));
}

// Every run directory under `root` that has a ledger (node_modules and the
// video's intermediate parts are skipped).
export async function findLedgers(root: string, depth = 4): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, left: number) => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    if (entries.some((e) => e.isFile() && e.name === LEDGER_FILE)) out.push(dir);
    if (left === 0) return;
    for (const e of entries) if (e.isDirectory() && !["node_modules", ".git", "parts", "previous"].includes(e.name)) await walk(join(dir, e.name), left - 1);
  };
  await walk(root, depth);
  return out.sort();
}

// One line per run (its total and the kinds in it), then the totals by kind and by tag.
export function spendAcross(runs: Array<{ runDir: string; entries: LedgerEntry[] }>, root: string): string {
  const all = runs.flatMap((r) => r.entries);
  const s = summarize(all);
  const width = Math.max(...runs.map((r) => relative(root, r.runDir).length), 4);
  const lines = runs.filter((r) => r.entries.length).map((r) => {
    const rs = summarize(r.entries);
    const kinds = Object.entries(rs.byKind).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${usd(v)}`).join(" · ");
    return `${relative(root, r.runDir).padEnd(width)}  ${usd(rs.total).padStart(8)}  ${kinds}`;
  });
  const by = (rec: Record<string, number>) => Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${usd(v)}`).join(" · ") || "—";
  return [
    ...lines,
    "",
    `total ${usd(s.total)} over ${s.calls} calls in ${lines.length} run${lines.length === 1 ? "" : "s"}`,
    `by kind: ${by(s.byKind as Record<string, number>)}`,
    `by tag: ${by(s.byTag)}`
  ].join("\n");
}

export function spendForRun(entries: LedgerEntry[], budgetUsd?: number, budgetKinds: readonly CostKind[] = BUDGET_KINDS): string {
  return formatSummary(summarize(entries), budgetUsd, budgetKinds);
}

// Marks entries (by time range and/or step) as `kind`, with `tag` if given,
// after backing the ledger up. Returns how many changed and where the backup is.
export async function retag(runDir: string, o: { kind: CostKind; tag?: string; after?: string; before?: string; step?: string }): Promise<{ changed: number; backup: string }> {
  const entries = readLedger(runDir);
  const backups = join(runDir, "backups");
  await mkdir(backups, { recursive: true });
  const backup = join(backups, `${LEDGER_FILE}.before-retag-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  await copyFile(join(runDir, LEDGER_FILE), backup);
  let changed = 0;
  const out = entries.map((e) => {
    if ((o.after && e.ts < o.after) || (o.before && e.ts >= o.before) || (o.step && e.step !== o.step)) return e;
    changed++;
    const { tag: _old, ...rest } = e;
    return { ...rest, kind: o.kind, ...(o.tag ? { tag: o.tag } : e.tag ? { tag: e.tag } : {}) };
  });
  await writeFile(join(runDir, LEDGER_FILE), out.map((e) => JSON.stringify(e)).join("\n") + (out.length ? "\n" : ""));
  return { changed, backup };
}
