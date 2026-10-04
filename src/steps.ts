import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { combineContexts, contextFile } from "./context.ts";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders } from "./providers.ts";
import { runStory } from "./engine.ts";
import { generateAudiobook, writeVoiceMap } from "./audiobook.ts";
import { renderVideo } from "./video.ts";
import type { EncoderChoice } from "./video.ts";
import { CAST_PHOTO_LABEL, extensionFor, ffmpegShrink, makeCastDescriber, makeImageBackend, makeInspector, renderArt, renderOne, resolveArtistConfig } from "./artist.ts";
import type { ImageBackend, Inspector, Shrink } from "./artist.ts";
import { castContext, castRun, loadImage, slug } from "./cast.ts";
import type { CastDescriber, CastEntry, CastMember } from "./cast.ts";
import { storyArtStyle } from "./visualrefs.ts";
import { designRun, needsTagging, sceneTags, tagRun } from "./tagging.ts";
import { castVoiceRun } from "./casting.ts";
import type { TonePaletteData } from "./tagging.ts";
import type { GeminiMode } from "./geminiBatch.ts";
import { replay } from "./bible.ts";
import { c } from "./colors.ts";
import { Accountant, currentAccountant, LEDGER_FILE, setAccountant, usd } from "./usage.ts";
import type { Bible, SceneCommittedData, StoryConfig, StoryEvent } from "./types.ts";

// The pipeline's steps — story, art, audiobook, video — as plain functions with
// their console progress. Shared by the individual CLI commands and `make`.
// Each step resumes or skips finished work, so re-running one is always safe.

// Runs a paid step with spend accounting: every API call is logged to the run's
// usage.jsonl, the budget is enforced, and the step's spend is printed. Reuses
// the active accountant when one is already open for this run (make).
export async function accounted<T>(runDir: string, config: StoryConfig | undefined, step: string, fn: () => Promise<T>): Promise<T> {
  const active = currentAccountant();
  const acc = active && active.file === join(runDir, LEDGER_FILE)
    ? active
    : new Accountant(runDir, { pricing: config?.pricing, budgetUsd: config?.budget?.usd });
  const previous = setAccountant(acc);
  acc.setStep(step);
  try {
    return await fn();
  } finally {
    const budget = acc.budgetUsd !== undefined ? ` of ${usd(acc.budgetUsd)} budget` : "";
    if (acc.stepSpent > 0) console.error(`[scriptorium] ${c.dim(`spend: ${step} ${usd(acc.stepSpent)} · run total ${usd(acc.spent)}${budget}`)}`);
    setAccountant(previous);
  }
}

export interface StoryStepOptions {
  config: StoryConfig;
  runDir: string;
  scenes?: number;
  maxAttempts?: number;
  premise?: string;
  setting?: string;
  contextPaths?: string[];
  speakerTags?: boolean;
  cast?: CastMember[];  // real people and animals who star, from photos
}

export async function readContexts(paths: string[]): Promise<{ context?: string; contextFiles: string[] }> {
  const files = await Promise.all(paths.map(async (p) => contextFile(p, await readFile(p, "utf8"))));
  return { context: combineContexts(files), contextFiles: paths.map((p) => basename(p)) };
}

export async function storyStep(opts: StoryStepOptions): Promise<{ log: EventLog; bible: Bible }> {
  return accounted(opts.runDir, opts.config, "story", () => storyStepInner(opts));
}

