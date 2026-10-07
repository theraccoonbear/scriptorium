import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { renderBible, replay } from "../src/bible.ts";
import { draftSheet, portraitIds, recordedSheet, SHEET_FILE, syncCharacterSheet } from "../src/characterSheet.ts";
import { planReferences, staleCharacterRefs } from "../src/engine.ts";
import { buildRoleProviders } from "../src/providers.ts";
import { AUTHOR_DESIGN_LABEL, INSPECTOR_SYSTEM, MockImageBackend, buildArtJobs, renderArt } from "../src/artist.ts";
import { parseApprovalTarget, readApprovals, setApproval } from "../src/approvals.ts";
import { needAuditions, renderVoiceSamples, sampleText } from "../src/voiceSamples.ts";
import { planSteps } from "../src/make.ts";
import { pitch } from "../src/pitch.ts";
import { readVisualRefs } from "../src/visualrefs.ts";
import type { VisualRefData } from "../src/types.ts";

// Issue #84: phased production — the author's character sheet, reference and
// voice phases, and approvals that stick.

const CHARS = {
  lemuel: { id: "lemuel", name: "Lemuel Braunschweiger", traits: "halfling barbarian", goal: "", voice: "loud", status: "active", gender: "male", vocal: "booming" },
  ivana: { id: "ivana", name: "Ivana de Donder", traits: "wood elf ranger", goal: "", voice: "dry", status: "active", gender: "female" },
  osmagus: { id: "osmagus", name: "Osmagus Larbyr", traits: "porter", goal: "", voice: "", status: "active", gender: "male" }
};
const PROSE = ['lemuel: "Up," Lemuel said. "Everyone up."', 'ivana: "Quiet," said Ivana.', "The road was empty."].join("\n\n");

async function run() {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-phases-"));
  const log = new EventLog(runDir);
  await log.load();
  await log.append("scene_committed", { index: 0, prose: PROSE, bible: { premise: "p", tone: "deadpan", characters: CHARS, locations: { ditch: { id: "ditch", name: "The Ditch", description: "a muddy ditch" } } } });
  return { runDir, log };
}

async function editSheet(runDir: string, edit: (s: { characters: Record<string, Record<string, unknown>> }) => void) {
  const file = join(runDir, SHEET_FILE);
  const sheet = JSON.parse(await readFile(file, "utf8"));
  edit(sheet);
  await writeFile(file, JSON.stringify(sheet, null, 2));
}

test("the character sheet is drafted from the bible, keeps the author's edits, and gains new characters", async () => {
  const { runDir, log } = await run();
  const first = await syncCharacterSheet(runDir, log);
  assert.equal(first.created, true);
  const drafted = JSON.parse(await readFile(join(runDir, SHEET_FILE), "utf8"));
  assert.deepEqual(Object.keys(drafted.characters), ["ivana", "lemuel", "osmagus"]);
  assert.equal(drafted.characters.lemuel.vocal, "booming");
  await editSheet(runDir, (s) => { s.characters.lemuel.background = "Lost his family's goat farm to brigands."; s.characters.osmagus.portrait = false; });
  const again = await syncCharacterSheet(runDir, log);
  assert.equal(again.recorded, true, "the edit is recorded");
  assert.equal(recordedSheet(log.events)!.lemuel.background, "Lost his family's goat farm to brigands.");
  assert.equal((await syncCharacterSheet(runDir, log)).recorded, false, "unchanged: nothing new recorded");
  // A character the story gains later is added; the author's text is untouched.
  await log.append("scene_committed", { index: 1, prose: "x", patch: { upsertCharacters: [{ id: "rantoul", name: "Rantoul Hayworth", traits: "monk", goal: "", voice: "", status: "active" }] } });
  const grown = await syncCharacterSheet(runDir, log);
  assert.deepEqual(grown.added, ["rantoul"]);
  const after = JSON.parse(await readFile(join(runDir, SHEET_FILE), "utf8"));
  assert.equal(after.characters.lemuel.background, "Lost his family's goat farm to brigands.");
  assert.deepEqual(portraitIds(log.events), ["ivana", "lemuel", "rantoul"], "portrait: false is left out");
});

