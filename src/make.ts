import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { EventLog } from "./eventlog.ts";
import { checkDirection } from "./providers.ts";
import { formatSummary, readLedger, summarize } from "./usage.ts";
import { artStep, audiobookStep, loadRun, readContexts, storyStep, videoStep } from "./steps.ts";
import { c } from "./colors.ts";
import { CRITIC_MODES } from "./types.ts";
import type { StoryConfig, StoryEvent } from "./types.ts";

// A story file holds everything about one story — the config, premise,
// context files, step options and a fixed run directory — so `make` can run
// the whole pipeline (story → art → audiobook → video) from one command, and
// re-running it just finishes whatever's missing.

export interface StoryFile {
  config: string | StoryConfig;        // path to a config file, or the config inline
  out: string;                         // the run directory (fixed — no timestamp)
  premise?: string;
  setting?: string;
  context?: string | string[];         // one or more context files
  scenes?: number;
  maxAttempts?: number | "unlimited";
  speakerTags?: boolean;
  audiobook?: { narratorVoice?: string; language?: string; voiceGenders?: Record<string, string>; kokoroVoices?: { include?: string[]; exclude?: string[] } };
  video?: { encoder?: "auto" | "nvenc" | "x264"; parallel?: number };
  direction?: Record<string, string>;  // author direction per creative layer (see DIRECTION_LAYERS)
  budget?: { usd: number };            // stop before spending more than this on the run
  maxDraftsPerScene?: number;          // hard stop for a scene that won't settle (default 20)
  pricing?: StoryConfig["pricing"];    // per-model USD per million tokens, over the defaults
  artStyle?: string;                   // prescriptive art style; overrides the Creator's
  critic?: StoryConfig["critic"];      // "blocking" (default), "advisory" or "off"
}

export interface ResolvedStory {
  file: string;
  config: StoryConfig;
  configPath?: string;
  runDir: string;
  premise?: string;
  setting?: string;
  contextPaths: string[];
  scenes?: number;
  maxAttempts?: number;
  speakerTags?: boolean;
  audiobook: NonNullable<StoryFile["audiobook"]>;
  video: NonNullable<StoryFile["video"]>;
}

export const STEPS = ["story", "art", "audiobook", "video"] as const;
export type Step = (typeof STEPS)[number];

// Paths in a story file are relative to the story file's own directory.
export async function loadStoryFile(path: string): Promise<ResolvedStory> {
  const raw = JSON.parse(await readFile(path, "utf8")) as StoryFile;
  const base = dirname(resolve(path));
  const at = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  if (!raw.out) throw new Error(`${path}: "out" (the run directory) is required`);
  if (!raw.config) throw new Error(`${path}: "config" (a config file path, or the config inline) is required`);
  const configPath = typeof raw.config === "string" ? at(raw.config) : undefined;
  const baseConfig = configPath ? (JSON.parse(await readFile(configPath, "utf8")) as StoryConfig) : (raw.config as StoryConfig);
  // The story file's direction and art style layer over the config's.
  const config: StoryConfig = {
    ...baseConfig,
    ...(raw.direction || baseConfig.direction ? { direction: { ...baseConfig.direction, ...raw.direction } } : {}),
    ...(raw.artStyle ?? baseConfig.artStyle ? { artStyle: raw.artStyle ?? baseConfig.artStyle } : {}),
    ...(raw.budget ?? baseConfig.budget ? { budget: raw.budget ?? baseConfig.budget } : {}),
    ...(raw.maxDraftsPerScene ?? baseConfig.maxDraftsPerScene ? { maxDraftsPerScene: raw.maxDraftsPerScene ?? baseConfig.maxDraftsPerScene } : {}),
    ...(raw.pricing || baseConfig.pricing ? { pricing: { ...baseConfig.pricing, ...raw.pricing } } : {}),
    ...(raw.critic ?? baseConfig.critic ? { critic: raw.critic ?? baseConfig.critic } : {})
  };
  if (config.budget !== undefined && !(typeof config.budget.usd === "number" && config.budget.usd > 0)) {
    throw new Error(`${path}: "budget" must look like { "usd": 5 }`);
  }
  if (config.critic !== undefined && !(CRITIC_MODES as readonly string[]).includes(config.critic)) {
    throw new Error(`${path}: "critic" must be one of ${CRITIC_MODES.join(", ")}`);
  }
  checkDirection(config.direction);
  const contexts = raw.context === undefined ? [] : Array.isArray(raw.context) ? raw.context : [raw.context];
  const attempts = raw.maxAttempts === "unlimited" ? Infinity : raw.maxAttempts;
  if (attempts !== undefined && !(attempts === Infinity || (Number.isInteger(attempts) && attempts > 0))) {
    throw new Error(`${path}: "maxAttempts" must be a positive integer or "unlimited"`);
  }
  return {
    file: path,
    config,
    configPath,
    runDir: at(raw.out),
    premise: raw.premise,
    setting: raw.setting,
    contextPaths: contexts.map(at),
    scenes: raw.scenes,
    maxAttempts: attempts,
    speakerTags: raw.speakerTags,
    audiobook: raw.audiobook ?? {},
    video: raw.video ?? {}
  };
}

