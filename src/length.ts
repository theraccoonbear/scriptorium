import { closeSync, existsSync, openSync, readSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SceneCommittedData, StoryEvent, WordBudget } from "./types.ts";

// A story's length as a running time (#170): "12 minutes in 3 scenes" becomes
// word budgets at the narrator's pace, a fit check of the author's plan against
// it before anything is written, beats sized to each scene's share, and drafts
// held to their budget.

export interface LengthSetting {
  minutes: number;            // the running time to aim for: narration, not counting titles and cards
  // The scene count is the story file's own "scenes" (else one per ~10 minutes); it isn't set here.
  wordsPerMinute?: number;    // the narrator's pace (else measured from this run's audiobook, else 156)
  // When the plan won't fit: "check" (default) stops before writing, with the
  // options; "compress" goes ahead, telling the director what to tighten; "off" skips the check.
  fit?: "check" | "compress" | "off";
}

export const WORDS_PER_MINUTE = 156;      // measured: Rantoul's Mushrooms, ~10.8K words in a 68.7-minute film
export const WORDS_PER_SCENE = 1500;      // a scene when the author doesn't say (about 10 minutes)
export const BUDGET_SLACK = 0.15;         // a scene's budget: its share, ±15%
export const MIN_SCENE_WORDS = 250;

export interface ResolvedLength {
  minutes: number;
  scenes: number;
  wordsPerMinute: number;
  totalWords: number;
  sceneWords: WordBudget;     // the even share, ±15%: what a scene gets before the arc weighs in
  fit: "check" | "compress" | "off";
}

export function resolveLength(len: LengthSetting, opts: { scenes?: number; measuredWpm?: number } = {}): ResolvedLength {
  if ("scenes" in len) throw new Error(`"length.scenes" is gone: the scene count has one place, "scenes" at the top of the story file`);
  if (!(typeof len.minutes === "number" && len.minutes > 0)) throw new Error(`"length.minutes" must be a positive number`);
  const wordsPerMinute = len.wordsPerMinute ?? opts.measuredWpm ?? WORDS_PER_MINUTE;
  const totalWords = Math.round(len.minutes * wordsPerMinute);
  const scenes = opts.scenes ?? Math.max(1, Math.round(totalWords / WORDS_PER_SCENE));
  if (!(Number.isInteger(scenes) && scenes > 0)) throw new Error(`"scenes" must be a positive whole number`);
  const fit = len.fit ?? "check";
  if (!["check", "compress", "off"].includes(fit)) throw new Error(`"length.fit" must be "check", "compress" or "off"`);
  return { minutes: len.minutes, scenes, wordsPerMinute, totalWords, sceneWords: band(totalWords / scenes), fit };
}

const band = (words: number): WordBudget => {
  const mid = Math.max(MIN_SCENE_WORDS, words);
  return { min: Math.round(mid * (1 - BUDGET_SLACK)), max: Math.round(mid * (1 + BUDGET_SLACK)) };
};
export const midpoint = (b: WordBudget) => (b.min + b.max) / 2;

// Each scene's share of a running time: weighted by the arc's tension (1-10),
// so the climax runs long and a quiet bridge runs short, adding up to the whole.
export function sceneBudgets(totalWords: number, tensions: number[]): WordBudget[] {
  const weights = tensions.map((t) => 0.8 + 0.04 * Math.min(10, Math.max(1, t)));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => band((totalWords * w) / sum));
}

export const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
export const minutesFor = (words: number, wpm = WORDS_PER_MINUTE) => words / wpm;

// The narrator's actual pace in this run: words per minute of its voiced
// scenes (audiobook/scene-NN.wav), from the WAV headers. Undefined without any.
export function measuredPace(runDir: string, events: StoryEvent[]): number | undefined {
  const dir = join(runDir, "audiobook");
  if (!existsSync(dir)) return undefined;
  const committed = new Map(events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData).map((d) => [d.index, d]));
  let words = 0, seconds = 0;
  for (const f of readdirSync(dir)) {
    const m = /^scene-(\d+)\.wav$/.exec(f);
    const scene = m ? committed.get(Number(m[1]) - 1) : undefined;
    const sec = scene ? wavSeconds(join(dir, f)) : undefined;
    if (!scene || !sec) continue;
    words += wordCount(scene.prose.replace(/^[a-z0-9_]+:\s*/gim, ""));
    seconds += sec;
  }
  return seconds > 60 ? Math.round(words / (seconds / 60)) : undefined;
}

