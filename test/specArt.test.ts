import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStoryFile, make, settingChanges, storyPitch, storySettings } from "../src/make.ts";
import { replay, withAuthorProps } from "../src/bible.ts";
import { renderArt } from "../src/artist.ts";
import type { Image, ImageBackend, ImageRequest } from "../src/artist.ts";
import type { Bible, StoryEvent } from "../src/types.ts";

const repo = new URL("..", import.meta.url).pathname;
const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
const lantern = { id: "brass_lantern", name: "Brass lantern", description: "A hand lantern a foot tall." };
const anvil = { id: "anvil", name: "Anvil", description: "A squat iron anvil." };

async function storyDir(story: Record<string, unknown>) {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-specart-"));
  await writeFile(join(dir, "style.png"), PNG_1X1);
  const file = join(dir, "story.json");
  await writeFile(file, JSON.stringify({ config: join(repo, "story.config.json"), out: "run", premise: "A shop opens.", scenes: 1, ...story }));
  return { dir, file };
}

const events = async (dir: string): Promise<StoryEvent[]> => (await readFile(join(dir, "run", "events.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
const manifest = async (dir: string) => JSON.parse(await readFile(join(dir, "run", "art", "art.json"), "utf8"));
const refsOf = (es: StoryEvent[]) => es.filter((e) => e.type === "visual_ref").map((e) => { const d = e.data as { kind: string; id: string }; return `${d.kind}:${d.id}`; }).sort();

test("the story file's props, style references and reference kinds are checked at load", async () => {
  const load = async (story: Record<string, unknown>) => loadStoryFile((await storyDir(story)).file);
  const ok = await storyDir({ props: [lantern], styleReferences: ["style.png"], referenceKinds: ["prop"] });
  const s = await loadStoryFile(ok.file);
  assert.deepEqual(s.config.props, [lantern]);
  assert.deepEqual(s.config.styleReferences, [join(ok.dir, "style.png")]);
  assert.deepEqual(s.config.referenceKinds, ["prop"]);
  await assert.rejects(load({ props: [{ ...lantern, id: "brass-lantern" }] }), /"brass-lantern" must be snake_case/);
  await assert.rejects(load({ props: [lantern, lantern] }), /listed twice/);
  await assert.rejects(load({ props: [{ ...lantern, description: "" }] }), /needs "description"/);
  await assert.rejects(load({ props: [] }), /"props" must be a list/);
  await assert.rejects(load({ props: [{ ...lantern, sprite: 1.5 }] }), /"sprite" must be a whole number/);
  await assert.rejects(load({ props: [{ ...lantern, drawing: 3 }] }), /"drawing" must be text/);
  await assert.rejects(load({ styleReferences: ["missing.png"] }), /no file at/);
  await assert.rejects(load({ styleReferences: ["story.json"] }), /must be a \.png/);
  await assert.rejects(load({ styleReferences: ["style.png", "style.png", "style.png", "style.png"] }), /each job takes 3/);
  await assert.rejects(load({ referenceKinds: ["vehicle"] }), /"referenceKinds" must be a list/);
});

test("a config can't hold the story file's prop settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-specart-"));
  const file = join(dir, "s.json");
  await writeFile(file, JSON.stringify({ config: { providers: {}, roles: {}, props: [lantern] }, out: "run" }));
  await assert.rejects(loadStoryFile(file), /"props" is set in .*belongs in the story file/);
});

test("the author's list replaces the Creator's key objects", () => {
  const bible = { objects: { sword: { id: "sword", name: "Sword", description: "x" } } } as unknown as Bible;
  assert.equal(withAuthorProps(bible), bible);
  assert.deepEqual(Object.keys(withAuthorProps(bible, [lantern, anvil]).objects), ["brass_lantern", "anvil"]);
});

test("a props story plans and draws exactly the author's list, with nothing discovered or left over", async () => {
  const { dir, file } = await storyDir({ props: [lantern, anvil], referenceKinds: ["prop"] });
  await make(file, { only: "story,refs" });
  const es = await events(dir);
  assert.deepEqual(Object.keys(replay(es).objects).sort(), ["anvil", "brass_lantern"]);
  assert.deepEqual(refsOf(es), ["prop:anvil", "prop:brass_lantern"], "no mock_prop, no portraits or places");
  assert.deepEqual(Object.keys(await manifest(dir)).sort(), ["prop-anvil", "prop-brass_lantern"]);
});

test("without the new settings, discovery and every kind of reference carry on", async () => {
  const { dir, file } = await storyDir({});
  await make(file, { only: "story,refs" });
  const refs = refsOf(await events(dir));
  assert.ok(refs.includes("prop:mock_prop"), "the art director still discovers props");
  assert.ok(refs.some((r) => r.startsWith("character:")) && refs.some((r) => r.startsWith("location:")));
});

