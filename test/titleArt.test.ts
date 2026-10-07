import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boxArt, renderLogo, shelfCover } from "../src/titleArt.ts";

// Issue #128: the title logo is typeset in code (exact spelling); the shelf
// covers and the box are composited from the art. Needs ImageMagick 7.

const hasMagick = (() => { try { execFileSync("magick", ["-version"]); return true; } catch { return false; } })();
const size = (f: string) => execFileSync("magick", ["identify", "-format", "%wx%h", f]).toString();

test("the logo, its stacked and one-colour versions; covers at streaming sizes; the box as back, spine and front", { skip: !hasMagick && "ImageMagick 7 (magick) not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-logo-"));
  const { logo, stacked, mono } = await renderLogo({ title: "Rantoul's Mushrooms", subtitle: "Part 1", outDir: dir });
  const [lw, lh] = size(logo).split("x").map(Number);
  const [sw, sh] = size(stacked).split("x").map(Number);
  assert.ok(lw > lh * 3, "one line: wide");
  assert.ok(sh > lh && sw < lw, "stacked: taller, narrower");
  assert.equal(execFileSync("magick", ["identify", "-format", "%[channels]", mono]).toString().includes("a"), true, "transparent");
  const art = join(dir, "art.jpg");
  execFileSync("magick", ["-size", "1696x2528", "gradient:#445-#a87", art]);
  await shelfCover(art, stacked, join(dir, "cover.jpg"), [2000, 3000], 0.86);
  assert.equal(size(join(dir, "cover.jpg")), "2000x3000");
  await boxArt({ front: join(dir, "cover.jpg"), mono, stills: [art, art, art, art], copy: { tagline: "A tagline.", synopsis: "A synopsis.", credits: "A Mock Production" }, out: join(dir, "box.jpg") });
  assert.equal(size(join(dir, "box.jpg")), "2640x1800", "back 1200 + spine 240 + front 1200");
});

test("a drawn logo's key is checked: a flat green keys clean; a gradient background is caught (and redrawn)", { skip: !hasMagick && "ImageMagick 7 (magick) not installed" }, async () => {
  const { keyProblem, sameLetters } = await import("../src/titleArt.ts");
  const dir = await mkdtemp(join(tmpdir(), "scriptorium-key-"));
  const key = (bg: string, name: string) => {
    execFileSync("magick", ["-size", "600x300", bg, "-fill", "gold", "-pointsize", "80", "-annotate", "+150+180", "HI", join(dir, `${name}.png`)]);
    execFileSync("magick", [join(dir, `${name}.png`), "-fuzz", "28%", "-transparent", "#00ff00", join(dir, `${name}-k.png`)]);
    return join(dir, `${name}-k.png`);
  };
  assert.equal(await keyProblem(key("xc:#00ff00", "flat")), undefined);
  assert.match((await keyProblem(key("gradient:#00ff00-#2a7a10", "grad"))) ?? "", /didn't key out/);
  assert.ok(sameLetters("Rantoul’s Mushrooms\n", "RANTOUL'S MUSHROOMS"), "curly apostrophes, case and spacing don't matter");
  assert.ok(!sameLetters("RANTOUL'S MUSHROOOMS", "Rantoul's Mushrooms"), "letters do");
});
