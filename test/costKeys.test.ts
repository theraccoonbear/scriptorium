import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accountant, formatSummary, isScratchRun, readLedger, resolveCostKey, setCostKey, summarize } from "../src/usage.ts";
import { filterEntries, findLedgers, ledgerFor, retag, spendAcross } from "../src/spend.ts";
import { pitch } from "../src/pitch.ts";

// Issue #148: every cost is keyed by what it was for — production, rework,
// dev or experiment, plus a free tag — so a story's production spend can be
// told apart from pipeline testing and scratch experiments.

const reply = { usage: { input_tokens: 1_000_000, output_tokens: 0 } };  // $1 on Haiku 4.5

test("the key: what the command set, else the environment, else experiment for a scratch run, else production", () => {
  const prev = setCostKey({});
  try {
    assert.deepEqual(resolveCostKey("/r/runs/story", {}), { kind: "production" });
    assert.deepEqual(resolveCostKey("/r/runs/_scratch/ab", {}), { kind: "experiment" });
    assert.deepEqual(resolveCostKey("/r/runs/story", { SCRIPTORIUM_COST_KIND: "dev", SCRIPTORIUM_COST_TAG: "issue-148" }), { kind: "dev", tag: "issue-148" });
    assert.throws(() => resolveCostKey("/r/runs/story", { SCRIPTORIUM_COST_KIND: "fun" }), /must be one of/);
    setCostKey({ kind: "rework", tag: "canon-133" });
    assert.deepEqual(resolveCostKey("/r/runs/_scratch/ab", { SCRIPTORIUM_COST_KIND: "dev" }), { kind: "rework", tag: "canon-133" });
  } finally {
    setCostKey(prev);
  }
  assert.equal(isScratchRun("runs/_scratch/x"), true);
  assert.equal(isScratchRun("runs/scratchy"), false);
});

test("entries carry their key; the budget counts production and rework, not dev, unless told to", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-costs-"));
  const acc = new Accountant(runDir, { budgetUsd: 2.5 });
  const prev = setCostKey({ kind: "production" });
  try {
    acc.record("writer", "claude-haiku-4-5", reply);
    setCostKey({ kind: "dev", tag: "issue-148" });
    acc.record("writer", "claude-haiku-4-5", reply);
    acc.record("writer", "claude-haiku-4-5", reply);
    setCostKey({ kind: "rework" });
    acc.record("artist", "claude-haiku-4-5", reply);
  } finally {
    setCostKey(prev);
  }
  const ledger = readLedger(runDir);
  assert.deepEqual(ledger.map((e) => [e.kind, e.tag]), [["production", undefined], ["dev", "issue-148"], ["dev", "issue-148"], ["rework", undefined]]);
  assert.deepEqual([acc.spent, acc.spentAll], [2, 4], "dev doesn't count toward the budget");
  acc.check();
  assert.equal(new Accountant(runDir, { budgetUsd: 2.5 }).spent, 2, "a new session counts the same way");
  assert.equal(new Accountant(runDir, { budgetUsd: 2.5, budgetKinds: ["production", "rework", "dev"] }).spent, 4);
  const text = formatSummary(summarize(ledger), 2.5);
  assert.match(text, /total \$4\.00 over 4 calls, \$2\.00 of it toward the \$2\.50 budget \(production \+ rework\)/);
  assert.match(text, /by kind: dev \$2\.00 · production \$1\.00 · rework \$1\.00/);
  assert.match(text, /by tag: issue-148 \$2\.00/);
  assert.equal(pitch({ events: [], scenes: 0, ledger, budgetUsd: 2.5 }).spentUsd, 2, "the pitch counts like the budget");
});

test("spend --all: every run's ledger, old scratch spend as experiment; filters; retag with a backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptorium-spend-"));
  const story = join(root, "story");
  const scratch = join(root, "_scratch", "ab");
  await mkdir(story, { recursive: true });
  await mkdir(scratch, { recursive: true });
  const line = (ts: string, usd: number, extra = {}) => JSON.stringify({ ts, step: "art", role: "artist", model: "m", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd, ...extra });
  await writeFile(join(story, "usage.jsonl"), [line("2026-10-01T00:00:00Z", 1), line("2026-10-08T00:00:00Z", 2, { kind: "rework", tag: "canon" })].join("\n") + "\n");
  await writeFile(join(scratch, "usage.jsonl"), line("2026-10-08T00:00:00Z", 0.5) + "\n");
  assert.deepEqual(await findLedgers(root), [join(root, "_scratch", "ab"), story]);
  assert.equal(ledgerFor(scratch)[0].kind, "experiment");
  const report = spendAcross([{ runDir: story, entries: ledgerFor(story) }, { runDir: scratch, entries: ledgerFor(scratch) }], root);
  assert.match(report, /by kind: rework \$2\.00 · production \$1\.00 · experiment \$0\.50/);
  assert.equal(filterEntries(ledgerFor(story), { since: "2026-10-05" }).length, 1);
  assert.equal(filterEntries(ledgerFor(story), { tag: "canon" }).length, 1);
  const r = await retag(story, { kind: "dev", tag: "pipeline-tests", before: "2026-10-05" });
  assert.equal(r.changed, 1);
  assert.deepEqual(readLedger(story).map((e) => [e.kind, e.tag]), [["dev", "pipeline-tests"], ["rework", "canon"]]);
  assert.match(await readFile(r.backup, "utf8"), /"usd":1/);
  assert.equal((await readdir(join(story, "backups"))).length, 1);
});