test("referenceKinds leaves a kind out of planning, drawing and --redo", async () => {
  const { dir, file } = await storyDir({ referenceKinds: ["location"] });
  await make(file, { only: "story,refs" });
  assert.ok(refsOf(await events(dir)).every((r) => r.startsWith("location:")));
  assert.ok(Object.keys(await manifest(dir)).every((k) => k.startsWith("location-")));
  await assert.rejects(make(file, { only: "refs", redo: ["character:x"], notes: "older" }), /"referenceKinds" leaves that kind out/);
});

test("a changed prop list is refused for a story in progress", async () => {
  const before = { premise: "a", setting: null, context: null, contextFiles: [], speakerTags: false };
  const { file } = await storyDir({ props: [lantern] });
  const { file: other } = await storyDir({ props: [anvil] });
  const one = await storySettings(await loadStoryFile(file));
  assert.deepEqual(settingChanges(before, { ...before }), [], "older runs have no props recorded");
  assert.deepEqual(settingChanges(one, await storySettings(await loadStoryFile(other))), ["props"]);
});

function recording(): { backend: ImageBackend; asked: ImageRequest[] } {
  const asked: ImageRequest[] = [];
  return { asked, backend: { generate: async (req) => { asked.push(req); return { data: PNG_1X1, mimeType: "image/png" }; } } };
}
const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
const propEvents = [
  ev(0, "scene_committed", { index: 0, prose: "Rain.", bible: {} }),
  ev(1, "visual_ref", { kind: "prop", id: "anvil", appearance: "a", prompt: "An anvil." }),
  ev(2, "visual_ref", { kind: "prop", id: "lantern", appearance: "l", prompt: "A lantern." })
];
const shrink = async (image: Image) => image;

test("every reference job gets the author's style images, labelled for style, and a change redraws", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-specart-"));
  const style: Image = { data: PNG_1X1, mimeType: "image/png" };
  const first = recording();
  await renderArt(propEvents, { runDir, backend: first.backend, shrink, only: "references", styleReferences: [style], styleReferencesKey: "one" });
  assert.equal(first.asked.length, 2);
  assert.equal(first.asked[0].references.length, 1, "the anchor job has the author's image");
  assert.match(first.asked[0].references[0].label!, /match only its art style/);
  assert.equal(first.asked[1].references.length, 2, "the rest also have the anchor");
  const same = recording();
  await renderArt(propEvents, { runDir, backend: same.backend, shrink, only: "references", styleReferences: [style], styleReferencesKey: "one" });
  assert.equal(same.asked.length, 0, "unchanged images skip");
  const changed = recording();
  await renderArt(propEvents, { runDir, backend: changed.backend, shrink, only: "references", styleReferences: [style], styleReferencesKey: "two", approved: new Set(["prop-anvil"]) });
  assert.deepEqual(changed.asked.map((r) => r.prompt), ["A lantern."], "new style images redraw, except what's approved");
});

test("a prop's size and drawing direction reach the art director, the artist and the inspector, for that prop alone", async () => {
  const small = { ...lantern, id: "lantern_small", sprite: 13, drawing: "Six colours at most." };
  const large = { ...lantern, id: "lantern_large", sprite: 32 };
  const { dir, file } = await storyDir({ props: [small, large, anvil], referenceKinds: ["prop"], direction: { artist: "Plain background." } });
  await make(file, { only: "story,refs" });
  const m = await manifest(dir);
  assert.match(m["prop-lantern_small"].direction, /^Plain background\.\nDrawn for a sprite of 13 by 13 pixels.*Six colours at most\.$/);
  assert.match(m["prop-lantern_large"].direction, /32 by 32/);
  assert.equal(m["prop-anvil"].direction, "Plain background.");
  const threads = await readdir(join(dir, "run"), { recursive: true });
  const asked = await Promise.all(threads.filter((f) => f.endsWith(".md") && f.includes("artdirector-references")).map((f) => readFile(join(dir, "run", f), "utf8")));
  assert.ok(asked.some((t) => /DRAWING DIRECTION PER PROP/.test(t) && t.includes("- lantern_small: Drawn for a sprite of 13 by 13 pixels")));
  const story = await loadStoryFile(file);
  assert.equal(storyPitch(story, await events(dir), ["refs"]).images.references, 0);
  const changed = { ...story, config: { ...story.config, props: [{ ...small, drawing: "Four colours." }, large, anvil] } };
  assert.equal(storyPitch(changed, await events(dir), ["refs"]).images.references, 1, "a new direction redraws, and the pitch says so");
  assert.deepEqual(settingChanges(await storySettings(story), await storySettings(changed)), [], "it's the art's, not the story's");
});

