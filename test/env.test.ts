import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRepoEnv, loadRepoEnv } from "../src/env.ts";

test("API keys come only from .env: a shell key .env doesn't have is dropped; one it has is overridden", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-env-"));
  const path = join(dir, ".env");
  await writeFile(path, "GEMINI_API_KEY=AIzaSyREPO-key-cRWg\nANTHROPIC_API_KEY=same-in-both-abcd\nNEW_ONE=hello\n");
  const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: "AIzaSySHELL-key-Td6w", ANTHROPIC_API_KEY: "same-in-both-abcd", OPENAI_API_KEY: "sk-from-a-profile-9999", PATH: "/usr/bin" };
  const r = loadRepoEnv(path, env);
  assert.equal(env.GEMINI_API_KEY, "AIzaSyREPO-key-cRWg", ".env's key, not the shell's");
  assert.equal(env.OPENAI_API_KEY, undefined, "a shell-only key is never billed");
  assert.equal(env.PATH, "/usr/bin", "other variables are left alone");
  assert.equal(env.NEW_ONE, "hello");
  assert.deepEqual(r.ignored, ["OPENAI_API_KEY"]);
  assert.deepEqual(r.overridden, ["GEMINI_API_KEY"]);
  assert.deepEqual(r.keys, [{ name: "ANTHROPIC_API_KEY", tail: "…abcd" }, { name: "GEMINI_API_KEY", tail: "…cRWg" }]);
  const lines = describeRepoEnv(r);
  assert.deepEqual(lines, ["keys (from .env): ANTHROPIC_API_KEY …abcd, GEMINI_API_KEY …cRWg", "ignoring OPENAI_API_KEY from your shell: Scriptorium only uses keys in .env"]);
  assert.ok(!lines.join("").includes("REPO-key") && !lines.join("").includes("profile"), "never more than the last four characters");
});

test("no .env: every shell key is dropped, and the line says so", () => {
  const env: NodeJS.ProcessEnv = { GEMINI_API_KEY: "AIzaSySHELL-key-Td6w" };
  const r = loadRepoEnv("/nonexistent/.env", env);
  assert.equal(env.GEMINI_API_KEY, undefined);
  assert.match(describeRepoEnv(r)[0], /no API keys in \.env/);
});
