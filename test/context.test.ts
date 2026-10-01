import { test } from "node:test";
import assert from "node:assert/strict";
import { combineContexts, contextFile, storedContext } from "../src/context.ts";
import { CONTEXT_GATE_SYSTEM } from "../src/roles.ts";

test("context files are combined under headers naming each source", () => {
  const combined = combineContexts([
    contextFile("contexts/world.md", "A pygmy village.\n"),
    contextFile("/abs/path/osmagus.md", "  Osmagus stands 4'8\".  "),
    contextFile("empty.md", "   \n")
  ]);
  assert.equal(combined, "### from world.md\n\nA pygmy village.\n\n### from osmagus.md\n\nOsmagus stands 4'8\".");
  assert.equal(combineContexts([]), undefined);
  assert.equal(combineContexts([contextFile("blank.md", "\n")]), undefined);
});

test("the newest run_context is the run's context", () => {
  const ev = (seq: number, type: string, data: unknown) => ({ seq, type, ts: "t", data });
  assert.equal(storedContext([ev(0, "scene_committed", {})]), undefined);
  const ctx = storedContext([ev(0, "run_context", { files: ["a.md"], text: "A" }), ev(1, "run_context", { files: ["b.md"], text: "B" })]);
  assert.deepEqual(ctx, { files: ["b.md"], text: "B" });
});

test("the context gate flags hard contradictions with both sources quoted, never mere mixing", () => {
  assert.ok(CONTEXT_GATE_SYSTEM.includes("CONTEXT_CONTRADICTION"));
  assert.ok(CONTEXT_GATE_SYSTEM.includes("PREMISE_CONFLICT"));
  assert.ok(CONTEXT_GATE_SYSTEM.includes("detail MUST quote both sides with the file each came from"));
  assert.ok(CONTEXT_GATE_SYSTEM.includes("Mixing is the point"));
});
