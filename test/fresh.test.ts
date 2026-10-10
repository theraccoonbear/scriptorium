import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFresh, claudeMemoryDir, describeFresh, findFresh, guarded } from "../src/fresh.ts";

// Issue #193: clear what Claude and the pipeline made, never the author's own material.

test("fresh: the wizard's story files, every run and Claude's memory go; contexts/, tracked files and .env stay", async () => {
  const root = await mkdtemp(join(tmpdir(), "scriptorium-fresh-"));
  const home = await mkdtemp(join(tmpdir(), "scriptorium-home-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: root });
  git("init", "-q");
  await mkdir(join(root, "stories"));
  await mkdir(join(root, "contexts", "ole-and-dookie", "photos"), { recursive: true });
  await writeFile(join(root, "stories", "mock.json"), "{}");
  await writeFile(join(root, ".gitignore"), ".env\nruns/\n");
  git("add", "stories/mock.json", ".gitignore");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  await writeFile(join(root, "stories", "ole-and-dookie.json"), "{}");
  await writeFile(join(root, "contexts", "ole-and-dookie.md"), "notes");
  await writeFile(join(root, "contexts", "ole-and-dookie", "photos", "ole-1.jpg"), "jpg");
  await writeFile(join(root, ".env"), "GEMINI_API_KEY=x");
  await mkdir(join(root, "runs", "ole-and-dookie"), { recursive: true });
  await writeFile(join(root, "runs", "ole-and-dookie", "usage.jsonl"), JSON.stringify({ usd: 1.25 }) + "\n");
  const memory = claudeMemoryDir(root, home);
  await mkdir(memory, { recursive: true });
  await writeFile(join(memory, "MEMORY.md"), "- a note");

  const items = findFresh(root, home);
  assert.deepEqual(items.map((i) => i.path).sort(), [join(memory, "MEMORY.md"), join(root, "runs", "ole-and-dookie"), join(root, "stories", "ole-and-dookie.json")].sort());
  assert.match(describeFresh(items, root), /runs\/ole-and-dookie  \(a run, 0\.0 MB, \$1\.25 spent on it\)/);
  assert.match(describeFresh(items, root), /Keeps your contexts\//);
  assert.deepEqual(guarded(items), [], "a test run with nothing approved");
  applyFresh(items);
  for (const kept of ["stories/mock.json", "contexts/ole-and-dookie.md", "contexts/ole-and-dookie/photos/ole-1.jpg", ".env"]) assert.ok(existsSync(join(root, kept)), `${kept} kept`);
  assert.ok(!existsSync(join(root, "stories", "ole-and-dookie.json")) && !existsSync(join(root, "runs", "ole-and-dookie")) && !existsSync(join(memory, "MEMORY.md")));
  assert.equal(describeFresh(findFresh(root, home), root), "Already fresh: nothing to delete.");

  // A run with approved work is a real production: guarded.
  await mkdir(join(root, "runs", "real"), { recursive: true });
  await writeFile(join(root, "runs", "real", "approvals.json"), JSON.stringify({ art: ["cover"], voices: ["voice:narrator"] }));
  assert.deepEqual(guarded(findFresh(root, home)).map((i) => i.approved), [2]);
});

test("Claude's memory folder for a checkout: the path with / and . as -", () => {
  assert.equal(claudeMemoryDir("/var/home/don/code/scriptorium-sandbox", "/home/don"), "/home/don/.claude/projects/-var-home-don-code-scriptorium-sandbox/memory");
});
