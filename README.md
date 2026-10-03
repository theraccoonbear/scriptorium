# scriptorium

![Scriptorium Stories](assets/readme-banner.jpg)

A gated, multi-agent story engine that turns a premise into a narrated, illustrated video. Language-model roles plan, write, review and record each scene; nothing enters the story until a reviewer approves it. A finished run can then become a multi-voice audiobook, a set of consistent illustrations, and a YouTube-ready video with Ken Burns pans and subtitles.

```
worldbuilder → worldgate → creator/director → beatgate → writer → continuist ∥ critic
  → archivist → patchgate → commit → art director (references, shots, cover)
                                         ↓ after the run
                              artist (images) · audiobook (Kokoro) · video (ffmpeg)
```

All state lives in an append-only event log (`<run>/events.jsonl`). The story bible is always rebuilt by replaying it, so you can resume, rewind and fork a story at any scene.

## Quick start

```bash
npm install
npm run story:mock -- --scenes 3          # offline: mock models, placeholder art
```

For real runs, put your keys in `.env`:

```
OPENCODE_API_KEY=...     # if your config uses opencode-go providers
ANTHROPIC_API_KEY=...    # if your config uses anthropic providers
GEMINI_API_KEY=...       # image generation and inspection
```

The easiest way to make a story is a **story file**: one JSON file holding everything about a story, which `make` turns into a finished video:

```jsonc
// stories/keeper.json — paths are relative to this file
{
  "config": "../story.opencode-go.config.json",  // or the config inline
  "out": "../runs/keeper",                        // a fixed run directory
  "premise": "a lighthouse keeper finds a letter addressed to her",
  "setting": "a remote northern coast, 1890s",
  "context": ["../contexts/keeper.md", "../contexts/coast.md"],
  "scenes": 3,
  "maxAttempts": "unlimited",
  "speakerTags": true,
  "audiobook": { "narratorVoice": "af_heart", "language": "en", "voiceGenders": {} }
}
```

```bash
npm run make -- stories/keeper.json                    # story → art → audiobook → video
npm run make -- stories/keeper.json --from audiobook   # just the later steps
npm run make -- stories/keeper.json --only art,video
```

Story files can also steer each creative layer directly. `artStyle` fixes the art style, overriding the Creator's choice. `direction` holds notes for individual layers, each added to that layer's prompts as instructions it must follow:

```jsonc
  "artStyle": "Cinematic, photorealistic, dramatic: like a frame from a fantasy action film",
  "direction": {
    "writer": "Keep fights fast and physical; short sentences in action.",
    "artdirector": "Favor low angles and dynamic action framing.",
    "artist": "Shallow depth of field, film grain, no painterly look."
  }
```

The layers are `contextgate`, `worldbuilder`, `worldgate`, `creator`, `director`, `beatgate`, `writer`, `continuist`, `critic`, `archivist`, `patchgate`, `artdirector` and `artist`. `artist` notes go with every image request and inspection. A misspelled layer is an error rather than silently ignored. Use context files for story facts, and `direction` for how each layer should work.

Re-running `make` finishes whatever's missing: the story resumes from its event log, and art, audio and video skip finished work. That covers a crash, running out of credits, or a deleted image you want regenerated. The run records its premise, setting, context and speaker tags, and `make` refuses to change them for a story already in progress unless you pass `--force`. Use a new `out` for a new story. `stories/mock.json` runs the whole pipeline offline; `stories/example.json` is a real one.

The individual commands below still work for one-off steps.

## Commands

