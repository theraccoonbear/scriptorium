import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { EventLog } from "./eventlog.ts";
import { checkDirection } from "./providers.ts";
import { formatSummary, readLedger, summarize, usd } from "./usage.ts";
import { pitch } from "./pitch.ts";
import type { Pitch } from "./pitch.ts";
import { artStep, audiobookStep, loadRun, musicStep, readContexts, storyStep, videoStep, voicesStep } from "./steps.ts";
import type { AudiobookStepOptions } from "./steps.ts";
import { portraitIds, recordedSheet, syncCharacterSheet } from "./characterSheet.ts";
import { staleCharacterRefs } from "./engine.ts";
import { replay } from "./bible.ts";
import { refAppearances } from "./visualrefs.ts";
import { c } from "./colors.ts";
import { CRITIC_MODES } from "./types.ts";
import type { StoryConfig, StoryEvent } from "./types.ts";
import type { CastMember } from "./cast.ts";
import type { TitleSettings } from "./titles.ts";
import type { MusicSettings } from "./music.ts";
import { GEMINI_MODES } from "./geminiBatch.ts";
import type { GeminiMode } from "./geminiBatch.ts";

// A story file holds everything about one story — the config, premise,
// context files, step options and a fixed run directory — so `make` can run
// the whole pipeline (story → art → audiobook → video) from one command, and
// re-running it just finishes whatever's missing.

export interface StoryFile {
  config: string | StoryConfig;        // path to a config file, or the config inline
  out: string;                         // the run directory (fixed — no timestamp)
  premise?: string;
  setting?: string;
  title?: string;                      // the story's title, for the video's opening ("Rantoul's Mushrooms")
  subtitle?: string;                   // beneath it ("Part 1")
  series?: { next?: string };          // a chapter of a series: ends "To be continued", and "Next: <next>"
  context?: string | string[];         // one or more context files
  scenes?: number;
  maxAttempts?: number | "unlimited";
  speakerTags?: boolean;
  audiobook?: {
    narratorVoice?: string;
    language?: string;
    voiceGenders?: Record<string, string>;
    narration?: "kokoro" | "gemini";             // default kokoro
    dialogue?: "kokoro" | "gemini";              // default kokoro
    geminiModel?: string;
    geminiVoices?: Record<string, string>;       // character id or "narrator" -> Gemini voice
    kokoroVoices?: { include?: string[]; exclude?: string[] };
    characterVoices?: Record<string, string>;  // character id -> Kokoro voice
    geminiMode?: GeminiMode;                     // "line" (default), "palette" or "speaker"
    paletteSize?: number;                        // palette mode: tones per speaker (default 4)
    geminiRpm?: number;                          // Gemini TTS requests per minute (default 9)
    geminiFallback?: "kokoro" | "gemini";        // a Gemini line that keeps failing (default: gemini if all-Gemini)
    pauseScale?: number;                         // batched modes: scales the pauses between pieces (default 1)
    casting?: boolean;                           // cast Gemini voices from the library (default true)
    geminiConcurrency?: number;                  // batched modes: voice batches at once (default 2; 1 = one at a time)
    geminiBatch?: boolean;                       // batched modes through Gemini Batch Mode (half price, slower)
    castingFile?: string;                        // a cast list shared by every chapter (relative to the story file)
    designVoices?: string[];                     // character ids to give a designed voice
  };
  music?: MusicSettings | false;       // the score (off unless present): { style, duck, volume, model, maxTakes }
  video?: {
    encoder?: "auto" | "nvenc" | "x264";
    parallel?: number;
    titles?: TitleSettings | false;    // the cards: opening title, scene cards, ending, credits (default on)
  };
  direction?: Record<string, string>;  // author direction per creative layer (see DIRECTION_LAYERS)
  budget?: { usd: number };            // stop before spending more than this on the run
  // How art and audio run: "audio-first" (default: voicing is cheap and listening
  // can send a story back for a rewrite before images are paid for),
  // "art-first", or "parallel" (fastest).
  stepOrder?: StepOrder;
  maxDraftsPerScene?: number;          // hard stop for a scene that won't settle (default 20)
  pricing?: StoryConfig["pricing"];    // per-model USD per million tokens, over the defaults
  artStyle?: string;                   // prescriptive art style; overrides the Creator's
  artist?: StoryConfig["artist"];      // image settings over the config's (batch, retakes, concurrency...)
  critic?: StoryConfig["critic"];      // "blocking" (default), "advisory" or "off"
  // The author's pins, per scene in order (null: the models decide).
  tension?: Array<number | null>;      // tension targets 1-10 (else the creator's arc)
  turns?: Array<string | null>;        // each scene's turn (else the plan or the director)
  // Real people and animals who star in the story, from photos (paths relative to the story file).
  cast?: { name: string; photos: string | string[]; notes?: string }[];
}

