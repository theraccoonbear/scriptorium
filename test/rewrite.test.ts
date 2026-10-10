import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { runStory } from "../src/engine.ts";
import { buildRoleProviders } from "../src/providers.ts";
import { rewriteConfig, rewriteDirection, rewriteScene } from "../src/rewrite.ts";
import { make } from "../src/make.ts";
import type { Roles, SceneArtData, SceneCommittedData, StoryConfig } from "../src/types.ts";

// Issue #184: rewrite one scene with the author's note; the rest stay, checked against it.

async function threeScenes() {
  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 3, premise: "A keeper, a letter, a fog." } as StoryConfig;
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-rewrite-"));
  await runStory({ config, log: new EventLog(dir), roles: buildRoleProviders(config), runDir: dir });
  return { config, dir };
}

test("the note goes to the director and the writer, with the old version and the hand-off into the next scene", () => {
  const d = rewriteDirection({ scene: 1, note: "Ada wins the argument", old: { index: 1, prose: "OLD PROSE", beat: { title: "The Row", goal: "argue" } } as unknown as SceneCommittedData, next: { index: 2, beat: { title: "Dawn", goal: "sail" } } as unknown as SceneCommittedData });
  assert.match(d.director, /REWRITING SCENE 2 — THE AUTHOR'S NOTE: Ada wins the argument/);
  assert.match(d.director, /The scene after it is written and stays: Dawn — sail/);
  assert.match(d.writer, /<<<PREVIOUS VERSION\nOLD PROSE\nPREVIOUS VERSION>>>/);
  // Added to the author's own direction for those layers, not replacing it.
  const c = rewriteConfig({ direction: { writer: "dry, deadpan", critic: "x" } } as unknown as StoryConfig, d);
  assert.match(c.direction!.writer, /^dry, deadpan\n\nREWRITING THIS SCENE/);
  assert.equal(c.direction!.critic, "x");
  assert.match(c.direction!.director, /^REWRITING SCENE 2/);
});

test("rewriting scene 2: only it changes, in place, backed up; its shots go; later scenes are read against it", async () => {
  const { config, dir } = await threeScenes();
  await writeFile(join(dir, "approvals.json"), JSON.stringify({ art: ["scene-02-01", "scene-03-01"], voices: [] }));
  const before = new EventLog(dir);
  const old = await before.load();
  const oldScenes = old.filter((e) => e.type === "scene_committed");
  const wrapRoles = (roles: Roles): Roles => {
    const w = roles.writer;
    w.provider = { complete: async () => "narrator: Rewritten. Ada won the argument." };
    const cont = roles.continuist;
    const realC = cont.provider.complete.bind(cont.provider);
    cont.provider = { complete: async (req) => ((req.ctx as { task?: string })?.task === "canon"
      ? JSON.stringify({ issues: [{ where: "prose", quote: (req.prompt.match(/PROSE:\n(\S+ \S+ \S+)/) ?? [])[1] ?? "x", canon: "Ada won", contradicts: true, fix: "Ada, who had won" }] })
      : realC(req)) };
    return roles;
  };
  const r = await rewriteScene({ runDir: dir, config, scene: 2, note: "Ada wins the argument", total: 3, wrapRoles });
  const after = await new EventLog(dir).load();
  const scenes = after.filter((e) => e.type === "scene_committed");
  assert.deepEqual(scenes.map((e) => e.seq), oldScenes.map((e) => e.seq), "one record a scene, in place");
  const s2 = scenes.find((e) => (e.data as SceneCommittedData).index === 1)!.data as SceneCommittedData & { rewrite?: { note: string } };
  assert.match(s2.prose, /Ada won the argument/);
  assert.equal(s2.rewrite?.note, "Ada wins the argument");
  assert.equal((scenes[0].data as SceneCommittedData).prose, (oldScenes[0].data as SceneCommittedData).prose, "scene 1 untouched");
  assert.equal((scenes[2].data as SceneCommittedData).prose, (oldScenes[2].data as SceneCommittedData).prose, "scene 3 untouched until the author applies a fix");
  assert.ok(!after.some((e) => e.type === "scene_art" && (e.data as SceneArtData).sceneIndex === 1), "scene 2's shots are re-planned on the next art run");
  assert.ok(after.some((e) => e.type === "scene_art" && (e.data as SceneArtData).sceneIndex === 2), "other scenes' shots stay");
  assert.match(await readFile(join(dir, "story.md"), "utf8"), /Ada won the argument/);
  assert.ok((await readdir(join(dir, "backups"))).some((f) => f.startsWith("events.jsonl.before-rewrite-scene-02-")));
  assert.deepEqual(r.approvedShots, ["scene-02-01"]);
  assert.equal(r.findings.length > 0, true);
  assert.ok(r.findings.every((f) => f.scene === 2), "only later scenes are checked");
  assert.match(await readFile(join(r.round!.dir, "legend.txt"), "utf8"), /^After rewriting scene 2: \d+ places? in later scenes no longer fit/);
});

test("rewriting scene 1 keeps the story's foundation (cast, premise), and a rewrite needs a note", async () => {
  const { config, dir } = await threeScenes();
  const oldBible = ((await new EventLog(dir).load()).find((e) => e.type === "scene_committed")!.data as SceneCommittedData & { bible?: { characters: object } }).bible;
  await rewriteScene({ runDir: dir, config, scene: 1, note: "open on the shore, not the tower", total: 3 });
  const s1 = (await new EventLog(dir).load()).find((e) => e.type === "scene_committed")!.data as SceneCommittedData & { bible?: { characters: object } };
  assert.deepEqual(Object.keys(s1.bible!.characters), Object.keys(oldBible!.characters), "same cast, not a new foundation");
  await assert.rejects(rewriteScene({ runDir: dir, config, scene: 1, note: " ", total: 3 }), /needs a --note/);
  await assert.rejects(rewriteScene({ runDir: dir, config, scene: 9, note: "x", total: 3 }), /scene 9 isn't written yet/);
  const story = join(dir, "story.json");
  await writeFile(story, JSON.stringify({ config: new URL("../story.config.json", import.meta.url).pathname, out: dir, scenes: 3 }));
  await assert.rejects(make(story, { only: "story", redo: ["scene:2"] }), /--note says what should change/);
});
