import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ArtManifest } from "./artist.ts";
import type { VisualRefKind } from "./types.ts";

// Pixel art from an image model arrives at about 1024 px, each "pixel" a square
// of 20-odd real ones. Resampling that to a game's size blurs it, so this finds
// the grid the model drew on and reads the cells back: the sprite the picture
// already is. Free: it runs on finished art, and writes only under the run.

export interface Raster { width: number; height: number; data: Uint8Array }  // RGB, or RGBA with `alpha`
type Rgb = [number, number, number];

export const GRID_RANGE = { min: 8, max: 128 };
export const DEFAULT_TOLERANCE = 96;
export const DEFAULT_COLORS = 16;
export const DEFAULT_FUZZ = 28;   // percent: how near the background still keys out, JPEG fringe included
export const DEFAULT_ERODE = 2;   // pixels shaved off the cut-out's edge, where the background bled in
// Average colour error of a clean grid, even through JPEG: above it, there isn't one.
const GRID_NOISE = 18;

// How far the image is from its own nearest-neighbour round trip at this grid.
function gridError(image: Raster, grid: number): number {
  const { width, height, data } = image;
  const cell = width / grid;
  const centre = (x: number) => Math.floor((Math.floor(x / cell) + 0.5) * cell);
  const stride = Math.max(1, Math.floor(width / 512));
  let total = 0;
  let n = 0;
  for (let y = 0; y < height; y += stride) {
    const cy = Math.min(centre(y), height - 1);
    for (let x = 0; x < width; x += stride) {
      const cx = Math.min(centre(x), width - 1);
      const a = (y * width + x) * 3;
      const b = (cy * width + cx) * 3;
      for (let k = 0; k < 3; k++) { const d = data[a + k] - data[b + k]; total += d * d; }
      n += 3;
    }
  }
  return Math.sqrt(total / n);
}

// The coarsest grid nearly as faithful as the best: a true 40 also fits at 80,
// and the 40 is the drawing.
export function detectGrid(image: Raster, range = GRID_RANGE): { grid: number; error: number; clean: boolean } {
  const max = Math.min(range.max, Math.floor(image.width / 2));
  if (max < range.min) return { grid: image.width, error: 0, clean: false };
  const scores: { grid: number; error: number }[] = [];
  for (let grid = range.min; grid <= max; grid++) scores.push({ grid, error: gridError(image, grid) });
  const best = Math.min(...scores.map((s) => s.error));
  const found = scores.find((s) => s.error <= best * 1.25 + 1.5)!;
  return { ...found, clean: found.error <= GRID_NOISE };
}

// The background: the colour at the corners (median, so one stray corner can't win).
export function cornerColour(image: Raster): Rgb {
  const { width, height, data } = image;
  const size = Math.min(8, Math.floor(width / 4) || 1, Math.floor(height / 4) || 1);
  const samples: number[][] = [[], [], []];
  for (const [ox, oy] of [[0, 0], [width - size, 0], [0, height - size], [width - size, height - size]]) {
    for (let y = oy; y < oy + size; y++) for (let x = ox; x < ox + size; x++) for (let k = 0; k < 3; k++) samples[k].push(data[(y * width + x) * 3 + k]);
  }
  return samples.map((s) => s.sort((a, b) => a - b)[Math.floor(s.length / 2)]) as Rgb;
}

// One pixel per cell, the mean of the cell's middle (the edges carry JPEG ringing
// from the neighbours), transparent where it's the background within tolerance.
export function readCells(image: Raster, grid: number, background: Rgb, tolerance: number): Raster {
  const { width, height, data } = image;
  const cell = width / grid;
  const rows = Math.max(1, Math.round(height / cell));
  const out = new Uint8Array(grid * rows * 4);
  for (let r = 0; r < rows; r++) {
    for (let g = 0; g < grid; g++) {
      const x0 = Math.floor((g + 0.25) * cell), x1 = Math.max(x0 + 1, Math.floor((g + 0.75) * cell));
      const y0 = Math.floor((r + 0.25) * cell), y1 = Math.max(y0 + 1, Math.floor((r + 0.75) * cell));
      const sum = [0, 0, 0];
      let n = 0;
      for (let y = y0; y < Math.min(y1, height); y++) for (let x = x0; x < Math.min(x1, width); x++) {
        for (let k = 0; k < 3; k++) sum[k] += data[(y * width + x) * 3 + k];
        n++;
      }
      const rgb = sum.map((v) => Math.round(v / Math.max(1, n)));
      const distance = Math.hypot(rgb[0] - background[0], rgb[1] - background[1], rgb[2] - background[2]);
      out.set([...rgb, distance <= tolerance ? 0 : 255], (r * grid + g) * 4);
    }
  }
  return { width: grid, height: rows, data: out };
}

