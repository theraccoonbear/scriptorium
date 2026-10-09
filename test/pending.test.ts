import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeRounds, formatPending, keysInName, markRound, roundStatuses } from "../src/pending.ts";
import { newRound } from "../src/rounds.ts";

// Issue #137: nothing recorded whether the author had dealt with a review
// round, so "what's waiting on me?" was answered from memory. Now it's worked
// out from the run, and listed with the files to look at (#123).

async function run() {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-pending-"));
  await writeFile(join(runDir, "approvals.json"), JSON.stringify({ art: ["scene-01-01"], voices: ["lemuel"] }));
  return runDir;
}
const statusOf = async (runDir: string) => Object.fromEntries((await roundStatuses(runDir)).map((s) => [s.round.name, [s.done, s.why]]));

test("image rounds close when their images are approved or redone later; hand-made folders by the keys in their name", async () => {
  const runDir = await run();
  await newRound(runDir, { kind: "shots", subject: "new", keys: ["scene-01-01", "scene-01-02", "scene-01-03"] });
  await newRound(runDir, { kind: "redo", subject: "scene-01-02", keys: ["scene-01-02"] });
  await mkdir(join(runDir, "review", "rounds", "03-fixes-01-01-02-05"), { recursive: true });
  await writeFile(join(runDir, "review", "rounds", "03-fixes-01-01-02-05", "before-after.jpg"), "x");
  const s = await statusOf(runDir);
  assert.deepEqual(s["01-shots-new"], [false, "approve or redo: scene-01-03"], "01-01 approved, 01-02 redone in round 2");
  assert.deepEqual(s["02-redo-scene-01-02"], [false, "approve or redo: scene-01-02"]);
  assert.deepEqual(s["03-fixes-01-01-02-05"], [false, "approve or redo: scene-02-05"]);
  assert.deepEqual(keysInName("36-fixes-06-05-06-11-06-19"), ["scene-06-05", "scene-06-11", "scene-06-19"]);
});

test("auditions close on a pick (or an approved voice); a canon check on apply; a speech check when nothing is still flagged", async () => {
  const runDir = await run();
  const a = await newRound(runDir, { kind: "auditions", subject: "hellga" });
  await newRound(runDir, { kind: "auditions", subject: "lemuel" });
  const canon = await newRound(runDir, { kind: "canon", subject: "check", findings: [] });
  await newRound(runDir, { kind: "speech-check", subject: "audiobook", lines: [{ ok: true }, { ok: false }] });
  await newRound(runDir, { kind: "speech-check", subject: "voices", lines: [{ ok: true }] });
  let s = await statusOf(runDir);
  assert.equal(s["01-auditions-hellga"][0], false);
  assert.deepEqual(s["02-auditions-lemuel"], [true, "voice:lemuel approved"]);
  assert.equal(s["03-canon-check"][0], false);
  assert.deepEqual(s["04-speech-check-audiobook"], [false, "listen to 1 line still flagged, then close it"]);
  assert.deepEqual(s["05-speech-check-voices"], [true, "nothing still flagged"]);
  await markRound(a, { picked: "en-us-csagent-5" });
  await markRound(canon, { applied: { at: "now", fixes: [1] } });
  assert.deepEqual(await closeRounds(runDir, [4], "accepted as is"), ["04-speech-check-audiobook"]);
  s = await statusOf(runDir);
  assert.deepEqual([s["01-auditions-hellga"], s["03-canon-check"], s["04-speech-check-audiobook"]], [[true, "picked en-us-csagent-5"], [true, "applied"], [true, "closed: accepted as is"]]);
  assert.equal(formatPending(await roundStatuses(runDir), "story.json"), "Nothing waiting on you: every review round is dealt with.");
});

test("the pending list names what each open round waits on, with the exact files to look at", async () => {
  const runDir = await run();
  const r = await newRound(runDir, { kind: "shots", subject: "new", keys: ["scene-02-01"] });
  await writeFile(join(r.dir, "changed.jpg"), "x");
  await writeFile(join(r.dir, "legend.txt"), "x");
  await mkdir(join(runDir, "review", "rounds", "02-inputs-note"), { recursive: true });
  await writeFile(join(runDir, "review", "rounds", "02-inputs-note", "inputs.jpg"), "x");
  const text = formatPending(await roundStatuses(runDir), "stories/x.json");
  assert.match(text, /^2 review rounds waiting on you:/);
  assert.ok(text.includes(`01-shots-new: approve or redo: scene-02-01\n   ${join(r.dir, "changed.jpg")}\n   ${join(r.dir, "legend.txt")}`));
  assert.match(text, /02-inputs-note: look, then close it\n {3}\S+inputs\.jpg/);
  await closeRounds(runDir, [2]);
  assert.match(await readFile(join(runDir, "review", "rounds", "02-inputs-note", "round.json"), "utf8"), /"closed"/, "a hand-made folder gets a round.json when closed");
});
