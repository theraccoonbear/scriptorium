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
  assert.deepEqual(toInspection({ ok: true, issues: [], revised_prompt: "" }), { ok: true, severity: 0, issues: [], revisedPrompt: undefined });
  assert.deepEqual(toInspection({ ok: "yes", issues: ["x"], revised_prompt: "fixed" }), { ok: false, severity: 5, issues: ["x"], revisedPrompt: "fixed" });
  assert.deepEqual(toInspection(null), { ok: false, severity: 5, issues: [], revisedPrompt: undefined });
  // The model's own score, kept within 0-10.
  assert.equal(toInspection({ ok: false, severity: 8, issues: ["wrong horn"] }).severity, 8);
  assert.equal(toInspection({ ok: false, severity: 42 }).severity, 10);
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

test("references and the inspected image are sent shrunk; files on disk stay full size", async () => {
  const { readFile } = await import("node:fs/promises");
  const runDir = await tmp();
  const events = [
    ev(0, "visual_ref", { kind: "character", id: "a", appearance: "x", prompt: "portrait a" }),
    ev(1, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "s1", characters: ["a"] }] })
  ];
  const sizes: number[] = [];
  // Fake resizer: marks the image as shrunk to the requested size.
  const shrink = async (img: { data: Buffer; mimeType: string }, max: number) => { sizes.push(max); return { ...img, data: Buffer.from(`small-${max}`) }; };
  const backend = new MockImageBackend();
  const inspector = new MockInspector();
  await renderArt(events, { runDir, backend, inspector, shrink });
  assert.equal(String(backend.calls[1].references[0].data), "small-768", "the portrait reference was shrunk");
  assert.ok(inspector.calls.every((c) => String(c.image.data) === "small-1024"), "the candidate was shrunk for inspection");
  const onDisk = await readFile(join(runDir, "art", "character-a.png"));
  assert.notEqual(String(onDisk), "small-768");
  assert.ok(onDisk.length > 0);
});

test("ffmpegShrink falls back to the original on input it can't read", async () => {
  const { ffmpegShrink } = await import("../src/artist.ts");
  const junk = { data: Buffer.from("not an image"), mimeType: "image/png" };
  assert.equal(await ffmpegShrink(junk, 768), junk);
  assert.equal(await ffmpegShrink(junk, 0), junk);
});

test("direction.artist goes with every image and inspection; changing it re-renders", async () => {
  const runDir = await tmp();
  const events = [ev(0, "scene_art", { sceneIndex: 0, prompt: "s1", shots: [{ startParagraph: 0, prompt: "s1" }] })];
  const backend = new MockImageBackend();
  const inspector = new MockInspector();
  await renderArt(events, { runDir, backend, inspector, direction: "Anamorphic lens, film grain." });
  assert.equal(backend.calls[0].direction, "Anamorphic lens, film grain.");
  assert.equal(inspector.calls[0].direction, "Anamorphic lens, film grain.");
  const same = new MockImageBackend();
  await renderArt(events, { runDir, backend: same, direction: "Anamorphic lens, film grain." });
  assert.equal(same.calls.length, 0);
  const changed = new MockImageBackend();
  await renderArt(events, { runDir, backend: changed, direction: "Black and white." });
  assert.equal(changed.calls.length, 1);
  assert.ok(INSPECTOR_SYSTEM.includes("AUTHOR DIRECTION"));
});

test("a spent budget during image generation stops the art step instead of counting as a failed image", async () => {
  const { BudgetExceededError } = await import("../src/usage.ts");
  const runDir = await tmp();
  const backend = { generate: async () => { throw new BudgetExceededError(5, 5); } };
  await assert.rejects(renderArt([ev(0, "scene_art", { sceneIndex: 0, prompt: "x", shots: [{ startParagraph: 0, prompt: "x" }] })], { runDir, backend }), BudgetExceededError);
});