test("the author's sheet overrides the bible for every role, and the archivist can't undo it", async () => {
  const { runDir, log } = await run();
  await syncCharacterSheet(runDir, log);
  await editSheet(runDir, (s) => { s.characters.ivana.appearance = "Tall, silver-haired, a scar through one eyebrow."; s.characters.ivana.vocal = "low and wry"; });
  await syncCharacterSheet(runDir, log);
  await log.append("scene_committed", { index: 1, prose: "x", patch: { upsertCharacters: [{ id: "ivana", vocal: "high and bright" }] } });
  const ivana = replay(log.events).characters.ivana;
  assert.equal(ivana.vocal, "low and wry");
  assert.equal(ivana.appearance, "Tall, silver-haired, a scar through one eyebrow.");
  assert.match(renderBible(replay(log.events)), /looks \(author\): Tall, silver-haired/);
  assert.deepEqual(draftSheet([]), { characters: {} });
});

test("the refs phase makes a portrait per sheet character and place; a sheet edit makes that portrait stale", async () => {
  const { runDir, log } = await run();
  const config = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const roles = buildRoleProviders(config);
  await syncCharacterSheet(runDir, log);
  await editSheet(runDir, (s) => { s.characters.osmagus.portrait = false; });
  await syncCharacterSheet(runDir, log);
  const first = await planReferences({ config, log, roles });
  assert.ok(first.made.includes("character:lemuel") && first.made.includes("character:ivana") && first.made.includes("location:ditch"));
  assert.ok(!first.made.includes("character:osmagus"), "portrait: false");
  assert.deepEqual(staleCharacterRefs(log.events), [], "portraits made from the current sheet are current");
  await editSheet(runDir, (s) => { s.characters.ivana.background = "Raised by the Grey Hunt; owes them a debt."; });
  await syncCharacterSheet(runDir, log);
  assert.deepEqual(staleCharacterRefs(log.events), ["ivana"]);
  const second = await planReferences({ config, log, roles });
  assert.deepEqual(second.stale, ["ivana"]);
  assert.deepEqual(second.made.filter((r) => r.startsWith("character:")), ["character:ivana"], "only the changed portrait is remade");
  const ivana = readVisualRefs(log.events).find((r) => r.id === "ivana") as VisualRefData;
  assert.ok(ivana.sheet?.includes("Grey Hunt"), "the portrait remembers the sheet it was drawn from");
});

test("approved work is never remade: a redo of it is refused, and a stale approved portrait stays", async () => {
  const { runDir, log } = await run();
  const config = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const roles = buildRoleProviders(config);
  await syncCharacterSheet(runDir, log);
  await planReferences({ config, log, roles });
  const approved = new Set(["character-ivana"]);
  await assert.rejects(planReferences({ config, log, roles, redo: ["character:ivana"], approved }), /approved — revoke/);
  await assert.rejects(planReferences({ config, log, roles, notes: "older" }), /--note only applies with --redo/);
  await editSheet(runDir, (s) => { s.characters.ivana.appearance = "Older now."; });
  await syncCharacterSheet(runDir, log);
  const out = await planReferences({ config, log, roles, approved });
  assert.ok(!out.made.includes("character:ivana"));
  const redone = await planReferences({ config, log, roles, redo: ["character:lemuel"], notes: "a bigger beard" });
  assert.ok(redone.made.includes("character:lemuel"));
});

test("renderArt: refs only renders just the references; approved images are kept even when forced or re-prompted", async () => {
  const { runDir, log } = await run();
  await log.append("visual_ref", { kind: "character", id: "lemuel", appearance: "a", prompt: "portrait lemuel" });
  await log.append("scene_art", { sceneIndex: 0, prompt: "s", shots: [{ startParagraph: 0, prompt: "shot one" }] });
  await log.append("cover_art", { sceneCount: 1, prompt: "cover" });
  const backend = new MockImageBackend();
  const refsOnly = await renderArt(log.events, { runDir, backend, only: "references" });
  assert.equal(refsOnly.rendered, 1);
  assert.deepEqual(backend.calls.map((c) => c.prompt.split("\n")[0]), ["portrait lemuel"]);
  await log.append("visual_ref", { kind: "character", id: "lemuel", appearance: "b", prompt: "portrait lemuel, older" });
  const locked = await renderArt(log.events, { runDir, backend: new MockImageBackend(), approved: new Set(["character-lemuel"]), force: true });
  assert.equal(locked.manifest["character-lemuel"].prompt, "portrait lemuel", "the approved portrait is untouched");
  assert.equal(locked.rendered, 2, "the shot and the cover");
});