test("mixed sizes anchor apart: each group's first reference anchors only its own group", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-specart-"));
  const es = [
    ev(0, "scene_committed", { index: 0, prose: "Rain.", bible: {} }),
    ...["a_large", "a_small", "b_large", "b_small"].map((id, i) => ev(i + 1, "visual_ref", { kind: "prop", id, appearance: "x", prompt: `Draw ${id}.` }))
  ];
  const asked: { prompt: string; anchors: number }[] = [];
  const backend: ImageBackend = { generate: async (req) => { asked.push({ prompt: req.prompt, anchors: req.references.length }); return { data: Buffer.from(req.prompt), mimeType: "image/png" }; } };
  const seen = new Map<string, string[]>();
  const tracking: ImageBackend = { generate: async (req) => { seen.set(req.prompt, req.references.map((r) => r.data.toString())); return backend.generate(req); } };
  await renderArt(es, { runDir, backend: tracking, shrink, only: "references", referenceGroups: { "prop-a_large": "32", "prop-b_large": "32", "prop-a_small": "13", "prop-b_small": "13" } });
  assert.deepEqual([seen.get("Draw a_large."), seen.get("Draw a_small.")], [[], []], "each size has its own lead, drawn with no anchor");
  assert.deepEqual(seen.get("Draw b_large."), ["Draw a_large."]);
  assert.deepEqual(seen.get("Draw b_small."), ["Draw a_small."]);
  const plain = new Map<string, number>();
  await renderArt(es, { runDir: await mkdtemp(join(tmpdir(), "scriptorium-specart-")), backend: { generate: async (req) => { plain.set(req.prompt, req.references.length); return { data: PNG_1X1, mimeType: "image/png" }; } }, shrink, only: "references" });
  assert.deepEqual([...plain.values()].sort(), [0, 1, 1, 1], "without groups, one anchor as before");
});

test("--edit takes a reference key, keeps its square and its history, and is refused outside the art step", async () => {
  const { dir, file } = await storyDir({ props: [lantern], referenceKinds: ["prop"] });
  await make(file, { only: "story,refs" });
  const m = await manifest(dir);
  await make(file, { only: "art", edit: ["prop-brass_lantern"], notes: "a taller handle", steps: { audiobook: async () => {} } });
  const after = await manifest(dir);
  assert.deepEqual(after["prop-brass_lantern"].edits.map((e: { note: string }) => e.note), ["a taller handle"]);
  assert.equal(after["prop-brass_lantern"].prompt, m["prop-brass_lantern"].prompt, "a later run won't redraw over the edit");
  await assert.rejects(make(file, { only: "refs", edit: ["prop-brass_lantern"], notes: "x" }), /edited in the art step/);
  await assert.rejects(make(file, { only: "art", edit: ["vehicle-x"], notes: "x" }), /can be edited/);
});

test("the refs pitch counts the author's list before the story, then what's planned but undrawn", async () => {
  const { dir, file } = await storyDir({ props: [lantern, anvil], referenceKinds: ["prop"] });
  const story = await loadStoryFile(file);
  const before = storyPitch(story, [], ["refs"]);
  assert.equal(before.images.references, 2, "the list is known before the story exists");
  await make(file, { only: "story" });
  const planned = storyPitch(story, await events(dir), ["refs"]);
  assert.equal(planned.images.references, 2, "planned in the story step, not drawn yet");
  assert.ok(planned.images.usd > 0);
  await make(file, { only: "refs" });
  assert.equal(storyPitch(story, await events(dir), ["refs"]).images.references, 0, "drawn: nothing left");
  assert.equal(storyPitch(story, await events(dir), ["refs"], ["prop:anvil"]).images.references, 1, "a redo counts once");
});

test("the refs pitch counts references out of date against the style images, but not approved ones", async () => {
  const { dir, file } = await storyDir({ props: [lantern, anvil], referenceKinds: ["prop"], styleReferences: ["style.png"] });
  await make(file, { only: "story,refs" });
  const story = await loadStoryFile(file);
  assert.equal(storyPitch(story, await events(dir), ["refs"]).images.references, 0);
  await writeFile(join(dir, "style.png"), Buffer.concat([PNG_1X1, Buffer.from("new")]));
  assert.equal(storyPitch(story, await events(dir), ["refs"]).images.references, 2);
  await mkdir(join(dir, "run"), { recursive: true });
  await writeFile(join(dir, "run", "approvals.json"), JSON.stringify({ art: ["prop-anvil"], voices: [] }));
  assert.equal(storyPitch(story, await events(dir), ["refs"]).images.references, 1);
  assert.ok(existsSync(join(dir, "style.png")));
});