| Command | What it does |
|---|---|
| `make <story.json> [--only <steps>] [--from <step>] [--force]` | Run a story file's pipeline (`story`, `art`, `audiobook`, `video`), finishing whatever's missing. `--force` allows changed story settings for a story in progress. |
| `run --config <file> [--out <prefix>] [--scenes N] [--premise ".."] [--setting ".."] [--context <file.md> …] [--max-attempts N\|unlimited] [--speaker-tags]` | Generate a story, then render its art. `--out` is a prefix (`runs/keeper` → `runs/keeper-<timestamp>`); pointing it at an existing run directory resumes that run. |
| `fork --from <dir> --at <sceneCount> --out <dir>` | Branch a run after a given scene. |
| `show --out <dir>` / `bible --out <dir>` | Print the story as markdown / the current bible as JSON. |
| `audiobook --out <dir> [--narrator-voice <id>] [--language <prefix>] [--voice-gender id=male,…] [--exclude-voices id,…] [--force]` | Narrate each scene to `audiobook/scene-NN.wav` with local Kokoro TTS. Scenes whose text and voice settings are unchanged are skipped. |
| `art --out <dir> [--config <file>] [--force]` | Render (or resume/retry) a run's images. Unchanged images are skipped. |
| `artdirect --out <dir> [--config <file>] [--redo kind:id,…] [--note ".."]` | Redo the art direction for an existing run (references, shots, cover), then render. |
| `video --out <dir> [--force]` | Assemble art + audiobook into `video/story.mp4`. |
| `cast <story.json> [--as "..."]` | Preview a story's cast: describe each member from their photos and render one portrait each into `<run>/cast/preview/`. |
| `cost --out <dir>` | What a run has spent, by step, role and model. |
| `models --config <file> --provider <name>` | List the model ids a provider serves. |

npm shortcuts: `make`, `story` (real config), `story:mock`, `art`, `artdirect`, `video`, `test`, `typecheck`. Run `node src/cli.ts` with no command for the full usage text.

## The roles

| Role | Job | Required |
|---|---|---|
| **contextgate** | Before anything is generated, checks the author's context files for contradictions between them or with the premise. | optional (falls back to the continuist) |
| **worldbuilder** | Names characters and places that belong in the setting. | optional |
| **creator** | Builds the foundation: premise, tone, **art style**, cast (with gender), locations, **key objects**, threads, and scene 1's beat. Runs on the `director`'s provider. | — |
| **director** | Plans each later scene as a JSON beat spec — never prose. | yes |
| **writer** | Writes the scene in the POV character's voice, inside a word band. | yes |
| **editor** | Line-edits each draft before review: hunts machine-prose tics, trims about 10%, and keeps every event, name and speaker tag. An edit that guts or pads the scene is discarded. | optional |
| **continuist** | Blocks continuity and canon errors: POV, timeline, constraints, setups, key-object contradictions. | yes |
| **critic** | Blocks craft problems: pacing, telling-not-showing, sensory detail, voice drift, recurring style tics. | optional |
| **archivist** | The only role that changes the bible, via JSON patches. | yes |
| **worldgate / beatgate / patchgate** | Review the worldbuilder's output, each beat spec, and each bible patch before they're used. | optional (fall back to the continuist / critic) |
| **artdirector** | After each scene: a sequence of shots, plus canonical visual references for what they show; at the end, the cover. | optional |

Every role is mapped to a provider in the config, so each can run on a different model.

### The bible

The bible holds the premise, tone, **art style**, characters (traits, goal, voice sheet, gender), locations, **key objects**, threads, the Chekhov ledger of open setups, resolved decisions, and rolling scene summaries. Some of it is canon that can't be rewritten later: a character's recorded gender, and a key object's physical description. A key object is a signature item such as an instrument, a relic or a letter. Its spec gives size and width, shape, materials and how it's held. The writer must depict it as specced, and the continuist flags any contradiction.

### The review loop

The continuist and the critic review every draft in parallel, and both must approve. A rejected draft climbs a ladder:

1. Three surgical revisions.
2. A fresh draft from scratch.
3. A regenerated beat spec, on the theory that the spec is the problem.

A reviewer that only repeats complaints it already made counts as approving. Repeats are matched by meaning, not wording. A passage flagged in three drafts, by either reviewer, skips straight to a new beat: that's reviewers disagreeing, or a demand that can't be met. The continuist stays in its lane, and craft complaints from it are dropped. `--max-attempts` caps the drafts per scene (default 3). `unlimited` keeps going until both reviewers approve.