async function storyStepInner(opts: StoryStepOptions): Promise<{ log: EventLog; bible: Bible }> {
  const { config, runDir } = opts;
  const log = new EventLog(runDir);
  let { context, contextFiles } = await readContexts(opts.contextPaths ?? []);
  if (opts.cast && opts.cast.length > 0) {
    const cast = await castStep(runDir, config, log, opts.cast);
    const files = await Promise.all((opts.contextPaths ?? []).map(async (p) => contextFile(p, await readFile(p, "utf8"))));
    context = combineContexts([...files, { name: "the cast (from photos)", text: castContext(cast) }]);
    contextFiles = [...contextFiles, "cast"];
  }
  const bible = await runStory({
    config: {
      ...config,
      premise: opts.premise,
      setting: opts.setting || config.setting,
      // No context given: runStory falls back to the context the run started with.
      ...(context ? { context, contextFiles } : {}),
      speakerTags: opts.speakerTags ?? config.speakerTags
    },
    log,
    roles: buildRoleProviders(config),
    scenes: opts.scenes,
    maxAttempts: opts.maxAttempts,
    runDir,
    onScene: (s) => {
      console.log(`${c.ok(`scene ${s.index + 1} committed`)} ${c.dim(`(tension ${s.tension}, attempts ${s.attempts})`)}`);
    }
  });
  return { log, bible };
}

// Describes the cast from their photos (once; again only when a member's
// name, notes or photos change) and records them in the run.
async function castStep(runDir: string, config: StoryConfig, log: EventLog, members: CastMember[], describer?: CastDescriber, shrink: Shrink = ffmpegShrink): Promise<CastEntry[]> {
  const events = await log.load();
  const { entries, changed } = await castRun(runDir, members, describer ?? makeCastDescriber(resolveArtistConfig(config.artist)), events, (img) => shrink(img, 1024));
  if (changed) await log.append("cast", { members: entries });
  for (const e of entries) console.error(`[scriptorium] ${c.dim(`cast: ${e.name} (${e.kind}) — ${e.appearance}`)}`);
  return entries;
}

// A quick look at the cast before a whole story: describes each member (the
// same casting the story step does, recorded in the run so the story reuses
// it) and renders one portrait each from their photos, in the story's art
// style, into <runDir>/cast/preview/. `as` dresses them for the part.
export interface CastPreviewOptions {
  runDir: string;
  config: StoryConfig;
  cast: CastMember[];
  as?: string;
  backend?: ImageBackend;    // injectable for tests
  inspector?: Inspector | null;
  describer?: CastDescriber;
  shrink?: Shrink;
}

export async function castPreviewStep(opts: CastPreviewOptions): Promise<{ name: string; file: string; accepted: boolean; issues: string[] }[]> {
  return accounted(opts.runDir, opts.config, "cast", () => castPreviewInner(opts));
}

async function castPreviewInner(opts: CastPreviewOptions) {
  const { runDir, config } = opts;
  if (opts.cast.length === 0) throw new Error("this story file has no \"cast\"");
  const artist = resolveArtistConfig(config.artist);
  const log = new EventLog(runDir);
  const entries = await castStep(runDir, config, log, opts.cast, opts.describer, opts.shrink);
  const backend = opts.backend ?? makeImageBackend(artist.image);
  const inspector = opts.inspector === undefined ? (artist.inspector ? makeInspector(artist.inspector) : undefined) : opts.inspector ?? undefined;
  const shrink = opts.shrink ?? ffmpegShrink;
  const style = config.artStyle ?? storyArtStyle(log.events);
  const direction = config.direction?.artist?.trim() || undefined;
  const outDir = join(runDir, "cast", "preview");
  await mkdir(outDir, { recursive: true });
  const results = [];
  for (const e of entries) {
    const subject = e.kind === "animal" ? "this animal" : "this person";
    const prompt = [
      `A full-body character portrait of ${subject}: ${e.appearance}`,
      opts.as ? `Dressed and equipped for the story as: ${opts.as}.` : "",
      "A relaxed, natural pose with a hint of personality; plain, softly lit background; no other figures; no text."
    ].filter(Boolean).join(" ");
    const references = await Promise.all(e.photos.slice(0, 3).map(async (p) => ({ ...(await shrink(await loadImage(join(runDir, p)), 768)), label: CAST_PHOTO_LABEL })));
    console.error(`[scriptorium] ${c.blue(c.bold(`portrait: ${e.name}`))}`);
    const out = await renderOne(
      { key: `cast-${slug(e.name)}`, prompt, ref: { kind: "character", id: slug(e.name) } },
      references, backend, inspector, artist.maxAttempts ?? 3,
      (ev) => { if (ev.type === "attempt_rejected") console.error(`[scriptorium]   ${c.retry(`attempt ${ev.attempt} rejected: ${ev.issues.join("; ")}`)}`); },
      style, (img) => shrink(img, artist.inspectSize ?? 1024), direction
    );
    const file = join(outDir, `${slug(e.name)}.${extensionFor(out.image.mimeType)}`);
    await writeFile(file, out.image.data);
    console.log(`${out.accepted ? c.ok(`${e.name}:`) : c.retry(`${e.name} (kept after ${out.attempts} rejected attempts):`)} ${c.cyan(file)}`);
    results.push({ name: e.name, file, accepted: out.accepted, issues: out.issues });
  }
  return results;
}

