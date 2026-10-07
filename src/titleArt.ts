import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveFont } from "./titles.ts";

// The title logo, shelf covers and box art (#128). The logo is typeset in code
// (exact spelling, always) with a treatment applied as effects; the covers and
// the box are composited in code from approved art. No image model ever draws
// text, and none of this costs anything.

const run = promisify(execFile);
const magick = (args: string[]) => run("magick", args, { maxBuffer: 64 * 1024 * 1024 });

export const TREATMENTS = ["gilded", "bronze", "silver", "iron", "parchment", "plain"] as const;
export type Treatment = (typeof TREATMENTS)[number];
export interface LogoSettings {
  font?: string;          // a bundled font (see LOGO_FONTS) or a system font name; default Cinzel
  treatment?: Treatment;  // default gilded
  arc?: number;           // degrees to arch the title (0-40, the classic fantasy title curve); default 0
  caps?: boolean;         // all capitals (default true)
}

// Fill gradient, the dark edge round the letters, and whether they're bevelled (metal).
const FILLS: Record<Treatment, { fill: string; edge: string; bevel: boolean }> = {
  gilded: { fill: "#fff3be-#c8952f", edge: "#2b1a06", bevel: true },
  bronze: { fill: "#f2c38a-#7a4a1e", edge: "#1e1006", bevel: true },
  silver: { fill: "#ffffff-#7f8994", edge: "#121619", bevel: true },
  iron: { fill: "#c9ccd0-#4a4f55", edge: "#0b0c0e", bevel: true },
  parchment: { fill: "#f6ead0-#d8c49c", edge: "#2a1d10", bevel: false },
  plain: { fill: "#ffffff-#e8e2d6", edge: "#000000", bevel: false }
};

// One line of lettering: a gradient fill through the text's shape, a dark
// edge around it, a soft shadow beneath. Transparent PNG.
async function letter(text: string, font: string, points: number, kerning: number, fill: string, edge: string, dir: string, name: string, bevel = false, arc = 0): Promise<string> {
  const mask = join(dir, `${name}-mask.png`);
  await magick(["-background", "none", "-fill", "white", "-font", font, "-pointsize", String(points), "-kerning", String(kerning), `label:${text}`, "-trim", "+repage", "-bordercolor", "none", "-border", String(Math.round(points / 6)),
    ...(arc > 0 ? ["-virtual-pixel", "transparent", "-distort", "Arc", String(arc), "-trim", "+repage", "-bordercolor", "none", "-border", String(Math.round(points / 6))] : []), mask]);
  const { stdout } = await magick(["identify", "-format", "%wx%h", mask]);
  const fillImg = join(dir, `${name}-fill.png`);
  await magick(["-size", stdout.trim(), `gradient:${fill}`, fillImg]);
  const out = join(dir, `${name}.png`);
  const stroke = Math.max(2, Math.round(points / 40));
  await magick([
    "(", mask, "-morphology", "Dilate", `Disk:${stroke}`, "-fill", edge, "-colorize", "100", ")",
    "(", fillImg,
      // Metal: the letters' own relief (light from the upper left) worked into the fill.
      ...(bevel ? ["(", mask, "-alpha", "extract", "-blur", `0x${Math.max(2, Math.round(points / 30))}`, "-shade", "135x35", "-auto-level", "-function", "polynomial", "3.5,-5.05,2.1,0.25", ")", "-compose", "Overlay", "-composite"] : []),
      mask, "-compose", "CopyOpacity", "-composite", ")",
    "-compose", "Over", "-composite",
    "(", "+clone", "-background", "black", "-shadow", `75x${Math.round(points / 25)}+0+${Math.round(points / 40)}`, ")",
    "+swap", "-background", "none", "-layers", "merge", "+repage", out
  ]);
  return out;
}

