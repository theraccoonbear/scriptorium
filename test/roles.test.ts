import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ARTDIRECTOR_SYSTEM,
  BEAT_GATE_SYSTEM,
  CONTINUIST_SYSTEM,
  CRITIC_SYSTEM,
  ISSUE_RULES,
  ISSUE_SCHEMA,
  PATCH_GATE_SYSTEM,
  WORLD_GATE_SYSTEM
} from "../src/roles.ts";

const GATES: Record<string, string> = {
  continuist: CONTINUIST_SYSTEM,
  critic: CRITIC_SYSTEM,
  beatgate: BEAT_GATE_SYSTEM,
  patchgate: PATCH_GATE_SYSTEM,
  worldgate: WORLD_GATE_SYSTEM
};

// Regression contract for the critic/continuist schema-drift bug: every gate
// must carry the identical Issue shape, or repeat-detection silently degrades.
test("every gate embeds the shared issue schema", () => {
  const shape = '{"type":string,"entity":string,"constraint":string,"detail":string}';
  assert.ok(ISSUE_SCHEMA.includes(shape), "ISSUE_SCHEMA lost the issue shape");
  for (const [name, sys] of Object.entries(GATES)) {
    assert.ok(sys.includes(shape), `${name} prompt missing shared issue shape`);
    assert.ok(sys.includes("constraint:"), `${name} prompt missing constraint field doc`);
  }
});

test("every gate embeds the shared first-appearance rules", () => {
  for (const [name, sys] of Object.entries(GATES)) {
    assert.ok(sys.includes("FLAG EVERY ISSUE THE MOMENT YOU SEE IT"), `${name} missing first-appearance rule`);
    assert.ok(sys.includes("Same type + same constraint"), `${name} missing dedup key rule`);
  }
  assert.ok(ISSUE_RULES.includes("Same type + same constraint"));
});

// Regression test for issue #1: a scene that never establishes the beat's
// mustReveal (Mettka never appears) must be flagged, not waved through.
test("continuist enforces mustReveal delivery", () => {
  assert.ok(CONTINUIST_SYSTEM.includes("DELIVERING THE BEAT"), "missing DELIVERING THE BEAT section");
  assert.ok(CONTINUIST_SYSTEM.includes("mustReveal"), "does not mention mustReveal");
  assert.ok(CONTINUIST_SYSTEM.includes("flag UNRESOLVED_SETUP"), "does not prescribe UNRESOLVED_SETUP");
  assert.ok(
    CONTINUIST_SYSTEM.includes("Do not assume a later scene will deliver"),
    "missing no-deferral rule"
  );
});

// --- issue #2: escalation tracking ---
import { ARCHIVIST_SYSTEM, DIRECTOR_SYSTEM } from "../src/roles.ts";

test("director is told not to rehash resolved decisions", () => {
  assert.ok(DIRECTOR_SYSTEM.includes("RESOLVED DECISIONS"), "missing RESOLVED DECISIONS reference");
  assert.ok(DIRECTOR_SYSTEM.includes("NEW pressure"), "missing new-pressure rule");
  assert.ok(
    DIRECTOR_SYSTEM.includes("Each scene must turn the story somewhere it has not been"),
    "missing escalation requirement"
  );
});

test("archivist records decisions that closed in the scene", () => {
  assert.ok(ARCHIVIST_SYSTEM.includes('"resolveDecisions":[string]'), "missing schema field");
  assert.ok(ARCHIVIST_SYSTEM.includes("CLOSED in this scene"), "missing semantics");
});

test("beatgate can flag a rehash", () => {
  assert.ok(BEAT_GATE_SYSTEM.includes("REHASH"), "missing REHASH type");
  assert.ok(BEAT_GATE_SYSTEM.includes("RESOLVED DECISIONS"), "missing decision cross-check");
});