// Renders a run's art prompts (references, shots, cover) into <runDir>/art/.
export async function artStep(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined) {
  return accounted(runDir, config, "art", () => artStepInner(runDir, config, events, force));
}

async function artStepInner(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined) {
  const artist = resolveArtistConfig(config.artist);
  const result = await renderArt(events, {
    runDir,
    backend: makeImageBackend(artist.image),
    inspector: artist.inspector ? makeInspector(artist.inspector) : undefined,
    maxAttempts: artist.maxAttempts,
    maxReferences: artist.maxReferences,
    referenceSize: artist.referenceSize,
    inspectSize: artist.inspectSize,
    direction: config.direction?.artist,
    force,
    onProgress: (event) => {
      if (event.type === "job_start") console.error(`[scriptorium] ${c.blue(c.bold(`${event.key} (${event.index + 1}/${event.total})`))}`);
      else if (event.type === "job_skipped") console.error(`[scriptorium] ${c.dim(`${event.key} unchanged — skipping (${event.file})`)}`);
      else if (event.type === "attempt_rejected") console.error(`[scriptorium]   ${c.retry(`attempt ${event.attempt} rejected: ${event.issues.join("; ")}`)}`);
      else if (event.type === "job_done") console.error(`[scriptorium] ${event.accepted ? c.ok(`${event.key} written`) : c.retry(`${event.key} kept after ${event.attempts} rejected attempts`)} ${c.dim(event.file)}`);
      else if (event.type === "job_failed") console.error(`[scriptorium] ${c.fail(`${event.key} failed: ${event.error}`)}`);
    }
  });
  if (result.rendered + result.failed > 0) {
    console.log(`${c.ok(`art: ${result.rendered} rendered, ${result.skipped} unchanged, ${result.failed} failed →`)} ${c.cyan(result.outDir + "/")}`);
  }
  return result;
}

export interface AudiobookStepOptions {
  narratorVoice?: string;
  language?: string;
  characterGenders?: Record<string, string>;
  narration?: "kokoro" | "gemini";
  dialogue?: "kokoro" | "gemini";
  geminiModel?: string;
  geminiVoices?: Record<string, string>;
  kokoroVoices?: { include?: string[]; exclude?: string[] };
  characterVoices?: Record<string, string>;
  geminiMode?: GeminiMode;
  paletteSize?: number;  // palette mode: tones per speaker (default 4)
  geminiRpm?: number;
  geminiFallback?: "kokoro" | "gemini";
  pauseScale?: number;
  casting?: boolean;          // cast Gemini voices from the library (default true when Gemini speaks)
  castingFile?: string;       // a cast list shared across chapters
  designVoices?: string[];    // characters to give a designed voice
  force?: boolean;
  config?: StoryConfig;  // for spend accounting (pricing, budget)
}

