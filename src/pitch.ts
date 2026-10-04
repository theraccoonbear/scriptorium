import { buildScenes } from "./audiobook.ts";
import { planBatches } from "./geminiBatch.ts";
import { buildArtJobs } from "./artist.ts";
import type { GeminiMode } from "./geminiBatch.ts";
import { readLedger, usd } from "./usage.ts";
import type { LedgerEntry } from "./usage.ts";
import type { SceneArtData, SceneCommittedData, StoryEvent, VisualRefData } from "./types.ts";

// The pitch: before spending, what a story needs and what it will cost — images
// (references, shots, cover, and retakes), voice requests, time, and days of
// Gemini voice quota. Exact where the run already has it (scenes written, shots
// directed, scenes tagged), estimated where it doesn't; per-call costs come from
// the run's own ledger when it has history, else from typical figures.

export const TYPICAL = {
  imageUsd: 0.089,         // one image generation with references (Chapter 3's average)
  inspectionUsd: 0.0066,   // one inspection
  storyUsdPerScene: 0.30,  // Opus writer + editor, Haiku elsewhere (Gallows Inn: $0.88 / 3 scenes)
  ttsUsdPerSecond: 0.000225, // Gemini Flash TTS: ~25 audio tokens/s at $9/M
  wordsPerScene: 1500,
  wordsPerSecond: 2.6,     // narration pace
  paragraphsPerScene: 50,
  imageSeconds: 20,        // one generation + inspection
  ttsSecondsPerRequest: 12,
  ttsPerDay: 100           // Tier 1 daily cap per model
};

export interface PitchInput {
  events: StoryEvent[];
  ledger?: LedgerEntry[];
  scenes: number;                       // planned scenes
  wordsPerShot?: number;                // artWordsPerShot (default 110)
  art?: { maxAttempts?: number; retakes?: number; concurrency?: number; skip?: boolean };
  audio?: { narration?: "kokoro" | "gemini"; dialogue?: "kokoro" | "gemini"; geminiMode?: GeminiMode; geminiConcurrency?: number; skip?: boolean };
  budgetUsd?: number;
  artManifest?: Record<string, { prompt: string }>;  // art/art.json: images already rendered
  scenesVoiced?: number;                             // scenes whose audio is already rendered
}

export interface Pitch {
  exact: { story: boolean; shots: boolean; voicing: boolean };
  story: { scenesToWrite: number; usd: number };
  images: { references: number; shots: number; cover: number; generations: number; retakes: number; usd: number; minutes: number };
  audio: { seconds: number; geminiRequests: number; usd: number; minutes: number; days: number };
  spentUsd: number;
  totalUsd: number;
  warnings: string[];
}

// Average cost of one call to a model in the run's ledger (undefined without history).
function averageUsd(ledger: LedgerEntry[], match: (e: LedgerEntry) => boolean): number | undefined {
  const xs = ledger.filter((e) => match(e) && e.usd !== null);
  return xs.length >= 3 ? xs.reduce((a, e) => a + (e.usd ?? 0), 0) / xs.length : undefined;
}