// --- issue #3: scene length budget ---
import { artDirect, checkContinuity, write, WRITER_SYSTEM } from "../src/roles.ts";
import { MockProvider } from "../src/providers.ts";
import { emptyBible } from "../src/bible.ts";
import type { Beat } from "../src/types.ts";

const mockRole = { provider: new MockProvider(), temperature: 0 };
const testBeat: Beat = {
  goal: "g", conflict: "c", pov: "missing-pov", location: "missing-loc",
  mustReveal: "m", constraints: [], payoffs: []
};

test("writer prompt carries the length target and land-once rule", async () => {
  const out = await write(mockRole, {
    bible: emptyBible(), beat: testBeat, sceneIndex: 0, attempt: 0,
    sceneWords: { min: 1200, max: 1800 }
  });
  assert.ok(out.prompt.includes("LENGTH TARGET: 1200-1800 words"), "missing LENGTH TARGET");
  assert.ok(out.prompt.includes("do not restate the resolution"), "missing land-once prompt rule");
});

test("gate context carries the length target for the critic", async () => {
  const out = await checkContinuity(mockRole, {
    bible: emptyBible(), beat: testBeat, prose: "scene text here", sceneIndex: 0, attempt: 0,
    sceneWords: { min: 900, max: 1500 }
  });
  assert.ok(out.prompt.includes("LENGTH TARGET: 900-1500 words"), "gates never saw the budget");
});

test("writer system bans restating the ending", () => {
  assert.ok(WRITER_SYSTEM.includes("Land the ending ONCE"), "missing land-once rule");
  assert.ok(WRITER_SYSTEM.includes("Never restate the resolution"), "missing no-restate rule");
});

test("critic blocks sustained overshoot as PACE", () => {
  assert.ok(CRITIC_SYSTEM.includes("LENGTH ENFORCEMENT"), "missing enforcement section");
  assert.ok(CRITIC_SYSTEM.includes("twice the maximum"), "missing >2x blocking rule");
});

// --- issue #4: style patterns ---
test("writer bans the observed tics", () => {
  assert.ok(WRITER_SYSTEM.includes("Negation-then-correction"), "missing negation rule");
  assert.ok(WRITER_SYSTEM.includes('"He did not X. He Y."'), "missing did-not rule");
  assert.ok(WRITER_SYSTEM.includes("Abstract padding"), "missing padding rule");
  assert.ok(WRITER_SYSTEM.includes("stating the theme"), "missing theme rule");
  assert.ok(WRITER_SYSTEM.includes("Stock fantasy phrasing"), "missing stock-phrase rule");
});

test("critic blocks style tics only on recurrence", () => {
  assert.ok(CRITIC_SYSTEM.includes("STYLE_PATTERN"), "missing STYLE_PATTERN type");
  assert.ok(CRITIC_SYSTEM.includes("THREE OR MORE times"), "missing recurrence rule");
  assert.ok(CRITIC_SYSTEM.includes("are NOT blocking"), "single occurrences must stay non-blocking");
  assert.ok(CRITIC_SYSTEM.includes("CRAFT remains non-blocking"), "CRAFT rule weakened");
});

// --- issue #5: voice sheets + drift ---
test("writer gets voice sheets for every character, not just POV", async () => {
  const bible = emptyBible();
  bible.characters["a"] = { id: "a", name: "Osmagus", traits: "", goal: "", voice: "Short declarative sentences.", status: "active" };
  bible.characters["b"] = { id: "b", name: "Mettka", traits: "", goal: "", voice: "Measured, speaks in parables.", status: "active" };
  const out = await write(mockRole, {
    bible, beat: testBeat, sceneIndex: 0, attempt: 0,
    sceneWords: { min: 1200, max: 1800 }
  });
  assert.ok(out.prompt.includes("VOICE SHEETS"), "missing voice sheet block");
  assert.ok(out.prompt.includes("Osmagus: Short declarative sentences."), "missing first voice");
  assert.ok(out.prompt.includes("Mettka: Measured, speaks in parables."), "missing non-POV voice");
  assert.ok(out.prompt.includes("do not let voices converge"), "missing anti-convergence rule");
});

