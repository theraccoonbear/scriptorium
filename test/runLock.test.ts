import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { LOCK_FILE, RunLockedError, acquireRunLock, withRunLock } from "../src/runLock.ts";
import type { LockInfo } from "../src/runLock.ts";

// Issue #139: two makes on one run clashed (or, queued by hand with pgrep,
// deadlocked). A command that writes to a run now holds <run>/.lock.

const run = () => mkdtemp(join(tmpdir(), "scriptorium-lock-"));
const foreign = (runDir: string, pid: number, host = hostname()) =>
  writeFile(join(runDir, LOCK_FILE), JSON.stringify({ pid, host, command: "make --only art", started: "2026-10-08T12:00:00Z" } satisfies LockInfo));

test("the lock is held while running and released after, even when the work throws", async () => {
  const runDir = await run();
  await withRunLock(runDir, { command: "make" }, async () => {
    const info = JSON.parse(await readFile(join(runDir, LOCK_FILE), "utf8")) as LockInfo;
    assert.deepEqual([info.pid, info.command], [process.pid, "make"]);
  });
  assert.equal(existsSync(join(runDir, LOCK_FILE)), false);
  await assert.rejects(withRunLock(runDir, { command: "make" }, async () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(join(runDir, LOCK_FILE)), false, "released after a failure");
});

test("a second command waits for a live holder, then runs; --no-wait stops at once", async () => {
  const runDir = await run();
  await foreign(runDir, process.ppid);  // a live process on this host
  await assert.rejects(acquireRunLock(runDir, { command: "make", wait: false }), (err) => err instanceof RunLockedError && /in use by "make --only art"/.test(err.message));
  const waited: LockInfo[] = [];
  const got = acquireRunLock(runDir, { command: "make", pollMs: 10, onWait: (h) => waited.push(h) });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(waited.length, 1, "told once that it's waiting, and on what");
  await rm(join(runDir, LOCK_FILE));            // the holder finishes…
  const release = await got;                    // …and the waiter goes ahead
  assert.equal((JSON.parse(await readFile(join(runDir, LOCK_FILE), "utf8")) as LockInfo).pid, process.pid);
  await release();
});

test("a lock left by a process that died is taken over", async () => {
  const runDir = await run();
  await foreign(runDir, 2 ** 22 + 12345);  // no such pid
  const stale: LockInfo[] = [];
  const release = await acquireRunLock(runDir, { command: "make", wait: false, onStale: (h) => stale.push(h) });
  assert.equal(stale.length, 1);
  await release();
});

test("a command that runs another in the same process doesn't wait on itself", async () => {
  const runDir = await run();
  const outer = await acquireRunLock(runDir, { command: "audition", wait: false });
  const inner = await acquireRunLock(runDir, { command: "make --only voices", wait: false });
  await inner();
  assert.equal(existsSync(join(runDir, LOCK_FILE)), true, "still held by the outer command");
  await outer();
  assert.equal(existsSync(join(runDir, LOCK_FILE)), false);
});
