import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { castCharacters, castContext, castRun } from "../src/cast.ts";
import type { CastEntry } from "../src/cast.ts";
import { CAST_PHOTO_LABEL, CAST_PORTRAIT_LABEL, INSPECTOR_SYSTEM, MockCastDescriber, MockImageBackend, PORTRAIT_LABEL, STYLE_LABEL, buildArtJobs, renderArt } from "../src/artist.ts";
import { ARTDIRECTOR_SYSTEM, artDirect } from "../src/roles.ts";
import { emptyBible } from "../src/bible.ts";
import type { StoryEvent } from "../src/types.ts";

function ev(seq: number, type: string, data: unknown): StoryEvent {
  return { seq, type, ts: `t${seq}`, data };
}

async function tmp() {
  return mkdtemp(join(tmpdir(), "scriptorium-cast-"));
}

async function photo(dir: string, name: string, bytes = name) {
  const path = join(dir, name);
  await writeFile(path, bytes);
  return path;
}

test("casting describes each member once, copies their photos into the run, and re-describes only on change", async () => {
  const src = await tmp();
  const runDir = await tmp();
  const don = [await photo(src, "don-a.jpg"), await photo(src, "don-b.JPG")];
  const biscuit = [await photo(src, "biscuit.png")];
  const members = [{ name: "Don", photos: don, notes: "he/him" }, { name: "Biscuit", photos: biscuit }];
  const describer = new MockCastDescriber();

  const first = await castRun(runDir, members, describer, []);
  assert.equal(first.changed, true);
  assert.deepEqual(describer.calls, [{ name: "Don", photos: 2 }, { name: "Biscuit", photos: 1 }]);
  assert.deepEqual(first.entries.map((e) => e.photos), [["cast/don-1.jpg", "cast/don-2.jpg"], ["cast/biscuit-1.png"]]);
  assert.deepEqual((await readdir(join(runDir, "cast"))).sort(), ["biscuit-1.png", "don-1.jpg", "don-2.jpg"]);

  // Same cast again: nothing to describe, nothing new to record.
  const events = [ev(0, "cast", { members: first.entries })];
  const again = await castRun(runDir, members, describer, events);
  assert.equal(again.changed, false);
  assert.equal(describer.calls.length, 2);

  // A new photo of Biscuit: only Biscuit is described again.
  await photo(src, "biscuit.png", "a better photo");
  const changed = await castRun(runDir, members, describer, events);
  assert.equal(changed.changed, true);
  assert.deepEqual(describer.calls.slice(2), [{ name: "Biscuit", photos: 1 }]);
});

test("casting refuses an unnamed, photo-less, duplicate or non-image member", async () => {
  const src = await tmp();
  const runDir = await tmp();
  const describer = new MockCastDescriber();
  const ok = await photo(src, "a.jpg");
  await assert.rejects(castRun(runDir, [{ name: "", photos: [ok] }], describer, []), /needs a name/);
  await assert.rejects(castRun(runDir, [{ name: "Don", photos: [] }], describer, []), /at least one photo/);
  await assert.rejects(castRun(runDir, [{ name: "Don", photos: [ok] }, { name: "don", photos: [ok] }], describer, []), /listed twice/);
  await assert.rejects(castRun(runDir, [{ name: "Don", photos: [await photo(src, "a.heic")] }], describer, []), /\.jpg, \.png or \.webp/);
});

const DON: CastEntry = { name: "Don", photos: ["cast/don-1.jpg"], hash: "h1", kind: "person", appearance: "fortyish, broad, short gray beard" };
const BISCUIT: CastEntry = { name: "Biscuit", notes: "the hero's corgi", photos: ["cast/biscuit-1.png"], hash: "h2", kind: "animal", appearance: "red-and-white corgi" };

test("the cast joins the author context by name, and is matched to the story's characters by name", () => {
  const context = castContext([DON, BISCUIT]);
  assert.match(context, /MUST be a character in the story under exactly this name/);
  assert.match(context, /\* Don \(a person\): fortyish/);
  assert.match(context, /\* Biscuit \(an animal\): red-and-white corgi Author's note: the hero's corgi/);
  const events = [
    ev(0, "cast", { members: [DON, BISCUIT] }),
    ev(1, "scene_committed", { index: 0, bible: { characters: {
      sir_don: { id: "sir_don", name: "Sir Don of the Hills" },
      biscuit: { id: "biscuit", name: "Biscuit" },
      donovan: { id: "donovan", name: "Donovan" }
    } } })
  ];
  assert.deepEqual(Object.fromEntries(Object.entries(castCharacters(events)).map(([id, m]) => [id, m.name])), { sir_don: "Don", biscuit: "Biscuit" });
});

