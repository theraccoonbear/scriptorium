#!/usr/bin/env node
import { readFile, writeFile, readdir, rmdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders, listModels } from "./providers.ts";
import { renderStory, redirectArt } from "./engine.ts";
import { replay } from "./bible.ts";
import { parseVoiceGenders } from "./audiobook.ts";
import { accounted, artStep, castPreviewStep, audiobookStep, storyStep, videoStep } from "./steps.ts";
import { formatSummary, readLedger, summarize } from "./usage.ts";
import { loadStoryFile, make } from "./make.ts";
import { c } from "./colors.ts";

const USAGE = `scriptorium <command> [options]

  make  <story.json> [--only <steps>] [--from <step>] [--force]
        run a story file's whole pipeline: story → art → audiobook → video.
        Re-running finishes whatever's missing. Steps: story, art, audiobook, video.
        --force allows changed story settings for a story already in progress
  run   --config <file> [--out <prefix>] [--scenes N] [--premise "..."] [--setting "..."]
        [--context <file.md> ...] [--max-attempts N|unlimited] [--speaker-tags]
        generate (or resume) a story
  fork  --from <dir> --at <sceneCount> --out <dir>      branch a run at a scene
  show  --out <dir>                                     print the story as markdown
  bible --out <dir>                                     print the current bible as JSON
  audiobook --out <dir> [--narrator-voice <id>] [--language <prefix>]
            [--voice-gender <id>=<female|male>,...] [--dialogue kokoro|gemini]
            [--narration kokoro|gemini] [--exclude-voices <kokoro ids>]
            [--character-voice <id>=<kokoro voice>,...] [--force]
                                                         render the run's scenes to WAV
  art   --out <dir> [--config <file>] [--force]          render the run's art prompts to images
  video --out <dir> [--encoder auto|nvenc|x264] [--parallel N] [--force]
                                                         assemble art + audiobook into video/story.mp4
                                                         (Ken Burns shots, timed crossfades, subtitles)
  artdirect --out <dir> [--config <file>]               redo the art direction (shots + cover) for an
                                                         existing run, then render the images
            [--redo <kind>:<id>,...] [--note "..."]     also recreate these references (e.g. prop:horn),
                                                         with your corrections in --note
  cast  <story.json> [--as "..."]                      preview the story's cast: describe each member from
                                                         their photos and render one portrait each
  cost  --out <dir>                                     what a run has spent so far, by step, role and model
  models --config <file> --provider <name>              list model ids a provider serves

Options:
  --context <file.md>     Markdown file with pre-seeded story details
                          (characters, places, history, plot, etc.). Repeat
                          to mix files; a context gate rejects contradictions
                          between them before anything is generated
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
  --force                 art/audiobook/video: re-render even when unchanged
                          make: allow changed settings for a story in progress

Examples:
  npm run make -- stories/example.json
  npm run make -- stories/example.json --from audiobook
  npm run story -- --scenes 8
  npm run story -- --context my-story.md --scenes 5
  npm run story -- --context world.md --context hero.md --context rival.md --scenes 3
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

function engineFlag(value: string | undefined, flag: string): "kokoro" | "gemini" | undefined {
  if (value === undefined) return undefined;
  if (value !== "kokoro" && value !== "gemini") throw new Error(`${flag} must be kokoro or gemini`);
  return value;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string", default: "story.config.json" },
      out: { type: "string" },
      from: { type: "string" },
      at: { type: "string" },
      scenes: { type: "string" },
      provider: { type: "string" },
      premise: { type: "string" },
      setting: { type: "string" },
      context: { type: "string", multiple: true },
      "max-attempts": { type: "string" },
      "speaker-tags": { type: "boolean" },
      "narrator-voice": { type: "string" },
      language: { type: "string" },
      "voice-gender": { type: "string" },
      "exclude-voices": { type: "string" },
      "character-voice": { type: "string" },
      force: { type: "boolean" },
      redo: { type: "string" },
      only: { type: "string" },
      encoder: { type: "string" },
      dialogue: { type: "string" },
      narration: { type: "string" },
      parallel: { type: "string" },
      note: { type: "string" },
      as: { type: "string" }
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

  if (command === "cost") {
    if (!values.out) throw new Error("--out is required");
    const ledger = readLedger(values.out);
    if (ledger.length === 0) {
      console.log(`no usage recorded in ${values.out} (runs made before spend accounting have none)`);
      return;
    }
    console.log(formatSummary(summarize(ledger)));
    return;
  }

  if (command === "cast") {
    const storyFile = positionals[0];
    if (!storyFile) throw new Error('usage: cast <story.json> [--as "a dwarf warrior in chainmail"]');
    const story = await loadStoryFile(storyFile);
    const results = await castPreviewStep({ runDir: story.runDir, config: story.config, cast: story.cast, as: values.as });
    if (results.some((r) => !r.accepted)) process.exitCode = 1;
    return;
  }

  if (command === "make") {
    const storyFile = positionals[0];
    if (!storyFile) throw new Error("usage: make <story.json> [--only <steps>] [--from <step>] [--force]");
    await make(storyFile, { only: values.only, from: values.from, force: values.force });
    return;
  }

  if (command === "run") {
    const config = JSON.parse(await readFile(values.config, "utf8"));
    const runDir = await resolveRunDir(values.out);
    const scenes = values.scenes ? Number(values.scenes) : undefined;
    // --max-attempts N = limit revision attempts; --max-attempts 0 or "unlimited" = unbounded
    let maxAttempts = undefined;
    if (values["max-attempts"] !== undefined) {
      const v = values["max-attempts"];
      maxAttempts = (v === "0" || v === "unlimited" || v === "inf") ? Infinity : Number(v);
      if (Number.isNaN(maxAttempts)) throw new Error("--max-attempts must be a number, 0, or 'unlimited'");
    }
    await updateManifest(runDir, values.config);
    // --context file.md (repeatable) provides pre-seeded story details; files
    // are combined under headers naming each source.
    const { log } = await storyStep({
      config, runDir, scenes, maxAttempts,
      premise: values.premise, setting: values.setting,
      contextPaths: values.context ?? [],
      speakerTags: values["speaker-tags"]
    });
    // Render the Art Director's prompts to images. Presentation only: a failure here warns, never fails the run.
    if (buildRoleProviders(config).artdirector) {
      try {
        await artStep(runDir, config, log.events, false);
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
    const encoder = values.encoder ?? "auto";
    if (!["auto", "nvenc", "x264"].includes(encoder)) throw new Error("--encoder must be auto, nvenc or x264");
    const parallel = values.parallel ? Number(values.parallel) : undefined;
    if (parallel !== undefined && !(Number.isInteger(parallel) && parallel > 0)) throw new Error("--parallel must be a positive integer");
    await videoStep(values.out, log.events, values.force, { encoder: encoder as "auto" | "nvenc" | "x264", parallel });
    return;
  }

  if (command === "artdirect") {
    if (!values.out) {
      throw new Error("--out is required");
    }
    const config = JSON.parse(await readFile(values.config, "utf8"));
    const log = new EventLog(values.out);
    const scenes = await accounted(values.out, config, "artdirect", () => redirectArt({
      config,
      log,
      roles: buildRoleProviders(config),
      runDir: values.out,
      redo: (values.redo ?? "").split(",").map((r) => r.trim()).filter(Boolean),
      notes: values.note,
      onReferences: (refs) => console.error(`[scriptorium] ${c.ok(refs.length > 0 ? `new references: ${refs.join(", ")}` : "references: none missing")}`),
      onScene: (i, shots) => console.error(`[scriptorium] ${c.ok(`scene ${i + 1}: ${shots} shot${shots === 1 ? "" : "s"}`)}`)
    }));
    if (scenes === 0) {
      throw new Error(`no committed scenes in ${values.out}`);
    }
    const result = await artStep(values.out, config, log.events, values.force);
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
    const result = await artStep(values.out, config, log.events, values.force);
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
    await audiobookStep(values.out, log.events, {
      narratorVoice: values["narrator-voice"],
      language: values.language,
      characterGenders: parseVoiceGenders(values["voice-gender"]),
      dialogue: engineFlag(values.dialogue, "--dialogue"),
      narration: engineFlag(values.narration, "--narration"),
      kokoroVoices: values["exclude-voices"] ? { exclude: values["exclude-voices"].split(",").map((v) => v.trim()).filter(Boolean) } : undefined,
      characterVoices: values["character-voice"] ? Object.fromEntries(values["character-voice"].split(",").map((p) => p.split("=").map((x) => x.trim())).filter((p) => p.length === 2 && p[0] && p[1])) : undefined,
      force: values.force
    });
    return;
  }

  console.log(USAGE);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
