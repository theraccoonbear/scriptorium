import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { buildRoleProviders } from "../src/providers.ts";
import { redirectArt, runStory, tensionAt } from "../src/engine.ts";
import { replay } from "../src/bible.ts";
import type { CoverArtData, SceneArtData, SceneCommittedData } from "../src/types.ts";

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

test("art director emits one scene_art per scene and one cover_art, without touching canon", async () => {
  const config = await loadConfig({ scenes: 3 });
  const log = new EventLog(await tmp());
  await runStory({ config, log, roles: buildRoleProviders(config) });
  const art = log.events.filter((e) => e.type === "scene_art").map((e) => e.data as SceneArtData);
  assert.deepEqual(art.map((a) => a.sceneIndex), [0, 1, 2]);
  assert.ok(art.every((a) => a.prompt.length > 0));
  // Each scene's art is a sequence of shots anchored to its paragraphs, starting at the first.
  assert.ok(art.every((a) => (a.shots?.length ?? 0) >= 1 && a.shots![0].startParagraph === 0));
  assert.ok(art.every((a) => a.shots!.every((s, k, all) => k === 0 || s.startParagraph > all[k - 1].startParagraph)));
  // Each scene's art follows its own commit.
  const types = log.events.map((e) => e.type);
  assert.deepEqual(types.slice(0, 2), ["scene_committed", "scene_art"]);
  const covers = log.events.filter((e) => e.type === "cover_art").map((e) => e.data as CoverArtData);
  assert.equal(covers.length, 1);
  assert.equal(covers[0].sceneCount, 3);
  assert.equal(types.at(-1), "cover_art");

  const { artdirector: _, ...noArtRoles } = config.roles;
  const plainLog = new EventLog(await tmp());
  await runStory({ config: { ...config, roles: noArtRoles }, log: plainLog, roles: buildRoleProviders({ ...config, roles: noArtRoles }) });
  assert.deepEqual(replay(log.events), replay(plainLog.events));
});

test("art director failure does not fail the scene or the run", async () => {
  const config = await loadConfig({ scenes: 2 });
  config.providers = { mock: { type: "mock", failRoles: ["artdirector"] } };
  const log = new EventLog(await tmp());
  const bible = await runStory({ config, log, roles: buildRoleProviders(config) });
  assert.equal(bible.sceneCount, 2);
  assert.equal(log.events.filter((e) => e.type === "scene_committed").length, 2);
  assert.equal(log.events.filter((e) => e.type === "scene_art" || e.type === "cover_art").length, 0);
});

test("resuming a finished run does not duplicate the cover; extending it adds a fresh one", async () => {
  const config = await loadConfig({ scenes: 2 });
  const dir = await tmp();
  await runStory({ config, log: new EventLog(dir), roles: buildRoleProviders(config) });
  const again = new EventLog(dir);
  await runStory({ config, log: again, roles: buildRoleProviders(config) });
  assert.equal(again.events.filter((e) => e.type === "cover_art").length, 1);

  const extended = new EventLog(dir);
  await runStory({ config, log: extended, roles: buildRoleProviders(config), scenes: 3 });
  const covers = extended.events.filter((e) => e.type === "cover_art").map((e) => e.data as CoverArtData);
  assert.deepEqual(covers.map((c) => c.sceneCount), [2, 3]);
  assert.equal(extended.events.filter((e) => e.type === "scene_art").length, 3);
});

test("redirectArt re-shoots an existing run without touching canon", async () => {
  const config = await loadConfig({ scenes: 2 });
  const { artdirector: _, ...noArtRoles } = config.roles;
  const plain = { ...config, roles: noArtRoles };
  const dir = await tmp();
  await runStory({ config: plain, log: new EventLog(dir), roles: buildRoleProviders(plain) });
  const log = new EventLog(dir);
  await log.load();
  const before = replay(log.events);
  assert.equal(log.events.filter((e) => e.type === "scene_art").length, 0);

  const shotScenes: number[] = [];
  const scenes = await redirectArt({ config, log, roles: buildRoleProviders(config), onScene: (i) => shotScenes.push(i) });
  assert.equal(scenes, 2);
  assert.deepEqual(shotScenes, [0, 1]);
  const art = log.events.filter((e) => e.type === "scene_art").map((e) => e.data as SceneArtData);
  assert.deepEqual(art.map((a) => a.sceneIndex), [0, 1]);
  assert.ok(art.every((a) => (a.shots?.length ?? 0) >= 1));
  assert.equal(log.events.filter((e) => e.type === "cover_art").length, 1);
  assert.deepEqual(replay(log.events), before);
  await assert.rejects(redirectArt({ config: plain, log, roles: buildRoleProviders(plain) }), /no artdirector role/);
});

test("creator-assigned gender lands in the bible", async () => {
  const config = await loadConfig({ scenes: 1 });
  const log = new EventLog(await tmp());
  const bible = await runStory({ config, log, roles: buildRoleProviders(config) });
  assert.equal(bible.characters.keeper.gender, "female");
  assert.equal(bible.characters.voice.gender, undefined);
});