`"critic"` in the config or story file sets how much say the critic has:

- `"blocking"` (the default): both reviewers must approve, as above.
- `"advisory"`: the critic never holds a scene back. Only the continuist can reject a draft. When it does, the writer gets the critic's notes as optional suggestions alongside the continuity fixes. A draft with clean continuity commits, and any critic notes are dropped.
- `"off"`: the critic isn't called at all. This saves its calls.

### Context files

`--context <file.md>` hands your own notes to every role that plans or reviews the story: characters, places, history, and how things really work. Use it for facts the models get wrong, such as how an unusual object is held or played. See `contexts/` for examples.

`--context` can be repeated to mix and match, for example `--context world.md --context hero.md --context rival.md`. Each file goes in under a `### from <file>` header, so every role can tell where a detail came from. The run remembers its context, so resuming without `--context` uses the same files.

Before anything is generated, the **context gate** checks the combined files. It looks for hard contradictions: two files disagreeing about a fact, a file conflicting with the premise or setting, or a file contradicting itself. If it finds one, the run stops before spending anything and lists each conflict with both sides quoted. Mixing that's merely unusual, such as a character from one file dropped into another file's world, is the point and passes.

### Starring you: a cast from photos

A story file can list a **cast**: real people and animals who star in the story, each with one or more photos. Photo paths are relative to the story file.

```jsonc
  "cast": [
    { "name": "Don", "photos": ["../cast/don-1.jpg", "../cast/don-2.jpg"], "notes": "he/him; the reluctant hero" },
    { "name": "Biscuit", "photos": "../cast/biscuit.jpg", "notes": "Don's corgi, braver than he is" }
  ]
```

- **Casting.** Before the story starts, Gemini looks at each member's photos and writes a lasting description: build, age range, hair and face, or breed and markings. A member is described again only when their name, notes or photos change.
- **The story.** The cast joins the author context, so the story writes everyone in under their own names. A title or surname is fine, as in "Sir Don of the Hills".
- **The art.** Each cast member's reference portrait is drawn **from their photos**, in the story's art style and in the costume the story gives them. Every shot is built from those portraits.
- **Likeness checks.** The usual rule that characters must not look like real people doesn't apply to the cast. The inspector checks the reverse instead: that each cast member is recognizably the person or animal in the photos.

Keep photos in a top-level `cast/` folder, which git ignores so they are never committed. They are copied into the run's `cast/` folder, and are sent to Gemini to describe and draw the cast, but go nowhere else. Two or three clear, well-lit photos, with at least one showing the face, work best. Use `.jpg`, `.png` or `.webp` files.

To check the likeness before running a whole story, preview the cast:

```bash
npm run cast -- stories/us.json                                  # one portrait each, in the story's art style
npm run cast -- stories/us.json --as "adventurers in leather armor"
```

This describes everyone, recording the descriptions in the run so the story reuses them. It then renders one portrait each from the photos into `<run>/cast/preview/`. That costs a few cents per member. If a portrait isn't right, swap or add photos, or adjust `notes`, and preview again.

## Audiobook

