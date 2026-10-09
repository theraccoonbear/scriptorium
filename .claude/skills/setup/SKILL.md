---
name: setup
description: Set up Scriptorium for a new user — explain what it makes, get and install the right API keys, check them with `npm run doctor`, and finish with a free mock run. Use when someone is new to Scriptorium, asks how to set it up or which keys they need, asks what their keys can make, or a run fails on a missing key or tool.
---

# Setting up Scriptorium

Walk the user from nothing to a working setup. Go one step at a time and wait for them between steps. Keep it short; they can always ask for more.

## 1. What Scriptorium makes

Explain this in a few lines, then ask what they want to make: a story only, an illustrated audiobook, or the full video. That decides which keys they need.

Scriptorium turns a premise, or the author's own notes, into a finished story. It goes phase by phase:

| Phase | What it makes | Powered by |
|---|---|---|
| Story | the scenes, written, critiqued and revised | Claude (Anthropic), or OpenAI / OpenCode Go |
| Characters | a character sheet the author can edit | free |
| Portraits & shots | reference portraits, then illustrations for each scene, each checked by a vision model | Gemini (images and checks) |
| Voices | a cast voice per speaker, auditioned in a reel | Gemini TTS (acted), or Kokoro (local and free, plainer) |
| Audiobook | every scene narrated and acted | Gemini TTS or Kokoro |
| Music | a score under the narration | Gemini Lyria |
| Video | shots, narration, music, titles and subtitles in one MP4 | ffmpeg (local, free) |

The `produce` skill runs these phases with the author once setup is done.

## 2. Local tools, or Docker

Scriptorium needs Node 24+, ffmpeg and ImageMagick 7. Docker (or Podman) packs all of them into one image, so **Docker is the only thing to install**. Check what's there: `node --version; ffmpeg -version; magick -version; docker --version; podman --version`.
- **Node, ffmpeg and magick all present:** run locally. Commands are `npm run <command> -- <args>`; run `npm install` first if `node_modules/` is missing.
- **Otherwise, use Docker,** and don't install the rest one by one. If it's missing too, they install Docker Desktop (macOS, Windows) or `docker`/`podman` (Linux). Then build the image once: `docker compose build`, about 1 GB and a few minutes. From then on, **every command in these skills runs through Docker**: `npm run <command> -- <args>` becomes `docker compose run --rm scriptorium <command> <args>`. For example:
  - `npm run make -- stories/x.json --only story` → `docker compose run --rm scriptorium make stories/x.json --only story`;
  - with rootless Podman, `podman-compose -f docker-compose.yml -f compose.podman.yml run --rm scriptorium …`.
- **Files are shared:** stories, contexts, runs and `.env` stay in this folder; the container mounts it. If their user ID isn't 1000 (`id -u`), they `export SCRIPTORIUM_UID=$(id -u) SCRIPTORIUM_GID=$(id -g)` first, so the files are theirs.

Say which way it'll run, and use it consistently from here on.

## 3. Check what's there

Run `npm run doctor`, or its Docker form (free: it only lists each service's models). Show the user the checklist as it prints:
- ✓ ready
- ✗ broken or missing
- ○ not set up, or optional

## 4. Keys

Ask only for the keys their goal needs:

| Key | Gets them | Where |
|---|---|---|
| `ANTHROPIC_API_KEY` | writing (every Claude role) | https://console.anthropic.com/settings/keys |
| `GEMINI_API_KEY` | images, image checks, acted voices, music | https://aistudio.google.com/apikey |
| `OPENAI_API_KEY` | writing through OpenAI (`responses` providers) | https://platform.openai.com/api-keys |
| `OPENCODE_API_KEY` | writing through OpenCode Go (`opencode-go` providers) | https://opencode.ai |

- **Billing:** both main services need billing set up for real runs. Anthropic sells prepaid credits. Gemini's image, speech and music models need a key on a paid (billing-enabled) Google Cloud project. A free-tier key may list those models but fail when used. Say so: `doctor` can't tell.
- **Cost guide:**
  - Writing is about $1.50 a scene with Opus, much less with Haiku.
  - Images are about $0.05 each in batch mode.
  - Acted narration is about a cent a minute in batch mode.
  - `npm run pitch -- <story.json>` prices a story before anything is spent.
- **Writing the keys:** have the user put keys in `.env` at the repo root. `cp .env.example .env`, then they fill it in. Their `.env` always wins over the shell (`src/env.ts`), and it's git-ignored.
  - **Never ask them to paste a key into the chat.** If they do anyway, write it to `.env` without repeating it back, and suggest they rotate it later.
  - Never print `.env`.

After each key, re-run `npm run doctor` and show the changed rows.

## 5. Tools

With Docker, the image has every tool, so skip this step. Run locally, `doctor` checks them. Give the install command for their OS when one is ✗:
- **ffmpeg / ffprobe:** required for audio mixing, video and reference images.
  - Fedora: `sudo dnf install ffmpeg`
  - Debian/Ubuntu: `sudo apt install ffmpeg`
  - macOS: `brew install ffmpeg`
- **ImageMagick 7 (`magick`):** needed for review contact sheets (`imagemagick` on all three).
- **fontconfig (`fc-match`):** optional. Only needed for title fonts beyond the bundled EB Garamond and Cinzel.
- **Kokoro:** comes with `npm install`. Its voice model downloads on first use.

For commands needing sudo, suggest they type `! <command>` themselves.

## 6. A first run

1. **Free mock run:** `npm run make -- stories/mock.json` runs the whole pipeline with mock models and placeholder art, and writes `runs/mock-story/video/story.mp4` in about a minute. It needs no keys; Kokoro downloads its voice model the first time. It proves the install works.
2. **Their own story:** hand over to the **new-story** skill, the production wizard. It shapes their idea and audience into a story file, checks it with `npm run doctor -- stories/<name>.json`, and walks them through making it.

## Later

When any phase fails on a missing key, a rejected key or a missing tool, run `npm run doctor -- <story.json>` and fix what it marks ✗.
