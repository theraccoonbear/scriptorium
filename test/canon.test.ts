import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyCanonFixes, canonText, runCanonCheck } from "../src/canon.ts";
import { checkCanon } from "../src/roles.ts";
import { EventLog } from "../src/eventlog.ts";
import type { Role } from "../src/types.ts";

// Issue #133: canon that arrives after a scene is written (the author's sheet)
// never reached the prose; the canon re-check finds the contradictions and fixes them.

const prose = "The first thing Ivana knew was a boot, small and insistent, prodding her ribs. Lemuel had lost his left boot.";
const reply = (issues: object[]): Role => ({ provider: { complete: async () => JSON.stringify({ issues }) } });

test("only real contradictions count: flagged as such, quoting text that's really there, not 'the canon doesn't say'", async () => {
  const out = await checkCanon(reply([
    { where: "prose", quote: "a boot, small and insistent", canon: "always barefoot", contradicts: true, fix: "a foot, bare and small and insistent" },
    { where: "prose", quote: "lost his left boot", canon: "always barefoot", contradicts: false, fix: "" },
    { where: "prose", quote: "a boot that isn't there", canon: "always barefoot", contradicts: true, fix: "x" },
    { where: "prose", quote: "Ivana knew", canon: "The canon does not specify this", contradicts: true, fix: "x" },
    { where: "scene-01-01", quote: "A small boot", canon: "always barefoot", contradicts: true, fix: "A small bare foot" }
  ]), { canon: "Lemuel: always barefoot.", prose, shots: [{ key: "scene-01-01", prompt: "A small boot enters the frame." }] });
  assert.deepEqual(out.result.map((i) => [i.where, i.quote]), [["prose", "a boot, small and insistent"], ["scene-01-01", "A small boot"]]);
});

test("canon is the author's sheet and notes", () => {
  const events = [{ seq: 0, type: "author_characters", ts: "t", data: { characters: { lemuel: { name: "Lemuel", appearance: "always barefoot" } } } }];
  assert.match(canonText(events, ["The company is broke."]), /lemuel: name: Lemuel; appearance: always barefoot[\s\S]*THE AUTHOR'S NOTES \(canon\):\nThe company is broke\./);
});

test("the check writes a round; applying it fixes the prose and the shot prompt, with the event log backed up", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-canon-"));
  const log = new EventLog(runDir);
  await log.load();
  await log.append("scene_committed", { index: 0, prose, bible: { characters: {} } });
  await log.append("scene_art", { sceneIndex: 0, prompt: "x", shots: [{ startParagraph: 0, prompt: "A small boot enters the frame." }] });
  await log.append("author_characters", { characters: { lemuel: { appearance: "always barefoot" } } });
  const role = reply([
    { where: "prose", quote: "a boot, small and insistent", canon: "always barefoot", contradicts: true, fix: "a foot, bare and small and insistent" },
    { where: "prose", quote: " Lemuel had lost his left boot.", canon: "always barefoot", contradicts: true, fix: "" },
    { where: "scene-01-01", quote: "A small boot", canon: "always barefoot", contradicts: true, fix: "A small bare foot" }
  ]);
  const { round, findings } = await runCanonCheck({ runDir, events: log.events, role, contexts: [] });
  assert.equal(findings.length, 3);
  assert.match(await readFile(join(round!.dir, "legend.txt"), "utf8"), /1\. scene 1, the prose\n {3}canon: always barefoot\n {3}now: {3}a boot, small and insistent\n {3}fix: {3}a foot, bare and small and insistent/);
  await writeFile(join(runDir, "approvals.json"), JSON.stringify({ art: ["scene-01-01"], voices: [] }));
  const r = await applyCanonFixes({ runDir, skip: [] });
  assert.equal(r.applied.length, 3);
  assert.deepEqual(r.approvedShots, ["scene-01-01"], "an approved shot whose prompt changed is named, to revoke and redo");
  const events = (await readFile(join(runDir, "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(events.find((e) => e.type === "scene_committed").data.prose, "The first thing Ivana knew was a foot, bare and small and insistent, prodding her ribs.");
  assert.equal(events.find((e) => e.type === "scene_art").data.shots[0].prompt, "A small bare foot enters the frame.");
  assert.equal((await readFile(r.backup, "utf8")).includes("lost his left boot"), true, "the backup is the log as it was");
  assert.match(await readFile(join(runDir, "story.md"), "utf8"), /a foot, bare and small/);
});
