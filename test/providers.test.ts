import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { makeProvider, listModels, stripThinking, OutputLimitError } from "../src/providers.ts";
import { parseJson } from "../src/roles.ts";

// A fake OpenCode Go server. Records every request and answers per path.
let server: http.Server;
let base: string;
let requests: Array<{ method?: string; path?: string; headers: http.IncomingHttpHeaders; body: any }>;
let failuresLeft = 0;
let atLimit = false;  // answer as if the model hit its output limit mid-reply

before(async () => {
  process.env.FAKE_KEY = "sk-test";
  requests = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, path: req.url, headers: req.headers, body });
      const send = (status: number, obj: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const url = req.url || "";
      if (failuresLeft > 0 && url.endsWith("/chat/completions")) {
        failuresLeft -= 1;
        send(503, { error: "busy" });
        return;
      }
      if (url.endsWith("/chat/completions")) {
        send(200, {
          choices: [
            {
              finish_reason: atLimit ? "length" : "stop",
              message: { content: '<think>plan {"ok":false}</think>\n```json\n{"ok":true,"issues":[]}\n```' }
            }
          ]
        });
      } else if (url.endsWith("/messages")) {
        send(200, {
          stop_reason: atLimit ? "max_tokens" : "end_turn",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: '{"ok":true,"issues":[]}' }
          ]
        });
      } else if (url.endsWith("/responses")) {
        send(200, {
          status: atLimit ? "incomplete" : "completed",
          ...(atLimit ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
          output: [{ type: "message", content: [{ type: "output_text", text: "resp text" }] }]
        });
      } else if (url.endsWith("/models")) {
        send(200, { data: [{ id: "kimi-k3" }, { id: "glm-5.3-flash" }] });
      } else {
        send(404, { error: "nope" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("server did not bind a port");
  base = `http://127.0.0.1:${addr.port}/zen/go/v1`;
});

after(() => {
  server.close();
});

const req = { role: "critic", system: "SYS", prompt: "PROMPT", temperature: 0.2 };

test("stripThinking handles closed, unclosed and orphan tags", () => {
  assert.equal(stripThinking("<think>a</think>hello"), "hello");
  assert.equal(stripThinking("hello<think>trailing"), "hello");
  assert.equal(stripThinking("reasoning...</think>answer"), "answer");
});

test("opencode-go chat: path, auth, body, think stripping, JSON parse", async () => {
  requests.length = 0;
  const p = makeProvider({ type: "opencode-go", api: "chat", model: "kimi-k3", baseUrl: base, apiKeyEnv: "FAKE_KEY", maxTokens: 512 });
  const out = await p.complete(req);
  assert.deepEqual(parseJson(out), { ok: true, issues: [] });
  const r = requests[0];
  assert.equal(r.path, "/zen/go/v1/chat/completions");
  assert.equal(r.headers.authorization, "Bearer sk-test");
  assert.ok(r.headers["x-opencode-session"], "session header present");
  assert.ok(r.headers["user-agent"], "user-agent present");
  assert.equal(r.body.model, "kimi-k3");
  assert.equal(r.body.max_tokens, 512);
  assert.equal(r.body.temperature, 0.2);
  assert.equal(r.body.messages[0].role, "system");
});

test("opencode-go messages: sends both auth headers, drops thinking blocks", async () => {
  requests.length = 0;
  const p = makeProvider({ type: "opencode-go", api: "messages", model: "minimax-m3", baseUrl: base, apiKeyEnv: "FAKE_KEY" });
  const out = await p.complete(req);
  assert.equal(out, '{"ok":true,"issues":[]}');
  const r = requests[0];
  assert.equal(r.path, "/zen/go/v1/messages");
  assert.equal(r.headers["x-api-key"], "sk-test");
  assert.equal(r.headers.authorization, "Bearer sk-test");
  assert.ok(r.headers["x-opencode-session"], "session header present");
  assert.ok(r.headers["user-agent"], "user-agent present");
  assert.equal(r.body.system, "SYS");
  assert.equal(r.body.messages[0].content, "PROMPT");
});

test("opencode-go responses: instructions/input and output parsing", async () => {
  requests.length = 0;
  const p = makeProvider({ type: "opencode-go", api: "responses", model: "grok-4.7", baseUrl: base, apiKeyEnv: "FAKE_KEY", noTemperature: true });
  assert.equal(await p.complete(req), "resp text");
  const r = requests[0];
  assert.equal(r.path, "/zen/go/v1/responses");
  assert.ok(r.headers["x-opencode-session"], "session header present");
  assert.ok(r.headers["user-agent"], "user-agent present");
  assert.equal(r.body.instructions, "SYS");
  assert.equal(r.body.input, "PROMPT");
  assert.equal("temperature" in r.body, false);
});

test("retries on 503 then succeeds", async () => {
  requests.length = 0;
  failuresLeft = 1;
  const p = makeProvider({ type: "opencode-go", model: "kimi-k3", baseUrl: base, apiKeyEnv: "FAKE_KEY" });
  const out = await p.complete(req);
  assert.ok(out.includes('"ok":true'));
  assert.equal(requests.length, 2);
});

test("missing API key fails clearly", async () => {
  const p = makeProvider({ type: "opencode-go", model: "kimi-k3", baseUrl: base, apiKeyEnv: "NOPE_NOT_SET" });
  await assert.rejects(() => p.complete(req), /Missing environment variable NOPE_NOT_SET/);
});

test("listModels returns ids", async () => {
  const ids = await listModels({ type: "opencode-go", baseUrl: base, apiKeyEnv: "FAKE_KEY" });
  assert.deepEqual(ids, ["kimi-k3", "glm-5.3-flash"]);
});

test("a reply that stopped at the output limit fails clearly on every wire format, carrying the partial text", async () => {
  atLimit = true;
  try {
    for (const api of ["chat", "messages", "responses"] as const) {
      const p = makeProvider({ type: "opencode-go", api, model: "m", baseUrl: base, apiKeyEnv: "FAKE_KEY", maxTokens: 4096 });
      await assert.rejects(p.complete(req), (err: unknown) => {
        assert.ok(err instanceof OutputLimitError, `${api}: ${String(err)}`);
        assert.match(err.message, /stopped at its output limit \(maxTokens 4096\)/);
        assert.ok(err.partial.length > 0);
        return true;
      });
    }
  } finally {
    atLimit = false;
  }
});

test("author direction reaches only its own layer, matched by the call's role label", async () => {
  const { withDirection, checkDirection } = await import("../src/providers.ts");
  const seen: Array<[string, string]> = [];
  const inner = { complete: async (r: { role: string; prompt: string }) => { seen.push([r.role, r.prompt]); return "ok"; } };
  const p = withDirection(inner, { creator: "Make it a heist.", artdirector: "Cinematic, photorealistic." });
  await p.complete({ role: "creator", system: "S", prompt: "P" });
  await p.complete({ role: "director", system: "S", prompt: "P" });
  await p.complete({ role: "artdirector", system: "S", prompt: "P" });
  assert.equal(seen[0][1], "P\n\nAUTHOR DIRECTION for the creator (follow it; it overrides your defaults):\nMake it a heist.");
  assert.equal(seen[1][1], "P", "the director shares the model but gets no creator notes");
  assert.ok(seen[2][1].endsWith("Cinematic, photorealistic."));
  assert.throws(() => checkDirection({ artdirectr: "x" }), /unknown layer "artdirectr"/);
  checkDirection({ artist: "x", writer: "y" });
});
