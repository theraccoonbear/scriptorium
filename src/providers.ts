import { mulberry32 } from "./rng.ts";
import { randomUUID } from "node:crypto";
import https from "node:https";
import http from "node:http";
import { c } from "./colors.ts";
import { currentAccountant } from "./usage.ts";
import type { CompletionRequest, Provider, ProviderSpec, Role, Roles, StoryConfig } from "./types.ts";

const httpsAgent = new https.Agent({ keepAlive: true });
const httpAgent = new http.Agent({ keepAlive: true });

// Every provider implements: complete({ role, system, prompt, ctx, temperature }) -> string
// `ctx` is structured data for offline/mock use. Real providers ignore it.

const OPENCODE_GO_BASE = "https://opencode.ai/zen/go/v1";
const SCRIPTORIUM_UA = "scriptorium/0.1.0";

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = (s % 60).toFixed(1);
  return `${m}m ${rem}s`;
}

// Open reasoning models often emit <think> blocks. Roles expect clean output.
export function stripThinking(text: unknown): string {
  let out = String(text ?? "");
  out = out.replace(/<think>[\s\S]*?<\/think>/gi, "");
  if (/<\/think>/i.test(out) && !/<think>/i.test(out)) {
    out = out.slice(out.toLowerCase().lastIndexOf("</think>") + "</think>".length);
  }
  out = out.replace(/<think>[\s\S]*$/i, "");
  return out.trim();
}

// Loose structured ctx handed to providers; mock uses it, real providers ignore it.
type MockCtx = Record<string, any>;

interface MockVerdict {
  ok: boolean;
  issues: Array<string | Record<string, unknown>>;
}

export class MockProvider {
  spec: ProviderSpec;
  calls: string[] = [];

  constructor(spec: ProviderSpec = { type: "mock" }) {
    this.spec = spec;
  }