// Labels who speaks each paragraph (and how) for scenes written as plain prose,
// so every story can be voiced. Uses the config's "voicedirector" role, else its
// continuist's model (a cheap one). Without a config, untagged scenes are read
// by the narrator alone.
async function tagStep(runDir: string, events: StoryEvent[], config?: StoryConfig, palette?: TonePaletteData): Promise<StoryEvent[]> {
  const bible = replay(events);
  const known = new Set(Object.keys(bible.characters));
  const tags = sceneTags(events);
  const untagged = events.filter((e) => e.type === "scene_committed")
    .map((e) => e.data as SceneCommittedData)
    .filter((d) => (!tags.has(d.index) || (palette && tags.get(d.index)!.palette !== palette.source)) && needsTagging(d.prose, known));
  if (untagged.length === 0) return events;
  const roles = config ? buildRoleProviders(config) : undefined;
  const role = roles?.voicedirector ?? roles?.continuist;
  if (!role) {
    console.error(`[scriptorium] ${c.retry(`${untagged.length} scene${untagged.length === 1 ? "" : "s"} written without speaker tags — the narrator reads ${untagged.length === 1 ? "it" : "them"} alone (pass --config so they can be tagged)`)}`);
    return events;
  }
  const log = new EventLog(runDir);
  await log.load();
  await tagRun(log, role, (index, speakers) => {
    console.error(`[scriptorium] ${c.ok(`scene ${index + 1} tagged`)} ${c.dim(`(speakers: ${speakers.join(", ") || "narrator only"})`)}`);
  }, palette);
  return log.events;
}

export async function audiobookStep(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions = {}) {
  return accounted(runDir, opts.config, "audiobook", () => audiobookStepInner(runDir, events, opts));
}

