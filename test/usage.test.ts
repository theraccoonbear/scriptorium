import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accountant, BudgetExceededError, costOf, DEFAULT_PRICES, extractUsage, formatSummary, priceFor, readLedger, summarize } from "../src/usage.ts";

test("prices match exact ids or the longest prefix (dated model ids)", () => {
  assert.deepEqual(priceFor("claude-haiku-4-5-20251001", DEFAULT_PRICES), DEFAULT_PRICES["claude-haiku-4-5"]);
  assert.deepEqual(priceFor("gemini-3.8-flash-tts", DEFAULT_PRICES), DEFAULT_PRICES["gemini-3.8-flash-tts"], "not the shorter gemini-3.8-flash");
  assert.equal(priceFor("deepseek-v4-flash", DEFAULT_PRICES), undefined);
});

test("usage is read from every provider's response shape", () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 400, cache_creation_input_tokens: 10 } }),
    { input: 100, output: 50, cacheRead: 400, cacheWrite: 10 }, "Anthropic");
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 120, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 20 } } }),
    { input: 100, output: 30, cacheRead: 20, cacheWrite: 0 }, "OpenAI-compatible chat");
  assert.deepEqual(extractUsage({ usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 1120, thoughtsTokenCount: 8 } }),
    { input: 12, output: 1128, cacheRead: 0, cacheWrite: 0 }, "Gemini (image output + thinking)");
  assert.deepEqual(extractUsage({ usage: { input_tokens: 90, output_tokens: 9, input_tokens_details: { cached_tokens: 40 } } }),
    { input: 50, output: 9, cacheRead: 40, cacheWrite: 0 }, "OpenAI Responses");
  assert.equal(extractUsage({ choices: [] }), undefined);
});

test("cost = tokens × per-million prices, cache priced separately", () => {
  const haiku = DEFAULT_PRICES["claude-haiku-4-5"];
  assert.equal(costOf({ input: 1_000_000, output: 200_000, cacheRead: 1_000_000, cacheWrite: 0 }, haiku), 1 + 1 + 0.1);
  // One Gemini image (~1120 output tokens at $60/M) ≈ $0.067, matching Google's per-image price.
  assert.equal(Math.round(costOf({ input: 0, output: 1120, cacheRead: 0, cacheWrite: 0 }, DEFAULT_PRICES["gemini-3.1-flash-image"]) * 1000) / 1000, 0.067);
});

test("the ledger spans sessions, the budget stops further calls, unpriced models are logged", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-usage-"));
  const a = new Accountant(runDir, { budgetUsd: 0.5 });
  a.setStep("story");
  a.record("writer", "claude-haiku-4-5-20251001", { usage: { input_tokens: 100_000, output_tokens: 20_000 } });  // $0.20
  a.record("writer", "deepseek-v4-flash", { usage: { prompt_tokens: 10, completion_tokens: 5 } });
  assert.equal(Math.round(a.spent * 100) / 100, 0.2);
  a.check();
  // A new session (resume) starts from what the ledger already holds.
  const b = new Accountant(runDir, { budgetUsd: 0.5 });
  assert.equal(Math.round(b.spent * 100) / 100, 0.2);
  b.setStep("art");
  b.record("artist", "gemini-3.1-flash-image", { usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 5_000 } });  // $0.30
  assert.throws(() => b.check(), (e: unknown) => e instanceof BudgetExceededError && /budget \$0\.50 reached \(\$0\.50 spent\)/.test((e as Error).message));
  const s = summarize(readLedger(runDir));
  assert.equal(s.calls, 3);
  assert.equal(s.unpricedCalls, 1);
  assert.deepEqual(Object.keys(s.byStep).sort(), ["art", "story"]);
  assert.match(formatSummary(s, 0.5), /^total \$0\.50 of \$0\.50 budget over 3 calls \(1 unpriced\)/);
});