  async complete(req: CompletionRequest): Promise<string> {
    this.calls.push(req.role);
    const ctx: MockCtx = req.ctx || {};
    if (this.spec.failRoles?.includes(req.role)) {
      throw new Error(`mock: ${req.role} failure`);
    }
    switch (req.role) {
      case "worldbuilder":
        return JSON.stringify(this.buildWorld(ctx));
      case "creator":
        return JSON.stringify(this.create(ctx));
      case "director":
        return JSON.stringify(this.direct(ctx));
      case "writer":
        return this.write(ctx);
      case "continuist":
        return JSON.stringify(this.critique(ctx));
      case "critic":
        return JSON.stringify({ ok: true, issues: [], review: "Mock review: looks good." });
      case "editor":
        return ctx.prose ?? "";
      case "voicedirector": {
        if (ctx.task === "cast") {
          // Each character takes the next unused library voice, in order.
          const lib: string[] = ctx.libraryIds ?? [];
          const ids: string[] = ctx.characterIds ?? [];
          return JSON.stringify({ narrator: ctx.narrator ? lib[0] : null, characters: Object.fromEntries(ids.map((id, i) => [id, lib[i + 1]])), reasons: {} });
        }
        if (ctx.task === "palette") {
          // Two tones for every cast member.
          const ids: string[] = ctx.castIds ?? [];
          return JSON.stringify({ palettes: Object.fromEntries([["narrator", ["even", "hushed"].slice(0, ctx.size ?? 2)], ...ids.map((id) => [id, ["plain", "intense"].slice(0, ctx.size ?? 2)])]) });
        }
        // A paragraph with a quotation is the first cast member's; the rest is narration.
        const castIds: string[] = ctx.castIds ?? [];
        return JSON.stringify({ paragraphs: (ctx.paragraphs ?? []).map((p: string, n: number) => ({ n: n + 1, speaker: p.includes('"') && castIds[0] ? castIds[0] : "narrator", delivery: "" })), newSpeakers: [] });
      }
      case "musicdirector":
        // A plain chamber cue for every scene.
        return JSON.stringify({ style: "Chamber strings and felt piano", theme: "Solo cello motif, 60 BPM, D minor", scenes: (ctx.scenes ?? []).map((n: number) => ({ scene: n, music: "Sparse low strings, 60 BPM, D minor" })) });
      case "archivist":
        return JSON.stringify(this.archive(ctx));
      case "beatgate":
        return JSON.stringify({ ok: true, issues: [] });
      case "patchgate":
        return JSON.stringify({ ok: true, issues: [] });
      case "worldgate":
        return JSON.stringify({ ok: true, issues: [] });
      case "contextgate":
        return JSON.stringify({ ok: true, issues: [] });
      case "artdirector": {
        if (ctx.mode === "references") {
          const ref = (id: string) => ({ id, appearance: `Mock look for ${id}.`, prompt: `Mock reference image of ${id}.` });
          return JSON.stringify({
            ...(ctx.artStyle ? {} : { art_style: "Mock woodcut style." }),
            characters: (ctx.characterIds ?? []).map(ref),
            locations: (ctx.locationIds ?? []).map(ref),
            // Canon objects, plus one discovered key prop the first time.
            props: [
              ...(ctx.objectIds ?? []).map((id: string) => ({ ...ref(id), name: id })),
              ...((ctx.propIds ?? []).length === 0 ? [{ ...ref("mock_prop"), name: "mock prop" }] : [])
            ]
          });
        }
        if (ctx.mode === "cover") {
          return JSON.stringify({ prompt: `Mock cover montage of ${ctx.beats?.length ?? 0} scenes.` });
        }
        // Evenly spaced 1-based starts across the scene's paragraphs.
        const count = Math.max(1, ctx.paragraphCount ?? 1);
        const n = Math.max(1, Math.min(ctx.shots ?? 1, count));
        const shots = Array.from({ length: n }, (_, k) => ({
          start_paragraph: Math.floor((k * count) / n) + 1,
          prompt: `Mock shot ${k + 1} of scene ${(ctx.sceneIndex ?? 0) + 1} at ${ctx.beat?.location ?? "an unknown place"}.`,
          characters: (ctx.knownIds ?? []).slice(0, 1),
          location: (ctx.locationIdsKnown ?? [])[0] ?? "",
          props: (ctx.propIds ?? []).slice(0, 1)
        }));
        return JSON.stringify({ shots });
      }
      default:
        return "";
    }
  }

  buildWorld(_ctx: MockCtx) {
    return {
      characters: [
        { name: "Ada Lark", archetype: "meticulous lighthouse keeper" },
        { name: "Jonas Wren", archetype: "calm stranger who shouldn't know her name" }
      ],
      locations: [
        { name: "The Lighthouse", archetype: "isolated coastal tower" },
        { name: "Harbour Road", archetype: "rocky, tide-worn path to shore" }
      ],
      setting_notes: "A lone lighthouse on a coast where the fog never lifts and letters arrive from people who shouldn't exist."
    };
  }

  create(ctx: MockCtx) {
    // A slow burn: the author's pins where given, else rising to the second-last scene.
    const total: number = ctx.total ?? 3;
    const arc = Array.from({ length: total }, (_, i) => ctx.arc?.[i] ?? Math.min(9, 3 + 2 * i));
    return {
      arc,
      premise: "A lone lighthouse keeper receives a letter from someone who shouldn't know they exist.",
      tone: "Quiet, uncanny, with dry humor.",
      art_style: "Muted ink and watercolor illustration, grey-green palette, soft diffuse light.",
      characters: [
        { id: "keeper", name: "Ada", traits: "methodical, sleep-deprived", goal: "Figure out who sent the letter", voice: "Clipped sentences. Nautical terms.", gender: "female" },
        { id: "voice", name: "The Voice", traits: "calm, precise", goal: "Be heard", voice: "Formal, slightly out of time.", gender: "" }
      ],
      locations: [
        { id: "tower", name: "The lighthouse", description: "Lantern room, spiral stairs, salt on every surface." },
        { id: "shore", name: "The shore", description: "Rocks, seaweed, a path worn by no one." }
      ],
      objects: [
        { id: "letter", name: "The letter", description: "A single folded sheet, palm-sized, cream paper gone soft with damp, sealed with grey wax.", owner: "keeper" }
      ],
      threads: [
        { id: "letter-origin", title: "Who sent the letter", status: "open" }
      ],
      beat: {
        turn: ctx.turn ?? "The letter is in Ada's own handwriting.",
        goal: "Ada finds the letter and must decide whether to answer it.",
        conflict: "The letter is addressed to her by name, but she told no one she was coming here.",
        pov: "keeper",
        location: "tower",
        mustReveal: "The letter is written in Ada's own handwriting.",
        constraints: ["Keep tension at 3: unease, not horror", "Ada's POV uses clipped sentences", "Do not resolve letter-origin"],
        payoffs: []
      }
    };
  }