test("approvals: images by key, voices by voice:<id>, and revoking", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-approve-"));
  assert.deepEqual(parseApprovalTarget("voice:nell"), { kind: "voices", id: "nell" });
  assert.deepEqual(parseApprovalTarget("character-nell"), { kind: "art", id: "character-nell" });
  await setApproval(runDir, ["character-nell", "voice:nell", "voice:narrator"], true);
  await setApproval(runDir, ["voice:narrator"], false);
  assert.deepEqual(await readApprovals(runDir), { art: ["character-nell"], voices: ["nell"] });
});

test("voice samples: a fair stretch of each speaker's own lines, or an audition line when the story gives too little; each announced by name; remade only when the voice changes", async () => {
  const { runDir, log } = await run();
  // The test story gives Lemuel and Ivana a line each: too little to judge a voice by.
  assert.equal(sampleText(log.events, "lemuel"), undefined, "a few words is not a sample");
  assert.equal(sampleText(log.events, "narrator", 10), "The road was empty.");
  assert.equal(sampleText(log.events, "lemuel", 10), "Up, Everyone up.", "their own words only (not the narration between them), without the quotation marks");
  assert.deepEqual(needAuditions(log.events, ["narrator", "lemuel", "ivana"]), ["lemuel", "ivana"]);
  const spoken: string[] = [];
  const speak = async (prompt: string, voice: string) => { spoken.push(`${voice}:${prompt.includes("Read the transcript only.") ? "slate" : "sample"}`); return { samples: new Float32Array(2400), sampleRate: 24000 }; };
  const voices = { narrator: "en-us-storyteller-13", lemuel: "algenib", ivana: "kore" };
  const auditions = { lemuel: "Everyone up, I said. The road won't walk itself, and neither will you, so up.", ivana: "Quiet. Something is moving out there, and it is not a sheep." };
  const first = await renderVoiceSamples(log.events, { runDir, voices, speak, auditions });
  assert.equal(first[0].id, "narrator", "narrator first");
  assert.deepEqual(first.filter((s) => s.id !== "narrator").map((s) => s.source), ["audition", "audition"]);
  assert.ok(first.every((s) => s.slate), "each one announced by name");
  assert.equal(spoken.filter((x) => x.endsWith("slate")).length, 3);
  assert.ok(spoken.filter((x) => x.endsWith("slate")).every((x) => x.startsWith("en-us-storyteller-13")), "the narrator announces them");
  spoken.length = 0;
  const again = await renderVoiceSamples(log.events, { runDir, voices: { ...voices, ivana: "leda" }, speak, auditions });
  assert.deepEqual(again.filter((s) => s.made).map((s) => s.id), ["ivana"]);
  assert.deepEqual(spoken, ["leda:sample"], "only her sample is remade; the announcements are kept");
  assert.match(again.find((s) => s.id === "ivana")!.file, /audiobook\/samples\/ivana\.wav$/);
});

test("review phases run only when asked for, before the steps they feed", () => {
  assert.deepEqual(planSteps(), ["story", "art", "audiobook", "music", "video"]);
  assert.deepEqual(planSteps("voices,refs,characters"), ["characters", "refs", "voices"]);
  assert.deepEqual(planSteps("refs,art"), ["refs", "art"]);
  assert.throws(() => planSteps(undefined, "refs"), /review phase/);
});

test("the pitch for a phase covers just that phase", async () => {
  const { log } = await run();
  const refs = pitch({ events: log.events, scenes: 1, art: { refsOnly: true, refTargets: 4, batch: true }, audio: { skip: true } });
  assert.equal(refs.images.references, 4);
  assert.equal(refs.images.shots + refs.images.cover, 0);
  const voices = pitch({ events: log.events, scenes: 1, art: { skip: true }, audio: { narration: "gemini", dialogue: "gemini", samplesOnly: true, speakers: 4 } });
  assert.equal(voices.audio.geminiRequests, 4);
  assert.ok(voices.audio.usd < 0.05 && voices.images.generations === 0);
  const batch = pitch({ events: log.events, scenes: 40, art: { skip: true }, audio: { narration: "gemini", dialogue: "gemini", geminiMode: "palette", geminiBatch: true } });
  assert.ok(!batch.warnings.some((w) => /100-a-day/.test(w)), "batch voice has its own limits");
});

