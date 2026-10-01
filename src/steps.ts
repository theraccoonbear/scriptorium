import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { combineContexts, contextFile } from "./context.ts";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders } from "./providers.ts";
import { runStory } from "./engine.ts";
import { generateAudiobook, writeVoiceMap } from "./audiobook.ts";
import { renderVideo } from "./video.ts";
import type { EncoderChoice } from "./video.ts";
import { makeImageBackend, makeInspector, renderArt, resolveArtistConfig } from "./artist.ts";
import { c } from "./colors.ts";
import type { Bible, StoryConfig, StoryEvent } from "./types.ts";

// The pipeline's steps — story, art, audiobook, video — as plain functions with
// their console progress. Shared by the individual CLI commands and `make`.
// Each step resumes or skips finished work, so re-running one is always safe.

export interface StoryStepOptions {
  config: StoryConfig;
  runDir: string;
  scenes?: number;
  maxAttempts?: number;
  premise?: string;
  setting?: string;
  contextPaths?: string[];
  speakerTags?: boolean;
}

export async function readContexts(paths: string[]): Promise<{ context?: string; contextFiles: string[] }> {
  const files = await Promise.all(paths.map(async (p) => contextFile(p, await readFile(p, "utf8"))));
  return { context: combineContexts(files), contextFiles: paths.map((p) => basename(p)) };
}

export async function storyStep(opts: StoryStepOptions): Promise<{ log: EventLog; bible: Bible }> {
  const { config, runDir } = opts;
  const log = new EventLog(runDir);
  const { context, contextFiles } = await readContexts(opts.contextPaths ?? []);
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

// Renders a run's art prompts (references, shots, cover) into <runDir>/art/.
export async function artStep(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined) {
  const artist = resolveArtistConfig(config.artist);
  const result = await renderArt(events, {
    runDir,
    backend: makeImageBackend(artist.image),
    inspector: artist.inspector ? makeInspector(artist.inspector) : undefined,
    maxAttempts: artist.maxAttempts,
    maxReferences: artist.maxReferences,
    referenceSize: artist.referenceSize,
    inspectSize: artist.inspectSize,
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
  force?: boolean;
}

export async function audiobookStep(runDir: string, events: StoryEvent[], opts: AudiobookStepOptions = {}) {
  const result = await generateAudiobook(events, {
    runDir,
    narratorVoice: opts.narratorVoice,
    language: opts.language,
    characterGenders: opts.characterGenders,
    force: opts.force,
    onProgress: (event) => {
      if (event.type === "model_loading") console.error(`[scriptorium] ${c.dim("loading Kokoro model (first run downloads it — this can take a while)...")}`);
      else if (event.type === "model_ready") console.error(`[scriptorium] ${c.ok("model ready")}`);
      else if (event.type === "scene_skipped") console.error(`[scriptorium] ${c.dim(`scene ${event.index + 1} unchanged — skipping (${event.path})`)}`);
      else if (event.type === "scene_start") console.error(`[scriptorium] ${c.blue(c.bold(`scene ${event.index + 1}/${event.total}`))} ${c.dim(`(${event.segments} segment${event.segments === 1 ? "" : "s"})`)}`);
      else if (event.type === "chunk_done") console.error(`[scriptorium]   ${c.dim(`[${event.speaker}] ${event.text.slice(0, 60)}${event.text.length > 60 ? "..." : ""}`)}`);
      else if (event.type === "segment_done") console.error(`[scriptorium]   ${c.dim(`segment ${event.segmentIndex + 1}/${event.segments} (${event.speaker}) done`)}`);
      else if (event.type === "scene_done") console.error(`[scriptorium] ${c.ok(`scene ${event.index + 1} written`)} ${c.dim(event.path)}`);
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