export interface ResolvedStory {
  file: string;
  config: StoryConfig;
  configPath?: string;
  runDir: string;
  premise?: string;
  setting?: string;
  title?: string;
  subtitle?: string;
  series?: { next?: string };
  contextPaths: string[];
  scenes?: number;
  maxAttempts?: number;
  speakerTags?: boolean;
  audiobook: NonNullable<StoryFile["audiobook"]>;
  video: NonNullable<StoryFile["video"]>;
  music?: MusicSettings;
  cast: CastMember[];
  stepOrder: StepOrder;
}

export const STEPS = ["story", "art", "audiobook", "music", "video"] as const;
// Review phases, run on their own with --only before the steps they feed:
// the character sheet, reference portraits, and cast voices with samples.
export const PHASES = ["characters", "refs", "voices"] as const;
const ALL_STEPS = ["story", "characters", "refs", "voices", "art", "audiobook", "music", "video"] as const;
export const STEP_ORDERS = ["audio-first", "art-first", "parallel"] as const;
export type StepOrder = (typeof STEP_ORDERS)[number];
export type Step = (typeof ALL_STEPS)[number];

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
    ...(raw.critic ?? baseConfig.critic ? { critic: raw.critic ?? baseConfig.critic } : {}),
    ...(raw.tension ?? baseConfig.tension ? { tension: raw.tension ?? baseConfig.tension } : {}),
    ...(raw.turns ?? baseConfig.turns ? { turns: raw.turns ?? baseConfig.turns } : {}),
    ...(raw.artist ? { artist: { ...baseConfig.artist, ...raw.artist } } : {})
  };
  if (config.budget !== undefined && !(typeof config.budget.usd === "number" && config.budget.usd > 0)) {
    throw new Error(`${path}: "budget" must look like { "usd": 5 }`);
  }
  if (config.critic !== undefined && !(CRITIC_MODES as readonly string[]).includes(config.critic)) {
    throw new Error(`${path}: "critic" must be one of ${CRITIC_MODES.join(", ")}`);
  }
  const mode = raw.audiobook?.geminiMode;
  if (mode !== undefined && !(GEMINI_MODES as readonly string[]).includes(mode)) {
    throw new Error(`${path}: audiobook "geminiMode" must be one of ${GEMINI_MODES.join(", ")}`);
  }
  checkDirection(config.direction);
  if (config.tension !== undefined && !(Array.isArray(config.tension) && config.tension.every((t) => t === null || (Number.isInteger(t) && t >= 1 && t <= 10)))) {
    throw new Error(`${path}: "tension" must be a list of tension targets 1-10, one per scene (null where the models decide)`);
  }
  if (config.turns !== undefined && !(Array.isArray(config.turns) && config.turns.every((t) => t === null || typeof t === "string"))) {
    throw new Error(`${path}: "turns" must be a list of each scene's turn, in order (null where the models decide)`);
  }
  const contexts = raw.context === undefined ? [] : Array.isArray(raw.context) ? raw.context : [raw.context];
  const attempts = raw.maxAttempts === "unlimited" ? Infinity : raw.maxAttempts;
  if (attempts !== undefined && !(attempts === Infinity || (Number.isInteger(attempts) && attempts > 0))) {
    throw new Error(`${path}: "maxAttempts" must be a positive integer or "unlimited"`);
  }
  if (raw.cast !== undefined && !Array.isArray(raw.cast)) throw new Error(`${path}: "cast" must be a list of { "name", "photos", "notes" }`);
  const cast: CastMember[] = (raw.cast ?? []).map((m) => {
    if (!m?.name || !m.photos || (Array.isArray(m.photos) && m.photos.length === 0)) throw new Error(`${path}: every cast member needs a "name" and at least one photo in "photos"`);
    return { name: m.name, photos: (Array.isArray(m.photos) ? m.photos : [m.photos]).map(at), ...(m.notes ? { notes: m.notes } : {}) };
  });
  checkVideoTitles(path, raw);
  checkMusic(path, raw);
  if (raw.stepOrder !== undefined && !(STEP_ORDERS as readonly string[]).includes(raw.stepOrder)) {
    throw new Error(`${path}: "stepOrder" must be one of ${STEP_ORDERS.join(", ")}`);
  }
  return {
    file: path,
    config,
    cast,
    stepOrder: raw.stepOrder ?? "audio-first",
    configPath,
    runDir: at(raw.out),
    premise: raw.premise,
    setting: raw.setting,
    title: raw.title,
    subtitle: raw.subtitle,
    series: raw.series,
    contextPaths: contexts.map(at),
    scenes: raw.scenes,
    maxAttempts: attempts,
    speakerTags: raw.speakerTags,
    audiobook: raw.audiobook?.castingFile ? { ...raw.audiobook, castingFile: at(raw.audiobook.castingFile) } : raw.audiobook ?? {},
    video: raw.video ?? {},
    ...(raw.music ? { music: raw.music } : {})
  };
}