async function audiobookStepInner(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions) {
  // Palette mode: design each speaker's tones from the whole script first, so
  // tagging can choose a tone for every line from them.
  let palette: TonePaletteData | undefined;
  if (opts.geminiMode === "palette") {
    const roles = opts.config ? buildRoleProviders(opts.config) : undefined;
    const role = roles?.voicedirector ?? roles?.continuist;
    if (!role) throw new Error('geminiMode "palette" needs a config (for the voice director\'s model) — pass --config');
    const log = new EventLog(runDir);
    await log.load();
    palette = await designRun(log, role, opts.paletteSize ?? 4);
    for (const [speaker, p] of Object.entries(palette.speakers)) console.error(`[scriptorium] ${c.dim(`palette ${speaker}: ${p.tones.join(" · ")}`)}`);
    events = log.events;
  }
  events = await tagStep(runDir, events, opts.config, palette);
  // Casting: a voice from Gemini's library (or a designed one) for every speaker.
  let geminiVoices = opts.geminiVoices;
  const geminiSpeaks = opts.narration === "gemini" || opts.dialogue === "gemini";
  if (geminiSpeaks && opts.casting !== false) {
    const roles = opts.config ? buildRoleProviders(opts.config) : undefined;
    const role = roles?.voicedirector ?? roles?.continuist;
    if (role) {
      geminiVoices = await castVoiceRun({
        events, role, runDir, language: opts.language ?? "en",
        ...(opts.castingFile ? { castingFile: opts.castingFile } : {}),
        ...(opts.designVoices ? { designVoices: opts.designVoices } : {}),
        pinned: opts.geminiVoices ?? {},
        log: (m) => console.error(m)
      });
    } else {
      console.error(`[scriptorium] ${c.retry("no config — Gemini voices assigned by gender, not cast (pass --config)")}`);
    }
  }
  const result = await generateAudiobook(events, {
    runDir,
    narratorVoice: opts.narratorVoice,
    language: opts.language,
    characterGenders: opts.characterGenders,
    narration: opts.narration,
    dialogue: opts.dialogue,
    geminiModel: opts.geminiModel,
    geminiVoices,
    kokoroVoices: opts.kokoroVoices,
    characterVoices: opts.characterVoices,
    geminiMode: opts.geminiMode,
    palette,
    geminiRpm: opts.geminiRpm,
    geminiFallback: opts.geminiFallback,
    pauseScale: opts.pauseScale,
    force: opts.force,
    onProgress: (event) => {
      if (event.type === "model_loading") console.error(`[scriptorium] ${c.dim("loading Kokoro model (first run downloads it — this can take a while)...")}`);
      else if (event.type === "model_ready") console.error(`[scriptorium] ${c.ok("model ready")}`);
      else if (event.type === "line_fallback") console.error(`[scriptorium]   ${c.retry(`Gemini TTS failed for ${event.speaker}, used Kokoro for that line: ${event.error.slice(0, 120)}`)}`);
      else if (event.type === "scene_skipped") console.error(`[scriptorium] ${c.dim(`scene ${event.index + 1} unchanged — skipping (${event.path})`)}`);
      else if (event.type === "scene_start") console.error(`[scriptorium] ${c.blue(c.bold(`scene ${event.index + 1}/${event.total}`))} ${c.dim(`(${event.segments} segment${event.segments === 1 ? "" : "s"})`)}`);
      else if (event.type === "chunk_done") console.error(`[scriptorium]   ${c.dim(`[${event.speaker}] ${event.text.slice(0, 60)}${event.text.length > 60 ? "..." : ""}`)}`);
      else if (event.type === "segment_done") console.error(`[scriptorium]   ${c.dim(`segment ${event.segmentIndex + 1}/${event.segments} (${event.speaker}) done`)}`);
      else if (event.type === "scene_done") console.error(`[scriptorium] ${c.ok(`scene ${event.index + 1} written`)} ${c.dim(event.path)}`);
      else if (event.type === "batch_done") console.error(`[scriptorium]   ${c.dim(`batch ${event.batch}/${event.batches}: ${event.speaker}${event.tone ? ` (${event.tone})` : ""}, ${event.lines} line${event.lines === 1 ? "" : "s"}${event.cached ? " — kept from an earlier run" : ""}`)}`);
      else if (event.type === "batch_failed") console.error(`[scriptorium]   ${c.retry(`batch for ${event.speaker} (${event.lines} line${event.lines === 1 ? "" : "s"}) didn't cut cleanly — ${event.split ? "trying it in two halves" : "voicing the line on its own"}: ${event.error.slice(0, 120)}`)}`);
      else if (event.type === "line_kept_long") console.error(`[scriptorium]   ${c.retry(`${event.speaker}: every Gemini take ran long — kept the shortest (${event.seconds.toFixed(1)}s); check this line`)}`);
    }
  });
  await writeVoiceMap(result.outDir, result.voices);
  console.log(`${c.ok(`${result.rendered} scene${result.rendered === 1 ? "" : "s"} rendered, ${result.skipped} unchanged →`)} ${c.cyan(result.outDir + "/")}`);
  return result;
}

export interface VideoStepOptions {
  encoder?: EncoderChoice;
  parallel?: number;
}

export async function videoStep(runDir: string, events: StoryEvent[], force: boolean | undefined, opts: VideoStepOptions = {}) {
  const result = await renderVideo(events, {
    runDir,
    force,
    encoder: opts.encoder,
    parallel: opts.parallel,
    onProgress: (event) => {
      if (event.type === "encoder") console.error(`[scriptorium] ${c.dim(`encoding with ${event.encoder === "nvenc" ? "NVENC (GPU)" : "x264 (CPU)"}, ${event.parallel} scene${event.parallel === 1 ? "" : "s"} at a time`)}`);
      else if (event.type === "warning") console.error(`[scriptorium] ${c.retry(event.message)}`);
      else if (event.type === "part_start") console.error(`[scriptorium] ${c.blue(c.bold(event.label))} ${c.dim(`(${Math.round(event.seconds)}s of video)`)}`);
      else if (event.type === "part_skipped") console.error(`[scriptorium] ${c.dim(`${event.label} unchanged — skipping`)}`);
      else if (event.type === "part_done") console.error(`[scriptorium] ${c.ok(`${event.label} rendered in ${Math.round(event.elapsedMs / 1000)}s`)}`);
      else if (event.type === "muxing") console.error(`[scriptorium] ${c.dim("joining parts and adding narration...")}`);
    }
  });
  const m = Math.floor(result.durationSec / 60);
  const s = Math.round(result.durationSec % 60);
  console.log(`${c.ok(`${m}m ${s}s video written to`)} ${c.cyan(result.video)} ${c.dim("(+ thumbnail.jpg, story.srt)")}`);
  return result;
}

// Loads a run's event log (for steps that read a finished or in-progress run).
export async function loadRun(runDir: string): Promise<StoryEvent[]> {
  const log = new EventLog(runDir);
  return log.load();
}
