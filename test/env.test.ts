import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRepoEnv } from "../src/env.ts";

test("the repo's .env wins over the shell, and each override is logged by its last four characters only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-env-"));
  const path = join(dir, ".env");
  await writeFile(path, "GEMINI_API_KEY=AIzaSyREPO-key-cRWg\nANTHROPIC_API_KEY=same-in-both\nNEW_ONE=hello\n");
  const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: "AIzaSySHELL-key-Td6w", ANTHROPIC_API_KEY: "same-in-both" };
  const logs: string[] = [];
  const overridden = loadRepoEnv(path, env, (m) => logs.push(m));
  assert.equal(env.GEMINI_API_KEY, "AIzaSyREPO-key-cRWg");
  assert.equal(env.NEW_ONE, "hello");
  assert.deepEqual(overridden, ["GEMINI_API_KEY"]);
  assert.deepEqual(logs, ["[scriptorium] GEMINI_API_KEY overridden by .env ...cRWg"]);
  assert.ok(!logs.join("").includes("REPO-key"), "never logs more than the last four characters");
  assert.deepEqual(loadRepoEnv(join(dir, "missing.env"), env), []);
});