// The logo: the title, and the subtitle beneath it, small and spaced. Writes
// logo.png (the treatment) and logo-mono.png (white, for small sizes and spines).
export async function renderLogo(o: { title: string; subtitle?: string; outDir: string; settings?: LogoSettings; base?: string }): Promise<{ logo: string; stacked: string; mono: string }> {
  const font = await resolveFont(o.settings?.font ?? "Cinzel", o.base);
  const t = FILLS[o.settings?.treatment ?? "gilded"];
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-logo-"));
  try {
    await mkdir(o.outDir, { recursive: true });
    // stacked: the title over two lines (balanced at a space), for tall and square covers.
    const build = async (fill: string, edge: string, file: string, stacked: boolean) => {
      const title = o.settings?.caps === false ? o.title : o.title.toUpperCase();
      const words = title.split(/\s+/);
      let split = 1;
      if (stacked && words.length > 1) {
        let best = Infinity;
        for (let i = 1; i < words.length; i++) {
          const d = Math.abs(words.slice(0, i).join(" ").length - words.slice(i).join(" ").length);
          if (d < best) { best = d; split = i; }
        }
      }
      const rows = stacked && words.length > 1 ? [words.slice(0, split).join(" "), words.slice(split).join(" ")] : [title];
      const lines: string[] = [];
      const bevel = file !== "logo-mono" && t.bevel;
      const arc = Math.max(0, Math.min(40, o.settings?.arc ?? 0));
      for (const [i, row] of rows.entries()) lines.push(await letter(row, font, 360, 6, fill, edge, dir, `${file}-t${i}`, bevel, i === 0 ? arc : 0));
      if (o.subtitle?.trim()) lines.push(await letter(o.subtitle.toUpperCase(), font, 190, 30, fill, edge, dir, `${file}-sub`, bevel));
      const out = join(o.outDir, `${file}.png`);
      await magick(["-background", "none", ...lines, "-gravity", "center", "-append", "-trim", "+repage", out]);
      return out;
    };
    return {
      logo: await build(t.fill, t.edge, "logo", false),
      stacked: await build(t.fill, t.edge, "logo-stacked", true),
      mono: await build("#ffffff-#ffffff", "#000000", "logo-mono", false)
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Shelf covers: the key art at a streaming size, darkened a little at the top,
// with the logo set in that space.
export const SHELF: Record<string, { from: string; size: [number, number]; logoWidth: number; stacked: boolean }> = {
  "cover-2x3": { from: "keyart-2x3", size: [2000, 3000], logoWidth: 0.86, stacked: true },
  "cover-16x9": { from: "keyart-16x9", size: [3840, 2160], logoWidth: 0.55, stacked: false },
  "cover-1x1": { from: "keyart-1x1", size: [2000, 2000], logoWidth: 0.52, stacked: true }
};

export async function shelfCover(keyArt: string, logo: string, out: string, size: [number, number], logoWidth: number): Promise<void> {
  const [w, h] = size;
  await magick([
    keyArt, "-resize", `${w}x${h}^`, "-gravity", "center", "-extent", `${w}x${h}`,
    "(", "-size", `${w}x${Math.round(h * 0.4)}`, "gradient:rgba(0,0,0,0.6)-rgba(0,0,0,0)", ")", "-gravity", "north", "-compose", "Over", "-composite",
    "(", logo, "-resize", `${Math.round(w * logoWidth)}x${Math.round(h * 0.3)}`, ")", "-gravity", "north", "-geometry", `+0+${Math.round(h * 0.05)}`, "-compose", "Over", "-composite",
    "-quality", "90", out
  ]);
}

// Box copy, written once by the art director (see roles.ts writeBoxCopy).
export interface BoxCopy { tagline: string; synopsis: string; credits: string }

// The box: back | spine | front, as one print-style layout. The front is the
// 2:3 cover; the spine carries the one-colour logo; the back a tagline, four
// stills, the synopsis, a billing block and a rating box.
export async function boxArt(o: {
  front: string; mono: string; stills: string[]; copy: BoxCopy;
  out: string; font?: string; bodyFont?: string; base?: string;
}): Promise<void> {
  const W = 1200, H = 1800, S = 240, M = 70;
  const head = await resolveFont(o.font ?? "Cinzel", o.base);
  const body = await resolveFont(o.bodyFont ?? "EB Garamond", o.base);
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-box-"));
  try {
    const p = (n: string) => join(dir, n);
    // Front
    await magick([o.front, "-resize", `${W}x${H}^`, "-gravity", "center", "-extent", `${W}x${H}`, p("front.png")]);
    // Spine: the one-colour logo (title and part) turned on its side.
    await magick([
      "-size", `${S}x${H}`, "xc:#14100c",
      "(", o.mono, "-rotate", "90", "-resize", `${S - 50}x${H - 200}`, ")", "-gravity", "center", "-geometry", "+0+0", "-compose", "Over", "-composite",
      p("spine.png")
    ]);
    // Back: tagline, stills (2x2), synopsis, billing block, rating.
    const cw = W - 2 * M;
    const stills = o.stills.slice(0, 4);
    await magick([...stills.flatMap((s) => [s]), "-resize", `${Math.floor(cw / 2) - 10}x${Math.floor(cw / 2 * 9 / 16)}^`, "-gravity", "center", "-extent", `${Math.floor(cw / 2) - 10}x${Math.floor(cw / 2 * 9 / 16)}`, "-bordercolor", "#14100c", "-border", "5", "-background", "#14100c", "(", "-clone", "0,1", "+append", ")", "(", "-clone", "2,3", "+append", ")", "-delete", "0-3", "-append", p("stills.png")]);
    await magick(["-background", "none", "-fill", "#f3e6c4", "-font", head, "-size", `${cw}x`, "-pointsize", "52", "-gravity", "center", `caption:${o.copy.tagline}`, p("tagline.png")]);
    await magick(["-background", "none", "-fill", "#e6dccb", "-font", body, "-size", `${cw}x`, "-pointsize", "31", "-interline-spacing", "6", `caption:${o.copy.synopsis}`, p("synopsis.png")]);
    await magick(["-background", "none", "-fill", "#a99d88", "-font", body, "-size", `${cw}x`, "-pointsize", "21", "-gravity", "center", `caption:${o.copy.credits.toUpperCase()}`, p("credits.png")]);
    await magick(["-size", "120x120", "xc:none", "-fill", "none", "-stroke", "#e6dccb", "-strokewidth", "4", "-draw", "rectangle 4,4 116,116", "-stroke", "none", "-fill", "#e6dccb", "-font", head, "-pointsize", "56", "-gravity", "center", "-annotate", "+0+0", "NR", p("rating.png")]);
    await magick([
      "-size", `${W}x${H}`, "xc:#1b1510",
      p("tagline.png"), "-gravity", "north", "-geometry", `+0+${M}`, "-compose", "Over", "-composite",
      p("stills.png"), "-gravity", "north", "-geometry", "+0+230", "-compose", "Over", "-composite",
      p("synopsis.png"), "-gravity", "north", "-geometry", `+0+${230 + Math.floor(cw * 9 / 16) + 60}`, "-compose", "Over", "-composite",
      p("credits.png"), "-gravity", "south", "-geometry", `+0+${M + 140}`, "-compose", "Over", "-composite",
      p("rating.png"), "-gravity", "southwest", "-geometry", `+${M}+${M}`, "-compose", "Over", "-composite",
      "(", o.mono, "-resize", "420x110", ")", "-gravity", "southeast", "-geometry", `+${M}+${M + 10}`, "-compose", "Over", "-composite",
      p("back.png")
    ]);
    await magick([p("back.png"), p("spine.png"), p("front.png"), "+append", "-quality", "90", o.out]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function exists(f: string): Promise<boolean> {
  try { await readFile(f); return true; } catch { return false; }
}
export { writeFile };

// A drawn logo (#128): the image model letters the title from the art
// director's brief, on flat green that's keyed out; a reader checks the
// spelling, and a take that's wrong is redrawn. Two shapes: one line, stacked.
export const LOGO_KEY = "#00ff00";
export interface DrawLogo {
  generate: (req: { prompt: string; aspectRatio: string; imageSize: string }) => Promise<{ data: Buffer; mimeType: string }>;
  read: (image: { data: Buffer; mimeType: string }) => Promise<string>;  // the text it shows
}

// Whether a keyed logo is clean: its border fully transparent, and almost no
// opaque green (a halo or an un-keyed patch) anywhere.
export async function keyProblem(file: string): Promise<string | undefined> {
  // The outer 2% on every side should be fully transparent.
  const strips = ["100%x2%+0+0", "100%x2%+0+0", "2%x100%+0+0", "2%x100%+0+0"];
  const sides = ["north", "south", "west", "east"];
  for (const [i, crop] of strips.entries()) {
    const { stdout } = await magick([file, "-alpha", "extract", "-gravity", sides[i], "-crop", crop, "+repage", "-format", "%[fx:maxima]", "info:"]);
    if (Number(stdout) > 0.1) return "the background didn't key out at the edges";
  }
  const { stdout: green } = await magick([file, "-fx", "a>0.5 && g>r+0.25 && g>b+0.25 ? 1 : 0", "-format", "%[fx:mean]", "info:"]);
  if (Number(green) > 0.004) return "green left after keying";
  return undefined;
}

export const sameLetters = (a: string, b: string) => {
  const norm = (x: string) => x.toUpperCase().replace(/[’']/g, "'").replace(/[^A-Z0-9']/g, "");
  return norm(a) === norm(b);
};

export async function drawLogo(o: { title: string; brief: string; draw: DrawLogo; outDir: string; tries?: number; log?: (m: string) => void }): Promise<{ logo: string; stacked: string; mono: string } | undefined> {
  const words = o.title.trim().split(/\s+/);
  const half = Math.max(1, Math.round(words.length / 2));
  const shapes = [
    { file: "logo", aspectRatio: "21:9", layout: "on a single line" },
    { file: "logo-stacked", aspectRatio: "4:3", layout: words.length > 1 ? `on two lines: "${words.slice(0, half).join(" ").toUpperCase()}" above "${words.slice(half).join(" ").toUpperCase()}"` : "on a single line" }
  ];
  await mkdir(o.outDir, { recursive: true });
  const made: Record<string, string> = {};
  for (const shape of shapes) {
    let ok = false;
    for (let t = 0; t < (o.tries ?? 3) && !ok; t++) {
      const img = await o.draw.generate({
        aspectRatio: shape.aspectRatio, imageSize: "2K",
        prompt: `A film title logo. ${o.brief}\n\nThe lettering reads exactly "${o.title.toUpperCase()}", ${shape.layout}, spelled exactly so, with no other words, letters or text anywhere. Centered, filling most of the width, on a perfectly flat, pure bright green (${LOGO_KEY}) background with nothing else: no scene, no frame, no shadow on the background.`
      });
      const heard = await o.draw.read(img);
      if (!sameLetters(heard, o.title)) { o.log?.(`logo (${shape.file}) reads "${heard.trim()}" — redrawing`); continue; }
      const raw = join(o.outDir, `${shape.file}-raw.png`);
      await writeFile(raw, img.data);
      const out = join(o.outDir, `${shape.file}.png`);
      // Key out the green, pull the green fringe off the edges, trim.
      await magick([raw, "-fuzz", "28%", "-transparent", LOGO_KEY, "-channel", "G", "-fx", "min(g,(r+b)/2+0.08)", "+channel", out]);
      // The key held only if the background came back flat: the edges all clear,
      // and next to no strong green left anywhere. Otherwise, draw it again.
      const problem = await keyProblem(out);
      await rm(raw, { force: true });
      if (problem) { o.log?.(`logo (${shape.file}): ${problem} — redrawing`); continue; }
      await magick([out, "-trim", "+repage", out]);
      made[shape.file] = out;
      ok = true;
    }
    if (!ok) return undefined;
  }
  const mono = join(o.outDir, "logo-mono.png");
  await magick([made.logo, "-alpha", "extract", "-background", "white", "-alpha", "shape", mono]);
  return { logo: made.logo, stacked: made["logo-stacked"], mono };
}
