import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRemovable, formatRemovable, moveToTrash, purgeTrash, trashDir } from "../src/cleanup.ts";
import { newRound } from "../src/rounds.ts";

// Issue #130: a cleanup that clears what a run no longer needs once it's
// settled — never canon, never the voice cache — moving it to a trash.

async function run() {
  const root = await mkdtemp(join(tmpdir(), "scriptorium-clean-"));
  const runDir = join(root, "story");
  await mkdir(join(runDir, "art", "previous", "scene-01-01"), { recursive: true });
  await mkdir(join(runDir, "art", "previous", "scene-01-02"), { recursive: true });
  await mkdir(join(runDir, "audiobook", "samples"), { recursive: true });
  await mkdir(join(runDir, "audiobook", "batches"), { recursive: true });
  await writeFile(join(runDir, "approvals.json"), JSON.stringify({ art: ["scene-01-01"], voices: [] }));
  await writeFile(join(runDir, "events.jsonl"), "{}\n");
  for (const f of ["a.jpg", "b.jpg"]) await writeFile(join(runDir, "art", "previous", "scene-01-01", f), "x");
  await writeFile(join(runDir, "art", "previous", "scene-01-02", "a.jpg"), "x");
  await writeFile(join(runDir, "audiobook", "casting.json"), JSON.stringify({ narrator: "n", characters: { nell: {} } }));
  for (const f of ["nell.wav", "narrator.wav", "ghost.wav", "samples.json"]) await writeFile(join(runDir, "audiobook", "samples", f), "x");
  await writeFile(join(runDir, "audiobook", "batches", "take.wav"), "x");
  await newRound(runDir, { kind: "shots", subject: "new", keys: ["scene-01-01"] });   // settled
  await newRound(runDir, { kind: "shots", subject: "new", keys: ["scene-01-02"] });   // open
  return { root, runDir };
}

test("only what's settled: done rounds, replaced takes of approved shots, uncast samples' audio", async () => {
  const { runDir } = await run();
  const items = await findRemovable(runDir);
  const rel = (p: string) => p.slice(runDir.length + 1);
  assert.deepEqual(items.map((i) => [i.kind, rel(i.path)]), [
    ["rounds", "review/rounds/01-shots-new"],
    ["previous", "art/previous/scene-01-01"],
    ["samples", "audiobook/samples/ghost.wav"]
  ]);
  assert.deepEqual((await findRemovable(runDir, { kinds: ["previous"], keepLast: true })).map((i) => rel(i.path)), ["art/previous/scene-01-01/a.jpg"], "--keep-last keeps the newest take");
  assert.match(formatRemovable(items, runDir, false), /^Would clean up: 3 items[\s\S]*rounds — [\s\S]*--apply/);
});

test("--apply moves to the run's trash, keeping paths; canon and the voice cache stay; --purge empties the trash", async () => {
  const { root, runDir } = await run();
  const items = await findRemovable(runDir);
  const dest = await moveToTrash(runDir, items, new Date("2026-10-08T20:00:00Z"));
  assert.equal(dest, join(root, "_trash", "story", "2026-10-08T20-00-00-000Z"));
  assert.ok(existsSync(join(dest, "art", "previous", "scene-01-01", "a.jpg")));
  assert.equal(existsSync(join(runDir, "art", "previous", "scene-01-01")), false);
  for (const kept of ["events.jsonl", "approvals.json", "audiobook/batches/take.wav", "audiobook/samples/samples.json", "audiobook/samples/nell.wav", "review/rounds/02-shots-new"]) assert.ok(existsSync(join(runDir, kept)), kept);
  assert.deepEqual(await findRemovable(runDir), [], "nothing left to clean");
  assert.ok((await purgeTrash(runDir)) > 0);
  assert.equal(existsSync(trashDir(runDir)), false);
});

test("sheets and logs only on request", async () => {
  const { runDir } = await run();
  await writeFile(join(runDir, "review", "refs.jpg"), "x");
  await mkdir(join(runDir, "logs"), { recursive: true });
  for (let k = 0; k < 3; k++) await writeFile(join(runDir, "logs", `${k}.log`), "x");
  assert.equal((await findRemovable(runDir)).some((i) => i.kind === "sheets" || i.kind === "logs"), false);
  assert.equal((await findRemovable(runDir, { kinds: ["sheets"] })).length, 1);
  assert.equal((await findRemovable(runDir, { kinds: ["logs"], keepLogs: 1 })).length, 2, "the newest one kept");
});
