import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Spend accounting. Every paid call goes through postJson, which asks the
// current Accountant (if any) to check the budget before the request and to
// record the response's token usage after it. The ledger lives in the run
// folder (usage.jsonl), so totals and the budget span every session of a run.

// USD per million tokens. Estimates as of 2026-10; override with config.pricing.
// A model billed per request instead (music) sets perRequest; its tokens, if
// any, are then ignored.
export interface Price {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  perRequest?: number;
  // A model priced by prompt length (Haiku 5.5): prompts of more than `above`
  // input tokens (uncached + cache reads + writes) pay these prices instead.
  longPrompt?: { above: number; input: number; output: number; cacheRead?: number; cacheWrite?: number };
}

export const DEFAULT_PRICES: Readonly<Record<string, Price>> = {
  // Anthropic (first-party API rates)
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longPrompt: { above: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Google (Developer API; 2026 introductory rates, several double on 2027-01-01)
  "gemini-3.8-flash-tts": { input: 0.5, output: 9 },
  "gemini-3.8-flash-lite-tts": { input: 0.5, output: 6 },
  "gemini-3.8-flash": { input: 0.75, output: 3.75 },
  "gemini-3.1-flash-image": { input: 0.25, output: 60 },  // images bill as output tokens
  // Lyria music: a flat price per generated cue, whatever its length
  "lyria-3.5": { input: 0, output: 0, perRequest: 0.08 },
  "lyria-3-clip-preview": { input: 0, output: 0, perRequest: 0.04 }
};

// Exact id, else the longest table key the id starts with ("claude-haiku-4-5-20251001").
export function priceFor(model: string, table: Readonly<Record<string, Price>>): Price | undefined {
  if (table[model]) return table[model];
  const key = Object.keys(table).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? table[key] : undefined;
}

export interface Usage {
  input: number;      // uncached input tokens
  output: number;     // output tokens, including thinking/reasoning and image/audio output
  cacheRead: number;
  cacheWrite: number;
}

// Token usage from any provider's response shape; undefined if it reports none.
export function extractUsage(data: unknown): Usage | undefined {
  const d = (data ?? {}) as Record<string, any>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  if (d.usageMetadata) {
    // Gemini: prompt includes cached tokens; thinking is billed as output.
    const m = d.usageMetadata;
    const cached = n(m.cachedContentTokenCount);
    return { input: n(m.promptTokenCount) - cached, output: n(m.candidatesTokenCount) + n(m.thoughtsTokenCount), cacheRead: cached, cacheWrite: 0 };
  }
  const u = d.usage;
  if (!u) return undefined;
  if (u.total_input_tokens !== undefined || u.total_output_tokens !== undefined) {
    // Gemini Interactions: totals across the interaction; thinking is billed as output.
    const cached = n(u.total_cached_tokens);
    return { input: n(u.total_input_tokens) - cached, output: n(u.total_output_tokens) + n(u.total_thought_tokens), cacheRead: cached, cacheWrite: 0 };
  }
  if (u.prompt_tokens !== undefined || u.completion_tokens !== undefined) {
    // OpenAI-compatible chat: prompt includes cached tokens.
    const cached = n(u.prompt_tokens_details?.cached_tokens);
    return { input: n(u.prompt_tokens) - cached, output: n(u.completion_tokens), cacheRead: cached, cacheWrite: 0 };
  }
  // Anthropic messages (input excludes cache reads/writes) and OpenAI Responses.
  const responsesCached = n(u.input_tokens_details?.cached_tokens);
  return {
    input: n(u.input_tokens) - responsesCached,
    output: n(u.output_tokens),
    cacheRead: n(u.cache_read_input_tokens) + responsesCached,
    cacheWrite: n(u.cache_creation_input_tokens)
  };
}

export function costOf(u: Usage, price: Price): number {
  const long = price.longPrompt && u.input + u.cacheRead + u.cacheWrite > price.longPrompt.above ? price.longPrompt : undefined;
  const p = long ?? price;
  return (u.input * p.input + u.output * p.output + u.cacheRead * (p.cacheRead ?? p.input) + u.cacheWrite * (p.cacheWrite ?? p.input)) / 1e6;
}

export interface LedgerEntry extends Usage {
  ts: string;
  step: string;
  role: string;
  model: string;
  usd: number | null;  // null: no price for this model
  batch?: boolean;     // a batch-mode call, priced at half
}

export class BudgetExceededError extends Error {
  constructor(spent: number, budget: number) {
    super(`budget $${budget.toFixed(2)} reached ($${spent.toFixed(2)} spent) — raise budget.usd and re-run the same command to continue`);
    this.name = "BudgetExceededError";
  }
}

export function isBudgetError(err: unknown): boolean {
  return err instanceof BudgetExceededError;
}

export const LEDGER_FILE = "usage.jsonl";

export function readLedger(runDir: string): LedgerEntry[] {
  try {
    return readFileSync(join(runDir, LEDGER_FILE), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export class Accountant {
  readonly file: string;
  readonly prices: Readonly<Record<string, Price>>;
  readonly budgetUsd?: number;
  step = "run";
  spent: number;       // whole run, including earlier sessions
  stepSpent = 0;
  private byStep = new Map<string, number>();  // this session, per step label
  private unpriced = new Set<string>();

  constructor(runDir: string, opts: { pricing?: Record<string, Price>; budgetUsd?: number } = {}) {
    this.file = join(runDir, LEDGER_FILE);
    this.prices = { ...DEFAULT_PRICES, ...opts.pricing };
    this.budgetUsd = opts.budgetUsd;
    this.spent = readLedger(runDir).reduce((s, e) => s + (e.usd ?? 0), 0);
  }

  setStep(step: string): void {
    this.step = step;
    this.stepSpent = 0;
  }

  // Before a paid call: stop if the budget is already spent.
  check(): void {
    if (this.budgetUsd !== undefined && this.spent >= this.budgetUsd) throw new BudgetExceededError(this.spent, this.budgetUsd);
  }

  // priceFactor: batch-mode calls cost half (BATCH_PRICE_FACTOR).
  record(role: string, model: string, response: unknown, opts: { priceFactor?: number } = {}): LedgerEntry | undefined {
    const price = priceFor(model, this.prices);
    const flat = price?.perRequest;
    // A per-request model is recorded whether or not its response reports tokens.
    const usage = extractUsage(response) ?? (flat !== undefined ? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined);
    if (!usage) return undefined;
    if (!price && !this.unpriced.has(model)) {
      this.unpriced.add(model);
      console.error(`[scriptorium] no price for model "${model}" — its tokens are logged but not costed (add it to config.pricing)`);
    }
    const usd = price ? (flat ?? costOf(usage, price)) * (opts.priceFactor ?? 1) : null;
    // Steps can run at once (art and audio): the step is the caller's, not the last one set.
    const step = context.getStore()?.step ?? this.step;
    const entry: LedgerEntry = { ts: new Date().toISOString(), step, role, model, ...usage, usd, ...(opts.priceFactor !== undefined && opts.priceFactor !== 1 ? { batch: true } : {}) };
    appendFileSync(this.file, JSON.stringify(entry) + "\n");
    this.spent += usd ?? 0;
    this.stepSpent += usd ?? 0;
    this.byStep.set(step, (this.byStep.get(step) ?? 0) + (usd ?? 0));
    return entry;
  }

  // What `step` has spent in this session.
  spentIn(step: string): number {
    return this.byStep.get(step) ?? 0;
  }
}

// Steps that run at the same time each carry their own accountant and step
// label through their async work, so spend is attributed to the right step.
const context = new AsyncLocalStorage<{ acc: Accountant; step: string }>();

export function runAccounted<T>(acc: Accountant, step: string, fn: () => Promise<T>): Promise<T> {
  return context.run({ acc, step }, fn);
}

// One accountant per run, shared by every step of it — so steps running at
// once see each other's spend against the budget.
const byFile = new Map<string, Accountant>();
export function accountantFor(runDir: string, opts: { pricing?: Record<string, Price>; budgetUsd?: number } = {}): Accountant {
  const file = join(runDir, LEDGER_FILE);
  let acc = byFile.get(file);
  if (!acc) { acc = new Accountant(runDir, opts); byFile.set(file, acc); }
  return acc;
}

// The accountant postJson reports to; null outside a run (tests, one-off calls).
let current: Accountant | null = null;
export function setAccountant(a: Accountant | null): Accountant | null {
  const previous = current;
  current = a;
  return previous;
}
export function currentAccountant(): Accountant | null {
  return context.getStore()?.acc ?? current;
}

export interface SpendSummary {
  total: number;
  calls: number;
  unpricedCalls: number;
  byStep: Record<string, number>;
  byRole: Record<string, number>;
  byModel: Record<string, { usd: number; calls: number; input: number; output: number }>;
}

export function summarize(entries: LedgerEntry[]): SpendSummary {
  const s: SpendSummary = { total: 0, calls: 0, unpricedCalls: 0, byStep: {}, byRole: {}, byModel: {} };
  for (const e of entries) {
    const usd = e.usd ?? 0;
    s.total += usd;
    s.calls++;
    if (e.usd === null) s.unpricedCalls++;
    s.byStep[e.step] = (s.byStep[e.step] ?? 0) + usd;
    s.byRole[e.role] = (s.byRole[e.role] ?? 0) + usd;
    const m = (s.byModel[e.model] ??= { usd: 0, calls: 0, input: 0, output: 0 });
    m.usd += usd;
    m.calls++;
    m.input += e.input + e.cacheRead + e.cacheWrite;
    m.output += e.output;
  }
  return s;
}

export const usd = (n: number) => `$${n < 0.1 && n > 0 ? n.toFixed(3) : n.toFixed(2)}`;

export function formatSummary(s: SpendSummary, budgetUsd?: number): string {
  const line = (rec: Record<string, number>) => Object.entries(rec).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${usd(v)}`).join(" · ");
  const models = Object.entries(s.byModel).sort((a, b) => b[1].usd - a[1].usd)
    .map(([m, v]) => `  ${m}: ${usd(v.usd)} (${v.calls} calls, ${v.input.toLocaleString()} in / ${v.output.toLocaleString()} out tokens)`);
  return [
    `total ${usd(s.total)}${budgetUsd !== undefined ? ` of ${usd(budgetUsd)} budget` : ""} over ${s.calls} calls${s.unpricedCalls ? ` (${s.unpricedCalls} unpriced)` : ""}`,
    `by step: ${line(s.byStep) || "—"}`,
    `by role: ${line(s.byRole) || "—"}`,
    "by model:",
    ...models
  ].join("\n");
}