// Cropped to what's opaque; undefined if nothing is.
export function trimSprite(sprite: Raster): Raster | undefined {
  const { width, height, data } = sprite;
  let left = width, right = -1, top = height, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (data[(y * width + x) * 4 + 3] === 0) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) return undefined;
  const w = right - left + 1, h = bottom - top + 1;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) out.set(data.subarray(((y + top) * width + left) * 4, ((y + top) * width + left + w) * 4), y * w * 4);
  return { width: w, height: h, data: out };
}

// On a transparent square of this size, centred, pixel for pixel. Nothing is
// resized: a design is drawn for its size, and one that doesn't fit is a redraw,
// so it comes back undefined rather than squeezed.
export function fitSprite(sprite: Raster, size: number): Raster | undefined {
  if (sprite.width > size || sprite.height > size) return undefined;
  const ox = Math.floor((size - sprite.width) / 2), oy = Math.floor((size - sprite.height) / 2);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < sprite.height; y++) out.set(sprite.data.subarray(y * sprite.width * 4, (y + 1) * sprite.width * 4), ((y + oy) * size + ox) * 4);
  return { width: size, height: size, data: out };
}

// ImageMagick does the decoding and encoding, and picks the palette.
function magickTools(bin: string) {
  const missing = (err: unknown) => (err as NodeJS.ErrnoException).code === "ENOENT" ? new Error(`sprites needs ImageMagick 7: no "${bin}" on PATH`) : (err as Error);
  const run = promisify(execFile);
  const call = async (args: string[]) => {
    try { return (await run(bin, args, { maxBuffer: 256 * 1024 * 1024, encoding: "buffer" })).stdout; } catch (err) { throw missing(err); }
  };
  const write = (args: string[], input: Uint8Array) => new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["pipe", "ignore", "inherit"] });
    child.on("error", (err) => reject(missing(err)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${bin} failed (${code})`))));
    child.stdin.on("error", () => { /* reported via close */ });
    child.stdin.end(input);
  });
  const hex = (c: Rgb) => `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  const size = async (file: string) => {
    const [width, height] = (await call(["identify", "-format", "%w %h", `${file}[0]`])).toString().trim().split(" ").map(Number);
    return { width, height };
  };
  return {
    // The model's image is flat: the background is painted pixels, with no alpha.
    // So key it at full size, before anything blends it into the object's edges.
    cutout: (from: string, to: string, background: Rgb, fuzz: number, erode: number) => call([
      from, "-alpha", "set", "-fuzz", `${fuzz}%`, "-transparent", hex(background),
      "(", "+clone", "-alpha", "extract", "-threshold", "50%", ...(erode > 0 ? ["-morphology", "Erode", `Diamond:${erode}`] : []), ")",
      "-alpha", "off", "-compose", "CopyOpacity", "-composite", `PNG32:${to}`
    ]),
    reduce: (from: string, to: string, size: number) => call([from, "-filter", "Box", "-resize", `${size}x${size}`, "-channel", "A", "-threshold", "50%", "+channel", `PNG32:${to}`]),
    decode: async (file: string, channels: "rgb" | "rgba"): Promise<Raster> => ({ ...(await size(file)), data: new Uint8Array(await call([file, "-colorspace", "sRGB", "-depth", "8", ...(channels === "rgb" ? ["-alpha", "off"] : []), `${channels}:-`])) }),
    encode: (sprite: Raster, file: string, colors?: number) => write(["-size", `${sprite.width}x${sprite.height}`, "-depth", "8", "rgba:-", ...(colors ? ["-dither", "None", "-colors", String(colors)] : []), `PNG32:${file}`], sprite.data),
    sheet: (files: string[], to: string) => call(["montage", ...files, "-filter", "Point", "-resize", "400%", "-background", "#808890", "-geometry", "+8+8", "-tile", "7x", to])
  };
}

export interface SpriteOptions {
  runDir: string;
  targets?: Record<string, number>;  // prop id -> its square size in pixels (the story file's "sprite")
  sizes?: number[];             // for art with no target of its own
  kinds?: VisualRefKind[];      // default props
  keys?: string[];              // just these art keys
  background?: Rgb;             // default the corners' colour
  tolerance?: number;           // 0-441: how far from the background still counts as background
  colors?: number;              // palette size per sprite; 0 keeps every colour
  magick?: string;              // the binary (default magick)
}

export interface SpriteResult {
  key: string;
  id: string;
  grid: number;
  width: number;
  height: number;
  sizes: Record<string, string>;  // size -> file
  unfit: number[];                // target sizes it doesn't fit: nothing written, redraw it
  flags: string[];
}

async function pickArt(opts: Pick<SpriteOptions, "runDir" | "kinds" | "keys">) {
  const artDir = join(opts.runDir, "art");
  const manifest = JSON.parse(await readFile(join(artDir, "art.json"), "utf8").catch(() => { throw new Error(`no art/art.json in ${opts.runDir}: run --only refs first`); })) as ArtManifest;
  const kinds = opts.kinds ?? ["prop"];
  const unknown = (opts.keys ?? []).filter((k) => !manifest[k]);
  if (unknown.length) throw new Error(`sprites: no image for ${unknown.join(", ")} (art keys, e.g. prop-lantern)`);
  const picked = Object.entries(manifest).filter(([key, e]) => (opts.keys ? opts.keys.includes(key) : e.refKind !== undefined && kinds.includes(e.refKind)));
  if (picked.length === 0) throw new Error(`sprites: nothing to do in ${artDir}`);
  return { artDir, picked };
}

// Reads art.json, and writes <run>/sprites/native/<id>.png (the true sprite),
// <run>/sprites/<size>px/<id>.png, sprites.json, and a sheet per size in review/.
export async function makeSprites(opts: SpriteOptions): Promise<SpriteResult[]> {
  const asked = [...(opts.sizes ?? []), ...Object.values(opts.targets ?? {})];
  if (asked.some((s) => !Number.isInteger(s) || s <= 0)) throw new Error("sprites: sizes must be whole numbers of pixels (--sizes 16,48)");
  const tools = magickTools(opts.magick ?? "magick");
  const { artDir, picked } = await pickArt(opts);
  const spritesDir = join(opts.runDir, "sprites");
  await mkdir(join(spritesDir, "native"), { recursive: true });
  const results: SpriteResult[] = [];
  for (const [key, entry] of picked) {
    const id = entry.refId ?? key;
    const image = await tools.decode(join(artDir, entry.file), "rgb");
    const { grid, clean } = detectGrid(image);
    const flags: string[] = [];
    if (!clean) flags.push("no clean pixel grid: the art isn't true pixel art");
    if (entry.accepted === false) flags.push(`the inspector never accepted this image: ${entry.issues.join("; ")}`);
    const trimmed = trimSprite(readCells(image, grid, opts.background ?? cornerColour(image), opts.tolerance ?? DEFAULT_TOLERANCE));
    if (!trimmed) {
      results.push({ key, id, grid, width: 0, height: 0, sizes: {}, unfit: [], flags: [...flags, "nothing left once the background was removed"] });
      continue;
    }
    const native = join(spritesDir, "native", `${id}.png`);
    await tools.encode(trimmed, native, opts.colors ?? DEFAULT_COLORS);
    const sprite = await tools.decode(native, "rgba");
    const own = opts.targets?.[id];
    const targets = own ? [own] : opts.sizes ?? [];
    if (targets.length === 0) flags.push("no target size: native sprite only");
    const sizes: SpriteResult["sizes"] = {};
    const unfit: number[] = [];
    for (const size of targets) {
      const fitted = fitSprite(sprite, size);
      if (!fitted) {
        unfit.push(size);
        flags.push(`${sprite.width}x${sprite.height} doesn't fit ${size}px: nothing written, redraw it simpler`);
        continue;
      }
      if (Math.max(sprite.width, sprite.height) * 2 <= size) flags.push(`only ${sprite.width}x${sprite.height} of ${size}px: it could carry more detail`);
      await mkdir(join(spritesDir, `${size}px`), { recursive: true });
      const file = join(spritesDir, `${size}px`, `${id}.png`);
      await tools.encode(fitted, file);
      sizes[size] = file;
    }
    results.push({ key, id, grid, width: sprite.width, height: sprite.height, sizes, unfit, flags });
  }
  await writeFile(join(spritesDir, "sprites.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
  await mkdir(join(opts.runDir, "review"), { recursive: true });
  for (const size of new Set(results.flatMap((r) => Object.keys(r.sizes)))) {
    await tools.sheet(results.flatMap((r) => (r.sizes[size] ? [r.sizes[size]] : [])), join(opts.runDir, "review", `sprites-${size}px.png`));
  }
  return results;
}

export interface CutoutOptions {
  runDir: string;
  reduce?: number[];            // square sizes to reduce to, from the cut-outs
  kinds?: VisualRefKind[];      // default props
  keys?: string[];              // just these art keys
  background?: Rgb;             // default the corners' colour
  fuzz?: number;                // percent, default DEFAULT_FUZZ
  erode?: number;               // pixels, default DEFAULT_ERODE
  magick?: string;              // the binary (default magick)
}

export interface CutoutResult {
  key: string;
  id: string;
  file?: string;                  // the full-size cut-out
  reduced: Record<string, string>;  // size -> file
  flags: string[];
}

// For art not drawn on a strict grid: a real-alpha PNG at full size in
// <run>/sprites/cutout/, and only if asked, reductions of those cut-outs in
// <run>/sprites/reduced/<size>px/. Reductions are averaged, not true pixels, so
// they stay apart from <size>px/. They never touch the background-backed image.
export async function makeCutouts(opts: CutoutOptions): Promise<CutoutResult[]> {
  const sizes = opts.reduce ?? [];
  if (sizes.some((s) => !Number.isInteger(s) || s <= 0)) throw new Error("sprites: --reduce takes whole numbers of pixels (--reduce 32,64)");
  const fuzz = opts.fuzz ?? DEFAULT_FUZZ;
  if (!(fuzz >= 0 && fuzz <= 100)) throw new Error("sprites: --fuzz is a percentage, 0 to 100");
  const erode = opts.erode ?? DEFAULT_ERODE;
  if (!Number.isInteger(erode) || erode < 0) throw new Error("sprites: --erode is a whole number of pixels");
  const tools = magickTools(opts.magick ?? "magick");
  const { artDir, picked } = await pickArt(opts);
  const spritesDir = join(opts.runDir, "sprites");
  await mkdir(join(spritesDir, "cutout"), { recursive: true });
  const results: CutoutResult[] = [];
  for (const [key, entry] of picked) {
    const id = entry.refId ?? key;
    const source = join(artDir, entry.file);
    const background = opts.background ?? cornerColour(await tools.decode(source, "rgb"));
    const flags = entry.accepted === false ? [`the inspector never accepted this image: ${entry.issues.join("; ")}`] : [];
    const file = join(spritesDir, "cutout", `${id}.png`);
    await tools.cutout(source, file, background, fuzz, erode);
    const { data } = await tools.decode(file, "rgba");
    if (!data.some((v, i) => i % 4 === 3 && v > 0)) {
      results.push({ key, id, reduced: {}, flags: [...flags, "nothing left once the background was removed"] });
      continue;
    }
    const reduced: CutoutResult["reduced"] = {};
    for (const size of sizes) {
      await mkdir(join(spritesDir, "reduced", `${size}px`), { recursive: true });
      reduced[size] = join(spritesDir, "reduced", `${size}px`, `${id}.png`);
      await tools.reduce(file, reduced[size], size);
    }
    results.push({ key, id, file, reduced, flags });
  }
  await writeFile(join(spritesDir, "cutouts.json"), JSON.stringify(results, null, 2) + "\n", "utf8");
  await mkdir(join(opts.runDir, "review"), { recursive: true });
  for (const size of sizes) {
    const files = results.flatMap((r) => (r.reduced[size] ? [r.reduced[size]] : []));
    if (files.length) await tools.sheet(files, join(opts.runDir, "review", `sprites-reduced-${size}px.png`));
  }
  return results;
}

// "#FF00FF" as a colour.
export function parseColour(text: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(text.trim());
  if (!m) throw new Error(`--background "${text}": use a hex colour such as #FF00FF`);
  return [Number.parseInt(m[1], 16), Number.parseInt(m[2], 16), Number.parseInt(m[3], 16)];
}
