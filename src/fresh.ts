import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { readLedger } from "./usage.ts";

// A clean slate for the next test run (#193): what Claude and the pipeline made
// in this checkout (the story file the wizard wrote, every run) and what Claude
// Code remembers about the folder. Never the author's own material: contexts/
// (their notes, photos, drawings, music) stays, as do .env, node_modules/ and
// ~/.cache/scriptorium/ (Gemini's voice list).

export interface FreshItem { path: string; bytes: number; why: string; spentUsd?: number; approved?: number }

// Where Claude Code keeps this folder's memory: ~/.claude/projects/<the path, "/" and "." as "-">/memory.
export function claudeMemoryDir(root: string, home = homedir()): string {
  return join(home, ".claude", "projects", root.replace(/[/.]/g, "-"), "memory");
}

function size(path: string): number {
  const s = statSync(path);
  if (!s.isDirectory()) return s.size;
  return readdirSync(path).reduce((n, f) => n + size(join(path, f)), 0);
}

// Files git doesn't track under these folders: what the author (or the wizard) added.
function untracked(root: string, dirs: string[]): string[] {
  try {
    const out = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--directory", "--", ...dirs], { cwd: root, encoding: "utf8" });
    return out.split("\n").map((l) => l.replace(/\/$/, "")).filter(Boolean);
  } catch {
    throw new Error("fresh needs a git checkout: it only deletes story files git doesn't track");
  }
}

// How much the author has signed off on in a run: the sign of real work, not a test.
function approvedCount(runDir: string): number {
  try {
    const a = JSON.parse(readFileSync(join(runDir, "approvals.json"), "utf8")) as { art?: string[]; voices?: string[] };
    return (a.art?.length ?? 0) + (a.voices?.length ?? 0);
  } catch { return 0; }
}

// Runs with approved work in them: fresh refuses these without --force.
export const guarded = (items: FreshItem[]) => items.filter((i) => (i.approved ?? 0) > 0);

export function findFresh(root: string, home = homedir()): FreshItem[] {
  const items: FreshItem[] = [];
  for (const rel of untracked(root, ["stories"])) {
    const path = join(root, rel);
    if (existsSync(path)) items.push({ path, bytes: size(path), why: "a story file" });
  }
  const runs = join(root, "runs");
  if (existsSync(runs)) {
    for (const name of readdirSync(runs)) {
      const path = join(runs, name);
      const dir = statSync(path).isDirectory();
      const spent = dir ? readLedger(path).reduce((a, e) => a + (e.usd ?? 0), 0) : 0;
      const approved = dir ? approvedCount(path) : 0;
      items.push({ path, bytes: size(path), why: "a run", ...(spent > 0 ? { spentUsd: spent } : {}), ...(approved ? { approved } : {}) });
    }
  }
  const memory = claudeMemoryDir(root, home);
  if (existsSync(memory)) for (const f of readdirSync(memory)) {
    const path = join(memory, f);
    items.push({ path, bytes: size(path), why: "Claude's memory of this folder" });
  }
  return items;
}

export function describeFresh(items: FreshItem[], root: string): string {
  if (items.length === 0) return "Already fresh: nothing to delete.";
  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  const show = (p: string) => (p.startsWith(root) ? relative(root, p) : p.replace(homedir(), "~"));
  const total = items.reduce((a, i) => a + i.bytes, 0);
  const spent = items.reduce((a, i) => a + (i.spentUsd ?? 0), 0);
  return [
    `Will delete (${mb(total)}):`,
    ...items.map((i) => `  ${show(i.path)}  (${i.why}, ${mb(i.bytes)}${i.spentUsd ? `, $${i.spentUsd.toFixed(2)} spent on it` : ""}${i.approved ? `, ${i.approved} approved` : ""})`),
    ...(spent > 0 ? [`These runs hold $${spent.toFixed(2)} of paid work, which can't be undone.`] : []),
    "Keeps your contexts/ (notes, photos, drawings, music), .env, node_modules/ and ~/.cache/scriptorium/."
  ].join("\n");
}

export function applyFresh(items: FreshItem[]): void {
  for (const i of items) rmSync(i.path, { recursive: true, force: true });
}