`audiobook` narrates each scene with [Kokoro](https://github.com/hexgrad/kokoro), running locally, so it needs no API key and can run offline. The first run downloads the model.

- **Multiple voices:** with `--speaker-tags` on `run`, the writer tags every paragraph with its speaker. Each character then gets their own voice, quoted dialogue is voiced by its speaker, and narration is read by the narrator.
- **Gender-matched voices:** a character whose gender is known gets a voice of that gender. Use `--voice-gender` to set genders for older runs.
- **Voice curation:** `"kokoroVoices": { "exclude": ["am_adam"] }` in a story file's `audiobook` block (or `--exclude-voices`) keeps weak or overused voices out. An `include` list instead limits the cast to exactly those voices.
- **Chosen voices:** `"characterVoices": { "osmagus": "bm_george" }` in the `audiobook` block (or `--character-voice osmagus=bm_george`) gives a character the voice you pick, by bible id. Nobody else is assigned that voice.
- **Timings:** `audiobook/timings.json` records each scene's duration and the start time of every paragraph. Video assembly uses it.
- **Acted dialogue (optional):** `--dialogue gemini`, or `"dialogue": "gemini"` in a story file's `audiobook` block, has Gemini TTS perform each character's lines while Kokoro keeps the narration. Each line gets the character's traits and voice sheet from the bible plus the narration just before it, in Gemini's structured prompt format, so only the line is spoken. Characters get distinct, gender-matched Gemini voices (override with `geminiVoices`). A failed or implausibly long reply is retried once, then falls back to that character's Kokoro voice. It costs cents per chapter (Gemini Flash TTS is about $0.81 per hour of generated audio at 2026 rates). `"narration": "gemini"` moves the narration over too.
- **Curating Kokoro voices:** `--exclude-voices af_bella,am_michael`, or `"kokoroVoices": { "exclude": […] }` / `{ "include": […] }` in a story file, drops weak or overused voices from character assignment.

## Art

The **art director** works in three layers:

1. **Art style.** The creator decides how the world is portrayed (medium, palette, light, line, detail, mood) along with the tone. Every image in the story uses it, and each story gets its own.
2. **Visual references.** One canonical image per **character** (full-body portrait), **location** (an establishing view with no people) and **key prop** (the object alone, at true proportions). Each is made once. Characters and locations get theirs the first time a shot shows them, so someone the story only mentions, such as a remembered grandmother or a figure in a mural, never costs a portrait. When a scene's shots introduce someone new, the shots are directed again once that person's reference exists, so the prompts use their canonical look. Characters' looks follow the bible and how the prose describes them. Props come from the bible's key objects, plus any others the art director finds in the prose.
3. **Shots.** About one per 110 words of narration (roughly 45 seconds read aloud; `artWordsPerShot`), 4–20 per scene. Each shot is anchored to the paragraph where it comes on screen and lists the characters, location and props it shows.

The **artist** renders them with Gemini (`GEMINI_API_KEY`). References render first. Each shot then gets the references for what it shows as labelled reference images: up to 3 characters, its location and 2 props, plus a recent image for style. An **inspector** checks each image against its prompt, its references and the art style, and flags anything that resembles a real person. It requests a revised regeneration up to `maxAttempts` times.

- **Request size:** reference images are sent downscaled (768 px), which keeps requests small.
- **Resuming:** everything is recorded in `art/art.json`, so a re-run skips finished images. Use `art` to resume after an interruption.

Output goes to `<run>/art/`: `character-<id>`, `location-<id>`, `prop-<id>`, `scene-NN-SS` (scene NN, shot SS) and `cover`.

**Fixing a bad reference:** run `artdirect --redo prop:<id> --note "what's wrong and what it should be"`. The note is passed to the art director as a correction from you.

## Video

`video` turns a run's art and audiobook into:

- `video/story.mp4`: 1080p30 H.264 + AAC, ready for YouTube
- `video/thumbnail.jpg`: 1280×720, from the cover
- `video/story.srt`: subtitles, one cue per sentence

It needs `ffmpeg` on the `PATH`.

**Timing:** each shot comes on screen when the narration reaches its paragraph, and holds until the next one. A shot held longer than 25 seconds gets several moves on its image. Shots that would show for under 6 seconds are dropped.

**Movement:** each shot gets an eased Ken Burns move: a zoom in or out, a pan, or a push toward one side. Consecutive shots never repeat a move, and shots crossfade over 1.5 seconds. The cover opens the video for 6 seconds, and a 1.5-second black pause separates scenes.

**Sync:** everything is frame-exact at 30 fps, so the pictures can't drift from the voice.

**Rendering:** the plan is written to `video/timeline.json` first, along with warnings, such as images the inspector never accepted. Each scene renders in one ffmpeg pass, several scenes at once (`--parallel`, default 3). Encoding uses NVIDIA's hardware encoder (NVENC) when available, about 3× faster than x264 at the same size and quality, and falls back to x264 (`--encoder auto|nvenc|x264`; a story file's `video` block takes the same options). Intermediate files go in `video/parts/` and are cached.

