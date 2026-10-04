import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { geminiBatchJobs, microBatcher } from "../src/batchJobs.ts";
import { accountantFor, readLedger, runAccounted } from "../src/usage.ts";
import { BatchImageBackend, MockImageBackend, renderArt } from "../src/artist.ts";
import { geminiBatchSpeaker } from "../src/geminiTts.ts";
import { encodeWav } from "../src/geminiBatch.ts";
import { parseScene, scenePieces, voiceSceneBatches } from "../src/audiobook.ts";
import { emptyBible } from "../src/bible.ts";
import type { StoryEvent } from "../src/types.ts";

const tmp = () => mkdtemp(join(tmpdir(), "scriptorium-batch-"));
const noSleep = async () => {};

// A fake Batch API: records submissions; each job reports pending, running, then succeeded
// with one response per request (out of order, the second one failing).
function fakeApi(opts: { fail?: boolean } = {}) {
  const submitted: { model: string; requests: { request: unknown; metadata: { key: string } }[] }[] = [];
  const polls = new Map<string, number>();
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body!);
      submitted.push({ model: url.split("/models/")[1].split(":")[0], requests: body.batch.input_config.requests.requests });
      const name = `batches/job${submitted.length}`;
      return { ok: true, status: 200, json: async () => ({ name }) };
    }
    const name = url.split("/v1beta/")[1];
    const n = (polls.get(name) ?? 0) + 1;
    polls.set(name, n);
    const job = submitted[Number(name.replace("batches/job", "")) - 1];
    if (n < 3) return { ok: true, status: 200, json: async () => ({ metadata: { state: n === 1 ? "BATCH_STATE_PENDING" : "BATCH_STATE_RUNNING" } }) };
    if (opts.fail) return { ok: true, status: 200, json: async () => ({ metadata: { state: "BATCH_STATE_FAILED" } }) };
    const items = job.requests.map((r) => r.metadata.key === "1"
      ? { metadata: r.metadata, error: { message: "blocked" } }
      : { metadata: r.metadata, response: { echo: r.request, usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 1_000_000 } } }).reverse();
    return { ok: true, status: 200, json: async () => ({ metadata: { state: "BATCH_STATE_SUCCEEDED" }, response: { inlinedResponses: { inlinedResponses: items } } }) };
  };
  return { fetch, submitted, polls };
}

test("a batch job is submitted once, polled to the end, its results matched by key and billed at half price", async () => {
  const runDir = await tmp();
  const api = fakeApi();
  const stateFile = join(runDir, "jobs.json");
  const jobs = geminiBatchJobs({ apiKey: "k", stateFile, fetch: api.fetch, sleep: noSleep });
  const acc = accountantFor(runDir, { pricing: { m: { input: 0, output: 1 } } });
  const items = await runAccounted(acc, "art", () => jobs.run("m", "artist", [{ n: 0 }, { n: 1 }, { n: 2 }]));
  assert.equal(api.submitted.length, 1);
  assert.deepEqual(items.map((i) => (i.response ? i.response.echo.n : `error`)), [0, "error", 2], "matched by key, though returned out of order");
  const ledger = readLedger(runDir);
  assert.equal(ledger.length, 2);
  assert.ok(ledger.every((e) => e.usd === 0.5 && e.batch === true && e.step === "art"), "half price, marked as batch");
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), {}, "a finished job is forgotten");
});

test("a stopped run resumes its job instead of paying again; a failed job is reported and forgotten", async () => {
  const dir = await tmp();
  const stateFile = join(dir, "jobs.json");
  const requests = [{ n: 0 }];
  const signature = createHash("sha1").update("m").update(JSON.stringify(requests)).digest("hex");
  const api = fakeApi();
  api.submitted.push({ model: "m", requests: [{ request: { n: 0 }, metadata: { key: "0" } }] });  // the job a previous run submitted
  await writeFile(stateFile, JSON.stringify({ [signature]: "batches/job1" }));
  const items = await geminiBatchJobs({ apiKey: "k", stateFile, fetch: api.fetch, sleep: noSleep }).run("m", "tts", requests);
  assert.equal(api.submitted.length, 1, "no second submission");
  assert.equal(items[0].response.echo.n, 0);
  const failing = fakeApi({ fail: true });
  await assert.rejects(geminiBatchJobs({ apiKey: "k", stateFile, fetch: failing.fetch, sleep: noSleep }).run("m", "tts", [{ x: 1 }]), /ended BATCH_STATE_FAILED/);
  assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), {});
});

