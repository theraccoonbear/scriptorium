# scriptorium

Agentic narrative scaffolding. Four roles over swappable models:

- **Director** plans each scene as a JSON beat spec (never prose).
- **Writer** renders the beat in the POV character's voice sheet.
- **Critic** checks the draft against the bible; rejections trigger rewrites.
- **Archivist** is the only role that changes the story bible (via JSON patches).

State lives in an append-only JSONL event log. The bible is always rebuilt by replay, so you can resume, rewind and fork.

## Use

    npm test
    node src/cli.js run  --config story.config.json --out runs/demo
    node src/cli.js fork --from runs/demo --at 3 --out runs/demo-b
    node src/cli.js run  --config story.config.json --out runs/demo-b --scenes 10
    node src/cli.js show --out runs/demo-b
    node src/cli.js bible --out runs/demo-b
    npm run art -- --out runs/demo-b      # re-render or retry a run's images
    npm run artdirect -- --out runs/demo-b  # redo shots + cover for an existing run, then render
    npm run video -- --out runs/demo-b      # art + audiobook -> video/story.mp4

## Art

With an `artdirector` role configured, each committed scene is broken into shots — about one per 110 words of narration (~45s read aloud; `artWordsPerShot` in the config), 4–20 per scene — each anchored to the paragraph where it comes on screen. The finished run also gets a `cover_art` prompt, and `run` renders them to images automatically when the story finishes (a rendering failure only warns; the story is already written). The images land in `<run>/art/` as `scene-NN-SS.jpg` (scene NN, shot SS) and `cover.jpg` (the extension follows whatever image type the model returns), rendered using the `artist` block of the config: an `image` backend (Gemini, `GEMINI_API_KEY`) and an optional `inspector` that checks each image against its prompt and the earlier images, and asks for a regeneration with a revised prompt, up to `maxAttempts` per image. Earlier images are passed as references so characters and style stay consistent. `art/art.json` records each image's prompt, attempts, unresolved issues, and its `sceneIndex` / `startParagraph`. The audiobook writes `audiobook/timings.json` with each scene's duration and every paragraph's start time (`paragraphStarts`, same paragraph numbering), so video assembly can bring each shot on screen when the narration reaches it. Re-running `art` skips images whose prompt is unchanged (`--force` re-renders everything). Set `"inspector": null` to skip review, or `"type": "mock"` for offline placeholders.

## Configure

`story.config.json` maps each role to a provider. Types: `mock` (offline, deterministic), `anthropic`, `openai` (any OpenAI-compatible server, including Ollama and llama.cpp). Point `writer` at a local TinyLM server and `director` at a strong model to mix tiers.

## OpenCode Go

    export OPENCODE_API_KEY=...
    node src/cli.js models --config story.opencode-go.config.json --provider go-director
    node src/cli.js run --config story.opencode-go.config.json --out runs/go

Provider type `opencode-go` takes `model` and `api`, the wire format that model uses: `chat` (default, OpenAI chat completions), `messages` (Anthropic format) or `responses` (OpenAI Responses). Base URL is `https://opencode.ai/zen/go/v1`. Check each model's format in the OpenCode Go docs table, and confirm ids with the `models` command; the ids in the example config are unverified.

All providers strip `<think>` blocks, retry on 429/5xx with backoff, and fail loudly on empty completions (raise `maxTokens` for reasoning models).

## Procedural pressure

- Tension curve rises to about 75% of the story, then falls.
- A seeded complication table injects a required complication per scene.
- Chekhov ledger: setups unpaid after `overdueAfter` scenes are forced into the director's payoffs; all are paid in the final scene.

## Next steps

- LLM-based hierarchical summarization (current compaction is deterministic concatenation).
- Streaming and per-role token budgets.
- Multiple writer voices per scene and a "twist" role that can propose retcons for archivist approval.

## Video

`video --out <run>` turns a run's art and audiobook into `video/story.mp4` (1080p30 H.264 + AAC, ready for YouTube), `video/thumbnail.jpg` (1280×720, from the cover) and `video/story.srt` (one subtitle cue per sentence). It needs `ffmpeg` on the PATH and runs after `art` and `audiobook`.

Each shot comes on screen when the narration reaches its paragraph (`art.json` `startParagraph` × `timings.json` `paragraphStarts`) and holds until the next shot, with a slow Ken Burns move (zoom in, zoom out, pan left or right — chosen per shot, never the same twice in a row) and a 1.5s crossfade. Shots that would be on screen for under 6s are dropped and the previous one holds. The cover opens the video for 6s and a 1.5s black pause separates scenes. Everything is frame-exact at 30fps and each scene's audio is padded/trimmed to its frame length, so the pictures can't drift from the narration. The plan is written to `video/timeline.json` (with warnings, e.g. images the inspector never accepted) before rendering. Each scene renders in one ffmpeg pass at about real time on a CPU; scenes are cached in `video/cache.json` and only re-rendered when their images or timing change (`--force` re-renders all).