// The author's own drawing of a character: copied into the run, their portrait
// drawn from it, checked against it, and remade only when the drawing changes.
test("a sheet reference image: copied and hashed, drives the portrait, and a new drawing remakes only that portrait", async () => {
  const { runDir, log } = await run();
  const config = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const roles = buildRoleProviders(config);
  const art = join(runDir, "..", `drawing-${Date.now()}.png`);
  await writeFile(art, "lemuel drawing v1");
  await syncCharacterSheet(runDir, log);
  await planReferences({ config, log, roles });
  assert.deepEqual(staleCharacterRefs(log.events), []);

  // Relative to characters.json.
  await editSheet(runDir, (s) => { s.characters.lemuel.reference = join("..", art.split("/").pop()!); });
  assert.equal((await syncCharacterSheet(runDir, log)).recorded, true);
  const lemuel = replay(log.events).characters.lemuel;
  assert.equal(lemuel.reference?.file, "references/lemuel.png");
  assert.equal(await readFile(join(runDir, "references/lemuel.png"), "utf8"), "lemuel drawing v1", "copied into the run");
  assert.deepEqual(staleCharacterRefs(log.events), ["lemuel"], "a new reference makes the portrait stale");
  const planned = await planReferences({ config, log, roles });
  assert.deepEqual(planned.made.filter((r) => r.startsWith("character:")), ["character:lemuel"]);

  // The portrait is drawn from the drawing, labelled as the author's design.
  const job = buildArtJobs(log.events).find((j) => j.key === "character-lemuel")!;
  assert.deepEqual([job.photos, job.design], [["references/lemuel.png"], true]);
  const shrink = async (img: { data: Buffer; mimeType: string }) => img;
  const backend = new MockImageBackend();
  await renderArt(log.events, { runDir, backend, shrink, only: "references" });
  const call = backend.calls.find((c) => c.prompt === job.prompt)!;
  assert.equal(call.references[0].label, AUTHOR_DESIGN_LABEL);
  assert.equal(call.references[0].data.toString(), "lemuel drawing v1");
  assert.ok(INSPECTOR_SYSTEM.includes("DESIGN MATCH") && INSPECTOR_SYSTEM.includes("An AUTHOR'S DESIGN is a drawing, not a real person"));

  // Same file, same drawing: nothing to record, nothing stale, nothing re-rendered.
  assert.equal((await syncCharacterSheet(runDir, log)).recorded, false);
  assert.deepEqual(staleCharacterRefs(log.events), []);
  const quiet = new MockImageBackend();
  await renderArt(log.events, { runDir, backend: quiet, shrink, only: "references" });
  assert.deepEqual(quiet.calls, []);

  // A new drawing at the same path is an edit: that portrait (only) is stale again.
  await writeFile(art, "lemuel drawing v2");
  assert.equal((await syncCharacterSheet(runDir, log)).recorded, true);
  assert.deepEqual(staleCharacterRefs(log.events), ["lemuel"]);
  // ...unless it's approved: then it stays, with a warning.
  const out = await planReferences({ config, log, roles, approved: new Set(["character-lemuel"]) });
  assert.ok(!out.made.includes("character:lemuel"));

  // Bad references are refused with the path explained.
  await editSheet(runDir, (s) => { s.characters.lemuel.reference = "nowhere.png"; });
  await assert.rejects(syncCharacterSheet(runDir, log), /lemuel's reference nowhere\.png not found \(paths are relative to/);
  await editSheet(runDir, (s) => { s.characters.lemuel.reference = "notes.txt"; });
  await assert.rejects(syncCharacterSheet(runDir, log), /must be a \.png, \.jpg or \.webp image/);
});

// A sheet edit must be able to change a face: when a portrait is remade, its old
// look is not handed to the art director as canon to keep.
test("a remade portrait follows the new sheet entry, not its old look", async () => {
  const { runDir, log } = await run();
  const config = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const prompts: string[] = [];
  const roles = buildRoleProviders(config);
  const inner = roles.artdirector!.provider;
  roles.artdirector!.provider = { complete: async (req) => { prompts.push(req.prompt); return inner.complete(req); } };
  await syncCharacterSheet(runDir, log);
  await planReferences({ config, log, roles });
  await log.append("visual_ref", { kind: "character", id: "lemuel", appearance: "OLD LOOK: grey hair, long lined face", prompt: "old portrait" });
  await editSheet(runDir, (s) => { s.characters.lemuel.appearance = "NEW LOOK: ginger beard, broken nose"; });
  await syncCharacterSheet(runDir, log);
  prompts.length = 0;
  const out = await planReferences({ config, log, roles });
  assert.ok(out.made.includes("character:lemuel"));
  const remake = prompts.find((p) => p.includes("lemuel"))!;
  assert.ok(remake.includes("NEW LOOK: ginger beard"), "the sheet's look reaches the art director");
  assert.ok(!remake.includes("OLD LOOK"), "the old portrait's look is not passed as canon");
});
