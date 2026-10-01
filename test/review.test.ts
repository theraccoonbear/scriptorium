import { test } from "node:test";
import assert from "node:assert/strict";
import { continuistLane, dedupIssues, sameIssue, samePassage, stuckIssues } from "../src/review.ts";
import type { Issue } from "../src/types.ts";

// Fixtures are real issues from an Osmagus run that stalled for 8 drafts.
const issue = (type: string, entity: string, detail = "", constraint = ""): Issue => ({ type, entity, constraint, detail });

const paceA = issue("PACE", "Kess's arrival and challenge sequence (from 'Kess", "Kess's entrance and offer resolve too quickly and cleanly; the confrontation lacks the friction and tension");
const paceB = issue("PACE", "Kess's arrival and challenge sequence (from 'a fig", "Kess's entrance, examination of the horn, and offer to play resolve too cleanly and quickly");
const noteA = issue("SENSORY_SPECIFICITY", "the broken note sequence: 'But as the note moved t", "The description of the broken note is abstract and metaphorical; the reader needs to hear or feel the specific acoustic failure");
const noteB = issue("SENSORY_SPECIFICITY", "'The tone didn't break cleanly. Instead it produce", "The description of the broken note is abstract and metaphorical; the reader needs to hear the specific acoustic failure—does the whistle pierce");
const theleA = issue("EPISTEMIC_VIOLATION", "Thele's statement: 'if the magic is in the wood or", "Thele asserts with confidence that the horn's power is real");
const theleB = issue("EPISTEMIC_VIOLATION", "Thele's statement: 'if there's something in the so", "Thele asserts with confidence that the horn's power is tied to Osmagus");
const kessHorn = issue("CONSTRAINT_VIOLATION", "Kess's alpenhorn: 'a newer piece, the wood lighter", "copper wire binding contradicts canon");
const gathering = issue("CONSTRAINT_VIOLATION", "Osmagus gathering the horn sections and placing th", "discovers the crack by inspection alone");

test("reworded repeats of the same complaint are the same issue", () => {
  assert.ok(sameIssue(paceA, paceB), "same passage, reworded quote");
  assert.ok(sameIssue(noteA, noteB), "different quote, same explanation");
  assert.ok(sameIssue(theleA, theleB));
});

test("different complaints stay different", () => {
  assert.ok(!sameIssue(kessHorn, gathering), "same type, different passages");
  assert.ok(!sameIssue(paceA, issue("UNRESOLVED_SETUP", paceA.entity, paceA.detail)), "different type");
  assert.equal(dedupIssues([paceA, paceB, noteA, noteB, kessHorn, gathering]).length, 4);
});

test("passages match across reviewers and issue types", () => {
  // Critic: "remove Thele's suggestion"; continuist: "it's missing, restore it" — same passage.
  const criticSays = issue("UNRESOLVED_SETUP", 'thele: "Could Kess play the ceremony? He has a hor', "prematurely forecloses the open choice");
  const continuistSays = issue("UNRESOLVED_SETUP", "Thele's suggestion about Kess playing the ceremony", "missing from this draft; loses a key pressure point");
  assert.ok(samePassage(criticSays, continuistSays));
});

test("a passage flagged in three drafts is stuck, whoever flags it and however", () => {
  const r1 = [paceA, kessHorn];
  const r2 = [noteA, paceB];
  const r3 = [issue("CHARACTER_ARC", "Kess's arrival and challenge sequence", "Kess acts out of character"), gathering];
  assert.deepEqual(stuckIssues([r1, r2]), []);
  const stuck = stuckIssues([r1, r2, r3]);
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].type, "CHARACTER_ARC");
  // The broken-note complaint, flagged six drafts running in the real run.
  assert.equal(stuckIssues([[noteA], [noteB], [noteA], [noteB]]).length, 1);
});

test("the continuist's craft flags are dropped; continuity flags kept", () => {
  const { verdict, dropped } = continuistLane({ ok: false, issues: [noteA, kessHorn, issue("PACE", "x"), issue("CRAFT", "untyped string issue")] });
  assert.deepEqual(verdict.issues.map((i) => i.type), ["CONSTRAINT_VIOLATION", "CRAFT"]);
  assert.equal(dropped.length, 2);
  assert.equal(verdict.ok, false);
  // Only craft complaints: continuity has nothing to block on.
  assert.equal(continuistLane({ ok: false, issues: [noteA] }).verdict.ok, true);
});