function checkMusic(path: string, raw: StoryFile) {
  const m = raw.music;
  if (m === undefined || m === false) return;
  if (typeof m !== "object" || m === null) throw new Error(`${path}: "music" must be false or { style, duck, volume, model, maxTakes }`);
  for (const k of ["duck", "volume"] as const) {
    if (m[k] !== undefined && typeof m[k] !== "number") throw new Error(`${path}: music "${k}" must be a number of dB`);
  }
  if (m.duck !== undefined && (m.duck < 0 || m.duck > 40)) throw new Error(`${path}: music "duck" is dB under the voice, 0-40`);
  if (m.maxTakes !== undefined && !(Number.isInteger(m.maxTakes) && m.maxTakes > 0)) throw new Error(`${path}: music "maxTakes" must be a positive integer`);
  for (const k of ["style", "model"] as const) {
    if (m[k] !== undefined && typeof m[k] !== "string") throw new Error(`${path}: music "${k}" must be text`);
  }
}

function checkVideoTitles(path: string, raw: StoryFile) {
  for (const k of ["title", "subtitle"] as const) {
    if (raw[k] !== undefined && typeof raw[k] !== "string") throw new Error(`${path}: "${k}" must be a string`);
  }
  if (raw.series !== undefined && (typeof raw.series !== "object" || (raw.series.next !== undefined && typeof raw.series.next !== "string"))) {
    throw new Error(`${path}: "series" must look like { "next": "Part 2" }`);
  }
  const t = raw.video?.titles;
  if (t === undefined || t === false) return;
  if (typeof t !== "object" || t === null) throw new Error(`${path}: video "titles" must be false or { opening, narrate, sceneTitles, credits, ending, font, titleFont }`);
  for (const k of ["opening", "narrate", "credits"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "boolean") throw new Error(`${path}: video titles "${k}" must be true or false`);
  }
  if (t.sceneTitles !== undefined && typeof t.sceneTitles !== "boolean" && !(Array.isArray(t.sceneTitles) && t.sceneTitles.every((x) => typeof x === "string"))) {
    throw new Error(`${path}: video titles "sceneTitles" must be true, false or a list of titles`);
  }
  if (t.ending !== undefined && t.ending !== false && typeof t.ending !== "string") throw new Error(`${path}: video titles "ending" must be text (e.g. "The End") or false`);
  for (const k of ["font", "titleFont"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "string") throw new Error(`${path}: video titles "${k}" must be a font name or file`);
  }
}

