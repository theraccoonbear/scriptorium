import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BEAT_GATE_SYSTEM,
  CONTINUIST_SYSTEM,
  CRITIC_SYSTEM,
  ISSUE_RULES,
  ISSUE_SCHEMA,
  PATCH_GATE_SYSTEM,
  WORLD_GATE_SYSTEM
} from "../src/roles.ts";

const GATES: Record<string, string> = {
  continuist: CONTINUIST_SYSTEM,
  critic: CRITIC_SYSTEM,
  beatgate: BEAT_GATE_SYSTEM,
  patchgate: PATCH_GATE_SYSTEM,
  worldgate: WORLD_GATE_SYSTEM
};

// Regression contract for the critic/continuist schema-drift bug: every gate
// must carry the identical Issue shape, or repeat-detection silently degrades.
test("every gate embeds the shared issue schema", () => {
  const shape = '{"type":string,"entity":string,"constraint":string,"detail":string}';
  assert.ok(ISSUE_SCHEMA.includes(shape), "ISSUE_SCHEMA lost the issue shape");
  for (const [name, sys] of Object.entries(GATES)) {
    assert.ok(sys.includes(shape), `${name} prompt missing shared issue shape`);
    assert.ok(sys.includes("constraint:"), `${name} prompt missing constraint field doc`);
  }
});

test("every gate embeds the shared first-appearance rules", () => {
  for (const [name, sys] of Object.entries(GATES)) {
    assert.ok(sys.includes("FLAG EVERY ISSUE THE MOMENT YOU SEE IT"), `${name} missing first-appearance rule`);
    assert.ok(sys.includes("Same type + same constraint"), `${name} missing dedup key rule`);
  }
  assert.ok(ISSUE_RULES.includes("Same type + same constraint"));
});

// Regression test for issue #1: a scene that never establishes the beat's
// mustReveal (Mettka never appears) must be flagged, not waved through.
test("continuist enforces mustReveal delivery", () => {
  assert.ok(CONTINUIST_SYSTEM.includes("DELIVERING THE BEAT"), "missing DELIVERING THE BEAT section");
  assert.ok(CONTINUIST_SYSTEM.includes("mustReveal"), "does not mention mustReveal");
  assert.ok(CONTINUIST_SYSTEM.includes("flag UNRESOLVED_SETUP"), "does not prescribe UNRESOLVED_SETUP");
  assert.ok(
    CONTINUIST_SYSTEM.includes("Do not assume a later scene will deliver"),
    "missing no-deferral rule"
  );
});

// --- issue #2: escalation tracking ---
import { ARCHIVIST_SYSTEM, DIRECTOR_SYSTEM } from "../src/roles.ts";

test("director is told not to rehash resolved decisions", () => {
  assert.ok(DIRECTOR_SYSTEM.includes("RESOLVED DECISIONS"), "missing RESOLVED DECISIONS reference");
  assert.ok(DIRECTOR_SYSTEM.includes("NEW pressure"), "missing new-pressure rule");
  assert.ok(
    DIRECTOR_SYSTEM.includes("Each scene must turn the story somewhere it has not been"),
    "missing escalation requirement"
  );
});

test("archivist records decisions that closed in the scene", () => {
  assert.ok(ARCHIVIST_SYSTEM.includes('"resolveDecisions":[string]'), "missing schema field");
  assert.ok(ARCHIVIST_SYSTEM.includes("CLOSED in this scene"), "missing semantics");
});

test("beatgate can flag a rehash", () => {
  assert.ok(BEAT_GATE_SYSTEM.includes("REHASH"), "missing REHASH type");
  assert.ok(BEAT_GATE_SYSTEM.includes("RESOLVED DECISIONS"), "missing decision cross-check");
});

// --- issue #3: scene length budget ---
import { checkContinuity, write, WRITER_SYSTEM } from "../src/roles.ts";
import { MockProvider } from "../src/providers.ts";
import { emptyBible } from "../src/bible.ts";
import type { Beat } from "../src/types.ts";