test("critic checks voice drift", () => {
  assert.ok(CRITIC_SYSTEM.includes("VOICE DRIFT"), "missing voice drift section");
  assert.ok(CRITIC_SYSTEM.includes("voice drift"), "missing drift semantics");
  assert.ok(CRITIC_SYSTEM.includes("confuses attribution"), "missing blocking threshold");
});

// --- issue #14: speaker tags for audiobook ---
test("writer omits speaker tags by default", async () => {
  const out = await write(mockRole, {
    bible: emptyBible(), beat: testBeat, sceneIndex: 0, attempt: 0,
    sceneWords: { min: 1200, max: 1800 }
  });
  assert.ok(!out.prompt.includes("SPEAKER TAGS"), "speaker tag block leaked into a run that didn't ask for it");
});

test("writer adds speaker tag instructions with valid bible ids when speakerTags is on", async () => {
  const bible = emptyBible();
  bible.characters["osmagus"] = { id: "osmagus", name: "Osmagus", traits: "", goal: "", voice: "", status: "active" };
  bible.characters["mettka"] = { id: "mettka", name: "Mettka", traits: "", goal: "", voice: "", status: "active" };
  const out = await write(mockRole, {
    bible, beat: testBeat, sceneIndex: 0, attempt: 0,
    sceneWords: { min: 1200, max: 1800 }, speakerTags: true
  });
  assert.ok(out.prompt.includes("SPEAKER TAGS"), "missing speaker tag block");
  assert.ok(out.prompt.includes("narrator:"), "missing narrator tag instruction");
  assert.ok(out.prompt.includes("osmagus"), "missing character id in valid tag list");
  assert.ok(out.prompt.includes("mettka"), "missing second character id in valid tag list");
  assert.ok(out.prompt.includes("Write dialogue normally"), "missing natural-dialogue instruction");
});

// --- issue #6: unaddressed practical gaps ---
test("continuist can flag unaddressed practical gaps", () => {
  assert.ok(CONTINUIST_SYSTEM.includes("UNADDRESSED_PRACTICAL"), "missing type in enum");
  assert.ok(CONTINUIST_SYSTEM.includes("obvious in-world fix"), "missing example in enum");
  assert.ok(CONTINUIST_SYSTEM.includes("PRACTICAL GAPS"), "missing section");
  assert.ok(CONTINUIST_SYSTEM.includes("the constraint is the reason"), "missing constraint carve-out");
  assert.ok(
    CONTINUIST_SYSTEM.includes("UNSATISFIABLE_CONSTRAINT"),
    "missing beatgate deferral for unsatisfiable specs"
  );
});

test("art director prompt covers both modes, continuity, and video framing", () => {
  assert.ok(ARTDIRECTOR_SYSTEM.includes('{"prompt":string}'), "missing output shape");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("- SCENE:"), "missing scene mode");
  assert.ok(ARTDIRECTOR_SYSTEM.includes('{"shots":[{"start_paragraph":number,"prompt":string,"characters":[characterId],"location":locationId,"props":[propId]}]}'), "missing shots output shape");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("first shot starts at paragraph 1"), "missing first-shot anchor rule");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("Spread shots across the WHOLE scene"), "missing whole-scene coverage rule");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("Vary the framing"), "missing framing variety rule");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("- COVER:"), "missing cover mode");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("never invent events"), "missing grounded-in-prose rule");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("VISUAL CONTINUITY"), "missing cross-scene continuity rule");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("never by name alone"), "missing describe-by-appearance rule");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("16:9"), "missing landscape framing");
  assert.ok(ARTDIRECTOR_SYSTEM.includes("No text"), "missing no-text rule");
});

