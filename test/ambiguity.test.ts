import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyPatch, emptyBible, renderBible } from "../src/bible.ts";
import { dueSetups, runStory, withPlants } from "../src/engine.ts";
import { AMBIGUITY_GUIDE, BEAT_GATE_SYSTEM, CONTINUIST_SYSTEM, DIRECTOR_SYSTEM, ARCHIVIST_SYSTEM } from "../src/roles.ts";
import { EventLog } from "../src/eventlog.ts";
import { buildRoleProviders } from "../src/providers.ts";
import type { Beat, Role, Setup, StoryConfig } from "../src/types.ts";

// Issue #93: not every setup is a promise. Red herrings misdirect, open
// questions may stay open, motifs recur — and a hidden layer the prose never states.

const ledger: Setup[] = [
  { id: "clue", text: "the torn letter", openedAt: 0 },                                    // no kind: a promise, as before
  { id: "herring", text: "the stained knife", openedAt: 0, kind: "red_herring", purpose: "makes the reader suspect the cook" },
  { id: "q_old", text: "who rang the bell", openedAt: 0, kind: "open_question" },
  { id: "q_mid", text: "where the dog went", openedAt: 1, kind: "open_question" },
  { id: "q_new", text: "what the child saw", openedAt: 2, kind: "open_question" },
  { id: "bell", text: "the bell tolling", openedAt: 0, kind: "motif" }
];
const ids = (xs: Setup[]) => xs.map((s) => s.id).sort();

test("only promises fall due mid-story; the ending settles by ambiguity, and motifs never", () => {
  assert.deepEqual(ids(dueSetups(ledger, 4, false, 3).due), ["clue"], "the red herring, questions and motif are never overdue");
  assert.deepEqual(ids(dueSetups(ledger, 2, false, 3).due), [], "not yet overdue");
  const tidy = dueSetups(ledger, 5, true, 3, "tidy");
  assert.deepEqual(ids(tidy.due), ["clue", "herring", "q_mid", "q_new", "q_old"]);
  assert.deepEqual(ids(tidy.standing), ["bell"]);
  const some = dueSetups(ledger, 5, true, 3, "some");
  assert.deepEqual(ids(some.due), ["clue", "q_old"], "the two newest questions may stand");
  assert.deepEqual(ids(some.standing), ["bell", "herring", "q_mid", "q_new"]);
  assert.deepEqual(ids(dueSetups(ledger, 5, true, 3, "lots").due), ["clue"]);
});

test("a setup's kind and purpose are recorded when it opens, the director's plant wins, and a kind never changes after", () => {
  const beat = { plants: [{ id: "herring", text: "a stained knife", kind: "red_herring", purpose: "suspect the cook" }, { id: "old", text: "x", kind: "motif" }] } as unknown as Beat;
  const patch = withPlants({ openSetups: [{ id: "herring", text: "the knife on the block", kind: "promise" }, { id: "clue", text: "a torn letter" }] }, beat, [{ id: "old", text: "", openedAt: 0 }]);
  assert.deepEqual(patch.openSetups, [{ id: "herring", text: "the knife on the block", kind: "red_herring", purpose: "suspect the cook" }, { id: "clue", text: "a torn letter" }], "the plant's kind over the archivist's; an already-open setup isn't re-planted");
  let bible = applyPatch(emptyBible(), patch, 0);
  assert.deepEqual(bible.ledger.map((s) => [s.id, s.kind]), [["herring", "red_herring"], ["clue", undefined]], "a promise is stored without a kind, as before");
  bible = applyPatch(bible, { openSetups: [{ id: "herring", text: "now a real clue", kind: "promise" }] }, 1);
  assert.equal(bible.ledger.find((s) => s.id === "herring")?.kind, "red_herring", "never quietly turned into a promise");
  assert.equal(applyPatch(emptyBible(), { openSetups: [{ id: "x", kind: "nonsense" as never }] }, 0).ledger[0].kind, undefined, "an unknown kind is a promise");
});