test("a cast member's portrait is drawn from their photos; shots pass it as an intended likeness", async () => {
  const runDir = await tmp();
  await mkdir(join(runDir, "cast"));
  await writeFile(join(runDir, "cast/don-1.jpg"), "don photo");
  const events = [
    ev(0, "cast", { members: [DON] }),
    ev(1, "scene_committed", { index: 0, bible: { characters: { don: { id: "don", name: "Don" }, gerald: { id: "gerald", name: "Gerald" } } } }),
    ev(2, "visual_ref", { kind: "character", id: "don", appearance: "a", prompt: "portrait don" }),
    ev(3, "visual_ref", { kind: "character", id: "gerald", appearance: "b", prompt: "portrait gerald" }),
    ev(4, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "s1", characters: ["don", "gerald"] }] })
  ];
  const jobs = buildArtJobs(events);
  assert.deepEqual(jobs.find((j) => j.key === "character-don")!.photos, ["cast/don-1.jpg"]);
  assert.equal(jobs.find((j) => j.key === "character-gerald")!.photos, undefined);

  const shrink = async (img: { data: Buffer; mimeType: string }) => img;
  const backend = new MockImageBackend();
  await renderArt(events, { runDir, backend, shrink });
  const call = (prompt: string) => backend.calls.find((c) => c.prompt === prompt)!;
  assert.deepEqual(call("portrait don").references.map((r) => r.label), [CAST_PHOTO_LABEL]);
  assert.equal(call("portrait don").references[0].data.toString(), "don photo");
  assert.deepEqual(call("portrait gerald").references.map((r) => r.label), [STYLE_LABEL]);
  assert.deepEqual(call("s1").references.map((r) => r.label), [CAST_PORTRAIT_LABEL, PORTRAIT_LABEL]);

  // New photos (a new cast hash) re-render the portrait even though its prompt is unchanged.
  const again = new MockImageBackend();
  await renderArt([...events, ev(5, "cast", { members: [{ ...DON, hash: "h1-new" }] })], { runDir, backend: again, shrink });
  assert.deepEqual(again.calls.map((c) => c.prompt), ["portrait don"]);
});

test("cast members are exempt from the real-person rules, and checked for likeness instead", async () => {
  assert.ok(ARTDIRECTOR_SYSTEM.includes("EXCEPT the CAST"));
  assert.ok(INSPECTOR_SYSTEM.includes("EXCEPT a real cast member"));
  const bible = emptyBible();
  bible.characters.don = { id: "don", name: "Don", traits: "", goal: "", voice: "", status: "active" };
  const role = { provider: { complete: async () => JSON.stringify({ characters: [], locations: [], props: [] }) }, temperature: 0 };
  const out = await artDirect(role, { bible, mode: "references", characterIds: ["don"], cast: { don: DON } });
  assert.match(out.prompt, /CAST \(real people starring in this story/);
  assert.match(out.prompt, /character don \(Don\) is Don, a person: fortyish/);
});

test("cast preview describes the cast into the run and renders one portrait each from their photos", async () => {
  const { castPreviewStep } = await import("../src/steps.ts");
  const { EventLog } = await import("../src/eventlog.ts");
  const src = await tmp();
  const runDir = join(await tmp(), "run");
  const backend = new MockImageBackend();
  const describer = new MockCastDescriber();
  const results = await castPreviewStep({
    runDir,
    config: { providers: {}, roles: {}, artStyle: "Oil painting." },
    cast: [{ name: "Don Smith", photos: [await photo(src, "don.jpg")] }, { name: "Biscuit", photos: [await photo(src, "b1.png"), await photo(src, "b2.png")] }],
    as: "a dwarf in chainmail",
    backend, inspector: null, describer, shrink: async (img) => img
  });
  assert.deepEqual(results.map((r) => [r.name, r.file.slice(runDir.length + 1), r.accepted]), [
    ["Don Smith", "cast/preview/don-smith.png", true],
    ["Biscuit", "cast/preview/biscuit.png", true]
  ]);
  assert.deepEqual(backend.calls.map((c) => c.references.map((r) => r.label)), [[CAST_PHOTO_LABEL], [CAST_PHOTO_LABEL, CAST_PHOTO_LABEL]]);
  assert.match(backend.calls[0].prompt, /Don Smith: mock appearance.*Dressed and equipped for the story as: a dwarf in chainmail\./);
  assert.equal(backend.calls[0].style, "Oil painting.");
  assert.equal(backend.calls[0].aspectRatio, "3:4");
  // The casting is recorded in the run, so the story reuses it instead of describing everyone again.
  const events = await new EventLog(runDir).load();
  assert.deepEqual(events.filter((e) => e.type === "cast").length, 1);
  await castRun(runDir, [{ name: "Don Smith", photos: [join(src, "don.jpg")] }, { name: "Biscuit", photos: [join(src, "b1.png"), join(src, "b2.png")] }], describer, events);
  assert.equal(describer.calls.length, 2);
});
