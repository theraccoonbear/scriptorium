import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { buildRoleProviders } from "../src/providers.ts";
import { redirectArt, runStory, tensionAt } from "../src/engine.ts";
import { replay } from "../src/bible.ts";
import type { CoverArtData, SceneArtData, SceneCommittedData, VisualRefData } from "../src/types.ts";

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
  // Scene 1's commit is followed by its visual references, then the scene's art.
  const types = log.events.map((e) => e.type);
  const firstArt = types.indexOf("scene_art");
  assert.equal(types[0], "scene_committed");
  assert.ok(firstArt > 1 && types.slice(1, firstArt).every((t) => t === "visual_ref"));
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

// --- issue #29: canonical visual references (characters, locations, props) ---
test("references are made once per character and location, props once, and shots name what they show", async () => {
  const config = await loadConfig({ scenes: 3 });
  const log = new EventLog(await tmp());
  const bible = await runStory({ config, log, roles: buildRoleProviders(config) });
  const refs = log.events.filter((e) => e.type === "visual_ref").map((e) => e.data as VisualRefData);
  const ids = (kind: string) => refs.filter((r) => r.kind === kind).map((r) => r.id).sort();
  assert.deepEqual(ids("character"), Object.keys(bible.characters).sort());
  assert.deepEqual(ids("location"), Object.keys(bible.locations).sort());
  // The Creator's canon key object gets a prop reference under its bible id, plus one discovered prop.
  assert.deepEqual(ids("prop"), ["letter", "mock_prop"]);
  assert.ok(bible.objects.letter.description.includes("palm-sized"));
  assert.ok(refs.every((r) => r.appearance && r.prompt));
  const shots = log.events.filter((e) => e.type === "scene_art").flatMap((e) => (e.data as SceneArtData).shots ?? []);
  assert.ok(shots.every((s) => (s.characters ?? []).every((id) => bible.characters[id])));
  assert.ok(shots.every((s) => s.location && bible.locations[s.location]));
  assert.ok(shots.some((s) => (s.props ?? []).length > 0));
  assert.ok(shots.every((s) => (s.props ?? []).every((id) => ids("prop").includes(id))));
});

test("a reference failure doesn't stop scene art or the run", async () => {
  const config = await loadConfig({ scenes: 2 });
  const log = new EventLog(await tmp());
  const roles = buildRoleProviders(config);
  const artdirector = roles.artdirector!;
  const real = artdirector.provider.complete.bind(artdirector.provider);
  artdirector.provider = { complete: async (req) => { if ((req.ctx as { mode?: string })?.mode === "references") throw new Error("boom"); return real(req); } };
  const bible = await runStory({ config, log, roles });
  assert.equal(bible.sceneCount, 2);
  assert.equal(log.events.filter((e) => e.type === "visual_ref").length, 0);
  assert.equal(log.events.filter((e) => e.type === "scene_art").length, 2);
});

test("redirectArt adds missing references to an existing run, keeping legacy portraits", async () => {
  const config = await loadConfig({ scenes: 1 });
  const { artdirector: _, ...noArtRoles } = config.roles;
  const plain = { ...config, roles: noArtRoles };
  const dir = await tmp();
  const bible = await runStory({ config: plain, log: new EventLog(dir), roles: buildRoleProviders(plain) });
  const log = new EventLog(dir);
  await log.load();
  // A portrait from before locations/props existed still counts.
  await log.append("character_art", { characterId: "keeper", appearance: "kept look", prompt: "kept" });
  const made: string[][] = [];
  await redirectArt({ config, log, roles: buildRoleProviders(config), onReferences: (r) => made.push(r) });
  assert.deepEqual(made[0].sort(), ["character:voice", ...Object.keys(bible.locations).map((id) => `location:${id}`), "prop:letter", "prop:mock_prop"].sort());
  assert.ok(!made[0].includes("character:keeper"));
});

test("storyMentions finds paragraphs naming a character or place by any part of its name", async () => {
  const { storyMentions } = await import("../src/engine.ts");
  const { emptyBible } = await import("../src/bible.ts");
  const bible = emptyBible();
  bible.characters.pip = { id: "pip", name: "Pip Goldleaf", traits: "", goal: "", voice: "", status: "active" };
  bible.characters.mekka = { id: "mekka", name: "Mekka Brighthorn", traits: "", goal: "", voice: "", status: "active" };
  bible.locations.spires = { id: "spires", name: "The Hornpeak Spires", description: "" };
  const events = [{ seq: 0, type: "scene_committed", ts: "t", data: { index: 0, prose: "narrator: Pip ran ahead. The boy laughed.\n\nnarrator: The ridge was cold.\n\nnarrator: Goldleaf, Mekka called from the Hornpeak. She waited." } }];
  const m = storyMentions(bible, events, ["pip", "mekka", "spires"]);
  assert.deepEqual(m.pip, ["Pip ran ahead. The boy laughed.", "Goldleaf, Mekka called from the Hornpeak. She waited."]);
  assert.deepEqual(m.mekka, ["Goldleaf, Mekka called from the Hornpeak. She waited."]);
  // "The" in a place name doesn't match every paragraph.
  assert.deepEqual(m.spires, ["Goldleaf, Mekka called from the Hornpeak. She waited."]);
  const pipe = storyMentions(bible, [{ seq: 0, type: "scene_committed", ts: "t", data: { index: 0, prose: "The Pipe sang." } }], ["pip"]);
  assert.deepEqual(pipe, {});
});

test("redirectArt --redo recreates a named reference and rejects unknown ones", async () => {
  const config = await loadConfig({ scenes: 1 });
  const log = new EventLog(await tmp());
  await runStory({ config, log, roles: buildRoleProviders(config) });
  const made: string[][] = [];
  await redirectArt({ config, log, roles: buildRoleProviders(config), redo: ["character:keeper"], onReferences: (r) => made.push(r) });
  assert.deepEqual(made[0], ["character:keeper"]);
  await assert.rejects(redirectArt({ config, log, roles: buildRoleProviders(config), redo: ["prop:nope"] }), /no such reference/);
  await assert.rejects(redirectArt({ config, log, roles: buildRoleProviders(config), notes: "x" }), /only applies with --redo/);
});