  direct(ctx: MockCtx) {
    const ids = Object.keys(ctx.bible.characters);
    const pov = ids[ctx.sceneIndex % ids.length];
    const locs = Object.keys(ctx.bible.locations);
    const location = locs.length ? locs[ctx.sceneIndex % locs.length] : "loc-0";
    return {
      turn: ctx.turn ?? `Scene ${ctx.sceneIndex + 1}: something about ${pov} changes`,
      goal: `Advance the story at tension ${ctx.tension}`,
      conflict: `Pressure on ${pov}`,
      pov,
      location,
      mustReveal: `A detail about ${pov}`,
      constraints: ["stay in POV", "keep tone consistent"],
      payoffs: ctx.overdue.map((s: { id: string }) => s.id)
    };
  }

  write(ctx: MockCtx) {
    const rng = mulberry32(ctx.sceneIndex * 31 + ctx.attempt);
    const pov = ctx.bible.characters[ctx.beat.pov];
    const name = pov ? pov.name : ctx.beat.pov;
    const mood = ["quiet", "tense", "frantic", "hollow"][Math.floor(rng() * 4)];
    return `Scene ${ctx.sceneIndex + 1} (${mood}). ${name} faces this: ${ctx.beat.conflict} Goal: ${ctx.beat.goal}.`;
  }

  critique(ctx: MockCtx): MockVerdict {
    const rejects = this.spec.rejectFirstOn || [];
    if (rejects.includes(ctx.sceneIndex) && ctx.attempt === 0) {
      return { ok: false, issues: ["mock: tighten continuity with the bible"] };
    }
    if (!ctx.prose || ctx.prose.length < 10) {
      return { ok: false, issues: ["prose too short"] };
    }
    return { ok: true, issues: [] };
  }

