#!/usr/bin/env node
import { readFile, writeFile, readdir, rmdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders, listModels } from "./providers.ts";
import { runStory, renderStory, redirectArt } from "./engine.ts";
import { replay } from "./bible.ts";
import { generateAudiobook, parseVoiceGenders, writeVoiceMap } from "./audiobook.ts";
import { renderVideo } from "./video.ts";
import { makeImageBackend, makeInspector, renderArt, resolveArtistConfig } from "./artist.ts";
import { c } from "./colors.ts";
import type { StoryConfig, StoryEvent } from "./types.ts";

const USAGE = `scriptorium <command> [options]

  run   --config <file> [--out <prefix>] [--scenes N] [--premise "..."] [--setting "..."]
        [--context <file.md>] [--max-attempts N|unlimited] [--speaker-tags]
        generate (or resume) a story
  fork  --from <dir> --at <sceneCount> --out <dir>      branch a run at a scene
  show  --out <dir>                                     print the story as markdown
  bible --out <dir>                                     print the current bible as JSON
  audiobook --out <dir> [--narrator-voice <id>] [--language <prefix>]
            [--voice-gender <id>=<female|male>,...]
                                                         render the run's scenes to WAV
  art   --out <dir> [--config <file>] [--force]          render the run's art prompts to images
  video --out <dir> [--force]                          assemble art + audiobook into video/story.mp4
                                                         (Ken Burns shots, timed crossfades, subtitles)
  artdirect --out <dir> [--config <file>]               redo the art direction (shots + cover) for an
                                                         existing run, then render the images
  models --config <file> --provider <name>              list model ids a provider serves

Options:
  --context <file.md>     Markdown file with pre-seeded story details
                          (characters, places, history, plot, etc.)
  --premise "..."         One-line premise fed to worldbuilder + creator
  --setting "..."         Genre/setting description
  --max-attempts N        Total drafts per scene (default: 3)
  --max-attempts 0        Unlimited — keep revising until both reviewers approve
  --speaker-tags          Writer tags every paragraph with a speaker, so
                          audiobook can switch voices per character
  --narrator-voice <id>   Kokoro voice id for narration (default: af_heart)
  --voice-gender a=male,b=female
                          audiobook: set character genders for voice matching
                          (overrides the bible; needed for runs made before
                          characters had a recorded gender)
  --force                 art: re-render images whose prompt is unchanged

Examples:
  npm run story -- --scenes 8
  npm run story -- --context my-story.md --scenes 5
  npm run story -- --premise "a lighthouse keeper" --setting "1980s Maine" --scenes 3
  npm run story -- --max-attempts unlimited --scenes 3
  npm run story -- --speaker-tags --scenes 3
  node src/cli.ts audiobook --out runs/story-20260101-000000
  node --env-file=.env src/cli.ts art --config story.opencode-go.config.json --out runs/story-20260101-000000
`;

const MAX_RUNS = 10;

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function resolveRunDir(outPrefix: string | undefined): Promise<string> {
  // If outPrefix points to an existing run directory, resume from it.
  if (outPrefix) {
    try {
      await readFile(`${outPrefix}/events.jsonl`, "utf8");
      return outPrefix;
    } catch { /* not an existing run, create new */ }
  }
  const dir = outPrefix ? `${outPrefix}-${timestamp()}` : `runs/story-${timestamp()}`;
  await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
  return dir;
}

