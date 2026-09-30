import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { buildRoleProviders } from "../src/providers.ts";
import { runStory, tensionAt } from "../src/engine.ts";
import { replay } from "../src/bible.ts";
import type { SceneCommittedData } from "../src/types.ts";

async function loadConfig(overrides = {}) {
  const config = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  return { ...config, ...overrides };
}

async function tmp() {
  return mkdtemp(join(tmpdir(), "scriptorium-"));
}

test("runs a full story and replay matches live bible", async () => {
  const config = await loadConfig({ scenes: 6 });
  const log = new EventLog(await tmp());
  const live = await runStory({ config, log, roles: buildRoleProviders(config) });
  assert.equal(live.sceneCount, 6);
  assert.deepEqual(replay(log.events), live);
  const scenes = log.events.filter((e) => e.type === "scene_committed");
  assert.equal(scenes.length, 6);
  assert.ok(scenes.every((s) => (s.data as SceneCommittedData).prose.length > 0));
});

test("Chekhov ledger is empty after the final scene", async () => {
  const config = await loadConfig({ scenes: 7 });
  const log = new EventLog(await tmp());
  const bible = await runStory({ config, log, roles: buildRoleProviders(config) });
  assert.equal(bible.ledger.length, 0);
});

test("critic rejection triggers a revision", async () => {
  const config = await loadConfig({ scenes: 4 });
  config.providers = { mock: { type: "mock", rejectFirstOn: [2] } };
  const log = new EventLog(await tmp());
  await runStory({ config, log, roles: buildRoleProviders(config) });
  const scene = log.events.filter((e) => e.type === "scene_committed")[2].data as SceneCommittedData;
  assert.equal(scene.attempts, 2);
  assert.equal(scene.verdict.ok, true);
});

test("fork copies a prefix and diverges cleanly", async () => {
  const config = await loadConfig({ scenes: 5 });
  const src = new EventLog(await tmp());
  await runStory({ config, log: src, roles: buildRoleProviders(config) });
  const dst = await EventLog.fork(src.dir, 3, await tmp());
  assert.equal(replay(dst.events).sceneCount, 3);
  await runStory({ config: { ...config, rngSeed: 99 }, log: dst, roles: buildRoleProviders(config), scenes: 5 });
  const a = src.events.filter((e) => e.type === "scene_committed");
  const b = dst.events.filter((e) => e.type === "scene_committed");
  for (let i = 0; i < 3; i++) {
    assert.equal((a[i].data as SceneCommittedData).prose, (b[i].data as SceneCommittedData).prose);
  }
  assert.equal(b.length, 5);
});

test("resume continues where a run stopped", async () => {
  const config = await loadConfig({ scenes: 6 });
  const dir = await tmp();
  await runStory({ config, log: new EventLog(dir), roles: buildRoleProviders(config), scenes: 2 });
  const log2 = new EventLog(dir);
  const bible = await runStory({ config, log: log2, roles: buildRoleProviders(config) });
  assert.equal(bible.sceneCount, 6);
});

test("tension arc rises then falls", () => {
  const curve = Array.from({ length: 8 }, (_, i) => tensionAt(i, 8));
  const peak = curve.indexOf(Math.max(...curve));
  assert.ok(peak >= 4 && peak <= 6);
  assert.ok(curve[7] < curve[peak]);
});
