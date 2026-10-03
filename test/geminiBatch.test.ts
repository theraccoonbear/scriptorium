import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BATCH_PAUSE_NOTE, batchPrompt, planBatches, splitOnSilences, splitProblem, voiceBatch } from "../src/geminiBatch.ts";
import { parseScene, scenePieces, voiceSceneBatches } from "../src/audiobook.ts";
import { designRun, paletteToneFor, tagRun, sceneTags, proseHash, NARRATOR_TONES } from "../src/tagging.ts";
import { EventLog } from "../src/eventlog.ts";
import { emptyBible } from "../src/bible.ts";
import type { Role } from "../src/types.ts";

const RATE = 24000;
// Synthetic speech: a tone burst per "line" (seconds), silences between.
function audio(parts: Array<{ sound?: number; silence?: number }>): Float32Array {
  const n = parts.reduce((a, p) => a + Math.round(RATE * (p.sound ?? p.silence ?? 0)), 0);
  const out = new Float32Array(n);
  let at = 0;
  for (const p of parts) {
    const len = Math.round(RATE * (p.sound ?? p.silence ?? 0));
    if (p.sound) for (let i = 0; i < len; i++) out[at + i] = 0.5 * Math.sin(i / 8);
    at += len;
  }
  return out;
}
const secs = (a: Float32Array) => a.length / RATE;

test("batches group a speaker's lines (and tone) in story order, capped in size", () => {
  const pieces = [
    { order: 0, speaker: "narrator", text: "The inn was quiet." },
    { order: 1, speaker: "nell", text: '"You\'re him."', tone: "curt" },
    { order: 2, speaker: "edrick", text: '"Edrick Vell."' },
    { order: 3, speaker: "nell", text: '"Nell Ashby."', tone: "curt" },
    { order: 4, speaker: "nell", text: '"Please."', tone: "pleading" },
    { order: 5, speaker: "narrator", text: "She did not sit." }
  ];
  const batches = planBatches(pieces);
  assert.deepEqual(batches.map((b) => [b.speaker, b.tone ?? "", b.pieces.map((p) => p.order)]), [
    ["narrator", "", [0, 5]], ["nell", "curt", [1, 3]], ["edrick", "", [2]], ["nell", "pleading", [4]]
  ]);
  assert.equal(planBatches(pieces, 1400, 1).length, 6, "a line cap splits batches");
  const prompt = batchPrompt(batches[1], { name: "Nell Ashby", profile: "A midwife." });
  assert.ok(prompt.includes("Perform every line curt.") && prompt.includes(BATCH_PAUSE_NOTE));
  assert.ok(prompt.endsWith('#### TRANSCRIPT\n"You\'re him."\n\n"Nell Ashby."'));
});

test("audio is cut at the longest silences; a dramatic pause inside a line is not a cut", () => {
  const a = audio([{ silence: 0.3 }, { sound: 1.0 }, { silence: 2.0 }, { sound: 0.8 }, { silence: 0.6 }, { sound: 0.7 }, { silence: 2.1 }, { sound: 1.2 }, { silence: 0.4 }]);
  const pieces = splitOnSilences(a, RATE, 3)!;
  assert.equal(pieces.length, 3);
  assert.ok(Math.abs(secs(pieces[0]) - 1.16) < 0.1, `line 1: ${secs(pieces[0])}`);
  assert.ok(Math.abs(secs(pieces[1]) - 2.26) < 0.1, `line 2 keeps its inner pause: ${secs(pieces[1])}`);
  assert.ok(Math.abs(secs(pieces[2]) - 1.36) < 0.1, `line 3: ${secs(pieces[2])}`);
  assert.equal(splitOnSilences(audio([{ sound: 3 }]), RATE, 2), undefined, "no pause, no split");
  assert.match(splitProblem([audio([{ sound: 9 }])], ['"Door."'], RATE)!, /runs 9.0s for 1 words/);
});

test("a batch whose audio can't be cut cleanly is retaken, then given up", async () => {
  let n = 0;
  const batch = { speaker: "nell", pieces: [{ order: 0, speaker: "nell", text: '"You\'re him."' }, { order: 1, speaker: "nell", text: '"Nell Ashby."' }] };
  const good = audio([{ sound: 1 }, { silence: 2 }, { sound: 1 }]);
  const bad = audio([{ sound: 30 }]);  // read the whole prompt aloud
  const speak = async () => ({ samples: n++ === 0 ? bad : good, sampleRate: RATE });
  const lines = await voiceBatch(speak, batch, "Kore", { name: "Nell", profile: "" }, RATE);
  assert.equal(n, 2);
  assert.equal(lines.length, 2);
  await assert.rejects(voiceBatch(async () => ({ samples: bad, sampleRate: RATE }), batch, "Kore", { name: "Nell", profile: "" }, RATE), /fewer than 1 pauses|runs/);
});