async function updateManifest(runDir: string, config: string): Promise<unknown[]> {
  const manifestPath = "runs/manifest.json";
  let manifest: Array<{ dir: string; config: string; timestamp: string; scenes: number }> = [];
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch { /* first run */ }
  manifest.unshift({
    dir: runDir,
    config,
    timestamp: new Date().toISOString(),
    scenes: 0
  });
  // keep last MAX_RUNS
  if (manifest.length > MAX_RUNS) {
    const toDelete = manifest.splice(MAX_RUNS);
    for (const entry of toDelete) {
      try {
        const files = await readdir(entry.dir);
        for (const f of files) {
          await import("node:fs/promises").then((fs) => fs.unlink(`${entry.dir}/${f}`));
        }
        await rmdir(entry.dir);
      } catch { /* dir may not exist */ }
    }
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return manifest;
}

// Renders a run's scene_art/cover_art prompts into <runDir>/art/. Shared by `run` and `art`.
async function renderRunArt(runDir: string, config: StoryConfig, events: StoryEvent[], force: boolean | undefined) {
  const artist = resolveArtistConfig(config.artist);
  const result = await renderArt(events, {
    runDir,
    backend: makeImageBackend(artist.image),
    inspector: artist.inspector ? makeInspector(artist.inspector) : undefined,
    maxAttempts: artist.maxAttempts,
    maxReferences: artist.maxReferences,
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

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      config: { type: "string", default: "story.config.json" },
      out: { type: "string" },
      from: { type: "string" },
      at: { type: "string" },
      scenes: { type: "string" },
      provider: { type: "string" },
      premise: { type: "string" },
      setting: { type: "string" },
      context: { type: "string" },
      "max-attempts": { type: "string" },
      "speaker-tags": { type: "boolean" },
      "narrator-voice": { type: "string" },
      language: { type: "string" },
      "voice-gender": { type: "string" },
      force: { type: "boolean" }
    }
  });

  if (command === "models") {
    const config = JSON.parse(await readFile(values.config, "utf8"));
    if (!values.provider) throw new Error("--provider is required");
    const spec = config.providers[values.provider];
    if (!spec) {
      throw new Error(`--provider must be one of: ${Object.keys(config.providers).join(", ")}`);
    }
    console.log((await listModels(spec)).join("\n"));
    return;
  }

  if (command === "run") {
    const config = JSON.parse(await readFile(values.config, "utf8"));
    const runDir = await resolveRunDir(values.out);
    const log = new EventLog(runDir);
    const roles = buildRoleProviders(config);
    const scenes = values.scenes ? Number(values.scenes) : undefined;
    // --max-attempts N = limit revision attempts; --max-attempts 0 or "unlimited" = unbounded
    let maxAttempts = undefined;
    if (values["max-attempts"] !== undefined) {
      const v = values["max-attempts"];
      maxAttempts = (v === "0" || v === "unlimited" || v === "inf") ? Infinity : Number(v);
      if (Number.isNaN(maxAttempts)) throw new Error("--max-attempts must be a number, 0, or 'unlimited'");
    }
    // --context file.md provides pre-seeded story details
    let context = undefined;
    if (values.context) {
      context = await readFile(values.context, "utf8");
    }
    await updateManifest(runDir, values.config);
    await runStory({
      config: {
        ...config,
        premise: values.premise,
        setting: values.setting || config.setting,
        context,
        speakerTags: values["speaker-tags"] ?? config.speakerTags
      },
      log,
      roles,
      scenes,
      maxAttempts,
      runDir,
      onScene: (s) => {
        console.log(`${c.ok(`scene ${s.index + 1} committed`)} ${c.dim(`(tension ${s.tension}, attempts ${s.attempts})`)}`);
      }
    });
    // Render the Art Director's prompts to images. Presentation only: a failure here warns, never fails the run.
    if (roles.artdirector) {
      try {
        await renderRunArt(runDir, config, log.events, false);
      } catch (err) {
        console.error(`[scriptorium] ${c.retry(`art rendering failed (non-fatal): ${err instanceof Error ? err.message : String(err)} — retry with: node src/cli.ts art --out ${runDir} --config ${values.config}`)}`);
      }
    }
    console.log(`${c.green("run written to")} ${c.cyan(runDir + "/")}`);
    return;
  }

  if (command === "fork") {
    if (!values.from || !values.out || values.at === undefined) {
      throw new Error("--from, --at and --out are required");
    }
    const dst = await EventLog.fork(values.from, Number(values.at), values.out);
    console.log(`forked ${dst.events.length} events into ${values.out}`);
    return;
  }

  if (command === "show" || command === "bible") {
    if (!values.out) {
      throw new Error("--out is required");
    }
    const log = new EventLog(values.out);
    await log.load();
    console.log(command === "show" ? renderStory(log.events) : JSON.stringify(replay(log.events), null, 2));
    return;
  }

  if (command === "video") {
    if (!values.out) {
      throw new Error("--out is required");
    }
    const log = new EventLog(values.out);
    await log.load();
    const result = await renderVideo(log.events, {
      runDir: values.out,
      force: values.force,
      onProgress: (event) => {
        if (event.type === "warning") console.error(`[scriptorium] ${c.retry(event.message)}`);
        else if (event.type === "part_start") console.error(`[scriptorium] ${c.blue(c.bold(event.label))} ${c.dim(`(${Math.round(event.seconds)}s of video)`)}`);
        else if (event.type === "part_skipped") console.error(`[scriptorium] ${c.dim(`${event.label} unchanged — skipping`)}`);
        else if (event.type === "part_done") console.error(`[scriptorium] ${c.ok(`${event.label} rendered in ${Math.round(event.elapsedMs / 1000)}s`)}`);
        else if (event.type === "muxing") console.error(`[scriptorium] ${c.dim("joining parts and adding narration...")}`);
      }
    });
    const m = Math.floor(result.durationSec / 60);
    const s = Math.round(result.durationSec % 60);
    console.log(`${c.ok(`${m}m ${s}s video written to`)} ${c.cyan(result.video)} ${c.dim("(+ thumbnail.jpg, story.srt)")}`);
    return;
  }

  if (command === "artdirect") {
    if (!values.out) {
      throw new Error("--out is required");
    }
    const config = JSON.parse(await readFile(values.config, "utf8"));
    const log = new EventLog(values.out);
    const scenes = await redirectArt({
      config,
      log,
      roles: buildRoleProviders(config),
      runDir: values.out,
      onScene: (i, shots) => console.error(`[scriptorium] ${c.ok(`scene ${i + 1}: ${shots} shot${shots === 1 ? "" : "s"}`)}`)
    });
    if (scenes === 0) {
      throw new Error(`no committed scenes in ${values.out}`);
    }
    const result = await renderRunArt(values.out, config, log.events, values.force);
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === "art") {
    if (!values.out) {
      throw new Error("--out is required");
    }
    const config = JSON.parse(await readFile(values.config, "utf8"));
    const log = new EventLog(values.out);
    await log.load();
    const result = await renderRunArt(values.out, config, log.events, values.force);
    if (result.rendered + result.skipped + result.failed === 0) {
      throw new Error(`no scene_art/cover_art events in ${values.out} — was the run made with an artdirector role?`);
    }
    if (result.failed > 0) process.exitCode = 1;
    return;
  }

  if (command === "audiobook") {
    if (!values.out) {
      throw new Error("--out is required");
    }
    const log = new EventLog(values.out);
    await log.load();
    const result = await generateAudiobook(log.events, {
      runDir: values.out,
      narratorVoice: values["narrator-voice"],
      language: values.language,
      characterGenders: parseVoiceGenders(values["voice-gender"]),
      onProgress: (event) => {
        if (event.type === "model_loading") console.error(`[scriptorium] ${c.dim("loading Kokoro model (first run downloads it — this can take a while)...")}`);
        else if (event.type === "model_ready") console.error(`[scriptorium] ${c.ok("model ready")}`);
        else if (event.type === "scene_start") console.error(`[scriptorium] ${c.blue(c.bold(`scene ${event.index + 1}/${event.total}`))} ${c.dim(`(${event.segments} segment${event.segments === 1 ? "" : "s"})`)}`);
        else if (event.type === "chunk_done") console.error(`[scriptorium]   ${c.dim(`[${event.speaker}] ${event.text.slice(0, 60)}${event.text.length > 60 ? "..." : ""}`)}`);
        else if (event.type === "segment_done") console.error(`[scriptorium]   ${c.dim(`segment ${event.segmentIndex + 1}/${event.segments} (${event.speaker}) done`)}`);
        else if (event.type === "scene_done") console.error(`[scriptorium] ${c.ok(`scene ${event.index + 1} written`)} ${c.dim(event.path)}`);
      }
    });
    await writeVoiceMap(result.outDir, result.voices);
    console.log(`${c.ok(`${result.scenes} scene${result.scenes === 1 ? "" : "s"} rendered to`)} ${c.cyan(result.outDir + "/")}`);
    return;
  }

  console.log(USAGE);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