test("the bible shows each setup's kind and purpose, and the hidden truths as never to be stated", () => {
  const text = renderBible({ ...emptyBible(), ledger: ledger.slice(0, 2), hiddenTruths: ["the cook is the narrator's mother"] });
  assert.match(text, /- clue \(opened S1\): the torn letter/);
  assert.match(text, /- herring \[red herring — purpose: makes the reader suspect the cook\] \(opened S1\)/);
  assert.match(text, /HIDDEN TRUTHS \(what's really going on — keep every scene consistent with them, NEVER state them outright in the prose\):\n- the cook is the narrator's mother/);
  assert.doesNotMatch(renderBible(emptyBible()), /HIDDEN TRUTHS/, "only when there are some");
});

test("the gates respect the kinds: an invented explanation is caught, an implied reveal isn't flagged, a stated hidden truth is", () => {
  assert.match(BEAT_GATE_SYSTEM, /INVENTED_EXPLANATION: the spec gives a red herring, an open question or a motif/);
  assert.match(CONTINUIST_SYSTEM, /keepImplied stays implied ON PURPOSE: never flag it as unresolved/);
  assert.match(CONTINUIST_SYSTEM, /flag HIDDEN_TRUTH_STATED/);
  assert.match(DIRECTOR_SYSTEM, /"plants":\[\{"id":string,"text":string,"kind":"promise"\|"red_herring"\|"open_question"\|"motif","purpose":string\}\],"keepImplied":\[string\]/);
  assert.match(ARCHIVIST_SYSTEM, /Never re-record an open setup as a different kind/);
  assert.match(AMBIGUITY_GUIDE.lots, /plant red herrings, open questions and motifs freely/);
});

test("a mock story: scene 1 plants a promise, a red herring and an open question; the ending pays only the promise and leaves the others standing", async () => {
  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 2, premise: "A cook, a knife, a missing letter.", ambiguity: "some" } as StoryConfig;
  const roles = buildRoleProviders(config);
  const directorPrompts: string[] = [];
  const real = roles.director.provider.complete.bind(roles.director.provider);
  roles.director.provider = { complete: async (req) => {
    const out = await real(req);
    if (req.role === "creator") {
      const f = JSON.parse(out);
      f.hidden_truths = ["the cook wrote the letter"];
      f.beat.plants = [
        { id: "clue", text: "a torn letter in the grate", kind: "promise", purpose: "points to the writer" },
        { id: "herring", text: "a stained knife", kind: "red_herring", purpose: "suspect the cook" },
        { id: "bell", text: "who rang the bell", kind: "open_question", purpose: "unease" }
      ];
      return JSON.stringify(f);
    }
    if (req.role === "director") directorPrompts.push(req.prompt);
    return out;
  } };
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-ambiguity-"));
  const log = new EventLog(dir);
  const bible = await runStory({ config, log, roles, runDir: dir });
  const final = directorPrompts.at(-1)!;
  const due = /OVERDUE SETUPS TO PAY OFF: (.*)/.exec(final)![1];
  assert.ok(due.includes("clue") && !due.includes("herring") && !due.includes("bell"), `only promises due: ${due}`);
  assert.match(final, /MAY STAY AS THEY ARE[^\n]*herring \(red herring\), bell \(open question\)/);
  assert.match(final, /AMBIGUITY: some/);
  assert.deepEqual(bible.hiddenTruths, ["the cook wrote the letter"]);
  assert.ok(["herring", "bell"].every((id) => bible.ledger.some((s) => s.id === id)), "the red herring and the open question survive the ending unexplained");
});

test("the writer's notes are cut off its draft: never in the prose, shown to the reviewers and the archivist as intent", async () => {
  const { splitWriterNotes } = await import("../src/roles.ts");
  assert.deepEqual(splitWriterNotes("The bell rang.\n\n### WRITER'S NOTES\n- seeding the bell as a motif"), { prose: "The bell rang.", notes: "- seeding the bell as a motif" });
  assert.deepEqual(splitWriterNotes("The bell rang.\n\n**Writers notes**\n- x"), { prose: "The bell rang.", notes: "- x" });
  assert.deepEqual(splitWriterNotes("The bell rang. He wrote notes in the margin."), { prose: "The bell rang. He wrote notes in the margin." }, "no heading, no notes");

  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 1, premise: "A bell nobody rings." } as StoryConfig;
  const roles = buildRoleProviders(config);
  const seen: Record<string, string[]> = {};
  for (const name of ["writer", "continuist", "critic", "archivist"] as const) {
    const role = roles[name]!;
    const real = role.provider.complete.bind(role.provider);
    role.provider = { complete: async (req) => {
      (seen[req.role] ??= []).push(req.prompt);
      const out = await real(req);
      return req.role === "writer" ? `${out}\n\n### WRITER'S NOTES\n- seeding the bell as a motif; its ringer stays unknown on purpose` : out;
    } };
  }
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-notes-"));
  const log = new EventLog(dir);
  await runStory({ config, log, roles, runDir: dir });
  const committed = log.events.find((e) => e.type === "scene_committed")!.data as { prose: string };
  assert.doesNotMatch(committed.prose, /WRITER'S NOTES|seeding the bell/);
  assert.match(seen.continuist.at(-1)!, /WRITER'S NOTES \(the writer's stated intent, not part of the scene\):\n- seeding the bell as a motif/);
  assert.match(seen.archivist.at(-1)!, /WRITER'S NOTES \(what the writer meant/);
  assert.match(CONTINUIST_SYSTEM, /They are never evidence: judge only what the prose itself establishes/);
});