test("portraits fix a character's look, not their pose; the inspector flags stiff staging", () => {
  assert.match(PORTRAIT_LABEL, /NOT the reference's pose/);
  assert.ok(INSPECTOR_SYSTEM.includes("STAGING"));
  assert.ok(INSPECTOR_SYSTEM.includes("make the action and camera angle explicit"));
});

test("images render in parallel (up to the limit), each scene's shots anchored on its first shot, the manifest complete", async () => {
  const runDir = await tmp();
  const events = [
    ev(0, "visual_ref", { kind: "character", id: "nell", appearance: "a", prompt: "portrait nell" }),
    ev(1, "visual_ref", { kind: "character", id: "edrick", appearance: "b", prompt: "portrait edrick" }),
    ev(2, "visual_ref", { kind: "location", id: "inn", appearance: "c", prompt: "place inn" }),
    ev(3, "scene_art", { sceneIndex: 0, prompt: "a1", shots: [1, 2, 3, 4].map((k) => ({ startParagraph: k, prompt: `a${k}`, characters: k === 1 ? ["nell"] : [] })) }),
    ev(4, "scene_art", { sceneIndex: 1, prompt: "b1", shots: [1, 2, 3].map((k) => ({ startParagraph: k, prompt: `b${k}`, characters: [] })) }),
    ev(5, "cover_art", { sceneCount: 2, prompt: "cover" })
  ];
  let inFlight = 0;
  let peak = 0;
  const backend = new MockImageBackend();
  const real = backend.generate.bind(backend);
  backend.generate = async (req) => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 15));
    inFlight--;
    return real(req);
  };
  const result = await renderArt(events, { runDir, backend, concurrency: 3, shrink: async (img) => img });
  assert.equal(result.rendered, 11);
  assert.equal(peak, 3, "three at a time, never more");
  const manifest: ArtManifest = JSON.parse(await readFile(join(runDir, "art", "art.json"), "utf8"));
  assert.equal(Object.keys(manifest).length, 11, "concurrent writes lost nothing");
  const call = (p: string) => backend.calls.find((c) => c.prompt === p)!;
  // a2..a4 and b2..b3 take their own scene's first shot for style; first shots without canon borrow a reference.
  assert.deepEqual(call("a3").references.map((r) => r.label), [SCENE_LABEL]);
  assert.deepEqual(call("b2").references.map((r) => r.label), [SCENE_LABEL]);
  assert.ok(call("b1").references.length > 0, "a first shot without canon still gets a style anchor");
  assert.ok(backend.calls.findIndex((c) => c.prompt === "a1") < backend.calls.findIndex((c) => c.prompt === "a2"), "anchors first");
});

test("triage: every shot once, then retakes go to the worst-scored first; a retake is kept only if it scores better", async () => {
  const runDir = await tmp();
  const events = [
    ev(0, "visual_ref", { kind: "character", id: "nell", appearance: "a", prompt: "portrait nell" }),
    ev(1, "scene_art", { sceneIndex: 0, prompt: "s1", shots: ["s1", "s2", "s3", "s4"].map((p, k) => ({ startParagraph: k, prompt: p, characters: ["nell"] })) }),
    ev(2, "cover_art", { sceneCount: 1, prompt: "cover" })
  ];
  // First takes score: s1 2 (fine), s2 9 (awful), s3 5, s4 7, cover 1. A retake of s2 scores 3 (better);
  // of s4 scores 8 (worse). The reference is rejected once, then fine.
  const first: Record<string, number> = { s1: 2, s2: 9, s3: 5, s4: 7, cover: 1 };
  const retake: Record<string, number> = { s2: 3, s4: 8, s3: 4 };
  const seen = new Map<string, number>();
  const inspector = {
    async inspect(req: { prompt: string }) {
      const base = req.prompt.split("\n\nRETAKE")[0];
      const n = seen.get(base) ?? 0; seen.set(base, n + 1);
      if (base === "portrait nell") return n === 0 ? { ok: false, severity: 6, issues: ["off"], revisedPrompt: "portrait nell\n\nRETAKE" } : { ok: true, severity: 0, issues: [] };
      const severity = n === 0 ? first[base] : retake[base];
      return { ok: severity < 3, severity, issues: severity < 3 ? [] : ["problem"], revisedPrompt: `${base}\n\nRETAKE` };
    }
  };
  const backend = new MockImageBackend();
  const events2: string[] = [];
  const result = await renderArt(events, { runDir, backend, inspector, retakes: 0.4, maxAttempts: 3, shrink: async (img) => img,
    onProgress: (e) => { if (e.type === "triage") events2.push(`triage ${e.scored}/${e.retakes}`); if (e.type === "retake_done") events2.push(`${e.key} ${e.before}->${e.after} ${e.kept ? "kept" : "dropped"}`); } });
  // 5 scored (4 shots + cover) × 0.4 = 2 retakes: the two worst (s2: 9, s4: 7), not s3 (5).
  assert.deepEqual(events2.sort(), ["scene-01-02 9->3 kept", "scene-01-04 7->8 dropped", "triage 5/2"].sort());
  assert.equal(result.manifest["scene-01-02"].severity, 3);
  assert.equal(result.manifest["scene-01-02"].retaken, true);
  assert.equal(result.manifest["scene-01-04"].severity, 7, "the worse retake was dropped");
  assert.equal(result.manifest["character-nell"].attempts, 2, "references keep their own retake loop");
  assert.equal(backend.calls.filter((c) => c.prompt.startsWith("s")).length, 4 + 2, "each shot once, plus two retakes");
});

