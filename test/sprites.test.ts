import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cornerColour, detectGrid, fitSprite, makeSprites, parseColour, readCells, trimSprite } from "../src/sprites.ts";
import type { Raster } from "../src/sprites.ts";

const hasMagick = (() => { try { execFileSync("magick", ["-version"]); return true; } catch { return false; } })();
const MAGENTA: [number, number, number] = [255, 0, 255];

// A sprite of cells drawn big: magenta, with a block of mixed colours in the middle.
function drawn(cells: number, cellSize: number): Raster {
  const width = cells * cellSize;
  const data = new Uint8Array(width * width * 3);
  const colour = (cx: number, cy: number) => {
    const inside = cx >= cells / 4 && cx < (3 * cells) / 4 && cy >= cells / 4 && cy < (3 * cells) / 4;
    return inside ? [(cx * 53) % 200, (cy * 97) % 200, ((cx ^ cy) * 31) % 200] : MAGENTA;
  };
  for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) data.set(colour(Math.floor(x / cellSize), Math.floor(y / cellSize)), (y * width + x) * 3);
  return { width, height: width, data };
}

test("the true grid is found, the coarsest that fits, even with noise", () => {
  assert.equal(detectGrid(drawn(40, 12)).grid, 40);
  assert.equal(detectGrid(drawn(32, 16)).grid, 32);
  assert.equal(detectGrid(drawn(13, 40)).grid, 13);
  const noisy = drawn(40, 12);
  noisy.data.forEach((v, i) => { noisy.data[i] = Math.max(0, Math.min(255, v + ((i * 7919) % 9) - 4)); });
  const found = detectGrid(noisy);
  assert.equal(found.grid, 40);
  assert.equal(found.clean, true);
});

test("an image with no grid is not called clean", () => {
  const width = 480;
  const data = new Uint8Array(width * width * 3);
  data.forEach((_, i) => { data[i] = (i * 2654435761) % 251; });
  assert.equal(detectGrid({ width, height: width, data }).clean, false);
  assert.equal(detectGrid({ width: 1, height: 1, data: new Uint8Array(3) }).clean, false);
});

test("cells read back exactly, the background goes, and trimming finds the sprite", () => {
  const image = drawn(40, 12);
  assert.deepEqual(cornerColour(image), MAGENTA);
  const sprite = trimSprite(readCells(image, 40, MAGENTA, 96))!;
  assert.deepEqual([sprite.width, sprite.height], [20, 20]);
  assert.equal(sprite.data[3], 255);
  const empty = { width: 2, height: 2, data: new Uint8Array(16) };
  assert.equal(trimSprite(empty), undefined);
});

test("fitting centres pixel for pixel, and refuses what's too big rather than squeezing it", () => {
  const sprite = { width: 4, height: 2, data: new Uint8Array(4 * 4 * 2).fill(255) };
  const fitted = fitSprite(sprite, 8)!;
  const on = (r: Raster, x: number, y: number) => r.data[(y * r.width + x) * 4 + 3];
  assert.equal(fitted.width, 8);
  assert.deepEqual([on(fitted, 2, 3), on(fitted, 5, 4), on(fitted, 1, 3), on(fitted, 2, 2)], [255, 255, 0, 0]);
  assert.equal(fitSprite(sprite, 3), undefined);
});

test("parseColour reads hex, with or without the hash", () => {
  assert.deepEqual(parseColour("#FF00FF"), MAGENTA);
  assert.deepEqual(parseColour("00ff80"), [0, 255, 128]);
  assert.throws(() => parseColour("pink"), /hex colour/);
});