test("the micro-batcher sends calls made together as one batch; a call's error is only its own", async () => {
  const flushed: number[][] = [];
  const send = microBatcher<number, number>(async (xs) => { flushed.push(xs); return xs.map((x) => (x === 3 ? new Error("bad") : x * 10)); }, { windowMs: 5 });
  const first = await Promise.allSettled([send(1), send(2), send(3)]);
  assert.deepEqual(first.map((r) => (r.status === "fulfilled" ? r.value : "rejected")), [10, 20, "rejected"]);
  await send(4);
  assert.deepEqual(flushed, [[1, 2, 3], [4]]);
});

test("in batch mode each art stage goes out as one job", async () => {
  const runDir = await tmp();
  const ev = (seq: number, type: string, data: unknown): StoryEvent => ({ seq, type, ts: `t${seq}`, data });
  const events = [
    ev(0, "visual_ref", { kind: "character", id: "nell", appearance: "a", prompt: "portrait nell" }),
    ev(1, "visual_ref", { kind: "location", id: "inn", appearance: "b", prompt: "place inn" }),
    ev(2, "scene_art", { sceneIndex: 0, prompt: "a1", shots: [{ startParagraph: 0, prompt: "a1", characters: ["nell"] }, { startParagraph: 1, prompt: "a2" }] }),
    ev(3, "scene_art", { sceneIndex: 1, prompt: "b1", shots: [{ startParagraph: 0, prompt: "b1", characters: ["nell"] }, { startParagraph: 1, prompt: "b2" }] }),
    ev(4, "cover_art", { sceneCount: 2, prompt: "cover" })
  ];
  const png = (await new MockImageBackend().generate({ prompt: "x", references: [] })).data.toString("base64");
  const jobs: number[] = [];
  const fakeJobs = { async run(_m: string, _r: string, reqs: unknown[]) { jobs.push(reqs.length); return reqs.map(() => ({ response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "image/png", data: png } }] } }] } })); } };
  const result = await renderArt(events, { runDir, backend: new BatchImageBackend({ type: "gemini", model: "img" }, fakeJobs), concurrency: 10000, shrink: async (i) => i });
  assert.equal(result.rendered, 7);
  assert.deepEqual(jobs, [1, 1, 2, 2, 1], "first reference, other references, the scenes' first shots, the other shots, the cover");
});

test("in batch mode a scene's voice batches go out as one job", async () => {
  const RATE = 24000;
  const scene = parseScene(0, ['nell: "Go home," she said.', 'edrick: "No."', "narrator: Rain."].join("\n\n"), new Set(["nell", "edrick"]));
  const tone = (secs: number) => { const a = new Float32Array(Math.round(RATE * secs)); for (let i = 0; i < a.length; i++) a[i] = 0.5 * Math.sin(i / 8); return a; };
  const jobs: number[] = [];
  const fakeJobs = {
    async run(_m: string, _r: string, reqs: any[]) {
      jobs.push(reqs.length);
      return reqs.map((r) => {
        const lines = r.contents[0].parts[0].text.split("#### TRANSCRIPT\n")[1].split("\n\n");
        const parts: Float32Array[] = [];
        lines.forEach((_: string, i: number) => { if (i) parts.push(new Float32Array(RATE * 2)); parts.push(tone(1)); });
        const all = new Float32Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
        return { response: { candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/wav", data: encodeWav(all, RATE).toString("base64") } }] } }] } };
      });
    }
  };
  const out = await voiceSceneBatches(scene, "speaker", { bible: emptyBible(), voiceFor: (s) => `gemini:${s}`, speak: geminiBatchSpeaker(fakeJobs, { model: "tts" }), concurrency: 10000, onProgress: () => {} });
  assert.equal(out.size, scenePieces(scene).length);
  assert.deepEqual(jobs, [3], "narrator, Nell and Edrick batches: one job");
});

test("a batch too big for one inline job is split into several, results back in order", async () => {
  const api = fakeApi();
  const big = Array.from({ length: 5 }, (_, n) => ({ n, image: "x".repeat(400) }));
  const items = await geminiBatchJobs({ apiKey: "k", fetch: api.fetch, sleep: noSleep, maxJobBytes: 1000 }).run("m", "artist", big);
  assert.deepEqual(api.submitted.map((j) => j.requests.length), [2, 2, 1], "split into jobs under the limit");
  // The fake fails each job's second request (key "1"): requests 1 and 3 overall.
  assert.deepEqual(items.map((i) => i.response?.echo.n ?? "error"), [0, "error", 2, "error", 4], "every result in its original place");
});