  archive(ctx: MockCtx) {
    const beat = ctx.beat;
    const patch = {
      upsertLocations: [{ id: beat.location, name: beat.location, description: `Seen in scene ${ctx.sceneIndex + 1}` }],
      upsertCharacters: [{ id: beat.pov, status: "active" }],
      openSetups: [] as { id: string; text: string }[],
      paySetups: (beat.payoffs || []) as string[],
      timeline: `${beat.pov} at ${beat.location}: ${beat.conflict}`
    };
    if (!ctx.isFinal) {
      patch.openSetups.push({ id: `setup-${ctx.sceneIndex + 1}`, text: `Consequence of: ${beat.conflict}` });
    }
    return patch;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface HttpResult {
  status: number;
  data: string;
}

function requestJson(
  url: string,
  headers: Record<string, string | undefined>,
  body: string | null,
  timeoutMs: number
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const opts = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: body ? "POST" : "GET",
      headers: { ...headers, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) },
      timeout: timeoutMs,
      agent: isHttps ? httpsAgent : httpAgent
    };
    const req = (isHttps ? https : http).request(opts, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        const hdrs = res.headers;
        const rateInfo: string[] = [];
        for (const k of ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "retry-after", "x-ratelimit-used"]) {
          if (hdrs[k] !== undefined) rateInfo.push(`${k}=${hdrs[k]}`);
        }
        if (rateInfo.length) console.error(`[scriptorium]   headers: ${rateInfo.join(", ")}`);
        resolve({ status: res.statusCode ?? 0, data });
      });
    });
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// POST with timeout and retry on network errors, 429 and 5xx.
// Timeout scales 1.5x per retry attempt.
export async function postJson(url: string, headers: Record<string, string | undefined>, body: unknown, spec: ProviderSpec & { role?: string } = { type: "" }): Promise<any> {
  const attempts = (spec.retries ?? 1) + 1;
  const bodyStr = JSON.stringify(body);
  const allHeaders: Record<string, string | undefined> = { "user-agent": SCRIPTORIUM_UA, ...headers };
  let lastErr: unknown;
  const timeout = spec.timeoutMs ?? 180000;
  const model = (body as { model?: string } | null)?.model || spec.model || "?";
  const role = spec?.role || "?";
  const promptKB = (bodyStr.length / 1024).toFixed(1);
  const tag = c.label(role, model);
  // Spend accounting: refuse the call if the run's budget is spent.
  currentAccountant()?.check();
  console.error(`[scriptorium]   ${tag} ${c.dim("start")} (prompt=${c.yellow(promptKB + "KB")}, timeout=${c.yellow(formatDuration(timeout))})`);
  const t0 = Date.now();
  for (let i = 0; i < attempts; i++) {
    let result: HttpResult | null = null;
    const attemptStart = Date.now();
    try {
      result = await requestJson(url, allHeaders, bodyStr, timeout);
    } catch (err) {
      lastErr = err;
      const waited = formatDuration(Date.now() - attemptStart);
      console.error(`[scriptorium]     ${c.fail(`(${i + 1}/${attempts}) ${err instanceof Error ? err.message : String(err)} after ${waited}`)}`);
    }
    if (result && result.status >= 200 && result.status < 300) {
      const respKB = (result.data.length / 1024).toFixed(1);
      const elapsed = formatDuration(Date.now() - t0);
      console.error(`[scriptorium]   ${tag} ${c.got(`${respKB}KB, ${elapsed}`)}`);
      const data = JSON.parse(result.data);
      currentAccountant()?.record(role, model, data);
      return data;
    }
    if (result) {
      lastErr = new Error(`HTTP ${result.status} from ${url}: ${result.data.slice(0, 300)}`);
      console.error(`[scriptorium]     ${c.fail(`(${i + 1}/${attempts}) HTTP ${result.status}: ${result.data.slice(0, 200)}`)}`);
      if (result.status !== 429 && result.status < 500) {
        throw lastErr;
      }
    }
    if (i < attempts - 1) {
      console.error(`[scriptorium]   ${tag} ${c.retry(`(${i + 2}/${attempts})`)}`);
      await sleep(500);
    }
  }
  console.error(`[scriptorium]   ${tag} ${c.fail(`failed after ${attempts} attempts`)}`);
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export function requireKey(envName: string): string {
  const key = process.env[envName];
  if (!key) {
    throw new Error(`Missing environment variable ${envName}`);
  }
  return key;
}

// The model hit the provider's output limit (maxTokens) and stopped mid-reply,
// as the API reports via stop_reason / finish_reason / status. Nothing on our
// side shortened anything. Carries the partial text: a JSON caller can't use it
// (and re-asking hits the same limit), but a prose draft may still be usable.
export class OutputLimitError extends Error {
  partial: string;
  constructor(spec: ProviderSpec, partial: string) {
    super(`${spec.model} stopped at its output limit (maxTokens ${spec.maxTokens ?? "default"}) after ${(partial.length / 1024).toFixed(1)}KB, mid-reply — raise maxTokens for this provider`);
    this.name = "OutputLimitError";
    this.partial = partial;
  }
}

function checkOutputLimit(hitLimit: boolean, text: unknown, spec: ProviderSpec): void {
  if (hitLimit) throw new OutputLimitError(spec, stripThinking(text));
}

function nonEmpty(text: unknown, spec: ProviderSpec, detail: string): string {
  const out = stripThinking(text);
  if (!out) {
    throw new Error(`Empty completion from ${spec.model} (${detail}). Reasoning models may need a higher maxTokens.`);
  }
  return out;
}

// OpenAI chat completions. Also Ollama, llama.cpp, vLLM, OpenRouter, OpenCode Go "chat" models.
export class OpenAICompatProvider implements Provider {
  spec: ProviderSpec;
  sessionId: string | null;

  constructor(spec: ProviderSpec) {
    this.spec = spec;
    this.sessionId = spec.sessionId || null;
  }

  async complete({ role, system, prompt, temperature, timeoutMs }: CompletionRequest): Promise<string> {
    const headers: Record<string, string> = {};
    if (this.spec.apiKeyEnv) {
      headers.authorization = `Bearer ${requireKey(this.spec.apiKeyEnv)}`;
    }
    if (this.sessionId) {
      headers["x-opencode-session"] = this.sessionId;
    }
    const base = this.spec.baseUrl || "https://api.openai.com/v1";
    const body: Record<string, any> = {
      model: this.spec.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt }
      ],
      ...(this.spec.extraBody || {})
    };
    const temp = temperature ?? this.spec.temperature ?? 0.8;
    if (!this.spec.noTemperature) {
      body.temperature = temp;
    }
    if (this.spec.maxTokens) {
      body.max_tokens = this.spec.maxTokens;
    }
    const data = await postJson(`${base}/chat/completions`, headers, body, { ...this.spec, role, timeoutMs: timeoutMs ?? this.spec.timeoutMs });
    const choice = data.choices && data.choices[0];
    const msg = choice && choice.message || {};
    let content = msg.content;
    if (content == null || content === "") {
      content = msg.reasoning || "";
    }
    if (Array.isArray(content)) {
      content = content.map((p) => p.text || "").join("");
    }
    checkOutputLimit(choice?.finish_reason === "length", content, this.spec);
    return nonEmpty(content, this.spec, `finish_reason ${choice ? choice.finish_reason : "none"}`);
  }
}

