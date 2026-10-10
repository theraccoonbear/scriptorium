import { resolveRating } from "./ratings.ts";
import { measuredPace, midpoint, resolveLength } from "./length.ts";
import { rewriteScene } from "./rewrite.ts";
import type { LengthSetting } from "./length.ts";
import type { RatingSetting } from "./ratings.ts";
import { narratorReads } from "./casting.ts";
import { runCanonCheck } from "./canon.ts";
import type { Pronunciations } from "./geminiTts.ts";
import { changedKeys, imageRound, snapshotArt } from "./rounds.ts";
import type { ArtSnapshot } from "./rounds.ts";
import { lineCounts } from "./voiceSamples.ts";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders, checkDirection } from "./providers.ts";
import { COST_KINDS, formatSummary, getCostKey, parseCostKind, readLedger, setCostKey, summarize, usd } from "./usage.ts";
import type { CostKind } from "./usage.ts";
import { pitch } from "./pitch.ts";
import { changedShare } from "./tagging.ts";
import { withRunLock } from "./runLock.ts";
import type { LockOptions } from "./runLock.ts";
import type { Pitch } from "./pitch.ts";
import { accounted, artStep, audiobookStep, resolveAudioTags, extrasStep, loadRun, musicStep, readContexts, storyStep, videoStep, voicesStep } from "./steps.ts";
import type { AudiobookStepOptions } from "./steps.ts";
import { portraitIds, recordedSheet, syncCharacterSheet } from "./characterSheet.ts";
import { staleCharacterRefs } from "./engine.ts";
import { replay } from "./bible.ts";
import { refAppearances } from "./visualrefs.ts";
import { c } from "./colors.ts";
import { CRITIC_MODES } from "./types.ts";
import type { Ambiguity, StoryConfig, StoryEvent } from "./types.ts";
import type { CastMember } from "./cast.ts";
import type { TitleSettings } from "./titles.ts";
import type { MusicSettings } from "./music.ts";
import { cuesToMake, sceneCueId, trackSpans } from "./music.ts";
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
    geminiBatch?: boolean;                       // batched modes through Gemini Batch Mode (half price, slower); not for 3.8+ TTS, which is voiced live (#114)
    castingFile?: string;                        // a cast list shared by every chapter (relative to the story file)
    castMin?: number;                            // characters spoken to earn a voice of their own (default 120); the rest are read by the narrator
    audioTags?: boolean | string[];              // sounds in Gemini lines — laughs, sighs, pauses — where the prose calls for them (#71); off by default
    pronunciations?: Pronunciations;     // how to say the story's hard words: { "McPoyle": "mick-POYL, rhymes with boil" }
    designVoices?: string[];                     // character ids to give a designed voice
  };
  music?: MusicSettings | false;       // the score (off unless present): { style, duck, volume, model, maxTakes }
  video?: {
    encoder?: "auto" | "nvenc" | "x264";
    parallel?: number;
    titles?: TitleSettings | false;    // the cards: opening title, scene cards, ending, credits (default on)
  };
  direction?: Record<string, string>;  // author direction per creative layer (see DIRECTION_LAYERS)
  budget?: { usd: number; count?: CostKind[] };  // stop before spending more than this on the run (counting these kinds of spend)
  rating?: RatingSetting;  // hold the story to an audience rating (#88): "PG", or { base, age, forbid, flag, allow, mode, card }
  ambiguity?: Ambiguity;   // how much the story leaves unsaid (#93): "tidy", "some" (default) or "lots"
  length?: LengthSetting;  // a running time (#170): { "minutes": 12 }; sets each scene's word budget, and the scene count when "scenes" isn't set
  // How art and audio run: "audio-first" (default: voicing is cheap and listening
  // can send a story back for a rewrite before images are paid for),
  // "art-first", or "parallel" (fastest).
  stepOrder?: StepOrder;
  maxDraftsPerScene?: number;          // hard stop for a scene that won't settle (default 20)
  pricing?: StoryConfig["pricing"];    // per-model USD per million tokens, over the defaults
  extras?: StoryConfig["extras"];   // override the art style / direction for the extras (see StoryConfig)
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
// extras: bonus artwork (key art, a cast photo), only when named.
// canon: re-check the written story against today's canon (#133), only when named.
export const PHASES = ["characters", "canon", "refs", "voices", "extras"] as const;
const ALL_STEPS = ["story", "characters", "canon", "refs", "voices", "art", "extras", "audiobook", "music", "video"] as const;
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
    ...(raw.extras ?? baseConfig.extras ? { extras: { ...baseConfig.extras, ...raw.extras } } : {}),
    ...(raw.budget ?? baseConfig.budget ? { budget: raw.budget ?? baseConfig.budget } : {}),
    ...(raw.rating !== undefined ? { rating: resolveRating(raw.rating, `${path}: "rating"`) } : {}),
    ...(typeof raw.title === "string" && raw.title.trim() ? { title: raw.title.trim() } : {}),
    ...(raw.length ?? baseConfig.length ? { length: raw.length ?? baseConfig.length } : {}),
    ...(raw.ambiguity ?? baseConfig.ambiguity ? { ambiguity: raw.ambiguity ?? baseConfig.ambiguity } : {}),
    ...(raw.maxDraftsPerScene ?? baseConfig.maxDraftsPerScene ? { maxDraftsPerScene: raw.maxDraftsPerScene ?? baseConfig.maxDraftsPerScene } : {}),
    ...(raw.pricing || baseConfig.pricing ? { pricing: { ...baseConfig.pricing, ...raw.pricing } } : {}),
    ...(raw.critic ?? baseConfig.critic ? { critic: raw.critic ?? baseConfig.critic } : {}),
    ...(raw.tension ?? baseConfig.tension ? { tension: raw.tension ?? baseConfig.tension } : {}),
    ...(raw.turns ?? baseConfig.turns ? { turns: raw.turns ?? baseConfig.turns } : {}),
    ...(raw.artist ? { artist: { ...baseConfig.artist, ...raw.artist } } : {})
  };
  if (baseConfig.scenes !== undefined) console.error(`[scriptorium] ${configPath ?? path}: "scenes" belongs in the story file, not a shared config — move it (the story file's "scenes" or "length" wins)`);
  if (raw.audiobook?.audioTags !== undefined) {
    try { resolveAudioTags(raw.audiobook.audioTags); } catch (err) { throw new Error(`${path}: ${(err as Error).message}`); }
  }
  if (config.ambiguity !== undefined && !["tidy", "some", "lots"].includes(config.ambiguity)) throw new Error(`${path}: "ambiguity" must be "tidy", "some" or "lots"`);
  if (config.budget !== undefined && !(typeof config.budget.usd === "number" && config.budget.usd > 0)) {
    throw new Error(`${path}: "budget" must look like { "usd": 5 }`);
  }
  if (config.budget?.count !== undefined && !(Array.isArray(config.budget.count) && config.budget.count.length > 0 && config.budget.count.every((k) => (COST_KINDS as readonly string[]).includes(k)))) {
    throw new Error(`${path}: budget "count" must be a list of ${COST_KINDS.join(", ")}`);
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
    // The scene count has one place: the story file's "scenes". Without it, a running
    // time sets it (what fits the minutes). A config's "scenes" is from before that rule:
    // used only for a story with neither, and flagged.
    scenes: raw.scenes ?? (config.length ? resolveLength(config.length).scenes : baseConfig.scenes),
    maxAttempts: attempts,
    speakerTags: raw.speakerTags,
    audiobook: raw.audiobook?.castingFile ? { ...raw.audiobook, castingFile: at(raw.audiobook.castingFile) } : raw.audiobook ?? {},
    video: raw.video ?? {},
    // The author's tracks' files resolve against the story file (#174).
    ...(raw.music ? { music: raw.music.tracks ? { ...raw.music, tracks: raw.music.tracks.map((t) => ({ ...t, file: at(t.file) })) } : raw.music } : {})
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
  if (m.generate !== undefined && typeof m.generate !== "boolean") throw new Error(`${path}: music "generate" must be true or false`);
  if (m.tracks !== undefined) {
    if (!Array.isArray(m.tracks)) throw new Error(`${path}: music "tracks" must be a list of { file, from, to?, loop?, start?, volume?, credit? }`);
    m.tracks.forEach((t, i) => {
      const where = `${path}: music track ${i + 1}`;
      if (typeof t?.file !== "string" || typeof t.from !== "string") throw new Error(`${where} needs "file" and "from"`);
      if (!existsSync(resolve(dirname(path), t.file))) throw new Error(`${where}: no file at ${t.file}`);
      for (const k of ["start", "volume"] as const) if (t[k] !== undefined && typeof t[k] !== "number") throw new Error(`${where}: "${k}" must be a number`);
      if (t.start !== undefined && t.start < 0) throw new Error(`${where}: "start" can't be negative`);
    });
    try { trackSpans(m.tracks); } catch (err) { throw new Error(`${path}: ${(err as Error).message}`); }
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
  if (typeof t !== "object" || t === null) throw new Error(`${path}: video "titles" must be false or { opening, narrate, sceneTitles, credits, ending, font, titleFont, crawl, logo }`);
  for (const k of ["opening", "narrate", "credits", "logo"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "boolean") throw new Error(`${path}: video titles "${k}" must be true or false`);
  }
  if (t.sceneTitles !== undefined && typeof t.sceneTitles !== "boolean" && !(Array.isArray(t.sceneTitles) && t.sceneTitles.every((x) => typeof x === "string"))) {
    throw new Error(`${path}: video titles "sceneTitles" must be true, false or a list of titles`);
  }
  if (t.ending !== undefined && t.ending !== false && typeof t.ending !== "string") throw new Error(`${path}: video titles "ending" must be text (e.g. "The End") or false`);
  for (const k of ["font", "titleFont"] as const) {
    if (t[k] !== undefined && typeof t[k] !== "string") throw new Error(`${path}: video titles "${k}" must be a font name or file`);
  }
  if (t.crawl !== undefined && typeof t.crawl !== "boolean" && typeof t.crawl !== "string" && !(Array.isArray(t.crawl) && t.crawl.every((x) => typeof x === "string"))) {
    throw new Error(`${path}: video titles "crawl" must be text, a list of paragraphs, true (the director drafts one) or false`);
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
  edit?: string[];  // images to edit in place with the note (#141): scene-03-10, cover
  source?: string;  // the take to edit, run-relative (art/previous/…); default the current image
  with?: string[];  // an edit's likeness references: art keys (character-rantoul, scene-06-07)
  // What this run's spend is for (#148). Default: what the command line or the
  // environment says, else rework for a --redo or --edit, else production.
  costKind?: CostKind;
  costTag?: string;
  steps?: Partial<StepRunners>;  // injectable for tests
  noWait?: boolean;  // another command holds the run: stop instead of waiting (#139)
}

// The extras an edit in place can change (#150): the key art in its three shapes and the cast photo.
const EDITABLE_EXTRAS = /^extra-(keyart-(2x3|16x9|1x1)|cast)$/;
export interface ExtrasEdit { keys: string[]; note: string; source?: string; with?: string[] }

// Shots to redo in the art step: by key (with the author's note), or whole scenes re-planned.
export interface ShotRedo { redo: string[]; replan: number[]; note?: string; edit?: { keys: string[]; note: string; source?: string; with?: string[] } }

export interface StepRunners {
  story: (story: ResolvedStory) => Promise<void>;
  characters: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  refs: (story: ResolvedStory, events: StoryEvent[], redo: string[], notes?: string) => Promise<void>;
  voices: (story: ResolvedStory, events: StoryEvent[], redo: string[]) => Promise<void>;
  art: (story: ResolvedStory, events: StoryEvent[], shots?: ShotRedo) => Promise<void>;
  extras: (story: ResolvedStory, events: StoryEvent[], redo: string[], notes?: string, edit?: ExtrasEdit) => Promise<void>;
  canon: (story: ResolvedStory, events: StoryEvent[]) => Promise<void>;
  audiobook: (story: ResolvedStory, events: StoryEvent[], opts?: { freshPalette?: boolean }) => Promise<void>;
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
    // New canon reaches written scenes only through a check (#133).
    if (sync.recorded && !sync.created) console.error(`[scriptorium] ${c.dim(`the sheet changed after the story was written — check the prose against it: npm run make -- ${s.file} --only canon`)}`);
  },
  refs: async (s, events, redo, notes) => { await artStep(s.runDir, s.config, events, false, { only: "references", redo, ...(notes ? { notes } : {}) }); },
  voices: async (s, events, redo) => { await voicesStep(s.runDir, events, { ...audiobookOptions(s), redo }); },
  // make never re-renders finished work; the individual commands take --force for that.
  art: async (s, events, shots) => { await artStep(s.runDir, s.config, events, false, shots ? { shotRedo: shots.redo, replan: shots.replan, ...(shots.note ? { notes: shots.note } : {}), ...(shots.edit ? { edit: shots.edit } : {}) } : {}); },
  canon: async (s, events) => {
    // Careful reading across whole scenes: a "canon" role if the config has one, else the editor, else the continuist.
    const roles = buildRoleProviders(s.config);
    const role = roles.canon ?? roles.editor ?? roles.continuist;
    if (!role) throw new Error("the canon check needs a config with a canon, editor or continuist role");
    const contexts = await Promise.all(s.contextPaths.map((p) => readFile(p, "utf8")));
    await accounted(s.runDir, s.config, "canon", async () => {
      const { round, findings } = await runCanonCheck({ runDir: s.runDir, events, role, contexts, log: (m) => console.error(`[scriptorium] ${c.dim(m)}`) });
      if (!round) { console.error(`[scriptorium] ${c.ok("the story agrees with its canon")}`); return; }
      console.error(`[scriptorium] ${c.retry(`${findings.length} contradiction${findings.length === 1 ? "" : "s"} with canon — ${join(round.dir, "legend.txt")}`)}`);
      console.error(`[scriptorium] ${c.dim(`apply the fixes: npm run canon -- ${s.file} --apply  (--skip 2,5 to leave some)`)}`);
    });
  },
  // --redo extras directs the key art and cast photo again; --redo extra-cast just retakes one.
  extras: async (s, events, redo, notes, edit) => { await extrasStep(s.runDir, s.config, events, false, { redo: redo.filter((r) => r !== "extras"), redirect: redo.includes("extras"), ...(notes ? { notes } : {}), ...(edit ? { edit } : {}), ...(s.title ? { title: s.title } : {}), ...(s.subtitle ? { subtitle: s.subtitle } : {}), base: dirname(resolve(s.file)) }); },
  audiobook: async (s, events, opts) => { await audiobookStep(s.runDir, events, { ...audiobookOptions(s), ...(opts?.freshPalette ? { freshPalette: true } : {}) }); },
  // Off unless the story file has a "music" block.
  music: async (s) => {
    if (!s.music) { console.error(`[scriptorium] ${c.dim("no music in the story file — skipping")}`); return; }
    if (s.music.generate === false) { console.error(`[scriptorium] ${c.dim("music: the author's own tracks only — nothing to generate")}`); return; }
    await musicStep(s.runDir, s.config, s.music);
  },
  video: async (s, events) => {
    await videoStep(s.runDir, events, false, {
      ...(s.audiobook.pronunciations ? { pronunciations: s.audiobook.pronunciations } : {}),
      ...s.video,
      title: s.title, subtitle: s.subtitle, series: s.series,
      contextPaths: s.contextPaths, base: dirname(resolve(s.file)), config: s.config,
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
    casting: a.casting, geminiConcurrency: a.geminiConcurrency, geminiBatch: a.geminiBatch, castingFile: a.castingFile, castMin: a.castMin, audioTags: a.audioTags, pronunciations: a.pronunciations, designVoices: a.designVoices,
    config: s.config
  };
}

const SETTINGS_FILE = "story-settings.json";

// The story's pitch: what the steps to run will need and cost.
export function storyPitch(story: ResolvedStory, events: StoryEvent[], steps: readonly Step[] = STEPS, redo: string[] = []): Pitch {
  const artist = story.config.artist ?? {};
  return pitch({
    events,
    ledger: readLedger(story.runDir),
    scenes: story.scenes ?? story.config.scenes ?? events.filter((e) => e.type === "scene_committed").length,
    wordsPerShot: story.config.artWordsPerShot,
    ...lengthPitch(story, events),
    // A scene rewritten with a note (#184): the scene again, and the later scenes read against it.
    ...(steps.includes("story") && redo.some((r) => /^scene:\d+$/.test(r)) ? { rewriteScenes: redo.filter((r) => /^scene:\d+$/.test(r)).length } : {}),
    art: {
      maxAttempts: artist.maxAttempts, retakes: artist.retakes, concurrency: artist.concurrency, batch: artist.batch,
      skip: !(steps.includes("art") || steps.includes("refs") || steps.includes("extras")) || !story.config.roles.artdirector,
      ...(steps.includes("refs") && !steps.includes("art") ? { refsOnly: true, refTargets: refTargets(events, approvedArt(story.runDir), redo) } : {}),
      ...(steps.includes("extras") && !steps.includes("art") && !steps.includes("refs") ? { extrasOnly: true } : {})
    },
    audio: {
      narration: story.audiobook.narration, dialogue: story.audiobook.dialogue, geminiMode: story.audiobook.geminiMode, ...(story.audiobook.geminiModel ? { geminiModel: story.audiobook.geminiModel } : {}), geminiConcurrency: story.audiobook.geminiConcurrency, geminiBatch: story.audiobook.geminiBatch,
      skip: !(steps.includes("audiobook") || steps.includes("voices")),
      ...(steps.includes("voices") && !steps.includes("audiobook") ? { samplesOnly: true, speakers: lineCounts(events).size - narratorReads(events, { min: story.audiobook.castMin, pinned: story.audiobook.geminiVoices }).length } : {})
    },
    ...(story.config.budget ? { budgetUsd: story.config.budget.usd, ...(story.config.budget.count ? { budgetKinds: story.config.budget.count } : {}) } : {}),
    ...readJson<Record<string, { prompt: string }>>(join(story.runDir, "art", "art.json"), (m) => ({ artManifest: m })),
    approved: [...approvedArt(story.runDir)],
    ...(redo.length ? { redo } : {}),
    music: {
      skip: !steps.includes("music") || !story.music,
      // The theme and a cue a scene, less what the author's own tracks cover (#174).
      ...musicCues(story, events)
    },
    scenesVoiced: existsSync(join(story.runDir, "audiobook")) ? readdirSync(join(story.runDir, "audiobook")).filter((f) => /^scene-\d+\.wav$/.test(f)).length : 0,
    revoiceShare: changedShare(events)
  });
}

// One scene rewritten with the author's note (#184), and what it leaves to do.
async function rewriteAndReport(story: ResolvedStory, scene: number, note: string, storyPath: string): Promise<void> {
  const config: StoryConfig = { ...story.config, ...(story.premise ? { premise: story.premise } : {}), ...(story.setting ? { setting: story.setting } : {}), ...(story.speakerTags !== undefined ? { speakerTags: story.speakerTags } : {}) };
  // Logged and capped like the story step: the rewrite's calls are the story's spend (rework).
  const r = await accounted(story.runDir, story.config, "story", () => rewriteScene({ runDir: story.runDir, config, scene, note, ...(story.scenes ?? story.config.scenes ? { total: story.scenes ?? story.config.scenes } : {}), log: (m) => console.error(`[scriptorium] ${c.dim(m)}`) }));
  console.log(c.ok(`scene ${scene} rewritten → ${join(story.runDir, "story.md")}`));
  if (r.round) console.log(`${c.retry(`${r.findings.length} place${r.findings.length === 1 ? "" : "s"} in later scenes no longer fit`)} — ${join(r.round.dir, "legend.txt")}
  apply the ones the author wants: npm run canon -- ${storyPath} --apply [--skip N,…]`);
  else console.log(c.dim("the later scenes still fit"));
  if (r.approvedShots.length) console.log(c.retry(`scene ${scene}'s approved shots are from the old version — revoke to redraw: npm run approve -- ${storyPath} ${r.approvedShots.join(" ")} --revoke`));
  console.log(c.dim(`next: --only art re-plans scene ${scene}'s shots; --only audiobook re-voices its changed lines; --only video rebuilds`));
}

// The cues the music step would make, and how many of those are already made.
function musicCues(story: ResolvedStory, events: StoryEvent[]): { cues: number; made?: number } {
  const scenes = story.scenes ?? story.config.scenes ?? events.filter((e) => e.type === "scene_committed").length;
  const all = [{ id: "theme" }, ...Array.from({ length: scenes }, (_, i) => ({ id: sceneCueId(i) }))];
  const wanted = story.music ? cuesToMake(all, story.music) : all;
  const made = readJson<Record<string, { clean?: boolean }>>(join(story.runDir, "music", "cues.json"), (m) => ({ made: wanted.filter((q) => m[q.id]?.clean).length }));
  return { cues: wanted.length, ...made };
}

// The running time for the pitch (#170): each scene's share and the narrator's pace.
function lengthPitch(story: ResolvedStory, events: StoryEvent[]): { wordsPerScene?: number; wordsPerMinute?: number; askedMinutes?: number } {
  const measuredWpm = measuredPace(story.runDir, events);
  const len = story.config.length ? resolveLength(story.config.length, { scenes: story.scenes ?? story.config.scenes, ...(measuredWpm ? { measuredWpm } : {}) }) : undefined;
  const words = story.config.sceneWords ?? len?.sceneWords;
  return {
    ...(words ? { wordsPerScene: midpoint(words) } : {}),
    ...(len ? { wordsPerMinute: len.wordsPerMinute, askedMinutes: len.minutes } : measuredWpm ? { wordsPerMinute: measuredWpm } : {})
  };
}

// References the refs phase would make: portraits and places without one,
// portraits the sheet has changed (unless approved or redone: those are
// counted as redos), and a couple of key props.
function refTargets(events: StoryEvent[], approved: ReadonlySet<string> = new Set(), redo: string[] = []): number {
  const have = refAppearances(events);
  const bible = replay(events);
  return portraitIds(events).filter((id) => !have.characters[id]).length
    + Object.keys(bible.locations).filter((id) => !have.locations[id]).length
    + staleCharacterRefs(events).filter((id) => !approved.has(`character-${id}`) && !redo.includes(`character:${id}`)).length
    + (Object.keys(have.props).length === 0 ? 2 : 0);
}

// Approved art keys (approvals.json), read synchronously for the pitch.
function approvedArt(runDir: string): Set<string> {
  try { return new Set((JSON.parse(readFileSync(join(runDir, "approvals.json"), "utf8")) as { art?: string[] }).art ?? []); } catch { return new Set(); }
}

function readJson<T>(path: string, wrap: (value: T) => object): object {
  try { return wrap(JSON.parse(readFileSync(path, "utf8")) as T); } catch { return {}; }
}

// Pipeline position of a step, with art and audio in the chosen order.
function rank(step: Step, order: StepOrder): number {
  if (step === "art") return order === "art-first" ? 1 : 2;
  if (step === "audiobook") return order === "art-first" ? 2 : 1;
  if (step === "characters") return 0.1;
  if (step === "canon") return 0.15;
  if (step === "refs") return 0.2;
  if (step === "voices") return 0.3;
  if (step === "extras") return 2.2;  // after the art it draws on
  // The cue sheet reads each scene's length from the audiobook's timings.
  if (step === "music") return 2.5;
  return step === "story" ? 0 : 3;
}

// A review round of the images a refs or art run made or remade (redos,
// retakes, reshoots), so the author sees just those. A first render of
// everything is left to the review contact sheets.
const ROUND_MAX = 40;
async function withImageRound(runDir: string, before: ArtSnapshot, fn: () => Promise<unknown>, info: { kind: string; subject: string; note?: string }): Promise<void> {
  await fn();
  const keys = changedKeys(before, await snapshotArt(runDir));
  if (keys.length === 0) return;
  if (before.size === 0 || keys.length > ROUND_MAX) {
    console.error(`[scriptorium] ${c.dim(`${keys.length} images made — see npm run review`)}`);
    return;
  }
  const round = await imageRound(runDir, keys, info);
  if (round) console.error(`[scriptorium] ${c.ok(`review round: ${join(round.dir, "changed.jpg")}`)} ${c.dim(`(${keys.length} image${keys.length === 1 ? "" : "s"})`)}`);
}

// The run's spend is keyed (#148): the kind asked for (option, command line,
// environment), else rework for a redo or an edit, else production (or
// experiment, for a run under runs/_scratch/).
// One make per run at a time (#139): a second waits for the first (or, with
// noWait, stops). Read-only commands don't take the lock.
export async function make(storyPath: string, opts: MakeOptions = {}): Promise<Step[]> {
  const previous = getCostKey();
  const kind = opts.costKind ?? previous.kind ?? parseCostKind(process.env.SCRIPTORIUM_COST_KIND, "SCRIPTORIUM_COST_KIND") ?? (opts.redo?.length || opts.edit?.length ? "rework" : undefined);
  const tag = opts.costTag ?? previous.tag;
  setCostKey({ ...(kind ? { kind } : {}), ...(tag ? { tag } : {}) });
  try {
    const { runDir } = await loadStoryFile(storyPath);
    return await withRunLock(runDir, runLockOptions(`make ${opts.only ? `--only ${opts.only}` : storyPath}`, opts.noWait), () => makeRun(storyPath, opts));
  } finally {
    setCostKey(previous);
  }
}

// How a waiting command says what it's waiting for.
export function runLockOptions(command: string, noWait?: boolean): LockOptions {
  return {
    command,
    wait: !noWait,
    onWait: (h) => console.error(`[scriptorium] ${c.retry(`waiting for "${h.command}" (pid ${h.pid}, started ${h.started}) to finish with this run…`)}`),
    onStale: (h) => console.error(`[scriptorium] ${c.dim(`taking over the lock left by "${h.command}" (pid ${h.pid}, no longer running)`)}`)
  };
}

async function makeRun(storyPath: string, opts: MakeOptions): Promise<Step[]> {
  const story = await loadStoryFile(storyPath);
  const steps = planSteps(opts.only, opts.from);
  const run = { ...defaultRunners, ...opts.steps };
  const redo = opts.redo ?? [];
  const redoVoices = redo.filter((r) => r.startsWith("voice:")).map((r) => r.slice("voice:".length));
  // Shots: scene-04-07 (one shot), scene:4 (re-plan a scene's shots).
  const redoShots = redo.filter((r) => /^scene-\d+-\d+$/.test(r) || r === "cover");
  const replanScenes = redo.filter((r) => /^scene:\d+$/.test(r)).map((r) => Number(r.slice("scene:".length)) - 1);
  const redoExtras = redo.filter((r) => r === "extras" || r.startsWith("extra-"));  // extra-logo redraws the logo
  if (redoExtras.length && !steps.includes("extras")) throw new Error(`--redo ${redoExtras.join(",")}: extras are redone in the extras phase (--only extras)`);
  // --redo palette: design the voices' tone palettes anew (they're otherwise kept, #135).
  const freshPalette = redo.includes("palette");
  if (freshPalette && !steps.includes("audiobook")) throw new Error("--redo palette: the tone palettes are made in the audiobook step (--only audiobook)");
  const redoRefs = redo.filter((r) => r !== "palette" && !r.startsWith("voice:") && !redoShots.includes(r) && !redoExtras.includes(r) && !/^scene:\d+$/.test(r));
  if (redoRefs.length && !steps.includes("refs")) throw new Error(`--redo ${redoRefs.join(",")}: references are remade in the refs phase (--only refs)`);
  if (redoVoices.length && !steps.includes("voices")) throw new Error(`--redo voice:…: voices are recast in the voices phase (--only voices)`);
  // scene:N with the story step rewrites that scene with the note (#184); with the art step, re-plans its shots.
  const rewrites = steps.includes("story") ? replanScenes : [];
  if ((redoShots.length || (replanScenes.length && !rewrites.length)) && !steps.includes("art")) throw new Error(`--redo scene-…: shots are redone in the art step (--only art); --redo scene:N with --only story rewrites the scene`);
  if (rewrites.length && !opts.notes) throw new Error(`--redo scene:${rewrites[0] + 1} with the story step rewrites that scene: --note says what should change`);
  const edit = opts.edit ?? [];
  if (edit.length) {
    const bad = edit.filter((k) => !/^scene-\d+-\d+$/.test(k) && k !== "cover" && !EDITABLE_EXTRAS.test(k));
    if (bad.length) throw new Error(`--edit ${bad.join(",")}: only shots (scene-NN-MM), the cover, the key art (extra-keyart-2x3|16x9|1x1) and the cast photo (extra-cast) can be edited`);
    const extras = edit.filter((k) => EDITABLE_EXTRAS.test(k));
    if (extras.length && extras.length !== edit.length) throw new Error("--edit: extras and shots go in separate runs (they're edited in different phases)");
    if (extras.length && !steps.includes("extras")) throw new Error("--edit extra-…: the key art and cast photo are edited in the extras phase (--only extras)");
    if (!opts.notes) throw new Error("--edit needs --note: the one change to make");
    if (redo.length) throw new Error("--edit and --redo go in separate runs (the note would apply to both)");
    if (!extras.length && !steps.includes("art")) throw new Error("--edit scene-…: images are edited in the art step (--only art)");
    if (opts.source && edit.length > 1) throw new Error("--source names one image's earlier take: edit one image at a time");
  } else if (opts.source || opts.with?.length) throw new Error(`${opts.source ? "--source" : "--with"} goes with --edit`);
  if (opts.notes && !edit.length && !rewrites.length && redoRefs.length === 0 && redoShots.length === 0 && redoExtras.filter((r) => r !== "extras").length === 0) throw new Error("--note goes with --redo <kind>:<id>, --redo scene-NN-MM, --redo extra-… or --edit scene-NN-MM");
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
  const p = storyPitch(story, await loadRun(story.runDir), steps, redo);
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
      if (rewrites.length) {
        for (const k of rewrites) await rewriteAndReport(story, k + 1, opts.notes!, storyPath);
        continue;
      }
      await run.story(story);
      continue;
    }
    if (stage[0] === "extras") {
      const events = await new EventLog(story.runDir).load();
      if (!events.some((e) => e.type === "scene_committed")) throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
      // An edit of the key art or cast photo (#150) runs here, like a shot's in the art step.
      const extrasEdit = edit.length && edit.every((k) => EDITABLE_EXTRAS.test(k)) ? { keys: edit, note: opts.notes!, ...(opts.source ? { source: opts.source } : {}), ...(opts.with?.length ? { with: opts.with } : {}) } : undefined;
      const round = extrasEdit ? { kind: "edit", subject: edit.join(" "), note: opts.notes, ...(opts.source ? { source: opts.source } : {}) }
        : redoExtras.length ? { kind: "redo", subject: redoExtras.join(" "), ...(opts.notes ? { note: opts.notes } : {}) } : { kind: "extras", subject: "key art and cast photo" };
      await withImageRound(story.runDir, await snapshotArt(story.runDir), () => run.extras(story, events, redoExtras, extrasEdit ? undefined : opts.notes, extrasEdit), round);
      continue;
    }
    if (stage[0] === "canon") {
      const events = await new EventLog(story.runDir).load();
      if (!events.some((e) => e.type === "scene_committed")) throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
      await run.canon(story, events);
      continue;
    }
    if (stage[0] === "characters" || stage[0] === "refs" || stage[0] === "voices") {
      const events = await new EventLog(story.runDir).load();
      if (!events.some((e) => e.type === "scene_committed")) throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
      if (stage[0] === "characters") await run.characters(story, events);
      else if (stage[0] === "refs") await withImageRound(story.runDir, await snapshotArt(story.runDir), () => run.refs(story, events, redoRefs, opts.notes), redoRefs.length ? { kind: "redo", subject: redoRefs.join(" "), ...(opts.notes ? { note: opts.notes } : {}) } : { kind: "portraits", subject: "new" });
      else await run.voices(story, events, redoVoices);
      continue;
    }
    // Later steps read the run as the story step left it.
    const events = await new EventLog(story.runDir).load();
    if (!events.some((e) => e.type === "scene_committed")) {
      throw new Error(`no committed scenes in ${story.runDir} — run the story step first`);
    }
    // Both finish (or fail) before the first failure is reported.
    const shots: ShotRedo = { redo: redoShots, replan: replanScenes, ...(opts.notes && redoShots.length ? { note: opts.notes } : {}), ...(edit.length ? { edit: { keys: edit, note: opts.notes!, ...(opts.source ? { source: opts.source } : {}), ...(opts.with?.length ? { with: opts.with } : {}) } } : {}) };
    const artRound = edit.length
      ? { kind: "edit", subject: edit.join(" "), note: opts.notes, ...(opts.source ? { source: opts.source } : {}) }
      : redoShots.length || replanScenes.length
      ? { kind: "redo", subject: [...redoShots, ...replanScenes.map((i) => `scene ${i + 1}`)].join(" "), ...(shots.note ? { note: shots.note } : {}) }
      : { kind: "shots", subject: "new" };
    const before = stage.includes("art") ? await snapshotArt(story.runDir) : new Map();
    const results = await Promise.allSettled(stage.map((step) => (step === "art" ? withImageRound(story.runDir, before, () => run.art(story, events, shots), artRound) : step === "audiobook" ? run.audiobook(story, events, { freshPalette }) : run[step as "music" | "video"](story, events))));
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  }
  console.error(`[scriptorium] ${c.ok(`done: ${steps.join(", ")}`)}`);
  const ledger = readLedger(story.runDir);
  if (ledger.length > 0) console.error(`[scriptorium] ${c.dim(`spend for ${story.runDir}:\n${formatSummary(summarize(ledger), story.config.budget?.usd, story.config.budget?.count)}`)}`);
  return steps;
}
