import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { chatBody, makeProvider } from "../src/providers.ts";
import { OpenAIImageBackend, OpenAIInspector, openaiImagePrompt, openaiSize, OPENAI_MAX_REFERENCES } from "../src/openaiArt.ts";
import { INSPECTOR_SYSTEM, makeImageBackend, makeInspector, PORTRAIT_LABEL, referenceKind, toInspection } from "../src/artist.ts";
import { DEFAULT_PRICES, extractUsage, priceFor } from "../src/usage.ts";

// Issue #89: OpenAI as a backend — text roles on its own API, GPT Image as the
// artist, a GPT vision model as the inspector, priced for the spend log.

let server: http.Server;
let base: string;
const requests: Array<{ path?: string; headers: http.IncomingHttpHeaders; body: any }> = [];
const jpeg = Buffer.from("fake-jpeg");

before(async () => {
  process.env.OPENAI_TEST_KEY = "sk-test";
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ path: req.url, headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url?.startsWith("/images/")) res.end(JSON.stringify({ data: [{ b64_json: jpeg.toString("base64") }], usage: { input_tokens: 1200, input_tokens_details: { image_tokens: 1000, text_tokens: 200 }, output_tokens: 4000 } }));
      else res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: '{"accepted":true,"issues":[],"severity":0}' } }], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 } } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

test("text on OpenAI's own API: its key by default, max_completion_tokens, no temperature for reasoning models", async () => {
  const own = chatBody({ type: "openai", model: "gpt-6.1-sol", maxTokens: 8000, noTemperature: true }, "S", "P");
  assert.equal(own.max_completion_tokens, 8000);
  assert.equal(own.max_tokens, undefined);
  assert.equal(own.temperature, undefined);
  const other = chatBody({ type: "openai", model: "llama", baseUrl: "http://localhost:11434/v1", maxTokens: 500 }, "S", "P", 0.3);
  assert.deepEqual([other.max_tokens, other.temperature], [500, 0.3], "other hosts keep max_tokens");
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  await assert.rejects(makeProvider({ type: "openai", model: "gpt-6-luna" }).complete({ role: "director", system: "", prompt: "" }), /OPENAI_API_KEY/);
  if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
});

test("OpenAI's models are priced, and both its usage shapes are read", () => {
  assert.deepEqual(priceFor("gpt-image-2.5-sunburst", DEFAULT_PRICES), { input: 8, output: 30, cacheRead: 2 });
  assert.equal(priceFor("gpt-6.1-sol", DEFAULT_PRICES)?.input, 2);
  assert.equal(priceFor("gpt-6-sol", DEFAULT_PRICES)?.cacheRead, 0.2, "not mistaken for 6.1");
  assert.deepEqual(extractUsage({ usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 100 } } }), { input: 800, output: 40, cacheRead: 100, cacheWrite: 0 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 1200, output_tokens: 4000 } }), { input: 1200, output: 4000, cacheRead: 0, cacheWrite: 0 });
});

test("GPT Image: sizes for our shapes, a prompt that numbers its references, generations without references and edits with up to four", async () => {
  assert.equal(openaiSize("16:9"), "1536x864");
  assert.equal(openaiSize("3:4"), "960x1280");
  assert.equal(openaiSize("16:9", "4K"), "3840x2160");
  for (const s of ["1536x864", "2016x1344", "3840x2160"]) assert.ok(s.split("x").every((d) => Number(d) % 16 === 0 && Number(d) <= 3840));
  const portrait = { data: Buffer.from("p"), mimeType: "image/png", label: PORTRAIT_LABEL };
  assert.match(openaiImagePrompt({ prompt: "A ditch at dawn.", references: [portrait], style: "gouache" }, [portrait]), /ART STYLE[^\n]*gouache\n\nREFERENCE IMAGES, in order:\n1\. Canonical look[\s\S]*Now generate this image:\nA ditch at dawn\./);

  requests.length = 0;
  const backend = makeImageBackend({ type: "openai", model: "gpt-image-2.5-flare", apiKeyEnv: "OPENAI_TEST_KEY", baseUrl: base });
  const plain = await backend.generate({ prompt: "A ditch at dawn.", references: [] });
  assert.deepEqual([plain.mimeType, plain.data.equals(jpeg)], ["image/jpeg", true]);
  assert.equal(requests[0].path, "/images/generations");
  assert.deepEqual([requests[0].body.size, requests[0].body.quality, requests[0].body.output_format, requests[0].body.images], ["1536x864", "high", "jpeg", undefined]);
  assert.equal(requests[0].headers.authorization, "Bearer sk-test");

  let dropped = 0;
  const six = Array.from({ length: 6 }, () => portrait);
  await new OpenAIImageBackend({ type: "openai", model: "gpt-image-2.5-sunburst", apiKeyEnv: "OPENAI_TEST_KEY", baseUrl: base, quality: "medium" }, (n) => { dropped = n; }).generate({ prompt: "Everyone.", references: six, aspectRatio: "2:3" });
  const edit = requests[1];
  assert.equal(edit.path, "/images/edits");
  assert.equal(edit.body.images.length, OPENAI_MAX_REFERENCES);
  assert.match(edit.body.images[0].image_url, /^data:image\/png;base64,/);
  assert.deepEqual([edit.body.size, edit.body.quality, dropped], ["1024x1536", "medium", 2]);
});

test("the GPT vision inspector: the candidate and each labelled reference as images, JSON back, the same verdict shape", async () => {
  requests.length = 0;
  const inspector = makeInspector({ type: "openai", model: "gpt-6.1-sol", apiKeyEnv: "OPENAI_TEST_KEY", baseUrl: base });
  assert.ok(inspector instanceof OpenAIInspector);
  const verdict = await inspector.inspect({ prompt: "A ditch.", image: { data: jpeg, mimeType: "image/jpeg" }, references: [{ data: Buffer.from("p"), mimeType: "image/png", label: PORTRAIT_LABEL }], style: "gouache" });
  assert.deepEqual(verdict, toInspection({ accepted: true, issues: [], severity: 0 }));
  const body = requests[0].body;
  assert.equal(requests[0].path, "/chat/completions");
  assert.equal(body.messages[0].content, INSPECTOR_SYSTEM);
  assert.deepEqual(body.response_format, { type: "json_object" });
  const parts = body.messages[1].content as Array<{ type: string; text?: string }>;
  assert.deepEqual(parts.map((p) => p.type), ["text", "text", "text", "image_url", "text", "image_url"]);
  assert.equal(parts[4].text, `REFERENCE IMAGE — ${referenceKind({ data: Buffer.from(""), mimeType: "", label: PORTRAIT_LABEL })}:`);
});
