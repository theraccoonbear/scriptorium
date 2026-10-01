import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INSPECTOR_SYSTEM,
  LOCATION_LABEL,
  PORTRAIT_LABEL,
  PROP_LABEL,
  SCENE_LABEL,
  MockImageBackend,
  MockInspector,
  buildArtJobs,
  extensionFor,
  renderArt,
  resolveArtistConfig,
  toInspection
} from "../src/artist.ts";
import type { ArtManifest } from "../src/artist.ts";
import type { StoryEvent } from "../src/types.ts";

function ev(seq: number, type: string, data: unknown): StoryEvent {
  return { seq, type, ts: `t${seq}`, data };
}

function storyEvents(): StoryEvent[] {
  return [
    ev(0, "scene_committed", { index: 0 }),
    ev(1, "scene_art", { sceneIndex: 0, prompt: "a dog on a path" }),
    ev(2, "scene_committed", { index: 1 }),
    ev(3, "scene_art", { sceneIndex: 1, prompt: "a hedgehog in a burrow" }),
    ev(4, "cover_art", { sceneCount: 2, prompt: "a montage" })
  ];
}

async function tmp() {
  return mkdtemp(join(tmpdir(), "scriptorium-art-"));
}

test("inspector prompt covers mismatch, continuity, artifacts, text, and a revised prompt", () => {
  assert.ok(INSPECTOR_SYSTEM.includes('"revised_prompt":string'), "missing output shape");
  assert.ok(INSPECTOR_SYSTEM.includes("PROMPT MISMATCH"));
  assert.ok(INSPECTOR_SYSTEM.includes("CONTINUITY"));
  assert.ok(INSPECTOR_SYSTEM.includes("ARTIFACTS"));
  assert.ok(INSPECTOR_SYSTEM.includes("TEXT"));
  assert.ok(INSPECTOR_SYSTEM.includes("Keep the same scene and moment"));
});

test("buildArtJobs maps events to files, keeping the latest prompt per scene and the latest cover", () => {
  const events = [
    ...storyEvents(),
    ev(5, "scene_committed", { index: 2 }),
    ev(6, "scene_art", { sceneIndex: 2, prompt: "a wellspring" }),
    ev(7, "cover_art", { sceneCount: 3, prompt: "a bigger montage" })
  ];
  assert.deepEqual(buildArtJobs(events), [
    { key: "scene-01", prompt: "a dog on a path", sceneIndex: 0, startParagraph: 0 },
    { key: "scene-02", prompt: "a hedgehog in a burrow", sceneIndex: 1, startParagraph: 0 },
    { key: "scene-03", prompt: "a wellspring", sceneIndex: 2, startParagraph: 0 },
    { key: "cover", prompt: "a bigger montage" }
  ]);
  assert.deepEqual(buildArtJobs([ev(0, "scene_committed", { index: 0 })]), []);
});

test("renderArt writes one image per job plus a manifest, passing earlier renders as references", async () => {
  const runDir = await tmp();
  const backend = new MockImageBackend();
  const result = await renderArt(storyEvents(), { runDir, backend, maxReferences: 1 });
  assert.equal(result.rendered, 3);
  assert.deepEqual((await readdir(join(runDir, "art"))).sort(), ["art.json", "cover.png", "scene-01.png", "scene-02.png"]);
  assert.deepEqual(backend.calls.map((c) => c.references.length), [0, 1, 1]);
  const manifest: ArtManifest = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));
  assert.equal(manifest["scene-02"].prompt, "a hedgehog in a burrow");
  assert.equal(manifest.cover.accepted, true);
});

test("renderArt skips unchanged prompts, re-renders changed ones, and --force re-renders all", async () => {
  const runDir = await tmp();
  await renderArt(storyEvents(), { runDir, backend: new MockImageBackend() });

  const again = new MockImageBackend();
  const second = await renderArt(storyEvents(), { runDir, backend: again });
  assert.equal(second.skipped, 3);
  assert.equal(again.calls.length, 0);

  // An extended run brings a new cover prompt: only the cover is redone, with the skipped scenes as references.
  const extended = [...storyEvents(), ev(5, "cover_art", { sceneCount: 2, prompt: "a new montage" })];
  const third = new MockImageBackend();
  const r3 = await renderArt(extended, { runDir, backend: third });
  assert.equal(r3.rendered, 1);
  assert.equal(r3.skipped, 2);
  assert.equal(third.calls[0].prompt, "a new montage");
  assert.equal(third.calls[0].references.length, 2);

  const forced = new MockImageBackend();
  const r4 = await renderArt(extended, { runDir, backend: forced, force: true });
  assert.equal(r4.rendered, 3);
});