// Anthropic Messages format. Also OpenCode Go "messages" models (MiniMax, Qwen).
export class AnthropicProvider implements Provider {
  spec: ProviderSpec;
  sessionId: string | null;

  constructor(spec: ProviderSpec) {
    this.spec = spec;
    this.sessionId = spec.sessionId || null;
  }

  async complete({ role, system, prompt, temperature, timeoutMs }: CompletionRequest): Promise<string> {
    const key = requireKey(this.spec.apiKeyEnv || "ANTHROPIC_API_KEY");
    const style = this.spec.authStyle || "x-api-key";
    const headers: Record<string, string> = { "anthropic-version": "2023-06-01" };
    if (this.sessionId) {
      headers["x-opencode-session"] = this.sessionId;
    }
    if (style === "x-api-key" || style === "both") {
      headers["x-api-key"] = key;
    }
    if (style === "bearer" || style === "both") {
      headers.authorization = `Bearer ${key}`;
    }
    const body: Record<string, any> = {
      model: this.spec.model,
      max_tokens: this.spec.maxTokens || 4096,
      system,
      messages: [{ role: "user", content: prompt }],
      ...(this.spec.extraBody || {})
    };
    if (!this.spec.noTemperature) {
      body.temperature = temperature ?? this.spec.temperature ?? 0.8;
    }
    const data = await postJson(this.spec.baseUrl || "https://api.anthropic.com/v1/messages", headers, body, { ...this.spec, role, timeoutMs: timeoutMs ?? this.spec.timeoutMs });
    const text = (data.content || []).filter((b: { type?: string; text?: string }) => b.type === "text").map((b: { text?: string }) => b.text || "").join("");
    checkOutputLimit(data.stop_reason === "max_tokens", text, this.spec);
    return nonEmpty(text, this.spec, `stop_reason ${data.stop_reason}`);
  }
}

// OpenAI Responses format. OpenCode Go serves some models (Grok, Muse) only this way.
export class ResponsesProvider implements Provider {
  spec: ProviderSpec;
  sessionId: string | null;

