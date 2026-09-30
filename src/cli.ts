#!/usr/bin/env node
import { readFile, writeFile, readdir, rmdir } from "node:fs/promises";
import { parseArgs } from "node:util";
import { EventLog } from "./eventlog.ts";
import { buildRoleProviders, listModels } from "./providers.ts";
import { runStory, renderStory } from "./engine.ts";
import { replay } from "./bible.ts";
import { c } from "./colors.ts";

const USAGE = `scriptorium <command> [options]

  run   --config <file> [--out <prefix>] [--scenes N] [--premise "..."] [--setting "..."]
        [--context <file.md>] [--max-attempts N|unlimited]
        generate (or resume) a story
  fork  --from <dir> --at <sceneCount> --out <dir>      branch a run at a scene
  show  --out <dir>                                     print the story as markdown
  bible --out <dir>                                     print the current bible as JSON
  models --config <file> --provider <name>              list model ids a provider serves

Options:
  --context <file.md>     Markdown file with pre-seeded story details
                          (characters, places, history, plot, etc.)
  --premise "..."         One-line premise fed to worldbuilder + creator
  --setting "..."         Genre/setting description
  --max-attempts N        Total drafts per scene (default: 3)
  --max-attempts 0        Unlimited — keep revising until both reviewers approve

Examples:
  npm run story -- --scenes 8
  npm run story -- --context my-story.md --scenes 5
  npm run story -- --premise "a lighthouse keeper" --setting "1980s Maine" --scenes 3
  npm run story -- --max-attempts unlimited --scenes 3
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
      "max-attempts": { type: "string" }
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
      config: { ...config, premise: values.premise, setting: values.setting || config.setting, context },
      log,
      roles,
      scenes,
      maxAttempts,
      runDir,
      onScene: (s) => {
        console.log(`${c.ok(`scene ${s.index + 1} committed`)} ${c.dim(`(tension ${s.tension}, attempts ${s.attempts})`)}`);
      }
    });
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

  console.log(USAGE);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