// Which steps to run: all of them, `--only a,b`, or `--from x` onward.
// The review phases (characters, refs, voices) only run when named in --only.
export function planSteps(only?: string, from?: string): Step[] {
  const parse = (s: string): Step => {
    if (!(ALL_STEPS as readonly string[]).includes(s)) throw new Error(`unknown step "${s}" (steps: ${STEPS.join(", ")}; review phases: ${PHASES.join(", ")})`);
    return s as Step;
  };
  if (only && from) throw new Error("use --only or --from, not both");
  if (only) {
    const wanted = new Set(only.split(",").map((s) => parse(s.trim())));
    return ALL_STEPS.filter((s) => wanted.has(s));
  }
  if (from) {
    const step = parse(from);
    if ((PHASES as readonly string[]).includes(step)) throw new Error(`${step} is a review phase — run it with --only ${step}`);
    return STEPS.slice(STEPS.indexOf(step as (typeof STEPS)[number]));
  }
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
  cast?: string | null;    // hash of the cast's names, notes and photo paths
}

export async function storySettings(story: ResolvedStory): Promise<StorySettings> {
  const { context, contextFiles } = await readContexts(story.contextPaths);
  return {
    premise: story.premise ?? null,
    setting: story.setting ?? null,
    context: context ? createHash("sha1").update(context).digest("hex") : null,
    contextFiles,
    speakerTags: Boolean(story.speakerTags ?? story.config.speakerTags),
    cast: story.cast.length > 0 ? createHash("sha1").update(JSON.stringify(story.cast)).digest("hex") : null
  };
}

export function settingChanges(before: StorySettings, after: StorySettings): string[] {
  const changed: string[] = [];
  if (before.premise !== after.premise) changed.push("premise");
  if (before.setting !== after.setting) changed.push("setting");
  if (before.context !== after.context) changed.push(`context (${before.contextFiles.join(", ") || "none"} → ${after.contextFiles.join(", ") || "none"}, or their contents)`);
  if (before.speakerTags !== after.speakerTags) changed.push("speakerTags");
  if ((before.cast ?? null) !== (after.cast ?? null)) changed.push("cast");
  return changed;
}

export interface MakeOptions {
  only?: string;
  from?: string;
  force?: boolean;  // allow changed story settings for a story already in progress
  stepOrder?: StepOrder;  // overrides the story file's
  redo?: string[];  // refs to remake ("character:nell") or voices to recast ("voice:nell")
  notes?: string;   // the author's corrections for the remade refs
  steps?: Partial<StepRunners>;  // injectable for tests
}

export interface StepRunners {
  story: (story: ResolvedStory) => Promise<void>;
  characters: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  refs: (story: ResolvedStory, events: StoryEvent[], redo: string[], notes?: string) => Promise<void>;
  voices: (story: ResolvedStory, events: StoryEvent[], redo: string[]) => Promise<void>;
  art: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  audiobook: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  music: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  video: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
}

const defaultRunners: StepRunners = {
  story: async (s) => {
    await storyStep({
      config: s.config, runDir: s.runDir, scenes: s.scenes, maxAttempts: s.maxAttempts,
      premise: s.premise, setting: s.setting, contextPaths: s.contextPaths, speakerTags: s.speakerTags,
      cast: s.cast
    });
  },
  characters: async (s) => {
    const log = new EventLog(s.runDir);
    await log.load();
    const sync = await syncCharacterSheet(s.runDir, log);
    const n = Object.keys(recordedSheet(log.events) ?? {}).length;
    console.error(`[scriptorium] ${c.ok(sync.created ? `character sheet drafted: ${n} characters` : `character sheet: ${n} characters${sync.added.length ? `, added ${sync.added.join(", ")}` : ""}${sync.recorded ? " — your edits recorded" : ""}`)} ${c.dim(sync.file)}`);
  },
  refs: async (s, events, redo, notes) => { await artStep(s.runDir, s.config, events, false, { only: "references", redo, ...(notes ? { notes } : {}) }); },
  voices: async (s, events, redo) => { await voicesStep(s.runDir, events, { ...audiobookOptions(s), redo }); },
  // make never re-renders finished work; the individual commands take --force for that.
  art: async (s, events) => { await artStep(s.runDir, s.config, events, false); },
  audiobook: async (s, events) => { await audiobookStep(s.runDir, events, audiobookOptions(s)); },
  // Off unless the story file has a "music" block.
  music: async (s) => {
    if (!s.music) { console.error(`[scriptorium] ${c.dim("no music in the story file — skipping")}`); return; }
    await musicStep(s.runDir, s.config, s.music);
  },
  video: async (s, events) => {
    await videoStep(s.runDir, events, false, {
      ...s.video,
      title: s.title, subtitle: s.subtitle, series: s.series,
      contextPaths: s.contextPaths, base: dirname(resolve(s.file)),
      gemini: s.audiobook.narration === "gemini" || s.audiobook.dialogue === "gemini" ? true : undefined,
      geminiModel: s.audiobook.geminiModel,
      music: s.music
    });
  }
};

