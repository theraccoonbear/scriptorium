import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { BACKOFF_CAP_MS, backoffDelay, OVERLOAD_RETRIES, postJson, RETRY_AFTER_CAP_MS } from "../src/providers.ts";

// Issue #126: retries back off exponentially with jitter, honour Retry-After,
// and an overloaded service (429/503) gets more tries.

test("the delay doubles per retry, with jitter, up to a cap", () => {
  const mid = () => 0.5;  // jitter factor 1.0
  assert.deepEqual([0, 1, 2, 3, 4].map((r) => backoffDelay(r, undefined, { random: mid })), [1000, 2000, 4000, 8000, 16000]);
  assert.equal(backoffDelay(10, undefined, { random: mid }), BACKOFF_CAP_MS);
  assert.equal(backoffDelay(0, undefined, { random: () => 0 }), 500, "jitter: as little as half");
  assert.equal(backoffDelay(0, undefined, { random: () => 0.999 }), 1499, "and up to half again");
});

test("a server's Retry-After wins: seconds or an HTTP date, capped", () => {
  assert.equal(backoffDelay(0, "7"), 7000);
  assert.equal(backoffDelay(0, "3600"), RETRY_AFTER_CAP_MS);
  assert.equal(backoffDelay(0, new Date(1_000_000 + 12_000).toUTCString(), { now: 1_000_000 }), 12000);
  assert.equal(backoffDelay(1, "soon", { random: () => 0.5 }), 2000, "unreadable: the usual backoff");
});

async function server(statuses: number[]) {
  const hits: number[] = [];
  const srv = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const status = statuses[hits.length] ?? 200;
      hits.push(status);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(status === 200 ? JSON.stringify({ ok: true }) : JSON.stringify({ error: "busy" }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/`, hits, close: () => srv.close() };
}

test("an overloaded service (503) is tried again past the caller's usual retry count, and gets through", async () => {
  const s = await server([503, 503, 503]);
  try {
    const out = await postJson(s.url, {}, { model: "m" }, { type: "gemini", retries: 1, backoffBaseMs: 1 });
    assert.deepEqual(out, { ok: true });
    assert.deepEqual(s.hits, [503, 503, 503, 200]);
  } finally { s.close(); }
});

test("it still gives up: an overload that doesn't clear, and other errors after the usual count", async () => {
  const busy = await server(Array(10).fill(503));
  try {
    await assert.rejects(postJson(busy.url, {}, {}, { type: "gemini", retries: 1, backoffBaseMs: 1 }), /HTTP 503/);
    assert.equal(busy.hits.length, OVERLOAD_RETRIES + 1);
  } finally { busy.close(); }
  const broken = await server([500, 500, 500]);
  try {
    await assert.rejects(postJson(broken.url, {}, {}, { type: "gemini", retries: 1, backoffBaseMs: 1 }), /HTTP 500/);
    assert.equal(broken.hits.length, 2, "a plain 5xx: the caller's count");
  } finally { broken.close(); }
  const bad = await server([400]);
  try {
    await assert.rejects(postJson(bad.url, {}, {}, { type: "gemini", retries: 3, backoffBaseMs: 1 }), /HTTP 400/);
    assert.equal(bad.hits.length, 1, "a 4xx isn't retried");
  } finally { bad.close(); }
});