export function wavSeconds(file: string): number | undefined {
  const fd = openSync(file, "r");
  try {
    const head = Buffer.alloc(4096);
    const n = readSync(fd, head, 0, head.length, 0);
    if (n < 44 || head.toString("ascii", 0, 4) !== "RIFF") return undefined;
    let byteRate = 0;
    for (let at = 12; at + 8 <= n;) {
      const id = head.toString("ascii", at, at + 4);
      const size = head.readUInt32LE(at + 4);
      if (id === "fmt ") byteRate = head.readUInt32LE(at + 16);
      if (id === "data") return byteRate ? size / byteRate : undefined;
      at += 8 + size + (size % 2);
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

// Scene by scene, what's written against its budget (for the pitch and review).
export interface SceneLength { scene: number; words: number; minutes: number; budget?: WordBudget; off?: "long" | "short" }
export function lengthReport(events: StoryEvent[], budgets: WordBudget[] | undefined, wpm = WORDS_PER_MINUTE): SceneLength[] {
  return events.filter((e) => e.type === "scene_committed").map((e) => e.data as SceneCommittedData)
    .sort((a, b) => a.index - b.index)
    .map((d) => {
      const words = wordCount(d.prose.replace(/^[a-z0-9_]+:\s*/gim, ""));
      const budget = budgets?.[d.index];
      const off = budget ? (words > budget.max * (1 + BUDGET_SLACK) ? "long" : words < budget.min * (1 - BUDGET_SLACK) ? "short" : undefined) : undefined;
      return { scene: d.index + 1, words, minutes: minutesFor(words, wpm), ...(budget ? { budget } : {}), ...(off ? { off } : {}) };
    });
}

// A draft past its budget's ceiling by more than the slack goes back to be trimmed.
export const overBudget = (words: number, b: WordBudget) => words > b.max * (1 + BUDGET_SLACK);
export const underBudget = (words: number, b: WordBudget) => words < b.min * (1 - BUDGET_SLACK);

// The fit check's verdict, and what stops the run.
export interface LengthFit {
  needMinutes: number;                          // what the plan needs, told at an easy pace
  items: { item: string; minutes: number }[];   // the plan's events, plot points and exchanges, each with its time
  cuts: { item: string; saves: number }[];      // what to drop or merge first, least needed first
  split?: string;                               // where it would break into parts, if it's far too long
}
export const FIT_TOLERANCE = 1.25;  // a plan needing up to 25% more than asked is tightened by the writing, not stopped
export const tooLong = (fit: LengthFit, minutes: number) => fit.needMinutes > minutes * FIT_TOLERANCE;
export const tooThin = (fit: LengthFit, minutes: number) => fit.needMinutes > 0 && fit.needMinutes < minutes * 0.5;

export function fitMessage(fit: LengthFit, len: ResolvedLength): string {
  const lines = [
    `length: the plan needs about ${Math.round(fit.needMinutes)} minutes; you asked for ${len.minutes} (${len.scenes} scene${len.scenes === 1 ? "" : "s"}, ~${len.totalWords} words). Nothing was written. Choose:`,
    `  - stretch: set "length": { "minutes": ${Math.ceil(fit.needMinutes)} }`,
    fit.cuts.length ? `  - cut: trim the plan; least needed first:\n${fit.cuts.map((c) => `      ${c.item} (saves ~${Math.round(c.saves * 10) / 10} min)`).join("\n")}` : "",
    fit.split ? `  - split: make it a series; ${fit.split}` : "",
    `  - compress: set "length": { ..., "fit": "compress" } to keep the plan and have the director and writer tighten it to fit`
  ];
  return lines.filter(Boolean).join("\n");
}