function audiobookOptions(s: ResolvedStory): AudiobookStepOptions {
  const a = s.audiobook;
  return {
    narratorVoice: a.narratorVoice, language: a.language, characterGenders: a.voiceGenders,
    narration: a.narration, dialogue: a.dialogue, geminiModel: a.geminiModel, geminiVoices: a.geminiVoices,
    kokoroVoices: a.kokoroVoices, characterVoices: a.characterVoices,
    geminiMode: a.geminiMode, paletteSize: a.paletteSize, geminiRpm: a.geminiRpm, geminiFallback: a.geminiFallback, pauseScale: a.pauseScale,
    casting: a.casting, geminiConcurrency: a.geminiConcurrency, geminiBatch: a.geminiBatch, castingFile: a.castingFile, designVoices: a.designVoices,
    config: s.config
  };
}

const SETTINGS_FILE = "story-settings.json";

// The story's pitch: what the steps to run will need and cost.
export function storyPitch(story: ResolvedStory, events: StoryEvent[], steps: readonly Step[] = STEPS): Pitch {
  const artist = story.config.artist ?? {};
  return pitch({
    events,
    ledger: readLedger(story.runDir),
    scenes: story.scenes ?? story.config.scenes ?? events.filter((e) => e.type === "scene_committed").length,
    wordsPerShot: story.config.artWordsPerShot,
    art: {
      maxAttempts: artist.maxAttempts, retakes: artist.retakes, concurrency: artist.concurrency, batch: artist.batch,
      skip: !(steps.includes("art") || steps.includes("refs")) || !story.config.roles.artdirector,
      ...(steps.includes("refs") && !steps.includes("art") ? { refsOnly: true, refTargets: refTargets(events) } : {})
    },
    audio: {
      narration: story.audiobook.narration, dialogue: story.audiobook.dialogue, geminiMode: story.audiobook.geminiMode, geminiConcurrency: story.audiobook.geminiConcurrency, geminiBatch: story.audiobook.geminiBatch,
      skip: !(steps.includes("audiobook") || steps.includes("voices")),
      ...(steps.includes("voices") && !steps.includes("audiobook") ? { samplesOnly: true, speakers: Object.keys(replay(events).characters).length + 1 } : {})
    },
    ...(story.config.budget ? { budgetUsd: story.config.budget.usd } : {}),
    ...readJson<Record<string, { prompt: string }>>(join(story.runDir, "art", "art.json"), (m) => ({ artManifest: m })),
    music: {
      skip: !steps.includes("music") || !story.music,
      cues: (story.scenes ?? story.config.scenes ?? events.filter((e) => e.type === "scene_committed").length) + 1,
      ...readJson<Record<string, { clean?: boolean }>>(join(story.runDir, "music", "cues.json"), (m) => ({ made: Object.values(m).filter((c) => c.clean).length }))
    },
    scenesVoiced: existsSync(join(story.runDir, "audiobook")) ? readdirSync(join(story.runDir, "audiobook")).filter((f) => /^scene-\d+\.wav$/.test(f)).length : 0
  });
}

// References the refs phase would make: portraits and places without one,
// portraits the sheet has changed, and a couple of key props.
function refTargets(events: StoryEvent[]): number {
  const have = refAppearances(events);
  const bible = replay(events);
  return portraitIds(events).filter((id) => !have.characters[id]).length
    + Object.keys(bible.locations).filter((id) => !have.locations[id]).length
    + staleCharacterRefs(events).length
    + (Object.keys(have.props).length === 0 ? 2 : 0);
}