test("triage respects a hard cap (what the budget can buy), and skips images that scored fine", async () => {
  const runDir = await tmp();
  const events = [ev(0, "scene_art", { sceneIndex: 0, prompt: "a", shots: ["a", "b", "c"].map((p, k) => ({ startParagraph: k, prompt: p })) })];
  const inspector = { async inspect(req: { prompt: string }) { const s = req.prompt === "a" ? 1 : 8; return { ok: s < 3, severity: s, issues: [] }; } };
  const backend = new MockImageBackend();
  let retakes = -1;
  await renderArt(events, { runDir, backend, inspector, retakes: 1, maxRetakes: 1, shrink: async (img) => img, onProgress: (e) => { if (e.type === "triage") retakes = e.retakes; } });
  assert.equal(retakes, 1, "one retake allowed by the cap, though 1 per shot was asked for");
});

test("the triage cap can be worked out when triage starts (after the first pass)", async () => {
  const runDir = await tmp();
  const events = [ev(0, "scene_art", { sceneIndex: 0, prompt: "a", shots: ["a", "b", "c"].map((p, k) => ({ startParagraph: k, prompt: p })) })];
  const inspector = { async inspect() { return { ok: false, severity: 8, issues: ["x"] }; } };
  const backend = new MockImageBackend();
  let asked = -1;
  let firstPassDone = 0;
  await renderArt(events, { runDir, backend, inspector, retakes: 1, shrink: async (img) => img,
    maxRetakes: () => { firstPassDone = backend.calls.length; return 2; },
    onProgress: (e) => { if (e.type === "triage") asked = e.retakes; } });
  assert.equal(firstPassDone, 3, "asked after all three first takes");
  assert.equal(asked, 2);
});

// Gallows Inn: most images scored 3 ("usable"), and 16 of 20 retakes came back no better.
test("triage only retakes images with a clear mistake (severity 5 by default, configurable)", async () => {
  const events = [ev(0, "scene_art", { sceneIndex: 0, prompt: "a", shots: [{ startParagraph: 0, prompt: "a" }, { startParagraph: 1, prompt: "b" }, { startParagraph: 2, prompt: "c" }] })];
  const scores: Record<string, number> = { a: 3, b: 4, c: 6 };
  const inspector = { async inspect(req: { prompt: string }) { const s = scores[req.prompt.split("\n")[0]] ?? 0; return { ok: s < 3, severity: s, issues: [] }; } };
  const triaged = async (opts: { retakeAbove?: number }) => {
    let n = -1;
    await renderArt(events, { runDir: await tmp(), backend: new MockImageBackend(), inspector, retakes: 1, shrink: async (img) => img, ...opts, onProgress: (e) => { if (e.type === "triage") n = e.retakes; } });
    return n;
  };
  assert.equal(await triaged({}), 1, "only the 6: a 3 and a 4 are usable");
  assert.equal(await triaged({ retakeAbove: 3 }), 3);
});