test("a whole scene is voiced in batches: one request per speaker (and tone), every piece accounted for", async () => {
  const prose = [
    "narrator: The inn was quiet.",
    'nell: "You\'re him," she said.',
    'edrick: "Edrick Vell."',
    'nell: "Nell Ashby." She did not sit. "Corin\'s sister."'
  ].join("\n\n");
  const scene = parseScene(0, prose, new Set(["nell", "edrick"]));
  const bible = emptyBible();
  bible.characters.nell = { id: "nell", name: "Nell Ashby", traits: "", goal: "", voice: "clipped", status: "active" };
  bible.characters.edrick = { id: "edrick", name: "Edrick Vell", traits: "", goal: "", voice: "sparse", status: "active" };
  const prompts: string[] = [];
  // Answers with one burst per transcript line, two-second gaps between.
  const speak = async (prompt: string) => {
    prompts.push(prompt);
    const lines = prompt.split("#### TRANSCRIPT\n")[1].split("\n\n");
    return { samples: audio(lines.flatMap((_, i) => (i ? [{ silence: 2 }, { sound: 1 }] : [{ sound: 1 }]))), sampleRate: RATE };
  };
  // Nell's last paragraph (index 3) is curt; everything else is untoned.
  const toneOf = (_scene: number, paragraph: number, speaker: string) => (speaker === "nell" && paragraph === 3 ? "curt" : undefined);
  const out = await voiceSceneBatches(scene, "palette", { bible, voiceFor: (s) => `gemini:${s === "nell" ? "Kore" : "Charon"}`, speak, toneOf, onProgress: () => {} });
  const all = scenePieces(scene);
  assert.equal(out.size, all.length, "every piece has audio");
  // narrator (4 pieces), nell untoned (1), nell curt (2), edrick (1) = 4 requests for 8 pieces
  assert.equal(prompts.length, 4);
  assert.ok(prompts.some((p) => p.startsWith("# AUDIO PROFILE: Nell Ashby") && p.includes("Perform every line curt.")));
  assert.ok(prompts.every((p) => p.includes(BATCH_PAUSE_NOTE)));
});

test("palettes are designed from the whole script; tagging picks each line's tone from them", async () => {
  const log = new EventLog(await mkdtemp(join(tmpdir(), "scriptorium-pal-")));
  await log.load();
  const scene1 = ['"Go home," Corin said.', '"Not without you," Nell said.', "The fire hissed."].join("\n\n");
  const scene2 = ['"Please," Nell said.'].join("\n\n");
  const cast = { characters: { nell: { id: "nell", name: "Nell", traits: "", goal: "", voice: "clipped", status: "active" }, corin: { id: "corin", name: "Corin", traits: "", goal: "", voice: "light", status: "active" } } };
  await log.append("scene_committed", { index: 0, prose: scene1, bible: cast });
  await log.append("scene_committed", { index: 1, prose: scene2 });
  const prompts: Record<string, string[]> = { palette: [], tag: [] };
  const role: Role = { provider: { complete: async (req) => {
    const task = (req.ctx as { task: string }).task;
    assert.equal(req.role, "voicedirector");
    prompts[task].push(req.prompt);
    if (task === "palette") return JSON.stringify({ palettes: { nell: ["low, furious", "pleading"], corin: ["bright, deflecting"] } });
    const n = (req.ctx as { paragraphs: string[] }).paragraphs.length;
    // Scene 1: Corin (tone 0), Nell (tone 0), narration tagged nell by mistake (tone 1). Scene 2: Nell pleading.
    return JSON.stringify({ paragraphs: n === 3
      ? [{ n: 1, speaker: "corin", tone: 0 }, { n: 2, speaker: "nell", tone: 0 }, { n: 3, speaker: "nell", tone: 1 }]
      : [{ n: 1, speaker: "nell", tone: 1 }], newSpeakers: [] });
  } } };
  const palette = await designRun(log, role, 2);
  assert.match(prompts.palette[0], /=== SCENE 1 ===[\s\S]*=== SCENE 2 ===/, "the whole script, in one call");
  assert.deepEqual(palette.speakers, { narrator: { tones: NARRATOR_TONES }, nell: { tones: ["low, furious", "pleading"] }, corin: { tones: ["bright, deflecting"] } });
  assert.equal(await designRun(log, role, 2), palette, "designed once per script");
  assert.equal(prompts.palette.length, 1);

  await tagRun(log, role, () => {}, palette);
  assert.match(prompts.tag[0], /TONE PALETTES[\s\S]*- nell: 0 = low, furious; 1 = pleading/);
  const tone = paletteToneFor(log.events, palette);
  assert.equal(tone(0, 0, "corin"), "bright, deflecting");
  assert.equal(tone(0, 1, "nell"), "low, furious");
  assert.equal(tone(1, 0, "nell"), "pleading");
  assert.equal(tone(0, 2, "nell"), undefined, "the quote check made the third paragraph narrator, so Nell's tone index is dropped");
  assert.equal(tone(0, 2, "narrator"), NARRATOR_TONES[0], "narration reads in the narrator's neutral tone");
  assert.equal(tone(0, 1, "narrator"), NARRATOR_TONES[0], "narration around Nell's quote doesn't take her tone");
  assert.equal(sceneTags(log.events).get(0)!.palette, palette.source);

  // A scene tagged without this palette is tagged again for it.
  await log.append("scene_tags", { version: 2, index: 1, source: proseHash(scene2), tags: ["nell"], delivery: [""], speakers: [] });
  await tagRun(log, role, () => {}, palette);
  assert.equal(paletteToneFor(log.events, palette)(1, 0, "nell"), "pleading");
});
