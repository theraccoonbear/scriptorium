import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { requireKey } from "./providers.ts";
import { currentAccountant } from "./usage.ts";

// Gemini Batch Mode: many generateContent requests as one job, at half the
// price, with its own rate limits; results in minutes (up to 24h). A job's name
// is kept in a state file as soon as it's submitted, so a stopped run picks the
// same job up again instead of paying for it twice (submitting isn't idempotent).

const BASE = "https://generativelanguage.googleapis.com/v1beta";
export const BATCH_PRICE_FACTOR = 0.5;
// Status checks that may fail in a row (network errors) before a run gives up on waiting.
const MAX_DROPPED_POLLS = 6;

export interface BatchItem { response?: any; error?: string }
export interface BatchJobs {
  run(model: string, role: string, requests: unknown[]): Promise<BatchItem[]>;
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;

export function geminiBatchJobs(opts: {
  apiKey?: string;
  stateFile?: string;               // where submitted job names are kept for resuming
  pollMs?: number;                  // first poll interval (grows to 60s); default 10s
  maxWaitMs?: number;               // give up after this long; default 48h (when Google expires jobs)
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  maxJobBytes?: number;             // inline jobs are capped at 20MB; larger batches split (default 15MB)
} = {}): BatchJobs {
  const get = opts.fetch ?? (fetch as unknown as Fetch);
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const log = opts.log ?? (() => {});
  const key = () => opts.apiKey ?? requireKey("GEMINI_API_KEY");
  const loadState = async (): Promise<Record<string, string>> => {
    if (!opts.stateFile) return {};
    try { return JSON.parse(await readFile(opts.stateFile, "utf8")); } catch { return {}; }
  };
  const saveState = async (state: Record<string, string>) => {
    if (!opts.stateFile) return;
    await mkdir(dirname(opts.stateFile), { recursive: true });
    await writeFile(opts.stateFile, JSON.stringify(state, null, 2) + "\n");
  };
  // Requests carrying images (an image job's references) quickly pass the inline
  // limit: split into jobs under maxJobBytes, run together, results in order.
  const run = async (model: string, role: string, requests: unknown[]): Promise<BatchItem[]> => {
    const limit = opts.maxJobBytes ?? 15 * 1024 * 1024;
    const chunks: unknown[][] = [];
    let size = 0;
    for (const r of requests) {
      const bytes = JSON.stringify(r).length;
      if (chunks.length === 0 || (size + bytes > limit && chunks.at(-1)!.length > 0)) { chunks.push([]); size = 0; }
      chunks.at(-1)!.push(r);
      size += bytes;
    }
    if (chunks.length > 1) log(`${requests.length} ${role} requests split into ${chunks.length} batch jobs (inline jobs are capped at 20MB)`);
    return (await Promise.all(chunks.map((c) => one.run(model, role, c)))).flat();
  };
  const one: BatchJobs = {
    async run(model, role, requests) {
      const signature = createHash("sha1").update(model).update(JSON.stringify(requests)).digest("hex");
      const state = await loadState();
      let name = state[signature];
      if (name) log(`batch job ${name} (${requests.length} requests): resuming`);
      else {
        currentAccountant()?.check();
        const res = await get(`${BASE}/models/${model}:batchGenerateContent`, {
          method: "POST",
          headers: { "x-goog-api-key": key(), "content-type": "application/json" },
          body: JSON.stringify({ batch: { display_name: `scriptorium-${role}-${signature.slice(0, 8)}`, input_config: { requests: { requests: requests.map((request, i) => ({ request, metadata: { key: String(i) } })) } } } })
        });
        const d = await res.json();
        if (!res.ok || !d.name) throw new Error(`batch submit: HTTP ${res.status} ${JSON.stringify(d.error ?? d).slice(0, 200)}`);
        name = d.name as string;
        await saveState({ ...(await loadState()), [signature]: name });
        log(`batch job ${name} submitted: ${requests.length} ${role} request${requests.length === 1 ? "" : "s"} at half price`);
      }
      const started = Date.now();
      let wait = opts.pollMs ?? 10000;
      let dropped = 0;
      for (;;) {
        // A dropped status check ("fetch failed": a reset socket after a big
        // upload, a network blip) isn't the job failing — Google keeps working
        // on it, and bills it. Wait and check again; after several in a row,
        // stop and leave the job to be resumed by the next run.
        let res: Awaited<ReturnType<Fetch>>, d: any;
        try {
          res = await get(`${BASE}/${name}`, { headers: { "x-goog-api-key": key() } });
          d = await res.json();
          dropped = 0;
        } catch (err) {
          if (++dropped >= MAX_DROPPED_POLLS) throw new Error(`batch job ${name}: status check failed ${dropped} times (${err instanceof Error ? err.message : String(err)}) — re-run later to resume it`);
          log(`batch job ${name}: status check failed (${err instanceof Error ? err.message : String(err)}) — checking again`);
          await sleep(wait);
          continue;
        }
        if (!res.ok) throw new Error(`batch status: HTTP ${res.status} ${JSON.stringify(d.error ?? d).slice(0, 200)}`);
        const jobState = String(d.metadata?.state ?? "");
        if (/SUCCEEDED/.test(jobState)) {
          const out: BatchItem[] = requests.map(() => ({ error: "no result" }));
          for (const item of d.response?.inlinedResponses?.inlinedResponses ?? []) {
            const i = Number(item.metadata?.key);
            if (!Number.isInteger(i) || i < 0 || i >= out.length) continue;
            if (item.response) {
              out[i] = { response: item.response };
              currentAccountant()?.record(role, model, item.response, { priceFactor: BATCH_PRICE_FACTOR });
            } else {
              out[i] = { error: JSON.stringify(item.error ?? "failed").slice(0, 200) };
            }
          }
          const rest = await loadState();
          delete rest[signature];
          await saveState(rest);
          log(`batch job ${name} done in ${Math.round((Date.now() - started) / 1000)}s`);
          return out;
        }
        if (/FAILED|CANCELLED|EXPIRED/.test(jobState)) {
          const rest = await loadState();
          delete rest[signature];
          await saveState(rest);
          throw new Error(`batch job ${name} ended ${jobState}`);
        }
        if (Date.now() - started > (opts.maxWaitMs ?? 48 * 3600 * 1000)) throw new Error(`batch job ${name} still ${jobState} — re-run later to resume it`);
        await sleep(wait);
        wait = Math.min(60000, Math.round(wait * 1.5));
      }
    }
  };
  return { run };
}

// Collects calls made close together into one batch: each caller gets a
// promise for its own result. A burst of calls (a stage of images, a scene's
// voice batches) becomes one job; retakes made while it runs form the next.
export function microBatcher<Req, Res>(flush: (reqs: Req[]) => Promise<Array<Res | Error>>, opts: { windowMs?: number; maxSize?: number } = {}): (req: Req) => Promise<Res> {
  let pending: { req: Req; resolve: (r: Res) => void; reject: (e: unknown) => void }[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const go = () => {
    timer = undefined;
    const batch = pending;
    pending = [];
    flush(batch.map((p) => p.req)).then(
      (results) => batch.forEach((p, i) => { const r = results[i]; if (r instanceof Error) p.reject(r); else p.resolve(r as Res); }),
      (err) => batch.forEach((p) => p.reject(err))
    );
  };
  return (req) => new Promise<Res>((resolve, reject) => {
    pending.push({ req, resolve, reject });
    if (timer) clearTimeout(timer);
    if (pending.length >= (opts.maxSize ?? 1000)) go();
    else timer = setTimeout(go, opts.windowMs ?? 1500);
  });
}
