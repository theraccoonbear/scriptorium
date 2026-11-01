---
name: spec-art
description: Make a set of props or assets (item icons, sprites, game or UI art) from the author's reference art, through Scriptorium's real image pipeline, with no audiobook or film. Use when someone wants spec art, item art, icons or sprites for an existing project rather than a story.
---

# Spec art: a set of props from reference art

The art comes from the real pipeline: art director, reference jobs, inspector, takes, ledger, review and approvals. The story here is one short scene that exists to carry the props. Nobody needs to read it.

**With Docker** (the setup skill decides), every `npm run <command> -- <args>` here is `docker compose run --rm scriptorium <command> <args>`.

**Never spend without a pitch and a yes.** Pitch each paid step and say the cost. Treat every `make` below as paid.

**Always pass `--only`.** A bare `make` goes on to the audiobook and video. Never use `--from`, and don't run `--only art` without `--edit`: it would draw the shots and cover.

## 1. Gather

- **The items:** one line each on what the art must show.
- **Reference art:** the author's own files. Read them from wherever they are. In `contexts/`, never write, copy or move anything.
- **Target sizes:** the exact pixel sizes the art will be used at. Check the project's code if it's available.

## 2. Separate designs for sizes far apart

A design holds up within about a factor of two of its size. Past that, a small version is not a shrunken big one: it needs fewer shapes, fewer colours and a bolder silhouette. So for sizes far apart, list **two props per item**, each with its own description, and don't reduce one to make the other. For example, `lantern_inline` at 13 px and `lantern_large` at 32 px are two drawings.

**Check the models first.** Run `npm run doctor`, and see "Keeping models fresh" in the setup skill. If a model or key fails at any point, stop and tell the author. Never swap in another provider or model for the art director, or any creative or judgement role, without their yes.

## 3. The story file

Keep it in `stories/<slug>.json`. `out` must not be under `runs/_scratch`, or the budget won't count the spend.

```json
{
  "config": "../story.recommended.config.json",
  "out": "../runs/<slug>",
  "title": "<project> props",
  "premise": "A quartermaster lays out the stock for one shift.",
  "setting": "<where the items are sold or used>",
  "scenes": 1,
  "sceneWords": { "min": 120, "max": 200 },
  "maxAttempts": 3,
  "critic": "off",
  "budget": { "usd": 3 },
  "artStyle": "<one or two sentences on medium, palette, light, line and detail, taken from the reference art>",
  "direction": {
    "creator": "<character and place names that share no word with any item>",
    "artdirector": "One square, centred object on a plain background, overriding your framing and camera rules.",
    "artist": "A game sprite on a plain flat magenta (#FF00FF) background. Pixel art and the magenta are intended."
  },
  "props": [
    { "id": "lantern_inline", "name": "Lantern (inline)", "sprite": 13, "description": "...", "drawing": "A bold silhouette in four colours, two shapes at most." },
    { "id": "lantern_large", "name": "Lantern (large)", "sprite": 32, "description": "...", "drawing": "Full shading and materials." }
  ],
  "styleReferences": ["../contexts/<project>/<art>.png"],
  "referenceKinds": ["prop"]
}
```

- **`props`:** the complete list. Ids are snake_case. The art director gets the name, `description` and `drawing`, and not the context files, so the description must carry everything.
- **`sprite`:** the square size it's drawn for, in pixels. It tells the art director, artist and inspector, and is the target in step 7.
- **`drawing`:** how to draw this one. Spell out how few pixels and colours a small prop has.
- **`styleReferences`:** up to `artist.maxReferences` images (3 by default). Choose the art closest to where the props will appear, and leave out logos and anything in another style. The art director reads text only, so put what you see in them into `artStyle`.
- **`referenceKinds`:** `["prop"]` skips the portraits and places.
- **Config:** to keep pixel edges, give this story its own copy of the config, or put the config inline in `"config"`, with `"referenceSize": 0` and `"inspectSize": 0` in its `artist`. The story file's `artist` doesn't hold these. Cheaper models are fine for the roles nobody reads here, such as the writer and director on this throwaway scene. Hold the art director to a known-good model: its prompts are the art. A shared config stays as it is.
- **Images:** describe only what should be there. Don't write what to leave out.