  constructor(spec: ProviderSpec) {
    this.spec = spec;
    this.sessionId = spec.sessionId || null;
  }

  async complete({ role, system, prompt, temperature, timeoutMs }: CompletionRequest): Promise<string> {
    const headers: Record<string, string> = { authorization: `Bearer ${requireKey(this.spec.apiKeyEnv || "OPENAI_API_KEY")}` };
    if (this.sessionId) {
      headers["x-opencode-session"] = this.sessionId;
    }
    const base = this.spec.baseUrl || "https://api.openai.com/v1";
    const body: Record<string, any> = {
      model: this.spec.model,
      instructions: system,
      input: prompt,
      ...(this.spec.extraBody || {})
    };
    if (!this.spec.noTemperature) {
      body.temperature = temperature ?? this.spec.temperature ?? 0.8;
    }
    if (this.spec.maxTokens) {
      body.max_output_tokens = this.spec.maxTokens;
    }
    const data = await postJson(`${base}/responses`, headers, body, { ...this.spec, role, timeoutMs: timeoutMs ?? this.spec.timeoutMs });
    let text = data.output_text;
    if (typeof text !== "string") {
      text = (data.output || [])
        .flatMap((item: { content?: unknown[] }) => (item.content || []) as unknown[])
        .filter((c: { type?: string }) => c.type === "output_text")
        .map((c: { text?: string }) => c.text || "")
        .join("");
    }
    checkOutputLimit(data.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens", text, this.spec);
    return nonEmpty(text, this.spec, `status ${data.status}`);
  }
}

// One entry for the whole OpenCode Go grab bag. `api` picks the wire format for the model:
// "chat" (default), "messages" or "responses". Key comes from OPENCODE_API_KEY unless overridden.
function makeOpenCodeGo(spec: ProviderSpec): Provider {
  const base = spec.baseUrl || OPENCODE_GO_BASE;
  const apiKeyEnv = spec.apiKeyEnv || "OPENCODE_API_KEY";
  const sessionId = spec.sessionId || randomUUID();
  switch (spec.api || "chat") {
    case "chat":
      return new OpenAICompatProvider({ ...spec, baseUrl: base, apiKeyEnv, sessionId });
    case "messages":
      return new AnthropicProvider({ ...spec, baseUrl: `${base}/messages`, apiKeyEnv, authStyle: spec.authStyle || "both", sessionId });
    case "responses":
      return new ResponsesProvider({ ...spec, baseUrl: base, apiKeyEnv, sessionId });
    default:
      throw new Error(`Unknown opencode-go api "${spec.api}" (use chat, messages or responses)`);
  }
}

export function makeProvider(spec: ProviderSpec): Provider {
  switch (spec.type) {
    case "mock":
      return new MockProvider(spec);
    case "openai":
      return new OpenAICompatProvider(spec);
    case "anthropic":
      return new AnthropicProvider(spec);
    case "responses":
      return new ResponsesProvider(spec);
    case "opencode-go":
      return makeOpenCodeGo(spec);
    default:
      throw new Error(`Unknown provider type: ${spec.type}`);
  }
}

// GET {base}/models for providers that expose it. Returns model ids.
export async function listModels(spec: ProviderSpec): Promise<string[]> {
  let base = spec.baseUrl;
  let apiKeyEnv = spec.apiKeyEnv;
  if (spec.type === "opencode-go") {
    base = base || OPENCODE_GO_BASE;
    apiKeyEnv = apiKeyEnv || "OPENCODE_API_KEY";
  } else if (spec.type === "openai") {
    base = base || "https://api.openai.com/v1";
  } else {
    throw new Error(`Provider type ${spec.type} has no model listing`);
  }
  const headers: Record<string, string> = { "user-agent": SCRIPTORIUM_UA };
  if (apiKeyEnv) {
    headers.authorization = `Bearer ${requireKey(apiKeyEnv)}`;
  }
  const result = await requestJson(`${base}/models`, headers, null, spec.timeoutMs ?? 30000);
  if (result.status !== 200) {
    throw new Error(`HTTP ${result.status} from ${base}/models: ${result.data.slice(0, 300)}`);
  }
  const data = JSON.parse(result.data);
  return (data.data || []).map((m: { id: string }) => m.id);
}

// Adaptive timeouts per role. Floor set from observed minimums, ceiling from P99 + safety.
const roleTimings: Record<string, number[]> = {};
const ROLE_FLOORS: Record<string, number> = { worldbuilder: 180000, director: 180000, writer: 180000, continuist: 180000, critic: 180000, archivist: 180000, beatgate: 180000, patchgate: 180000, worldgate: 180000, contextgate: 180000, artdirector: 180000, editor: 180000, musicdirector: 180000 };
const TIMEOUT_CEILING_MS = 120000;
const TIMEOUT_SAFETY = 1.5;

export function recordTiming(roleName: string, elapsedMs: number): void {
  if (!roleTimings[roleName]) roleTimings[roleName] = [];
  roleTimings[roleName].push(elapsedMs);
  if (roleTimings[roleName].length > 5) roleTimings[roleName].shift();
}

export function timeoutForRole(roleName: string): number {
  const floor = ROLE_FLOORS[roleName] || 10000;
  const history = roleTimings[roleName];
  if (!history || history.length === 0) return floor;
  const avg = history.reduce((a: number, b: number) => a + b, 0) / history.length;
  const timeout = Math.ceil(avg * TIMEOUT_SAFETY);
  return Math.min(TIMEOUT_CEILING_MS, Math.max(floor, timeout));
}

// Resolve config.roles -> { director, writer, critic, archivist } provider instances.
// Creative layers that take author direction, by the role label each call
// carries ("creator" runs on the director's model but is its own layer).
// "artist" is the image model, handled by the art step.
export const DIRECTION_LAYERS = [
  "contextgate", "worldbuilder", "worldgate", "creator", "director", "beatgate",
  "writer", "editor", "voicedirector", "continuist", "critic", "archivist", "patchgate", "artdirector", "artist", "musicdirector"
] as const;

export function checkDirection(direction: Record<string, string> | undefined): void {
  const unknown = Object.keys(direction ?? {}).filter((k) => !(DIRECTION_LAYERS as readonly string[]).includes(k));
  if (unknown.length > 0) throw new Error(`direction: unknown layer ${unknown.map((k) => `"${k}"`).join(", ")} (layers: ${DIRECTION_LAYERS.join(", ")})`);
}

// Appends the author's direction for a call's layer to its prompt.
export function withDirection(provider: Provider, direction: Record<string, string>): Provider {
  return {
    complete: (req) => {
      const note = direction[req.role]?.trim();
      return provider.complete(note ? { ...req, prompt: `${req.prompt}\n\nAUTHOR DIRECTION for the ${req.role} (follow it; it overrides your defaults):\n${note}` } : req);
    }
  };
}

export function buildRoleProviders(config: StoryConfig): Roles {
  checkDirection(config.direction);
  const instances: Record<string, Provider> = {};
  for (const [name, spec] of Object.entries(config.providers)) {
    const provider = makeProvider(spec);
    instances[name] = config.direction && Object.keys(config.direction).length > 0 ? withDirection(provider, config.direction) : provider;
  }
  const roles: Record<string, Role> = {};
  for (const [role, cfg] of Object.entries(config.roles)) {
    if (!instances[cfg.provider]) {
      throw new Error(`Role ${role} references unknown provider ${cfg.provider}`);
    }
    // A role's own timeout, else its provider's (e.g. a slow, thinking model), else the adaptive default.
    const timeoutMs = cfg.timeoutMs ?? config.providers[cfg.provider].timeoutMs ?? timeoutForRole(role);
    roles[role] = { provider: instances[cfg.provider], temperature: cfg.temperature, timeoutMs };
  }
  // Config must provide director/writer/continuist/archivist; validated at call sites.
  return roles as Roles;
}