function readJson<T>(path: string, wrap: (value: T) => object): object {
  try { return wrap(JSON.parse(readFileSync(path, "utf8")) as T); } catch { return {}; }
}

// Pipeline position of a step, with art and audio in the chosen order.
function rank(step: Step, order: StepOrder): number {
  if (step === "art") return order === "art-first" ? 1 : 2;
  if (step === "audiobook") return order === "art-first" ? 2 : 1;
  if (step === "characters") return 0.1;
  if (step === "refs") return 0.2;
  if (step === "voices") return 0.3;
  // The cue sheet reads each scene's length from the audiobook's timings.
  if (step === "music") return 2.5;
  return step === "story" ? 0 : 3;
}

export async function make(storyPath: string, opts: MakeOptions = {}): Promise<Step[]> {
  const story = await loadStoryFile(storyPath);
  const steps = planSteps(opts.only, opts.from);
  const run = { ...defaultRunners, ...opts.steps };
  const redo = opts.redo ?? [];
  const redoVoices = redo.filter((r) => r.startsWith("voice:")).map((r) => r.slice("voice:".length));
  const redoRefs = redo.filter((r) => !r.startsWith("voice:"));
  if (redoRefs.length && !steps.includes("refs")) throw new Error(`--redo ${redoRefs.join(",")}: references are remade in the refs phase (--only refs)`);
  if (redoVoices.length && !steps.includes("voices")) throw new Error(`--redo voice:…: voices are recast in the voices phase (--only voices)`);
  if (opts.notes && redoRefs.length === 0) throw new Error("--note goes with --redo <kind>:<id>");
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
  // The pitch, before anything is spent (the full breakdown: npm run pitch).
  const p = storyPitch(story, await loadRun(story.runDir), steps);
  console.error(`[scriptorium] ${c.dim(`pitch: ~${usd(p.totalUsd)} to spend (images ~${usd(p.images.usd)}, voice ~${usd(p.audio.usd)}${p.music.cues ? `, music ~${usd(p.music.usd)}` : ""}, ${p.audio.geminiRequests} Gemini voice requests)${story.config.budget ? ` · budget ${usd(story.config.budget.usd)}` : ""}`)}`);
  for (const w of p.warnings) console.error(`[scriptorium] ${c.retry(w)}`);
  // Art and audio don't depend on each other: they run in the story's order
  // (audio first by default), or at the same time. The video waits for both.
  const order = opts.stepOrder ?? story.stepOrder;
  const stages: Step[][] = order === "parallel"
    ? steps.reduce<Step[][]>((acc, step) => {
        const last = acc.at(-1);
        if (last && (step === "audiobook" || step === "art") && (last.includes("art") || last.includes("audiobook"))) last.push(step);
        else acc.push([step]);
        return acc;
      }, [])
    : [...steps].sort((a, b) => rank(a, order) - rank(b, order)).map((step) => [step]);
  for (const stage of stages) {
    console.error(`[scriptorium] ${c.blue(c.bold(`== ${stage.join(" + ")} ==`))}`);
    if (stage[0] === "story") {
      await run.story(story);
      continue;
    }
    if (stage[0] === "characters" || stage[0] === "refs" || stage[0] === "voices") {
      const events = await new EventLog(story.runDir).load();
      if (!events.some((e) => e.type === "scene_committed")) throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
      if (stage[0] === "characters") await run.characters(story, events);
      else if (stage[0] === "refs") await run.refs(story, events, redoRefs, opts.notes);
      else await run.voices(story, events, redoVoices);
      continue;
    }
    // Later steps read the run as the story step left it.
    const events = await new EventLog(story.runDir).load();
    if (!events.some((e) => e.type === "scene_committed")) {
      throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
    }
    // Both finish (or fail) before the first failure is reported.
    const results = await Promise.allSettled(stage.map((step) => run[step as "art" | "audiobook" | "music" | "video"](story, events)));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  console.error(`[scriptorium] ${c.ok(`done: ${steps.join(", ")}`)}`);
  const ledger = readLedger(story.runDir);
  if (ledger.length > 0) console.error(`[scriptorium] ${c.dim(`spend for ${story.runDir}:\n${formatSummary(summarize(ledger), story.config.budget?.usd)}`)}`);
  return steps;
}