## 4. Pilot one item at both sizes

A run doesn't pause after its first image, so a bad style would cost the whole set. Make a story file with `out` of its own and just one item's props (both sizes), and run steps 5 to 7 on it. Adopt it only when both sizes look right. Use a new `out` for the full set: a prop list can't change under a story in progress.

**Anchors:** with `sprite` set, each size has its own style anchor, the first prop of that size by id. The big design never anchors the small one, so detail doesn't leak down. The sizes share the art style and the author's references instead, so compare them side by side in the pilot.

## 5. Story, then references

```bash
npm run pitch -- <story.json> --only story
npm run make -- <story.json> --only story
npm run pitch -- <story.json> --only refs
npm run make -- <story.json> --only refs
```

After the story step, read the character and location names in `<run>/story.md`. A name that shares a word with an item ("Nova" and a nova bomb) is stripped from image prompts and corrupts them. Rename a character in `<run>/characters.json`. A location can't be renamed, so make a new run with different direction.

## 6. Review and fix

```bash
npm run review -- <story.json> refs
```

Show the author `<run>/review/refs-props.jpg`. Read `<run>/art/art.json` too, not just the pictures: an image with `"accepted": false` ran out of attempts and was kept anyway, and `issues` says why. A rejection for something intended (pixels, magenta) goes in `direction.artist`.

```bash
npm run make -- <story.json> --only refs --redo prop:<id> --note "what's wrong and what it should be"
npm run make -- <story.json> --only art --edit prop-<id> --note "the one change"
npm run approve -- <story.json> prop-<id>
```

A redo re-plans the prompt. An edit changes one detail of the image. Approve what's right: approved art is never redrawn. Changing `drawing`, `styleReferences` or the art direction redraws what isn't approved, and the pitch counts it. `npm run spend -- <story.json>` shows what was spent.

## 7. Sprites (free)

```bash
npm run sprites -- <story.json>
```

This finds the pixel grid the model really drew on, reads the cells back, removes the background and trims. Each prop lands on its own `sprite` size, centred, with nothing resized.

- **Output:** `<run>/sprites/<size>px/<id>.png`, the true sprites in `<run>/sprites/native/`, `sprites.json`, and enlarged sheets in `<run>/review/sprites-<size>px.png`.
- **Flags:** read every one. A sprite too big for its target is not written, and the command exits non-zero: redraw it simpler with a note, and don't resize it. "No clean pixel grid" also means a redraw.
- **Options:** `--sizes 16,48` serves art with no `sprite`. `--background`, `--tolerance` and `--colors` tune the keying and palette.

Show the sheets on a background like the one the art will sit on: near-black outlines vanish on dark colours.

### Art not on a strict grid

Image models don't honour very small grids: asked for 13 or 32 cells, they draw much finer, and a very small design rarely survives. Pilot this. If the small size fails, draw the set as detailed art, with no `sprite`, and reduce it or let the author adapt it by hand. Don't spend more retries on a grid the model won't draw.

Image models also return flat images: the background is painted pixels with no alpha, and blending it into the edges is what makes a fringe. So never shrink the image with its background still on.

```bash
npm run sprites -- <story.json> --cutout
npm run sprites -- <story.json> --reduce 32,64
```

- **`--cutout`:** keys the background at full size and shaves the fringe, writing real-alpha PNGs to `<run>/sprites/cutout/`. `--fuzz` (default 28) and `--erode` (default 2) tune it. Check thin glows and rings, which keying can eat.
- **`--reduce`:** also writes reductions of those cut-outs to `<run>/sprites/reduced/<size>px/`, with sheets in `review/sprites-reduced-<size>px.png`. They're averaged, so softer than true-grid sprites, and they're kept apart from them.