test("writerNotes: false takes the notes channel away; the A/B harness splices its floating detail into the prose, never the notes", async () => {
  const { write } = await import("../src/roles.ts");
  const systems: string[] = [];
  const role = { provider: { complete: async (req: { system: string }) => { systems.push(req.system); return "The fog came in.\n\n### WRITER'S NOTES\n- x"; } } } as unknown as Role;
  const beat = { goal: "", conflict: "", pov: "", location: "", mustReveal: "", constraints: [], payoffs: [] } as Beat;
  const off = await write(role, { bible: emptyBible(), beat, sceneIndex: 0, attempt: 0, sceneWords: { min: 1, max: 2 }, notes: false });
  const on = await write(role, { bible: emptyBible(), beat, sceneIndex: 0, attempt: 0, sceneWords: { min: 1, max: 2 } });
  assert.doesNotMatch(systems[0], /WRITER'S NOTES/);
  assert.match(systems[1], /WRITER'S NOTES \(optional\)/);
  assert.deepEqual([off.result, off.notes], ["The fog came in.", undefined], "notes are still cut off the prose, and dropped");
  assert.deepEqual([on.result, on.notes], ["The fog came in.", "- x"]);
  const { splice, PROBE_F } = await import("../experiments/ambiguity-ab/run.ts");
  const spliced = splice("One.\n\nTwo.\n\nThree.\n\n### WRITER'S NOTES\n- the bell stays unexplained");
  assert.equal(spliced, `One.\n\nTwo.\n\n${PROBE_F.sentence}\n\nThree.\n\n### WRITER'S NOTES\n- the bell stays unexplained`);
  assert.equal(splice(spliced), spliced, "once only");
});

test("loose ends: deliberate only when the draft that introduced it said so; a claim on a later draft doesn't count", async () => {
  const { classifyLooseEnds } = await import("../src/engine.ts");
  const drafts = new Map([[1, [
    { n: 1, prose: "A bell rang once at midnight. Someone had left a muddy boot print on the ceiling.", notes: "- The midnight bell stays unexplained on purpose." },
    { n: 2, prose: "A bell rang once at midnight. Someone had left a muddy boot print on the ceiling. Revised.", notes: "- The boot print on the ceiling is a stray detail for texture." }
  ]]]);
  const ends = classifyLooseEnds([
    { scene: 2, quote: "A bell rang once at midnight", detail: "a midnight bell with no church" },
    { scene: 2, quote: "a muddy boot print on the ceiling", detail: "boot print on the ceiling" },
    { scene: 1, quote: "a cart with no horse", detail: "a horseless cart" }
  ], drafts);
  assert.deepEqual(ends.map((e) => [e.declared, e.draft, e.id]), [[true, 1, undefined], [false, 1, "loose_end_2"], [false, undefined, "loose_end_3"]]);
});

test("a mock story: before the final scene, an accidental loose end falls due and a declared one stays open", async () => {
  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 2, premise: "A fog, a boat cut loose." } as StoryConfig;
  const roles = buildRoleProviders(config);
  const wrap = (name: "writer" | "continuist" | "director", f: (req: { role: string; prompt: string; ctx?: unknown }, out: string) => string) => {
    const role = roles[name]!;
    const real = role.provider.complete.bind(role.provider);
    role.provider = { complete: async (req) => f(req, await real(req)) };
  };
  wrap("writer", (req, out) => ((req.ctx as { sceneIndex?: number })?.sceneIndex === 0
    ? `${out}\n\nA bell rang once at midnight. Someone had left a muddy boot print on the ceiling.\n\n### WRITER'S NOTES\n- The midnight bell stays unexplained on purpose.`
    : out));
  wrap("continuist", (req, out) => (req.role === "looseends"
    ? JSON.stringify({ looseEnds: [{ scene: 1, quote: "A bell rang once at midnight", detail: "a midnight bell" }, { scene: 1, quote: "a muddy boot print on the ceiling", detail: "boot print on the ceiling" }] })
    : out));
  const finalPrompts: string[] = [];
  wrap("director", (req, out) => { if (req.role === "director") finalPrompts.push(req.prompt); return out; });
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-loose-"));
  const log = new EventLog(dir);
  await runStory({ config, log, roles, runDir: dir });
  const due = /OVERDUE SETUPS TO PAY OFF: (.*)/.exec(finalPrompts.at(-1)!)![1];
  assert.match(due, /loose_end_2/);
  assert.doesNotMatch(due, /loose_end_1/);
  const report = await readFile(join(dir, "loose-ends.md"), "utf8");
  assert.match(report, /## To pay off in the final scene\n- \*\*boot print on the ceiling\*\*/);
  assert.match(report, /## Left open on purpose[^\n]*\n- \*\*a midnight bell\*\* \(scene 1, draft 1\)/);
  assert.equal(log.events.filter((e) => e.type === "loose_ends").length, 1);
  // Held to it like any promise: the final director sees it in the open setups, not only the overdue list.
  assert.match(finalPrompts.at(-1)!, /OPEN SETUPS[^]*- loose_end_2 \(opened S1\): boot print on the ceiling/);
  const committed = log.events.find((e) => e.type === "scene_committed")!.data as { drafts?: unknown[] };
  assert.equal(committed.drafts?.length, 1, "each draft kept with the scene");
});
