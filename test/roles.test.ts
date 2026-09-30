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