test("a rejected image is regenerated from the inspector's revised prompt", async () => {
  const runDir = await tmp();
  const backend = new MockImageBackend();
  const inspector = new MockInspector(1);
  const rejected: string[] = [];
  const result = await renderArt(storyEvents(), {
    runDir, backend, inspector,
    onProgress: (e) => { if (e.type === "attempt_rejected") rejected.push(e.key); }
  });
  assert.equal(result.rendered, 3);
  assert.deepEqual(rejected, ["scene-01", "scene-02", "cover"]);
  assert.equal(backend.calls.length, 6);
  assert.equal(backend.calls[1].prompt, "a dog on a path\n\nREVISED: 1");
  assert.equal(result.manifest["scene-01"].attempts, 2);
  assert.equal(result.manifest["scene-01"].accepted, true);
  assert.equal(result.manifest["scene-01"].finalPrompt, "a dog on a path\n\nREVISED: 1");
});

test("when every attempt is rejected the last image is kept and flagged", async () => {
  const runDir = await tmp();
  const backend = new MockImageBackend();
  const result = await renderArt(storyEvents(), { runDir, backend, inspector: new MockInspector(99), maxAttempts: 2 });
  assert.equal(result.rendered, 3);
  assert.equal(backend.calls.length, 6);
  assert.equal(result.manifest["scene-01"].accepted, false);
  assert.deepEqual(result.manifest["scene-01"].issues, ["mock: subject missing"]);
});

test("one failed image doesn't stop the others", async () => {
  const runDir = await tmp();
  const result = await renderArt(storyEvents(), { runDir, backend: new MockImageBackend(["hedgehog"]) });
  assert.equal(result.rendered, 2);
  assert.equal(result.failed, 1);
  assert.equal(result.manifest["scene-02"], undefined);
  // The failed scene is retried on the next run since it has no manifest entry.
  const retry = await renderArt(storyEvents(), { runDir, backend: new MockImageBackend() });
  assert.equal(retry.rendered, 1);
  assert.equal(retry.skipped, 2);
});

test("toInspection normalizes model output", () => {
  assert.deepEqual(toInspection({ ok: true, issues: [], revised_prompt: "" }), { ok: true, issues: [], revisedPrompt: undefined });
  assert.deepEqual(toInspection({ ok: "yes", issues: ["x"], revised_prompt: "fixed" }), { ok: false, issues: ["x"], revisedPrompt: "fixed" });
  assert.deepEqual(toInspection(null), { ok: false, issues: [], revisedPrompt: undefined });
});

test("config defaults to Gemini and image extensions follow the returned type", () => {
  const cfg = resolveArtistConfig(undefined);
  assert.equal(cfg.image.type, "gemini");
  assert.equal(resolveArtistConfig({ inspector: null }).inspector, null);
  assert.equal(extensionFor("image/jpeg"), "jpg");
  assert.throws(() => extensionFor("image/gif"));
});

test("a failed generation is retried as another attempt", async () => {
  const runDir = await tmp();
  let calls = 0;
  const flaky = {
    async generate() {
      calls++;
      if (calls === 1) throw new Error("timeout");
      return new MockImageBackend().generate({ prompt: "", references: [] });
    }
  };
  const result = await renderArt([ev(0, "scene_art", { sceneIndex: 0, prompt: "x" })], { runDir, backend: flaky });
  assert.equal(result.rendered, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.manifest["scene-01"].attempts, 2);
});

test("buildArtJobs makes one job per shot, keyed by scene and shot, with its anchor paragraph", () => {
  const events = [
    ev(0, "scene_art", { sceneIndex: 0, prompt: "a", shots: [{ startParagraph: 0, prompt: "a" }, { startParagraph: 7, prompt: "b" }] }),
    ev(1, "scene_art", { sceneIndex: 1, prompt: "legacy single prompt" })
  ];
  assert.deepEqual(buildArtJobs(events), [
    { key: "scene-01-01", prompt: "a", sceneIndex: 0, startParagraph: 0 },
    { key: "scene-01-02", prompt: "b", sceneIndex: 0, startParagraph: 7 },
    { key: "scene-02", prompt: "legacy single prompt", sceneIndex: 1, startParagraph: 0 }
  ]);
});

test("the manifest records each image's scene and anchor paragraph, and keeps anchors current on skip", async () => {
  const runDir = await tmp();
  const shots = (second: number) => [ev(0, "scene_art", { sceneIndex: 0, prompt: "a", shots: [{ startParagraph: 0, prompt: "a" }, { startParagraph: second, prompt: "b" }] })];
  await renderArt(shots(5), { runDir, backend: new MockImageBackend() });
  const again = await renderArt(shots(6), { runDir, backend: new MockImageBackend() });
  assert.equal(again.skipped, 2);
  const manifest: ArtManifest = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));
  assert.equal(manifest["scene-01-02"].sceneIndex, 0);
  assert.equal(manifest["scene-01-02"].startParagraph, 6);
});