## Configure

A config file names the providers and maps each role to one. `story.config.json` is all-mock; `story.opencode-go.config.json` is the real setup.

Provider types:

- `mock`: offline and deterministic
- `anthropic`
- `openai`: any OpenAI-compatible server, including Ollama, llama.cpp and Gemini's OpenAI endpoint
- `responses`: OpenAI Responses
- `opencode-go`: takes `model` and `api` (`chat`, `messages` or `responses`); uses `OPENCODE_API_KEY`

All providers strip `<think>` blocks, retry on 429/5xx, and fail loudly on empty completions. For reasoning models, raise `maxTokens`.

Other config keys:

| Key | Default | Meaning |
|---|---|---|
| `scenes` | — | Scenes per story (or `--scenes`). |
| `maxRevisions` | 2 | Drafts per scene = this + 1 (or `--max-attempts`). |
| `sceneWords` | `{min:1200,max:1800}` | The writer's word band. The critic blocks more than 2× overshoot. |
| `overdueAfter` | 3 | Scenes before an open setup must be paid off. |
| `speakerTags` | false | Tag paragraphs by speaker for multi-voice audio (or `--speaker-tags`). |
| `artWordsPerShot` | 110 | Narration words per art shot. |
| `rngSeed` | 1 | Seeds the complication table. |
| `artist` | Gemini | `image` and `inspector` backends (`gemini` or `mock`; `"inspector": null` skips review), `maxAttempts`, `maxReferences`, `referenceSize`, `inspectSize`. |

## Spend

Every paid API call is logged to `<run>/usage.jsonl`. That covers the text roles, Gemini images, the image inspector and Gemini TTS; Kokoro and ffmpeg are local and free. Each entry records the step, role, model, token counts and estimated cost. `make` and the individual commands print what each step spent, `make` ends with a breakdown by step, role and model, and `cost --out <run>` reports on any run.

```jsonc
  "budget": { "usd": 10 },       // stop before the run spends more than this
  "maxDraftsPerScene": 20,       // stop a scene that won't settle, even with unlimited attempts
  "pricing": { "some-model": { "input": 0.5, "output": 2 } }   // USD per million tokens
```

The budget covers the whole run, including earlier sessions, since the log lives in the run folder. It's checked before every paid call. When it runs out, the run stops with a message; raise the budget and re-run the same command to continue. A stuck scene is never committed as-is: the run stops so you can adjust direction and resume.

Costs are estimates: token counts multiplied by a price table. The defaults are in `src/usage.ts`, dated 2026-10, and `pricing` overrides them. Models without a price are still logged by token count. The log keeps raw token counts, so costs can be recalculated when prices change.

## Procedural pressure

- **Tension curve:** rises to about 75% of the story, then falls.
- **Complications:** a seeded complication table adds a required complication to each scene.
- **Chekhov ledger:** setups left unpaid after `overdueAfter` scenes become required payoffs for the director. All of them are paid in the final scene.

## Development

```bash
npm test          # node --test
npm run typecheck # tsc, strict
npm run story:mock
```

TypeScript runs directly on Node with no build step. Contributor rules, including the invariants and the testing and PR conventions, are in [AGENTS.md](AGENTS.md).

## Not yet

- **Summaries:** earlier scenes are summarized by simple concatenation, not by a model.
- **Streaming and token budgets:** model responses aren't streamed, and there are no per-role token budgets.
- **Audio on the GPU:** Kokoro runs on the CPU only.
- **Publishing:** videos aren't uploaded automatically.
