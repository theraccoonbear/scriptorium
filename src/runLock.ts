import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync, unlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// One writer per run (#139). Two makes on the same run both write the art
// manifest, the event log, approvals and rounds, and can clobber each other.
// A command that writes to a run holds <run>/.lock for as long as it runs; a
// second one waits for it (or, with --no-wait, stops at once). A lock left by
// a process that has died is taken over. Read-only commands (pitch, review,
// show, spend) and approve (a small atomic write, often made mid-render) don't lock.

export const LOCK_FILE = ".lock";

export interface LockInfo { pid: number; host: string; command: string; started: string }

export class RunLockedError extends Error {
  constructor(runDir: string, holder: LockInfo) {
    super(`${runDir} is in use by "${holder.command}" (pid ${holder.pid}, started ${holder.started}) — wait for it, or drop --no-wait to queue behind it`);
    this.name = "RunLockedError";
  }
}

// Held locks in this process, by run, so a command that runs another (an
// audition that remakes the voices) doesn't wait on itself.
const held = new Map<string, { depth: number; file: string }>();

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === "EPERM"; }
}

async function readLock(file: string): Promise<LockInfo | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")) as LockInfo; } catch { return undefined; }
}

export interface LockOptions {
  command: string;
  wait?: boolean;                        // default true
  pollMs?: number;                       // default 2000
  onWait?: (holder: LockInfo) => void;   // told once when it starts waiting
  onStale?: (holder: LockInfo) => void;  // a dead process's lock was taken over
}

// Takes the run's lock, waiting while another live process holds it. Returns
// the release function; release is also done on exit, Ctrl-C and SIGTERM.
export async function acquireRunLock(runDir: string, o: LockOptions): Promise<() => Promise<void>> {
  const mine = held.get(runDir);
  if (mine) {
    mine.depth++;
    return async () => { await release(runDir); };
  }
  await mkdir(runDir, { recursive: true });
  const file = join(runDir, LOCK_FILE);
  const info: LockInfo = { pid: process.pid, host: hostname(), command: o.command, started: new Date().toISOString() };
  let told = false;
  for (;;) {
    try {
      await writeFile(file, JSON.stringify(info) + "\n", { flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = await readLock(file);
    // Unreadable (mid-write) or held by a live process here: wait. A lock from
    // another host can't be checked, so it's waited on too.
    if (holder && holder.host === info.host && !alive(holder.pid)) {
      o.onStale?.(holder);
      await rm(file, { force: true });
      continue;
    }
    if (o.wait === false) throw new RunLockedError(runDir, holder ?? { pid: 0, host: "?", command: "?", started: "?" });
    if (!told && holder) { o.onWait?.(holder); told = true; }
    await new Promise((r) => setTimeout(r, o.pollMs ?? 2000));
  }
  held.set(runDir, { depth: 1, file });
  ensureExitHooks();
  return async () => { await release(runDir); };
}

async function release(runDir: string): Promise<void> {
  const h = held.get(runDir);
  if (!h) return;
  if (--h.depth > 0) return;
  held.delete(runDir);
  const now = await readLock(h.file);
  if (now?.pid === process.pid) await rm(h.file, { force: true });
}

// Runs fn holding the run's lock.
export async function withRunLock<T>(runDir: string, o: LockOptions, fn: () => Promise<T>): Promise<T> {
  const done = await acquireRunLock(runDir, o);
  try { return await fn(); } finally { await done(); }
}

let hooked = false;
function ensureExitHooks(): void {
  if (hooked) return;
  hooked = true;
  // On exit only synchronous work is possible.
  const clear = () => {
    for (const { file } of held.values()) {
      try { if ((JSON.parse(readFileSync(file, "utf8")) as LockInfo).pid === process.pid) unlinkSync(file); } catch { /* gone already */ }
    }
    held.clear();
  };
  process.on("exit", clear);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => { clear(); process.exit(sig === "SIGINT" ? 130 : 143); });
  }
}