export function pitch(input: PitchInput): Pitch {
  const ledger = input.ledger ?? [];
  const committed = input.events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData);
  const toWrite = Math.max(0, input.scenes - committed.length);
  const words = committed.reduce((a, d) => a + d.prose.split(/\s+/).filter(Boolean).length, 0) + toWrite * TYPICAL.wordsPerScene;

  // Images: directed shots where they exist, else one per wordsPerShot.
  const directed = new Map<number, number>();
  for (const e of input.events) if (e.type === "scene_art") { const d = e.data as SceneArtData; directed.set(d.sceneIndex, d.shots?.length ?? 1); }
  const refs = new Set(input.events.filter((e) => e.type === "visual_ref").map((e) => `${(e.data as VisualRefData).kind}:${(e.data as VisualRefData).id}`)).size;
  const undirectedScenes = input.scenes - directed.size;
  const shots = [...directed.values()].reduce((a, b) => a + b, 0) + Math.max(0, undirectedScenes) * Math.round(TYPICAL.wordsPerScene / (input.wordsPerShot ?? 110));
  let references = refs + (directed.size === 0 ? 3 + 2 * input.scenes : Math.max(0, undirectedScenes) * 2);
  let shotsToRender = shots;
  let cover = 1;
  // Images already rendered for the same prompt are skipped, as the art step skips them.
  if (input.artManifest && directed.size > 0) {
    const pending = buildArtJobs(input.events).filter((j) => input.artManifest![j.key]?.prompt !== j.prompt);
    references = pending.filter((j) => j.ref).length + Math.max(0, undirectedScenes) * 2;
    shotsToRender = pending.filter((j) => !j.ref && j.sceneIndex !== undefined).length + Math.max(0, undirectedScenes) * Math.round(TYPICAL.wordsPerScene / (input.wordsPerShot ?? 110));
    cover = pending.some((j) => j.key === "cover") || input.scenes > committed.length ? 1 : 0;
  }
  const art = input.art ?? {};
  // Retakes: triage spends exactly its share; inspection-and-retry averages ~0.4 per image.
  const retakes = art.skip ? 0 : art.retakes !== undefined ? Math.round(art.retakes * (shotsToRender + cover)) + Math.round(0.4 * references) : Math.round(0.4 * (shotsToRender + cover + references));
  const generations = art.skip ? 0 : references + shotsToRender + cover + retakes;
  const imageUsd = averageUsd(ledger, (e) => e.model.includes("image")) ?? TYPICAL.imageUsd;
  const inspectUsd = averageUsd(ledger, (e) => e.role === "inspector") ?? TYPICAL.inspectionUsd;
  const imagesUsd = generations * (imageUsd + inspectUsd);
  const imageMinutes = (generations * TYPICAL.imageSeconds) / 60 / Math.max(1, art.concurrency ?? 4);

  // Voice: Gemini requests by mode (exact when the scenes are tagged and batched).
  const audio = input.audio ?? {};
  // Scenes already voiced are skipped, as the audiobook step skips them.
  const unvoiced = input.scenes > 0 ? Math.max(0, input.scenes - (input.scenesVoiced ?? 0)) / input.scenes : 0;
  const seconds = audio.skip ? 0 : (words / TYPICAL.wordsPerSecond) * unvoiced;
  const narrationShare = audio.narration === "gemini" ? 1 : 0;
  const dialogueShare = audio.dialogue === "gemini" ? 1 : 0;
  const geminiShare = audio.skip ? 0 : Math.max(narrationShare * 0.7 + dialogueShare * 0.3, 0);
  let geminiRequests = 0;
  let exactVoicing = false;
  if (geminiShare > 0) {
    const mode = audio.geminiMode ?? "line";
    const scenes = buildScenes(input.events);
    const tagged = scenes.filter((s) => s.tagged).length === committed.length && committed.length === input.scenes;
    const pieces = scenes.flatMap((s) => s.segments.flatMap((seg) => seg.text.split("\n\n").map((text, k) => ({ order: k, speaker: seg.speaker, text }))))
      .filter((p) => (p.speaker === "narrator" ? narrationShare : dialogueShare) > 0);
    if (tagged && mode !== "palette") {
      exactVoicing = true;
      geminiRequests = Math.round((mode === "line" ? pieces.length : planBatches(pieces).length) * unvoiced);
    } else {
      const paragraphs = committed.length > 0 ? scenes.reduce((a, s) => a + new Set(s.segments.flatMap((x) => x.paragraphs)).size, 0) / committed.length * input.scenes : TYPICAL.paragraphsPerScene * input.scenes;
      const perParagraph = mode === "line" ? 1.6 : mode === "palette" ? 0.35 : 0.25;
      geminiRequests = Math.round(paragraphs * perParagraph * geminiShare * unvoiced);
    }
    geminiRequests = Math.round(geminiRequests * 1.2); // retakes of reads that ran long
  }
  const audioUsd = seconds * geminiShare * 1.2 * TYPICAL.ttsUsdPerSecond;
  const kokoroSeconds = audio.skip ? 0 : seconds * (1 - geminiShare);
  const audioMinutes = (geminiRequests * TYPICAL.ttsSecondsPerRequest) / 60 / Math.max(1, audio.geminiConcurrency ?? 2) + kokoroSeconds / 1.05 / 60;
  const days = Math.ceil(geminiRequests / TYPICAL.ttsPerDay);

  const storyUsd = toWrite * TYPICAL.storyUsdPerScene;
  const spentUsd = ledger.reduce((a, e) => a + (e.usd ?? 0), 0);
  const totalUsd = storyUsd + imagesUsd + audioUsd;
  const warnings: string[] = [];
  if (days > 1) warnings.push(`${geminiRequests} Gemini voice requests is ${days} days of the 100-a-day cap — try geminiMode "palette" or "speaker"`);
  if (input.budgetUsd !== undefined && spentUsd + totalUsd > input.budgetUsd) warnings.push(`estimated ${usd(spentUsd + totalUsd)} is over the ${usd(input.budgetUsd)} budget`);
  return {
    exact: { story: toWrite === 0, shots: undirectedScenes <= 0, voicing: exactVoicing },
    story: { scenesToWrite: toWrite, usd: storyUsd },
    images: { references: art.skip ? 0 : references, shots: art.skip ? 0 : shotsToRender, cover: art.skip ? 0 : cover, generations, retakes, usd: imagesUsd, minutes: imageMinutes },
    audio: { seconds, geminiRequests, usd: audioUsd, minutes: audioMinutes, days },
    spentUsd, totalUsd, warnings
  };
}