test("art director prompt builder includes the scene, or the beat summary for the cover", async () => {
  const bible = emptyBible();
  bible.characters["a"] = { id: "a", name: "Osmagus", traits: "", goal: "", voice: "", status: "active" };
  const paragraphs = ["The lamp gutters.", "Osmagus lifts the horn.", "The note rolls down the valley.", "Silence.", "A reply comes."];
  const scene = await artDirect(mockRole, {
    bible, mode: "scene", beat: testBeat, paragraphs, shots: 3, sceneIndex: 0,
    previousPrompts: ["p1", "p2", "p3", "p4", "p5"]
  });
  assert.ok(scene.prompt.includes("MODE: SCENE"));
  assert.ok(scene.prompt.includes("[1] The lamp gutters."));
  assert.ok(scene.prompt.includes("[5] A reply comes."));
  assert.ok(scene.prompt.includes("Make 3 shots."));
  assert.equal(scene.result.shots?.length, 3);
  assert.equal(scene.result.shots?.[0].startParagraph, 0);
  assert.equal(scene.result.prompt, scene.result.shots?.[0].prompt);
  assert.ok(scene.prompt.includes("Osmagus"));
  assert.ok(scene.prompt.includes("- p5") && !scene.prompt.includes("- p1"), "continuity window should keep only recent prompts");
  assert.ok(scene.result.prompt.length > 0);

  const cover = await artDirect(mockRole, { bible, mode: "cover", beats: [testBeat, testBeat] });
  assert.ok(cover.prompt.includes("MODE: COVER"));
  assert.ok(cover.prompt.includes(`2. [${testBeat.location}]`));
  assert.ok(!cover.prompt.includes("COMMITTED SCENE"));
});

// --- issue #20: post-commit roles see the whole scene ---
import { archive, reviewPatch, normalizeShots, shotCountFor } from "../src/roles.ts";
import { sceneParagraphs } from "../src/audiobook.ts";

test("archivist, patch gate and art director see the scene's ending, not a truncated prefix", async () => {
  const ending = "The letter from Torvin was waiting downstairs on the bar.";
  const prose = `${"Osmagus lifts the horn. ".repeat(500)}\n\n${ending}`;
  assert.ok(prose.length > 10000);
  const params = { bible: emptyBible(), beat: testBeat, prose, sceneIndex: 0 };
  const arch = await archive(mockRole, { ...params, isFinal: false });
  assert.ok(arch.prompt.includes(ending), "archivist prompt is missing the scene ending");
  const gate = await reviewPatch(mockRole, { ...params, patch: {} });
  assert.ok(gate.prompt.includes(ending), "patch gate prompt is missing the scene ending");
  const art = await artDirect(mockRole, { bible: params.bible, beat: testBeat, mode: "scene", paragraphs: sceneParagraphs(prose, new Set()) });
  assert.ok(art.prompt.includes(ending), "art director prompt is missing the scene ending");
});

// --- issue #23: multiple shots per scene ---
test("shot count is ~1 per 110 words, clamped to 4..20 and to the paragraph count", () => {
  const para = (words: number) => Array(words).fill("word").join(" ");
  assert.equal(shotCountFor(Array(20).fill(para(90))), 16);   // 1800 words
  assert.equal(shotCountFor(Array(10).fill(para(20))), 4);    // 200 words -> floor of 4
  assert.equal(shotCountFor(Array(60).fill(para(100))), 20);  // 6000 words -> cap of 20
  assert.equal(shotCountFor([para(900), para(900)]), 2);      // can't have more shots than paragraphs
  assert.equal(shotCountFor(Array(20).fill(para(90)), 225), 8);
});

test("normalizeShots converts to 0-based, sorts, drops bad entries, and pins the first shot to the start", () => {
  const shots = normalizeShots({
    shots: [
      { start_paragraph: 5, prompt: "later" },
      { start_paragraph: 2, prompt: "early" },
      { start_paragraph: 5, prompt: "duplicate start" },
      { start_paragraph: 99, prompt: "out of range" },
      { start_paragraph: 3, prompt: "" },
      { start_paragraph: "x", prompt: "not a number" }
    ]
  }, 10);
  assert.deepEqual(shots, [
    { startParagraph: 0, prompt: "early" },
    { startParagraph: 4, prompt: "later" }
  ]);
  assert.deepEqual(normalizeShots({ prompt: "old shape" }, 10), []);
});

