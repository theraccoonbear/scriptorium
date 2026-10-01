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
test("references are made once, only for the characters and places shots show; props once; shots name what they show", async () => {
  const config = await loadConfig({ scenes: 3 });
  const log = new EventLog(await tmp());
  const bible = await runStory({ config, log, roles: buildRoleProviders(config) });
  const refs = log.events.filter((e) => e.type === "visual_ref").map((e) => e.data as VisualRefData);
  const ids = (kind: string) => refs.filter((r) => r.kind === kind).map((r) => r.id).sort();
  const shown = log.events.filter((e) => e.type === "scene_art").flatMap((e) => (e.data as SceneArtData).shots ?? []);
  assert.deepEqual(ids("character"), [...new Set(shown.flatMap((s) => s.characters ?? []))].sort());
  assert.deepEqual(ids("location"), [...new Set(shown.flatMap((s) => (s.location ? [s.location] : [])))].sort());
  assert.ok(Object.keys(bible.characters).length > ids("character").length, "characters no shot shows get no portrait");
  assert.equal(new Set(ids("character")).size, ids("character").length, "each reference made once");
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
  const shots = log.events.filter((e) => e.type === "scene_art").flatMap((e) => (e.data as SceneArtData).shots ?? []);
  const shownLocations = [...new Set(shots.flatMap((s) => (s.location ? [s.location] : [])))];
  assert.ok(shownLocations.length > 0 && shownLocations.length < Object.keys(bible.locations).length + 1);
  const shownCharacters = [...new Set(shots.flatMap((s) => s.characters ?? []))].filter((id) => id !== "keeper");
  assert.deepEqual(made[0].sort(), [...shownCharacters.map((id) => `character:${id}`), ...shownLocations.map((id) => `location:${id}`), "prop:letter", "prop:mock_prop"].sort());
  assert.ok(!made[0].includes("character:keeper"), "the legacy portrait still counts");
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

// --- issue #31: stalled review loops ---
// Scene 2's critic flags the same passage every draft, each time as a different
// kind of problem (so each looks "new") — the ping-pong that stalled a real run.
async function pingPongRun(maxAttempts: number) {
  const config = await loadConfig({ scenes: 2 });
  const roles = buildRoleProviders(config);
  const types = ["PACE", "CHARACTER_ARC", "UNRESOLVED_SETUP", "EPISTEMIC_VIOLATION", "TELLING_NOT_SHOWING", "SENSORY_SPECIFICITY"];
  let n = 0;
  const directorScenes: number[] = [];
  const real = roles.critic!.provider.complete.bind(roles.critic!.provider);
  roles.critic!.provider = {
    complete: async (req) => {
      const ctx = req.ctx as { sceneIndex?: number };
      if (req.role === "director") directorScenes.push(ctx.sceneIndex ?? -1);
      if (req.role === "critic" && ctx?.sceneIndex === 1) {
        const type = types[n++ % types.length];
        return JSON.stringify({ ok: false, issues: [{ type, entity: "Thele's suggestion that Kess play the ceremony", constraint: "", detail: `${type} complaint` }] });
      }
      return real(req);
    }
  };
  roles.director = { ...roles.director, provider: roles.critic!.provider };
  const log = new EventLog(await tmp());
  await runStory({ config, log, roles, maxAttempts });
  return { critiques: n, directorForScene2: directorScenes.filter((i) => i === 1).length, log };
}

test("a passage flagged in three drafts sends the scene back to the director for a new beat", async () => {
  const { critiques, directorForScene2, log } = await pingPongRun(4);
  assert.equal(directorForScene2, 2, "initial beat + one regeneration after draft 3");
  assert.equal(critiques, 4);
  assert.equal(log.events.filter((e) => e.type === "scene_committed").length, 2);
});

test("a reworded repeat of the same complaint counts as already flagged", async () => {
  const config = await loadConfig({ scenes: 2 });
  const roles = buildRoleProviders(config);
  let n = 0;
  const real = roles.critic!.provider.complete.bind(roles.critic!.provider);
  roles.critic!.provider = {
    complete: async (req) => {
      const ctx = req.ctx as { sceneIndex?: number };
      if (req.role === "critic" && ctx?.sceneIndex === 1) {
        n++;
        return JSON.stringify({ ok: false, issues: [{ type: "PACE", entity: `Kess's arrival and challenge sequence (take ${n})`, constraint: "", detail: `rushed, version ${n}` }] });
      }
      return real(req);
    }
  };
  const log = new EventLog(await tmp());
  await runStory({ config, log, roles, maxAttempts: 10 });
  // Draft 1 rejected; draft 2's only issue is the same complaint reworded → accepted.
  assert.equal(n, 2);
  const scene2 = log.events.filter((e) => e.type === "scene_committed")[1].data as SceneCommittedData;
  assert.equal(scene2.attempts, 2);
});

test("the Creator's art style lands in the bible; a run made without one gets it once from the Art Director", async () => {
  const { storyArtStyle } = await import("../src/visualrefs.ts");
  const config = await loadConfig({ scenes: 1 });
  const log = new EventLog(await tmp());
  const bible = await runStory({ config, log, roles: buildRoleProviders(config) });
  assert.equal(bible.artStyle, "Muted ink and watercolor illustration, grey-green palette, soft diffuse light.");
  assert.equal(storyArtStyle(log.events), bible.artStyle);
  assert.equal(log.events.filter((e) => e.type === "art_style").length, 0);

  // Simulate a run from before art styles: strip the style from the creator's bible.
  const old = new EventLog(await tmp());
  for (const e of log.events.filter((x) => x.type === "scene_committed")) {
    const d = structuredClone(e.data) as SceneCommittedData;
    if (d.bible) delete d.bible.artStyle;
    await old.append("scene_committed", d);
  }
  assert.equal(storyArtStyle(old.events), undefined);
  await redirectArt({ config, log: old, roles: buildRoleProviders(config) });
  assert.equal(storyArtStyle(old.events), "Mock woodcut style.");
  await redirectArt({ config, log: old, roles: buildRoleProviders(config) });
  assert.equal(old.events.filter((e) => e.type === "art_style").length, 1, "defined once, then reused");
});

// --- issue #33: multiple context files ---
test("a contradictory context stops the run before anything is generated", async () => {
  const config = await loadConfig({ scenes: 1, context: "### from a.md\n\nHe is 4'8\".\n\n### from b.md\n\nHe is 5'2\".", contextFiles: ["a.md", "b.md"] });
  const roles = buildRoleProviders(config);
  const called: string[] = [];
  const real = roles.continuist.provider.complete.bind(roles.continuist.provider);
  roles.continuist.provider = {
    complete: async (req) => {
      called.push(req.role);
      if (req.role === "contextgate") {
        return JSON.stringify({ ok: false, issues: [{ type: "CONTEXT_CONTRADICTION", entity: "his height", constraint: "", detail: 'a.md: "4\'8"" vs b.md: "5\'2""' }] });
      }
      return real(req);
    }
  };
  const log = new EventLog(await tmp());
  await assert.rejects(runStory({ config, log, roles }), /context gate[\s\S]*a\.md: "4'8"" vs b\.md: "5'2""/);
  assert.deepEqual(called, ["contextgate"], "nothing else ran");
  assert.equal(log.events.filter((e) => e.type === "scene_committed").length, 0);
});

test("a run remembers its context: resuming without --context reuses it, and the gate runs only before scene 1", async () => {
  const context = "### from world.md\n\nA lighthouse.";
  const config = await loadConfig({ scenes: 2, context, contextFiles: ["world.md"] });
  const dir = await tmp();
  const calls: string[] = [];
  const contextSeenBy = new Set<string>();
  // The continuist also serves as the beat and context gates in this config.
  const track = (roles: ReturnType<typeof buildRoleProviders>) => {
    const real = roles.continuist.provider.complete.bind(roles.continuist.provider);
    roles.continuist.provider = {
      complete: async (req) => {
        calls.push(req.role);
        if (req.prompt.includes("A lighthouse.")) contextSeenBy.add(req.role);
        return real(req);
      }
    };
    return roles;
  };
  await runStory({ config, log: new EventLog(dir), roles: track(buildRoleProviders(config)), scenes: 1 });
  assert.equal(calls.filter((r) => r === "contextgate").length, 1);
  const { context: _, contextFiles: __, ...noContext } = config;
  const log = new EventLog(dir);
  calls.length = 0;
  contextSeenBy.clear();
  await runStory({ config: noContext, log, roles: track(buildRoleProviders(noContext)) });
  assert.equal(calls.filter((r) => r === "contextgate").length, 0, "no gate on resume past scene 1");
  assert.equal(log.events.filter((e) => e.type === "run_context").length, 1);
  assert.ok(contextSeenBy.has("continuist"), "scene 2's reviewers still see the stored context");
});

// --- issue #35: references are batched so no reply grows with the cast ---
test("references for a big cast are made in batches of 3, and earlier batches survive a later failure", async () => {
  const config = await loadConfig({ scenes: 1 });
  const { artdirector: _, ...noArtRoles } = config.roles;
  const plain = { ...config, roles: noArtRoles };
  const dir = await tmp();
  await runStory({ config: plain, log: new EventLog(dir), roles: buildRoleProviders(plain) });
  const log = new EventLog(dir);
  await log.load();
  // Grow the cast to 7 characters by patching the bible through the log.
  const extra = Array.from({ length: 5 }, (_, k) => ({ id: `extra${k}`, name: `Extra ${k}` }));
  await log.append("scene_committed", { index: 1, patch: { upsertCharacters: extra }, prose: "The extras gather.\n\nThey wait.", beat: (log.events[0].data as SceneCommittedData).beat });

  const roles = buildRoleProviders(config);
  const batches: Array<{ characterIds: string[]; locationIds: string[] }> = [];
  const real = roles.artdirector!.provider.complete.bind(roles.artdirector!.provider);
  let failOn = -1;
  roles.artdirector!.provider = {
    complete: async (req) => {
      const ctx = req.ctx as { mode: string; characterIds: string[]; locationIds: string[]; knownIds: string[] };
      if (ctx.mode === "references") {
        batches.push({ characterIds: ctx.characterIds, locationIds: ctx.locationIds });
        if (batches.filter((b) => b.characterIds.length > 0).length === failOn) throw new Error("boom");
      }
      const out = await real(req);
      if (ctx.mode !== "scene") return out;
      // Every character is on screen in the first shot.
      const parsed = JSON.parse(out);
      parsed.shots[0].characters = ctx.knownIds;
      return JSON.stringify(parsed);
    }
  };
  failOn = 3;  // scene 1 shows its 2 characters; scene 2's 5 newcomers go 3 + 2, and that last batch fails — the shots survive it
  await redirectArt({ config, log, roles });
  assert.deepEqual(batches.filter((b) => b.characterIds.length > 0).map((b) => b.characterIds.length), [2, 3, 2]);
  const characterRefs = () => log.events.filter((e) => e.type === "visual_ref" && (e.data as VisualRefData).kind === "character").length;
  assert.equal(characterRefs(), 5, "the earlier batches were recorded before the failure");
  assert.ok(log.events.some((e) => e.type === "scene_art"), "the scene's shots were kept");

  // Retrying makes only what's still missing.
  batches.length = 0;
  failOn = -1;
  await redirectArt({ config, log, roles });
  assert.deepEqual(batches.filter((b) => b.characterIds.length > 0).map((b) => b.characterIds.length), [2]);
  assert.equal(characterRefs(), 7);
  assert.ok(batches.every((b) => b.characterIds.length + b.locationIds.length <= 3));
});

// --- issue #45: author direction ---
test("an author art style overrides the Creator's, is recorded once, and reaches art direction", async () => {
  const { storyArtStyle } = await import("../src/visualrefs.ts");
  const config = await loadConfig({ scenes: 1, artStyle: "Cinematic, photorealistic, dramatic." });
  const roles = buildRoleProviders(config);
  const prompts: string[] = [];
  const real = roles.artdirector!.provider.complete.bind(roles.artdirector!.provider);
  roles.artdirector!.provider = { complete: async (req) => { if (req.role === "artdirector") prompts.push(req.prompt); return real(req); } };
  const dir = await tmp();
  const log = new EventLog(dir);
  const bible = await runStory({ config, log, roles });
  assert.notEqual(bible.artStyle, config.artStyle, "the Creator still picked its own");
  assert.equal(storyArtStyle(log.events), "Cinematic, photorealistic, dramatic.");
  assert.ok(prompts.length > 0 && prompts.every((p) => p.includes("ART STYLE (canon — every prompt renders in exactly this and ends with it verbatim): Cinematic, photorealistic, dramatic.")));
  // Resuming with the same style records nothing new; a new style is recorded.
  await runStory({ config, log: new EventLog(dir), roles: buildRoleProviders(config) });
  const again = new EventLog(dir);
  await runStory({ config: { ...config, artStyle: "Woodcut." }, log: again, roles: buildRoleProviders(config) });
  const styles = again.events.filter((e) => e.type === "art_style").map((e) => (e.data as { style: string }).style);
  assert.deepEqual(styles, ["Cinematic, photorealistic, dramatic.", "Woodcut."]);
  assert.equal(storyArtStyle(again.events), "Woodcut.");
});

// --- issue #50: spend accounting ---
test("a spent budget stops the run even from non-fatal art direction; a stuck scene stops at maxDraftsPerScene", async () => {
  const { BudgetExceededError } = await import("../src/usage.ts");
  const config = await loadConfig({ scenes: 1 });
  const roles = buildRoleProviders(config);
  roles.artdirector!.provider = { complete: async () => { throw new BudgetExceededError(5.01, 5); } };
  await assert.rejects(runStory({ config, log: new EventLog(await tmp()), roles }), BudgetExceededError);

  // The critic never approves; unlimited attempts would loop forever.
  const stuck = await loadConfig({ scenes: 1, maxDraftsPerScene: 4 });
  const stuckRoles = buildRoleProviders(stuck);
  // Genuinely different complaints each draft, so none counts as a repeat.
  const complaints = [
    { type: "CHARACTER_ARC", entity: "the harbor argument", constraint: "", detail: "Ada forgives him far too quickly." },
    { type: "PACE", entity: "the lighthouse climb", constraint: "", detail: "Momentum stalls on the stairs." },
    { type: "EPISTEMIC_VIOLATION", entity: "her letter theory", constraint: "", detail: "She cannot know who wrote it yet." },
    { type: "UNRESOLVED_SETUP", entity: "storm warning bell", constraint: "", detail: "Rung early, never mentioned afterward." },
    { type: "TELLING_NOT_SHOWING", entity: "closing reflection", constraint: "", detail: "Explains grief instead of dramatizing it." }
  ];
  let n = 0;
  const real = stuckRoles.critic!.provider.complete.bind(stuckRoles.critic!.provider);
  stuckRoles.critic!.provider = {
    complete: async (r) => r.role === "critic"
      ? JSON.stringify({ ok: false, issues: [complaints[n++ % complaints.length]] })
      : real(r)
  };
  const log = new EventLog(await tmp());
  await assert.rejects(runStory({ config: stuck, log, roles: stuckRoles, maxAttempts: Infinity }), /scene 1 is stuck: 4 drafts/);
  assert.equal(log.events.filter((e) => e.type === "scene_committed").length, 0, "never committed as-is");
});

// --- issue #52: critic mode ---
// The critic objects to every draft; the writer's prompts are captured.
async function criticModeRun(critic: "blocking" | "advisory" | "off") {
  const config = await loadConfig({ scenes: 2, critic });
  config.providers = { mock: { type: "mock", rejectFirstOn: [1] } };  // continuist rejects scene 2's first draft
  const roles = buildRoleProviders(config);
  const writerPrompts: string[] = [];
  let critiques = 0;
  const real = roles.critic!.provider.complete.bind(roles.critic!.provider);
  roles.critic!.provider = {
    complete: async (req) => {
      critiques++;
      if (req.role !== "critic") return real(req);
      return JSON.stringify({ ok: false, issues: [{ type: "SENSORY_SPECIFICITY", entity: "the road", constraint: "", detail: `the mountain air is generic (${critiques})` }] });
    }
  };
  const realWriter = roles.writer.provider.complete.bind(roles.writer.provider);
  roles.writer = { ...roles.writer, provider: { complete: async (req) => { writerPrompts.push(req.prompt); return realWriter(req); } } };
  const log = new EventLog(await tmp());
  await runStory({ config, log, roles, maxAttempts: 6 });
  const scenes = log.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData);
  return { scenes, writerPrompts, critiques };
}

test("an advisory critic never blocks; its notes reach the writer only on a continuity redraft, as optional", async () => {
  const { scenes, writerPrompts, critiques } = await criticModeRun("advisory");
  assert.deepEqual(scenes.map((s) => s.attempts), [1, 2], "scene 1 commits despite the critic; scene 2 redrafts only for continuity");
  assert.ok(critiques >= 3);
  assert.equal(writerPrompts.length, 3);
  const redraft = writerPrompts[2];
  assert.match(redraft, /OPTIONAL SUGGESTIONS from the critic/);
  assert.match(redraft, /mountain air is generic/);
  const required = redraft.split("OPTIONAL SUGGESTIONS")[0];
  assert.doesNotMatch(required, /mountain air is generic/, "critic notes are not listed as issues to fix");
  assert.doesNotMatch(writerPrompts[0] + writerPrompts[1], /OPTIONAL SUGGESTIONS/);
});

test("critic off: the critic is never called, and only continuity sends a draft back", async () => {
  const { scenes, critiques } = await criticModeRun("off");
  assert.equal(critiques, 0);
  assert.deepEqual(scenes.map((s) => s.attempts), [1, 2]);
});

test("a blocking critic (the default) still holds a scene back", async () => {
  const { scenes } = await criticModeRun("blocking");
  assert.ok(scenes[0].attempts > 1);
});

test("an unknown critic mode is refused", async () => {
  const config = await loadConfig({ scenes: 1, critic: "polite" });
  await assert.rejects(runStory({ config, log: new EventLog(await tmp()), roles: buildRoleProviders(config) }), /critic must be one of blocking, advisory, off/);
});
