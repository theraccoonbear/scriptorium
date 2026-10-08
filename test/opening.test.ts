import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioFilterGraph, buildTimeline, cardFilterGraph, cardSpec, crawlSec, wrapCrawl } from "../src/video.ts";
import type { Timings } from "../src/video.ts";
import { OPENING_ART, OPENING_LOGO, crawlParagraphs, prepareTitles } from "../src/titles.ts";
import type { TitleCards } from "../src/titles.ts";
import type { ArtManifest, ManifestEntry } from "../src/artist.ts";

// Issue #145: the opening — the extras' title logo over the key art, then an
// optional crawl (the story so far) scrolling up, the theme under both.

const entry = (file: string, sceneIndex?: number, startParagraph?: number): ManifestEntry => ({ file, prompt: file, finalPrompt: file, attempts: 1, accepted: true, issues: [], sceneIndex, startParagraph });
const manifest: ArtManifest = { "scene-01-01": entry("scene-01-01.jpg", 0, 0), cover: entry("cover.jpg") };
const timings: Timings = { sampleRate: 24000, scenes: [{ index: 0, file: "scene-01.wav", durationSec: 20, paragraphStarts: [0] }] };
const crawl = ["We join the party in medias res.", "Robbed blind on the road to Red Arbor, they wake in a ditch with six gold pieces between them."];
const titles: TitleCards = {
  title: "Rantoul's Mushrooms", sceneCards: true, sceneTitles: { 0: "The Ditch" }, credits: [], font: "/f/Garamond.ttf", titleFont: "/f/Cinzel.ttf",
  logo: OPENING_LOGO, openingArt: OPENING_ART, crawl
};
const files = (t: string) => `/text/${t.length}.txt`;

test("the crawl's paragraphs, its reading time and its wrapped lines", () => {
  assert.deepEqual(crawlParagraphs("One  two.\n\nThree\nfour."), ["One two.", "Three four."]);
  assert.deepEqual(crawlParagraphs(["  a ", ""]), ["a"]);
  assert.deepEqual(crawlParagraphs(false), []);
  assert.equal(crawlSec(["short"]), 12, "never rushed");
  assert.equal(crawlSec([Array(100).fill("word").join(" ")]), 45, "2.5 words a second, plus time to settle");
  const wrapped = wrapCrawl(crawl, 30);
  assert.ok(wrapped.split("\n").every((l) => l.length <= 30));
  assert.match(wrapped, /res\.\n\nRobbed/, "a blank line between paragraphs");
});

test("the opening: the title, then the crawl, then the first scene's card", () => {
  const tl = buildTimeline(manifest, timings, { titles });
  assert.deepEqual(tl.parts.slice(0, 3).map((p) => p.kind), ["intro", "crawl", "card"]);
  assert.equal(tl.parts[1].frames, Math.round(crawlSec(crawl) * 30));
  assert.deepEqual(buildTimeline(manifest, timings, { titles: { ...titles, crawl: undefined } }).parts.slice(0, 2).map((p) => p.kind), ["intro", "card"], "no crawl, no part");
});

test("the title is the logo over the key art; the crawl scrolls over the key art, dimmed", () => {
  const tl = buildTimeline(manifest, timings, { titles });
  const intro = cardSpec(tl.parts[0], tl, titles);
  assert.deepEqual([intro.art, intro.logo, intro.texts.length], [OPENING_ART, OPENING_LOGO, 0], "the logo is the title: no typeset title over it");
  const g = cardFilterGraph(intro, tl.parts[0].frames, files);
  assert.match(g, /\[1:v\]loop=loop=-1:size=1,setpts=N\/30\/TB,format=rgba,scale=.*fade=t=in.*alpha=1.*\[logo\];\[bg\]\[logo\]overlay/);
  const c = cardSpec(tl.parts[1], tl, titles);
  const cg = cardFilterGraph(c, tl.parts[1].frames, files);
  assert.match(cg, /drawbox=.*black@0\.62/);
  assert.match(cg, /text_align=C/);
  assert.match(cg, /y='h-\(h\+text_h\)\*t\/[\d.]+'/, "y moves with time: it scrolls");
  // Without the extras: the typeset title over the cover, as before.
  const plain = cardSpec(tl.parts[0], tl, { ...titles, logo: undefined, openingArt: undefined });
  assert.deepEqual([plain.art, plain.logo, plain.texts[0].text], [undefined, undefined, "Rantoul's Mushrooms"]);
});

test("the theme plays under the title and the crawl as one stretch", () => {
  const tl = buildTimeline(manifest, timings, { titles, music: { theme: "video/music/theme.wav", beds: {}, duck: 19 } });
  const graph = audioFilterGraph(tl);
  const span = (tl.parts[0].frames + tl.parts[1].frames) / 30;
  assert.match(graph, new RegExp(`apad=whole_dur=${span}`), "one stretch of the theme the length of both");
  assert.match(graph, /\[crawl\]/, "silence under the crawl in the voice track");
});

test("prepareTitles uses the extras' logo and key art when they exist, and the story's crawl", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-opening-"));
  const plain = await prepareTitles([], { runDir, title: "T", settings: { crawl: "Before.\n\nAnd after." } });
  assert.deepEqual([plain.logo, plain.openingArt, plain.crawl], [undefined, undefined, ["Before.", "And after."]]);
  await mkdir(join(runDir, "art", "extra"), { recursive: true });
  await writeFile(join(runDir, OPENING_LOGO), "png");
  await writeFile(join(runDir, OPENING_ART), "jpg");
  const made = await prepareTitles([], { runDir, title: "T" });
  assert.deepEqual([made.logo, made.openingArt, made.crawl], [OPENING_LOGO, OPENING_ART, undefined]);
  assert.equal((await prepareTitles([], { runDir, title: "T", settings: { logo: false } })).logo, undefined, "logo: false keeps the typeset title");
});