// --- issue #27: gender for voice matching ---
test("creator and archivist are asked for character gender", async () => {
  const { ARCHIVIST_SYSTEM } = await import("../src/roles.ts");
  assert.ok(ARCHIVIST_SYSTEM.includes('"gender"?:"female"|"male"|""'), "archivist patch shape missing gender");
  assert.ok(ARCHIVIST_SYSTEM.includes("Never change an existing character's recorded gender"));
});

// --- issue #29: canonical visual references ---
import { normalizeReferences } from "../src/roles.ts";

test("art director prompt covers references for characters, locations and props, and no real-person likeness", () => {
  assert.ok(ARTDIRECTOR_SYSTEM.includes("- REFERENCES:"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes('"props":[{"id":string,"name":string,"appearance":string,"prompt":string}]'));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("a wide establishing view of the place with NO people"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("the object alone, whole and centered"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("never resemble, evoke, or be described in terms of any real person"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("CANONICAL APPEARANCES: when given, describe each character, location, and prop"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes('"location":locationId,"props":[propId]'));
});

test("references mode lists what's missing; scene mode gets canonical appearances and validates shot refs", async () => {
  const bible = emptyBible();
  bible.characters["osmagus"] = { id: "osmagus", name: "Osmagus", traits: "", goal: "", voice: "", status: "active" };
  bible.characters["merta"] = { id: "merta", name: "Merta", traits: "", goal: "", voice: "", status: "active" };
  bible.locations["spires"] = { id: "spires", name: "Hornpeak Spires", description: "" };
  const appearances = { characters: { osmagus: "stocky, red-bearded" }, locations: {}, props: { horn: { name: "the alpenhorn", appearance: "smooth pale wood" } } };
  const refs = await artDirect(mockRole, { bible, mode: "references", characterIds: ["merta"], locationIds: ["spires"], storyText: ["He lifted the horn."], appearances });
  assert.ok(refs.prompt.includes("characters: merta; locations: spires"));
  assert.ok(refs.prompt.includes("KNOWN PROPS: horn"));
  assert.ok(refs.prompt.includes("STORY TEXT (find key props here):\nHe lifted the horn."));
  assert.ok(refs.prompt.includes("- prop horn (the alpenhorn): smooth pale wood"));
  assert.deepEqual(refs.result.references?.map((r) => `${r.kind}:${r.id}`), ["character:merta", "location:spires"]);

  const scene = await artDirect(mockRole, { bible, mode: "scene", paragraphs: ["A.", "B.", "C.", "D."], shots: 2, appearances });
  assert.ok(scene.prompt.includes("CANONICAL APPEARANCES"));
  const known = { characters: new Set(["osmagus"]), locations: new Set(["spires"]), props: new Set(["horn"]) };
  assert.deepEqual(normalizeShots({ shots: [{ start_paragraph: 1, prompt: "p", characters: ["osmagus", "ghost"], location: "nowhere", props: ["horn", "sword"] }] }, 4, known),
    [{ startParagraph: 0, prompt: "p", characters: ["osmagus"], props: ["horn"] }]);
});

test("normalizeReferences keeps requested characters/locations and up to 4 new, slugged props", () => {
  const out = normalizeReferences({
    characters: [{ id: "a", appearance: "tall", prompt: "pa" }, { id: "a", appearance: "dupe", prompt: "x" }, { id: "zzz", appearance: "x", prompt: "x" }],
    locations: [{ id: "spires", appearance: "", prompt: "no look" }],
    props: [
      { id: "Old Horn!", name: "the old horn", appearance: "wood", prompt: "horn" },
      { id: "reed", appearance: "cane", prompt: "reed" },
      { id: "known", appearance: "x", prompt: "x" },
      { id: "p3", appearance: "x", prompt: "x" }, { id: "p4", appearance: "x", prompt: "x" }, { id: "p5", appearance: "x", prompt: "x" }
    ]
  }, { characters: new Set(["a"]), locations: new Set(["spires"]), knownProps: new Set(["known"]) });
  assert.deepEqual(out.map((r) => `${r.kind}:${r.id}`), ["character:a", "prop:old_horn", "prop:reed", "prop:p3", "prop:p4"]);
  assert.equal(out.find((r) => r.id === "old_horn")!.name, "the old horn");
  assert.equal(out.find((r) => r.id === "reed")!.name, "reed");
});

test("references mode can recreate a known prop under its id", async () => {
  const bible = emptyBible();
  // The existing reference got the object wrong; the author's note corrects it.
  const appearances = { characters: {}, locations: {}, props: { horn: { name: "the alpenhorn", appearance: "a wrong earlier look" }, reed: { name: "reed", appearance: "cane" } } };
  const note = "A long conical wooden tube whose bell rests on the ground when played.";
  const out = await artDirect(mockRole, { bible, mode: "references", redoProps: ["horn"], notes: note, appearances });
  assert.ok(out.prompt.includes(`AUTHOR NOTES (follow exactly):\n${note}`));
  assert.ok(out.prompt.includes("KNOWN PROPS: reed"));
  assert.ok(out.prompt.includes("RECREATE these props (keep the id): horn (the alpenhorn)"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("drawn at its true proportions"));
});

test("creator, archivist, writer and continuist all treat key objects as exact canon", async () => {
  const { ARCHIVIST_SYSTEM, CONTINUIST_SYSTEM } = await import("../src/roles.ts");
  assert.ok(ARCHIVIST_SYSTEM.includes('"upsertObjects":[{"id":string,"name"?:string,"description"?:string,"owner"?:characterId}]'));
  assert.ok(ARCHIVIST_SYSTEM.includes("Never rewrite an existing object's description"));
  assert.ok(WRITER_SYSTEM.includes("KEY OBJECTS in the bible have canon physical descriptions"));
  assert.ok(CONTINUIST_SYSTEM.includes("finger-holes on an instrument described without them"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("the image model cannot infer proportions from length alone"));
});

test("art director makes prop references for canon objects under their bible ids", async () => {
  const bible = emptyBible();
  bible.objects.horn = { id: "horn", name: "the alpenhorn", description: "Five feet long, slender." };
  const out = await artDirect(mockRole, { bible, mode: "references", objectIds: ["horn"], appearances: { characters: {}, locations: {}, props: {} } });
  assert.ok(out.prompt.includes("OBJECTS NEEDING REFERENCES (canon — props with these ids): horn (the alpenhorn)"));
  assert.ok(out.result.references?.some((r) => r.kind === "prop" && r.id === "horn"));
});

// --- art style: one per story, decided with the tone ---
test("the art style is canon: the Creator decides it, every art prompt carries it, and a styleless story gets one", async () => {
  assert.ok(ARTDIRECTOR_SYSTEM.includes("every image of a story shares one art style"));
  const bible = emptyBible();
  bible.artStyle = "Gouache illustration, warm earth palette.";
  const scene = await artDirect(mockRole, { bible, mode: "scene", paragraphs: ["A.", "B.", "C.", "D."], shots: 2 });
  assert.ok(scene.prompt.includes("ART STYLE (canon — every prompt renders in exactly this and ends with it verbatim): Gouache illustration, warm earth palette."));
  const refs = await artDirect(mockRole, { bible, mode: "references", appearances: { characters: {}, locations: {}, props: {} } });
  assert.equal(refs.result.artStyle, undefined, "a story with a style never gets a new one");
  const bare = await artDirect(mockRole, { bible: emptyBible(), mode: "references", appearances: { characters: {}, locations: {}, props: {} } });
  assert.ok(bare.prompt.includes("ART STYLE (canon — every prompt renders in exactly this and ends with it verbatim): (none yet)"));
  assert.equal(bare.result.artStyle, "Mock woodcut style.");
});

// --- issue #35: replies that stop at the output limit ---
import { OutputLimitError } from "../src/providers.ts";

test("a JSON role that hits the output limit fails once with the reason; the writer keeps its partial draft", async () => {
  let calls = 0;
  const limited = (partial: string) => ({
    provider: { complete: async () => { calls++; throw new OutputLimitError({ type: "x", model: "m", maxTokens: 10 }, partial); } },
    temperature: 0
  });
  await assert.rejects(artDirect(limited('{"characters":[{"id":"a"'), { bible: emptyBible(), mode: "references", appearances: { characters: {}, locations: {}, props: {} } }), /stopped at its output limit/);
  assert.equal(calls, 1, "no pointless 'reply with valid JSON' retry");
  const draft = await write(limited("The ridge was cold and"), { bible: emptyBible(), beat: testBeat, sceneIndex: 0, attempt: 0, sceneWords: { min: 1200, max: 1800 } });
  assert.equal(draft.result, "The ridge was cold and");
});

// --- the director follows the author's plan ---
import { direct, reviewBeat } from "../src/roles.ts";

test("the director sees the author's plan, and the plan outranks the random complication", async () => {
  const beatRole = { provider: { complete: async () => JSON.stringify(testBeat) }, temperature: 0 };
  const params = { bible: emptyBible(), sceneIndex: 1, total: 3, tension: 7, complication: "An ally withholds a crucial fact.", overdue: [] };
  const planned = await direct(beatRole, { ...params, context: "Scene 2 — The hold: the sigil door opens." });
  assert.ok(planned.prompt.includes("STORY CONTEXT (provided by author):\nScene 2 — The hold"));
  assert.ok(planned.prompt.includes("THE AUTHOR'S PLAN COMES FIRST"));
  assert.ok(planned.prompt.includes("SUGGESTED COMPLICATION (optional"));
  assert.ok(!planned.prompt.includes("REQUIRED COMPLICATION"));
  const open = await direct(beatRole, params);
  assert.ok(open.prompt.includes("REQUIRED COMPLICATION: An ally withholds"));
  assert.ok(!open.prompt.includes("STORY CONTEXT"));
});

test("the beat gate flags a beat that leaves the author's plan", async () => {
  assert.ok(BEAT_GATE_SYSTEM.includes("OFF_PLAN"));
  assert.ok(BEAT_GATE_SYSTEM.includes("check the spec against it FIRST"));
  const gateRole = { provider: { complete: async () => JSON.stringify({ ok: true, issues: [] }) }, temperature: 0 };
  const out = await reviewBeat(gateRole, { bible: emptyBible(), beat: testBeat, sceneIndex: 1, total: 3, tension: 7, complication: "x", context: "plan" });
  assert.ok(out.prompt.includes("SUGGESTED COMPLICATION (optional"));
});

// Issue #81 (Rantoul's Mushrooms, scene 5): the director paid off a stained
// quarterstaff with an invented reveal — it was a poison applicator — that the
// author's plan never made, and the beat gate let it through.
test("in an adaptation the director reveals only what the plan reveals, and the gate flags an invented reveal", async () => {
  const context = "Scene 5 — The troll: Lemuel feeds the troll leg six; it collapses. Leg four, owl hoots, the wagon escapes.";
  const beatRole = { provider: { complete: async () => JSON.stringify(testBeat) }, temperature: 0 };
  const params = { bible: emptyBible(), sceneIndex: 4, total: 6, tension: 9, complication: "Someone arrives who should not be here.", overdue: [] };
  const planned = await direct(beatRole, { ...params, context });
  assert.ok(planned.prompt.includes("Reveal only what the plan reveals"));
  assert.ok(planned.prompt.includes("open setups the plan doesn't pay off stay open"));
  assert.ok(!(await direct(beatRole, params)).prompt.includes("Reveal only what the plan reveals"), "original stories keep their payoffs");
  assert.ok(BEAT_GATE_SYSTEM.includes("explains, reveals or connects something the plan leaves unexplained"));
  assert.ok(BEAT_GATE_SYSTEM.includes("a secret purpose for an object"));
  const invented = { ...testBeat, mustReveal: "The troll's collapse was the gnacien toxin on Rantoul's quarterstaff: he is more prepared than he seems." };
  const verdict = { ok: false, issues: [{ type: "OFF_PLAN", severity: "high", quote: invented.mustReveal, constraint: "the author's Scene 5", detail: "The plan never explains the quarterstaff." }] };
  const gateRole = { provider: { complete: async () => JSON.stringify(verdict) }, temperature: 0 };
  const out = await reviewBeat(gateRole, { bible: emptyBible(), beat: invented, sceneIndex: 4, total: 6, tension: 9, complication: "x", context });
  assert.ok(out.prompt.includes(invented.mustReveal), "the gate sees the reveal");
  assert.equal(out.result.ok, false);
  assert.equal(out.result.issues[0].type, "OFF_PLAN");
});

test("the art director shoots the decisive instant, in motion, with a named camera angle", () => {
  assert.ok(ARTDIRECTOR_SYSTEM.includes("Pick the decisive instant"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("at most one such shot per scene"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("Name a camera angle and placement in every prompt"));
  assert.ok(ARTDIRECTOR_SYSTEM.includes("Only what a camera can see"));
  assert.ok(!ARTDIRECTOR_SYSTEM.includes("tension and aftermath"));
});

// --- issue #66: better prose ---
import { EDITOR_SYSTEM, PROSE_TICS } from "../src/roles.ts";
import { buildRoleProviders } from "../src/providers.ts";

test("beats are outcomes, not choreography; the writer is told the order and means are its own", async () => {
  for (const sys of [DIRECTOR_SYSTEM]) {
    assert.ok(sys.includes("WRITE THE BEAT AS OUTCOMES, NOT CHOREOGRAPHY"));
    assert.ok(sys.includes("at most THREE fixed moments"));
    assert.ok(sys.includes("Never write dialogue"));
  }
  assert.ok(WRITER_SYSTEM.includes("The order and the means are yours"));
  assert.ok(WRITER_SYSTEM.includes("A scene turns"));
  const out = await write(mockRole, { bible: emptyBible(), beat: { ...testBeat, constraints: ["x"] }, sceneIndex: 0, attempt: 0, sceneWords: { min: 1, max: 2 } });
  assert.ok(out.prompt.includes("CONSTRAINTS (must hold by the end of the scene; the order and the means are yours"));
  assert.ok(out.prompt.includes("MUST REVEAL (what the reader must come to understand — show it; no one announces it)"));
});

test("the line editor hunts the same tics and keeps events, names and speaker tags", () => {
  assert.ok(EDITOR_SYSTEM.includes(PROSE_TICS));
  assert.ok(EDITOR_SYSTEM.includes("Never add, remove, reorder or change events"));
  assert.ok(EDITOR_SYSTEM.includes("every paragraph you return must begin with one"));
});

test("a role takes its provider's timeout when it sets none (a slow thinking model)", () => {
  const roles = buildRoleProviders({
    providers: { slow: { type: "mock", timeoutMs: 600000 }, quick: { type: "mock" } },
    roles: { writer: { provider: "slow" }, continuist: { provider: "quick" }, director: { provider: "slow", timeoutMs: 1000 } }
  });
  assert.equal(roles.writer.timeoutMs, 600000);
  assert.equal(roles.director.timeoutMs, 1000);
  assert.equal(roles.continuist.timeoutMs, 180000);
});