// A lookalike rejection names the real person; that name must never reach the
// image model, which draws toward any name it reads ("not resembling X" included).
test("retake prompts never name a real person: a revised prompt that does is dropped, and issues go in with names removed", async () => {
  const { retakeFor, namesIn, INSPECTOR_SYSTEM: SYSTEM } = await import("../src/artist.ts");
  const issues = ["The figure strongly resembles real actor Mads Mikkelsen.", "Only five legs are visible."];
  assert.deepEqual(namesIn(issues), ["Mads Mikkelsen"]);
  const dropped = retakeFor("Portrait of a porter.", "Portrait of a porter strictly not resembling Mads Mikkelsen.", issues);
  assert.ok(!dropped.includes("Mikkelsen"), "the revised prompt that names him is thrown out");
  assert.ok(dropped.startsWith("Portrait of a porter.") && dropped.includes("- A face resembled a real person.") && dropped.includes("- Only five legs are visible."));
  assert.ok(dropped.includes("Every face is entirely original"));
  assert.equal(retakeFor("P", "A gaunt, narrow, freckled face; seven legs.", issues), "A gaunt, narrow, freckled face; seven legs.", "a clean revision is kept");
  const fallback = retakeFor("P", undefined, ["The face closely resembles actor Peter Dinklage, violating the direction."]);
  assert.ok(!fallback.includes("Dinklage"));
  assert.ok(!retakeFor("P", undefined, ["The background is wood, not plain."]).includes("entirely original"), "no lookalike, no extra line");
  assert.ok(SYSTEM.includes("NEVER name any real person"));
});

test("renderArt: a lookalike rejection's name never reaches the next generation", async () => {
  const { renderArt, MockImageBackend } = await import("../src/artist.ts");
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-names-"));
  const events = [{ seq: 0, type: "visual_ref", ts: "t", data: { kind: "character", id: "liam", appearance: "a", prompt: "Portrait of a small pale man." } }];
  let n = 0;
  const inspector = { calls: [] as unknown[], inspect: async () => (++n === 1
    ? { ok: false, severity: 8, issues: ["The face closely resembles actor Peter Dinklage."], revisedPrompt: "Portrait of a small pale man, not resembling Peter Dinklage." }
    : { ok: true, severity: 0, issues: [] }) };
  const backend = new MockImageBackend();
  await renderArt(events as never, { runDir, backend, inspector, maxAttempts: 3, only: "references" });
  assert.equal(backend.calls.length, 2);
  assert.ok(backend.calls.every((c) => !c.prompt.includes("Dinklage")), "no generation ever sees the name");
});

test("no name reaches the image model: the story's people and places, and anyone named as a lookalike, are stripped from every prompt", async () => {
  const { stripNames, storyNames, renderArt, MockImageBackend } = await import("../src/artist.ts");
  const events = [
    { seq: 0, type: "scene_committed", ts: "t", data: { index: 0, bible: { characters: { liam: { id: "liam", name: "Liam McPoyle" }, x: { id: "x", name: "Unknown Elf Woman" }, troll: { id: "troll", name: "Troll" } }, locations: { hen: { id: "hen", name: "The Howling Hen" } } } } },
    { seq: 1, type: "visual_ref", ts: "t", data: { kind: "character", id: "liam", appearance: "a", prompt: "Liam McPoyle stands in the Howling Hen, strictly not resembling Peter Dinklage." } }
  ];
  const names = storyNames(events as never);
  assert.deepEqual(names.map((n) => n.name), ["Liam McPoyle", "Howling Hen", "McPoyle", "Liam"], "full names and name parts; generic entries skipped");
  const out = stripNames("Liam's bathrobe. Liam McPoyle stands in the Howling Hen, strictly not resembling Peter Dinklage.\n\nA troll.", names);
  assert.equal(out.text, "their bathrobe. the figure stands in the place, with an original face.\n\nA troll.");
  assert.deepEqual(out.removed.sort(), ["Howling Hen", "Liam McPoyle", "Liam's", "strictly not resembling Peter Dinklage"].sort());
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-gate-"));
  const backend = new MockImageBackend();
  const seen: string[][] = [];
  await renderArt(events as never, { runDir, backend, only: "references", onProgress: (e) => { if (e.type === "names_removed") seen.push(e.names); } });
  assert.ok(!/Liam|McPoyle|Howling|Dinklage/.test(backend.calls[0].prompt), "the image model never sees a name");
  assert.equal(seen.length, 1, "and the run says what it removed");
});