// --- issue #29: canonical visual references ---
test("references render first; each shot gets its characters, location and props as labelled references", async () => {
  const runDir = await tmp();
  const events = [
    // A legacy portrait event still counts as a character reference.
    ev(0, "character_art", { characterId: "osmagus", appearance: "stocky", prompt: "portrait osmagus" }),
    ev(1, "visual_ref", { kind: "character", id: "merta", appearance: "old", prompt: "portrait merta" }),
    ev(2, "visual_ref", { kind: "location", id: "spires", appearance: "peaks", prompt: "place spires" }),
    ev(3, "visual_ref", { kind: "prop", id: "horn", name: "alpenhorn", appearance: "wood", prompt: "prop horn" }),
    ev(4, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [
      { startParagraph: 0, prompt: "s1", characters: ["osmagus"], location: "spires", props: ["horn"] },
      { startParagraph: 3, prompt: "s2", characters: [] },
      { startParagraph: 6, prompt: "s3", characters: ["merta", "osmagus"], location: "spires" }
    ] }),
    ev(5, "cover_art", { sceneCount: 1, prompt: "cover" })
  ];
  assert.deepEqual(buildArtJobs(events).map((j) => j.key),
    ["character-merta", "character-osmagus", "location-spires", "prop-horn", "scene-01-01", "scene-01-02", "scene-01-03", "cover"]);
  const backend = new MockImageBackend();
  const result = await renderArt(events, { runDir, backend });
  assert.equal(result.rendered, 8);
  const call = (prompt: string) => backend.calls.find((c) => c.prompt === prompt)!;
  assert.equal(call("portrait merta").aspectRatio, "3:4");
  assert.equal(call("place spires").aspectRatio, "16:9");
  assert.equal(call("prop horn").aspectRatio, "1:1");
  assert.deepEqual(call("s1").references.map((r) => r.label), [PORTRAIT_LABEL, LOCATION_LABEL, PROP_LABEL]);
  // No references for s2, so it leans on recent renders for style (only s1 exists yet).
  assert.deepEqual(call("s2").references.map((r) => r.label), [SCENE_LABEL]);
  assert.deepEqual(call("s3").references.map((r) => r.label), [PORTRAIT_LABEL, PORTRAIT_LABEL, LOCATION_LABEL, SCENE_LABEL]);
  // The cover features the most-shown characters, place and prop.
  assert.deepEqual(call("cover").references.filter((r) => r.label !== SCENE_LABEL).map((r) => r.label), [PORTRAIT_LABEL, PORTRAIT_LABEL, LOCATION_LABEL, PROP_LABEL]);
  assert.equal(result.manifest["prop-horn"].refKind, "prop");
  assert.equal(result.manifest["prop-horn"].sceneIndex, undefined);

  // Skipped (unchanged) references are still passed on the next render.
  const again = new MockImageBackend();
  await renderArt([...events, ev(6, "scene_art", { sceneIndex: 0, prompt: "new", shots: [{ startParagraph: 0, prompt: "new", characters: ["merta"], props: ["horn"] }] })], { runDir, backend: again });
  // ("new" replaces scene 1 and is the first non-reference image, so there's no earlier render for style.)
  assert.deepEqual(again.calls.map((c) => [c.prompt, c.references.map((r) => r.label)]), [["new", [PORTRAIT_LABEL, PROP_LABEL]]]);
});

test("the inspector checks references (characters, places, props) and real-person resemblance", () => {
  assert.ok(INSPECTOR_SYSTEM.includes("REFERENCE MATCH"));
  assert.ok(INSPECTOR_SYSTEM.includes("PROP reference"));
  assert.ok(INSPECTOR_SYSTEM.includes("REAL PERSON"));
});

test("every image is generated and inspected with the story's art style; changing it re-renders", async () => {
  const runDir = await tmp();
  const styled = (style: string) => [
    ev(0, "art_style", { style }),
    ev(1, "visual_ref", { kind: "character", id: "a", appearance: "x", prompt: "portrait a" }),
    ev(2, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "s1", characters: ["a"] }] })
  ];
  const backend = new MockImageBackend();
  const inspector = new MockInspector();
  await renderArt(styled("woodcut"), { runDir, backend, inspector });
  assert.deepEqual(backend.calls.map((c) => c.style), ["woodcut", "woodcut"]);
  assert.deepEqual(inspector.calls.map((c) => c.style), ["woodcut", "woodcut"]);
  const same = new MockImageBackend();
  await renderArt(styled("woodcut"), { runDir, backend: same });
  assert.equal(same.calls.length, 0);
  const changed = new MockImageBackend();
  const r = await renderArt(styled("oil painting"), { runDir, backend: changed });
  assert.equal(r.rendered, 2);
  assert.equal(r.manifest["character-a"].style, "oil painting");
});
