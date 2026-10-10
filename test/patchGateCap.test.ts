import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../src/eventlog.ts";
import { runStory } from "../src/engine.ts";
import { buildRoleProviders } from "../src/providers.ts";
import type { SceneCommittedData, StoryConfig } from "../src/types.ts";

// A scene the reviewers approved isn't lost because the patch gate keeps
// disputing the archivist's bookkeeping: after the last try the patch is kept,
// with the dispute recorded on the scene (seen in the #180 A/B: the whole run died).

test("bounded mode: a patch still disputed after the last try is kept, the scene committed, the dispute recorded", async () => {
  const base = JSON.parse(await readFile(new URL("../story.config.json", import.meta.url), "utf8"));
  const config = { ...base, scenes: 1, premise: "A keeper, a letter." } as StoryConfig;
  const roles = buildRoleProviders(config);
  let n = 0;
  for (const role of Object.values(roles)) {
    if (!role) continue;
    const real = role.provider.complete.bind(role.provider);
    role.provider = { complete: async (req) => (req.role === "patchgate"
      ? JSON.stringify({ ok: false, issues: [{ type: "WRONG_PAYOFF", entity: `entry ${++n}`, constraint: `match the scene (${n})`, detail: "not shown" }] })
      : real(req)) };
  }
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-patchcap-"));
  const log = new EventLog(dir);
  await runStory({ config, log, roles, runDir: dir, maxAttempts: 3 });
  const scene = log.events.find((e) => e.type === "scene_committed")!.data as SceneCommittedData;
  assert.ok(scene.prose.length > 0, "the approved scene is kept");
  assert.equal(n, 4, "four tries, as before");
  assert.match(scene.patchDisputed!.join("\n"), /WRONG_PAYOFF/);
});