const mockRole = { provider: new MockProvider(), temperature: 0 };
const testBeat: Beat = {
  goal: "g", conflict: "c", pov: "missing-pov", location: "missing-loc",
  mustReveal: "m", constraints: [], payoffs: []
};

test("writer prompt carries the length target and land-once rule", async () => {
  const out = await write(mockRole, {
    bible: emptyBible(), beat: testBeat, sceneIndex: 0, attempt: 0,
    sceneWords: { min: 1200, max: 1800 }
  });
  assert.ok(out.prompt.includes("LENGTH TARGET: 1200-1800 words"), "missing LENGTH TARGET");
  assert.ok(out.prompt.includes("do not restate the resolution"), "missing land-once prompt rule");
});

test("gate context carries the length target for the critic", async () => {
  const out = await checkContinuity(mockRole, {
    bible: emptyBible(), beat: testBeat, prose: "scene text here", sceneIndex: 0, attempt: 0,
    sceneWords: { min: 900, max: 1500 }
  });
  assert.ok(out.prompt.includes("LENGTH TARGET: 900-1500 words"), "gates never saw the budget");
});

test("writer system bans restating the ending", () => {
  assert.ok(WRITER_SYSTEM.includes("Land the ending ONCE"), "missing land-once rule");
  assert.ok(WRITER_SYSTEM.includes("Never restate the resolution"), "missing no-restate rule");
});

test("critic blocks sustained overshoot as PACE", () => {
  assert.ok(CRITIC_SYSTEM.includes("LENGTH ENFORCEMENT"), "missing enforcement section");
  assert.ok(CRITIC_SYSTEM.includes("twice the maximum"), "missing >2x blocking rule");
});

// --- issue #4: style patterns ---
test("writer bans the observed tics", () => {
  assert.ok(WRITER_SYSTEM.includes("No negation-then-correction"), "missing negation rule");
  assert.ok(WRITER_SYSTEM.includes("No abstract padding"), "missing padding rule");
  assert.ok(WRITER_SYSTEM.includes("Never state the theme outright"), "missing theme rule");
});

test("critic blocks style tics only on recurrence", () => {
  assert.ok(CRITIC_SYSTEM.includes("STYLE_PATTERN"), "missing STYLE_PATTERN type");
  assert.ok(CRITIC_SYSTEM.includes("THREE OR MORE times"), "missing recurrence rule");
  assert.ok(CRITIC_SYSTEM.includes("are NOT blocking"), "single occurrences must stay non-blocking");
  assert.ok(CRITIC_SYSTEM.includes("CRAFT remains non-blocking"), "CRAFT rule weakened");
});

// --- issue #5: voice sheets + drift ---
test("writer gets voice sheets for every character, not just POV", async () => {
  const bible = emptyBible();
  bible.characters["a"] = { id: "a", name: "Osmagus", traits: "", goal: "", voice: "Short declarative sentences.", status: "active" };
  bible.characters["b"] = { id: "b", name: "Mettka", traits: "", goal: "", voice: "Measured, speaks in parables.", status: "active" };
  const out = await write(mockRole, {
    bible, beat: testBeat, sceneIndex: 0, attempt: 0,
    sceneWords: { min: 1200, max: 1800 }
  });
  assert.ok(out.prompt.includes("VOICE SHEETS"), "missing voice sheet block");
  assert.ok(out.prompt.includes("Osmagus: Short declarative sentences."), "missing first voice");
  assert.ok(out.prompt.includes("Mettka: Measured, speaks in parables."), "missing non-POV voice");
  assert.ok(out.prompt.includes("do not let voices converge"), "missing anti-convergence rule");
});

test("critic checks voice drift", () => {
  assert.ok(CRITIC_SYSTEM.includes("VOICE DRIFT"), "missing voice drift section");
  assert.ok(CRITIC_SYSTEM.includes("voice drift"), "missing drift semantics");
  assert.ok(CRITIC_SYSTEM.includes("confuses attribution"), "missing blocking threshold");
});
