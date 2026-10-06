import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities, doctor, formatRows, investigate, storyRows } from "../src/doctor.ts";
import type { DoctorDeps } from "../src/doctor.ts";
import type { ResolvedStory } from "../src/make.ts";

// Issue #108: `doctor` says what this machine can make, from its keys and tools,
// without spending: each key is checked by listing its models.

const GEMINI_MODELS = ["gemini-3.1-flash-image", "gemini-3.8-flash", "gemini-3.8-flash-tts", "lyria-3.5"];

function deps(env: Record<string, string>, opts: { geminiModels?: string[]; reject?: string[]; missing?: string[]; kokoro?: boolean } = {}): DoctorDeps & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    env,
    fetch: (async (url: string, init: { headers: Record<string, string> }) => {
      urls.push(url);
      const key = Object.values(init.headers).join(" ");
      if (opts.reject?.some((k) => key.includes(k))) return new Response("{}", { status: 401 });
      if (url.includes("googleapis")) return Response.json({ models: (opts.geminiModels ?? GEMINI_MODELS).map((m) => ({ name: `models/${m}` })) });
      return Response.json({ data: [{ id: "claude-haiku-4-5-20251001" }, { id: "claude-opus-5-5" }] });
    }) as never,
    has: async (cmd) => !(opts.missing ?? []).includes(cmd),
    resolves: () => opts.kokoro ?? true
  };
}

const marks = (rows: { label: string; mark: string }[]) => Object.fromEntries(rows.map((r) => [r.label, r.mark]));

test("with no keys, every service is 'not set up' rather than broken, and nothing is called", async () => {
  const d = deps({});
  const rows = capabilities(await investigate(d));
  assert.deepEqual(d.urls, [], "no key, no call");
  const m = marks(rows);
  assert.equal(m["Story & writing (Claude)"], "unset");
  assert.equal(m["Images (Gemini)"], "unset");
  assert.equal(m["Music (Gemini Lyria)"], "unset");
  assert.equal(m["Video & audio mixing (ffmpeg)"], "ok", "local tools don't need keys");
  assert.equal(m["Voices, local (Kokoro)"], "ok");
  assert.ok(!("Story & writing (OpenAI)" in m), "other writing backends appear only when there's a key for them");
  const { text } = await doctor(d);
  assert.match(text, /Anthropic \(Claude\): get a key at https:\/\/console\.anthropic\.com\/settings\/keys, then add ANTHROPIC_API_KEY=\.\.\. to \.env/);
  assert.match(text, /Google Gemini: get a key at https:\/\/aistudio\.google\.com\/apikey/);
});

test("working keys light up what their models can make; a rejected key and a missing tool are ✗", async () => {
  const d = deps({ ANTHROPIC_API_KEY: "sk-good", GEMINI_API_KEY: "g-good" }, { geminiModels: ["gemini-3.1-flash-image", "gemini-3.8-flash", "gemini-3.8-flash-tts"], missing: ["magick", "fc-match"] });
  const m = marks(capabilities(await investigate(d)));
  assert.equal(m["Story & writing (Claude)"], "ok");
  assert.equal(m["Images (Gemini)"], "ok");
  assert.equal(m["Voices, acted (Gemini TTS)"], "ok");
  assert.equal(m["Music (Gemini Lyria)"], "no", "lyria isn't in this key's model list");
  assert.equal(m["Review sheets (ImageMagick)"], "no");
  assert.equal(m["System title fonts (fontconfig)"], "unset", "optional");

  const bad = marks(capabilities(await investigate(deps({ ANTHROPIC_API_KEY: "sk-bad", GEMINI_API_KEY: "g-good" }, { reject: ["sk-bad"] }))));
  assert.equal(bad["Story & writing (Claude)"], "no");
  assert.equal(bad["Images (Gemini)"], "ok");
});

test("a story file: its roles' providers, its art, voices and music are checked against the keys", async () => {
  const story = {
    file: "stories/x.json",
    config: {
      providers: { haiku: { type: "anthropic", model: "claude-haiku-4-5-20251001" }, gpt: { type: "responses", model: "gpt-9" }, mock: { type: "mock" } },
      roles: { writer: { provider: "haiku" }, editor: { provider: "haiku" }, critic: { provider: "gpt" }, archivist: { provider: "mock" }, artdirector: { provider: "haiku" } }
    },
    audiobook: { narration: "gemini", dialogue: "gemini" },
    music: {}
  } as unknown as ResolvedStory;
  const d = deps({ ANTHROPIC_API_KEY: "sk-good" });
  const rows = await storyRows(story, await investigate(d), d);
  assert.deepEqual(marks(rows), {
    "Writing: haiku (3 roles)": "ok",
    "Writing: gpt (1 role)": "no",
    "Writing: mock (1 role)": "ok",
    "Art: images": "no",
    "Art: image checks": "no",
    "Audiobook: Gemini voices": "no",
    "Music": "no",
    "Video & audio mixing": "ok"
  });
  assert.match(formatRows(rows), /Writing: gpt \(1 role\)\s+✗  needs OPENAI_API_KEY/);
  assert.match(formatRows(rows), /Art: images\s+✗  needs GEMINI_API_KEY/, "a story that needs a key it hasn't got is ✗, not ○");
  const { ready } = await doctor(d, story);
  assert.equal(ready, false);
});