async function runWithArt(size = 480) {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-sprites-"));
  await mkdir(join(runDir, "art", "prop"), { recursive: true });
  const raw = join(runDir, "art", "prop", "gem.rgb");
  const image = drawn(40, size / 40);
  await writeFile(raw, image.data);
  execFileSync("magick", ["-size", `${size}x${size}`, "-depth", "8", `rgb:${raw}`, "-quality", "92", join(runDir, "art", "prop", "gem.jpg")]);
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify({
    "prop-gem": { file: "prop/gem.jpg", refKind: "prop", refId: "gem", prompt: "p", finalPrompt: "p", attempts: 3, accepted: false, issues: ["too dark"] },
    "scene-01-01": { file: "scene/x.jpg", prompt: "p", finalPrompt: "p", attempts: 1, accepted: true, issues: [] }
  }));
  return runDir;
}

test("each prop goes to its own target, never resized; what doesn't fit is flagged and not written", { skip: !hasMagick && "ImageMagick 7 (magick) not installed" }, async () => {
  const runDir = await runWithArt();
  const [r, ...rest] = await makeSprites({ runDir, targets: { gem: 24 } });
  assert.equal(rest.length, 0, "shots are left alone");
  assert.deepEqual([r.id, r.grid, r.width, r.height], ["gem", 40, 20, 20]);
  assert.deepEqual(r.unfit, []);
  assert.ok(r.flags.some((f) => /never accepted.*too dark/.test(f)));
  const id = (f: string, format: string) => execFileSync("magick", ["identify", "-format", format, f]).toString();
  const out = join(runDir, "sprites", "24px", "gem.png");
  assert.equal(id(out, "%wx%h"), "24x24");
  assert.equal(id(join(runDir, "sprites", "native", "gem.png"), "%wx%h"), "20x20");
  assert.ok(Number(id(join(runDir, "sprites", "native", "gem.png"), "%k")) <= 16, "the palette is held");
  assert.equal(id(`${out}[1x1+0+0]`, "%[fx:u.a]"), "0", "a transparent corner");
  assert.equal(JSON.parse(await readFile(join(runDir, "sprites", "sprites.json"), "utf8"))[0].key, "prop-gem");
  id(join(runDir, "review", "sprites-24px.png"), "%wx%h");

  const small = await runWithArt();
  const [tiny] = await makeSprites({ runDir: small, targets: { gem: 13 } });
  assert.deepEqual([tiny.unfit, tiny.sizes], [[13], {}]);
  assert.ok(tiny.flags.some((f) => /20x20 doesn't fit 13px/.test(f)));
  assert.equal(existsSync(join(small, "sprites", "13px", "gem.png")), false, "nothing squeezed");

  const fallback = await runWithArt();
  assert.deepEqual(Object.keys((await makeSprites({ runDir: fallback, sizes: [24, 64] }))[0].sizes), ["24", "64"], "--sizes serves art with no target");
  assert.ok((await makeSprites({ runDir: fallback }))[0].flags.some((f) => /native sprite only/.test(f)));
  assert.ok((await makeSprites({ runDir: fallback, targets: { gem: 64 } }))[0].flags.some((f) => /could carry more detail/.test(f)));
});

test("makeSprites refuses bad input clearly, and says when ImageMagick is missing", async () => {
  const runDir = await mkdtemp(join(tmpdir(), "scriptorium-sprites-"));
  await assert.rejects(makeSprites({ runDir, sizes: [1.5] }), /whole numbers/);
  await assert.rejects(makeSprites({ runDir, targets: { x: 0 } }), /whole numbers/);
  await assert.rejects(makeSprites({ runDir, sizes: [16] }), /no art\/art\.json/);
  await mkdir(join(runDir, "art", "prop"), { recursive: true });
  await writeFile(join(runDir, "art", "art.json"), JSON.stringify({ "prop-x": { file: "prop/x.png", refKind: "prop", refId: "x" } }));
  await assert.rejects(makeSprites({ runDir, sizes: [16], keys: ["prop-y"] }), /no image for prop-y/);
  await assert.rejects(makeSprites({ runDir, sizes: [16], kinds: ["location"] }), /nothing to do/);
  await assert.rejects(makeSprites({ runDir, sizes: [16], magick: "no-such-magick-binary" }), /sprites needs ImageMagick 7/);
});