// Which steps to run: all of them, `--only a,b`, or `--from x` onward.
export function planSteps(only?: string, from?: string): Step[] {
  const parse = (s: string): Step => {
    if (!(STEPS as readonly string[]).includes(s)) throw new Error(`unknown step "${s}" (steps: ${STEPS.join(", ")})`);
    return s as Step;
  };
  if (only && from) throw new Error("use --only or --from, not both");
  if (only) {
    const wanted = new Set(only.split(",").map((s) => parse(s.trim())));
    return STEPS.filter((s) => wanted.has(s));
  }
  if (from) return STEPS.slice(STEPS.indexOf(parse(from)));
  return [...STEPS];
}

// The settings that shape a story's text. Changing one after scenes are
// committed would quietly produce a different story than the one in progress.
export interface StorySettings {
  premise: string | null;
  setting: string | null;
  context: string | null;  // hash of the combined context text
  contextFiles: string[];
  speakerTags: boolean;
}

export async function storySettings(story: ResolvedStory): Promise<StorySettings> {
  const { context, contextFiles } = await readContexts(story.contextPaths);
  return {
    premise: story.premise ?? null,
    setting: story.setting ?? null,
    context: context ? createHash("sha1").update(context).digest("hex") : null,
    contextFiles,
    speakerTags: Boolean(story.speakerTags ?? story.config.speakerTags)
  };
}

export function settingChanges(before: StorySettings, after: StorySettings): string[] {
  const changed: string[] = [];
  if (before.premise !== after.premise) changed.push("premise");
  if (before.setting !== after.setting) changed.push("setting");
  if (before.context !== after.context) changed.push(`context (${before.contextFiles.join(", ") || "none"} → ${after.contextFiles.join(", ") || "none"}, or their contents)`);
  if (before.speakerTags !== after.speakerTags) changed.push("speakerTags");
  return changed;
}

export interface MakeOptions {
  only?: string;
  from?: string;
  force?: boolean;  // allow changed story settings for a story already in progress
  steps?: Partial<StepRunners>;  // injectable for tests
}

export interface StepRunners {
  story: (story: ResolvedStory) => Promise<void>;
  art: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  audiobook: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  video: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
}

const defaultRunners: StepRunners = {
  story: async (s) => {
    await storyStep({
      config: s.config, runDir: s.runDir, scenes: s.scenes, maxAttempts: s.maxAttempts,
      premise: s.premise, setting: s.setting, contextPaths: s.contextPaths, speakerTags: s.speakerTags
    });
  },
  // make never re-renders finished work; the individual commands take --force for that.
  art: async (s, events) => { await artStep(s.runDir, s.config, events, false); },
  audiobook: async (s, events) => {
    await audiobookStep(s.runDir, events, {
      narratorVoice: s.audiobook.narratorVoice, language: s.audiobook.language, characterGenders: s.audiobook.voiceGenders, kokoroVoices: s.audiobook.kokoroVoices,
      config: s.config
    });
  },
  video: async (s, events) => { await videoStep(s.runDir, events, false, s.video); }
};

const SETTINGS_FILE = "story-settings.json";

export async function make(storyPath: string, opts: MakeOptions = {}): Promise<Step[]> {
  const story = await loadStoryFile(storyPath);
  const steps = planSteps(opts.only, opts.from);
  const run = { ...defaultRunners, ...opts.steps };
  await mkdir(story.runDir, { recursive: true });

  // Guard the story in progress against changed settings.
  const settings = await storySettings(story);
  const committed = (await loadRun(story.runDir)).some((e) => e.type === "scene_committed");
  let recorded: StorySettings | undefined;
  try { recorded = JSON.parse(await readFile(`${story.runDir}/${SETTINGS_FILE}`, "utf8")); } catch { /* new run */ }
  if (committed && recorded) {
    const changed = settingChanges(recorded, settings);
    if (changed.length > 0 && !opts.force) {
      throw new Error(`${storyPath} changes ${changed.join("; ")} for a story already in progress in ${story.runDir} — revert it, point "out" at a new directory, or pass --force`);
    }
    if (changed.length > 0) console.error(`[scriptorium] ${c.retry(`--force: continuing with changed ${changed.join("; ")}`)}`);
  }
  if (steps.includes("story") || !recorded) {
    await writeFile(`${story.runDir}/${SETTINGS_FILE}`, JSON.stringify(settings, null, 2) + "\n", "utf8");
  }

  console.error(`[scriptorium] ${c.dim(`make ${storyPath} → ${story.runDir} (${steps.join(" → ")})`)}`);
  for (const step of steps) {
    console.error(`[scriptorium] ${c.blue(c.bold(`== ${step} ==`))}`);
    if (step === "story") {
      await run.story(story);
      continue;
    }
    // Later steps read the run as the story step left it.
    const events = await new EventLog(story.runDir).load();
    if (!events.some((e) => e.type === "scene_committed")) {
      throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
    }
    await run[step](story, events);
  }
  console.error(`[scriptorium] ${c.ok(`done: ${steps.join(", ")}`)}`);
  const ledger = readLedger(story.runDir);
  if (ledger.length > 0) console.error(`[scriptorium] ${c.dim(`spend for ${story.runDir}:\n${formatSummary(summarize(ledger), story.config.budget?.usd)}`)}`);
  return steps;
}