// How many triage retakes the budget can still buy, after everything else.
export function affordableRetakes(p: Pitch, budgetUsd: number): number {
  const perImage = p.images.generations > 0 ? p.images.usd / p.images.generations : TYPICAL.imageUsd + TYPICAL.inspectionUsd;
  const left = budgetUsd - p.spentUsd - (p.totalUsd - p.images.retakes * perImage);
  return Math.max(0, Math.floor(left / perImage));
}

export function formatPitch(p: Pitch, budgetUsd?: number): string {
  const m = (min: number) => (min < 1 ? "<1 min" : `${Math.round(min)} min`);
  const est = (exact: boolean) => (exact ? "" : " (estimated)");
  return [
    `story: ${p.story.scenesToWrite === 0 ? "written" : `${p.story.scenesToWrite} scene${p.story.scenesToWrite === 1 ? "" : "s"} to write, ~${usd(p.story.usd)}`}`,
    p.images.generations === 0
      ? "images: nothing to render"
      : `images${est(p.exact.shots)}: ${p.images.references} references + ${p.images.shots} shots${p.images.cover ? " + cover" : ""}, ${p.images.retakes} retakes = ${p.images.generations} generations, ~${usd(p.images.usd)}, ~${m(p.images.minutes)}`,
    p.audio.seconds === 0
      ? "voice: nothing to voice"
      : `voice${est(p.exact.voicing)}: ~${Math.round(p.audio.seconds / 60)} min of audio, ${p.audio.geminiRequests} Gemini requests${p.audio.geminiRequests ? ` (${p.audio.days} day${p.audio.days === 1 ? "" : "s"} of quota)` : ""}, ~${usd(p.audio.usd)}, ~${m(p.audio.minutes)}`,
    `total: ~${usd(p.totalUsd)} still to spend${p.spentUsd > 0 ? ` (${usd(p.spentUsd)} spent so far)` : ""}${budgetUsd !== undefined ? ` · budget ${usd(budgetUsd)}` : ""}`,
    ...p.warnings.map((w) => `⚠ ${w}`)
  ].join("\n");
}
