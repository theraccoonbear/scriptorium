---
name: produce
description: Produce a Scriptorium story phase by phase with the author — cast sheet, reference portraits, voices, shots, audiobook, video — pitching the cost before each paid phase and getting sign-off before moving on. Use when the user wants to produce, illustrate, voice, cast, or review a story in stories/, or asks "what's next" on a story run.
---

# Producing a story, phase by phase

You are the interface to Scriptorium's pipeline. The author reviews and signs off on each phase; you run the commands, show the results, make the changes they ask for, and never spend money without showing the pitch first.

## The phases, in order

| # | Phase | Command | Output to review | Cost |
|---|---|---|---|---|
| 0 | Story | `npm run make -- <story.json> --only story` | `<run>/story.md` | ~$0.45/scene (Opus) |
| 1 | Characters | `npm run make -- <story.json> --only characters` | `<run>/characters.json` | free |
| 2 | Portraits | `npm run make -- <story.json> --only refs` | `npm run review -- <story.json> refs` | ~$0.05/image (batch) |
| 3 | Voices | `npm run make -- <story.json> --only voices` | `npm run review -- <story.json> voices` | cents |
| 4 | Shots + cover | `npm run make -- <story.json> --only art` | `npm run review -- <story.json> shots` | ~$0.05/image (batch) |
| 5 | Audiobook | `npm run make -- <story.json> --only audiobook` | `<run>/audiobook/scene-NN.mp3` | ~$0.01/min (batch) |
| 5½ | Music (optional) | `npm run make -- <story.json> --only music` | `npm run review -- <story.json> music` | ~$0.18/cue incl. retakes (theme + 1 per scene) |
| 6 | Video | `npm run make -- <story.json> --only video` | `<run>/video/story.mp4`, `<run>/video/titles.json` | free (local); a narrated title is one Gemini TTS line |

`<run>` is the story file's `"out"`. Every phase resumes and skips finished work, so re-running is safe.

## Review files

`npm run review -- <story.json> refs|shots|voices|music` builds them in `<run>/review/` (free):
- `refs-characters.jpg`, `refs-locations.jpg`, `refs-props.jpg`: every reference, labeled with its key (`✓` = approved)
- `shots-scene-NN.jpg` (one per scene) and `cover.jpg`
- `music.mp3`: every music cue, theme first, with its legend (`music.txt`)
- `voices.mp3`: every voice sample, a second apart, narrator first. The legend (`voices.txt`, also printed) says who speaks at what time, with which voice.

Send these files to the author. They're often on their phone, so don't just paste paths. Include the legend with the reel.

## Before every paid phase: the pitch

Run `npm run pitch -- <story.json> --only <phase>` and tell the author, in a line or two, what it will make and cost, and the budget left (`story.budget.usd` in the story file). Wait for a yes. If the estimate exceeds the budget, say so and offer to raise it — never raise it yourself.

## Phase 1: the character sheet

`characters.json` holds one entry per character: `name`, `gender`, `appearance`, `background`, `vocal`, `portrait`, `voiced`, and optionally `reference`. `reference` is the author's own drawing or design of the character (a .png/.jpg/.webp, relative to `characters.json`); the portrait is drawn from it. Filled fields override everything the pipeline generated — portraits, voice casting, and any later writing. Empty fields leave the generated values alone.

- Show the author what the run knows about a character: their sheet entry, their bible entry (`node src/cli.ts bible --out <run>`), how the prose describes them (grep `story.md`), and the source material (contexts/, or the author's notes). Point out where the prose contradicts the source.
- Ask what they remember or want; write it into the sheet in their spirit: `appearance` is concrete and visual (build, age, face, hair, clothing, signature gear); `background` is the history the story leaves out; `vocal` is how they SOUND (age, pitch, texture, accent, pace).
- If the author has art of a character (a drawing, a commission, a mini), set `reference` to it **and** write the `appearance` from it. The image steers the portrait, and the words carry the look into every shot.
- Keep secrets out of `background`: it feeds later writing. Anything the story must never reveal stays off the sheet.
- Set `"portrait": false` for characters who don't need one (bit parts, creatures that only appear once) — ask first.
- `voiced` decides who gets a cast voice. Unset, a speaker is cast when they say at least `audiobook.castMin` characters (default 120) in the story; everyone else is read by the narrator, lightly in character. `"voiced": true` casts them anyway; `"voiced": false` always gives them to the narrator.
- Re-run `--only characters` after edits: it records them (and adds any new characters without touching the author's text).

## Phase 2: portraits

After `--only refs`, build the contact sheet (`npm run review -- <story.json> refs`) and send it to the author. Then, per image:
- **Approve:** `npm run approve -- <story.json> character-lemuel location-ditch ...`
- **Redo with notes:** `npm run make -- <story.json> --only refs --redo character:hellga --note "older, a burn scar on the left cheek"`
- **Fix the source:** if the look is wrong because the description is, edit `characters.json` instead — a changed sheet entry remakes that portrait on the next `--only refs`.
Send the new contact sheet after every round. Move on when the author has approved the portraits they care about.

## Phase 3: voices

After `--only voices`, build the reel (`npm run review -- <story.json> voices`) and send it with its legend (who speaks when, with which voice; walk-on parts the narrator reads are listed at the end). Then:
- **Approve:** `npm run approve -- <story.json> voice:narrator voice:lemuel ...`
- **Recast:** edit the character's `vocal` on the sheet if the description is the problem, then `npm run make -- <story.json> --only voices --redo voice:lemuel`.
- A voice can also be pinned by hand in the story file: `audiobook.geminiVoices: { "lemuel": "<voice id>" }`.
- **Narrator or own voice:** `"voiced": true|false` on the sheet moves a speaker between the cast and the narrator (then re-run `--only voices`).

## Phase 4: shots

`--only art` plans shots for every scene that has none, then renders them. Send the shots contact sheet (`npm run review -- <story.json> shots`), scene by scene. Approve good shots by key (`scene-03-07`); approved images are never redone.
- **Redo a shot:** `npm run make -- <story.json> --only art --redo scene-03-07 --note "what's wrong"` (the note stays with that shot). `--redo scene:3` re-plans scene 3's shots.
- **Reshoots:** after any reference changes, `npm run reshoot -- <story.json>` lists the shots drawn from the old version (⟳ on the contact sheet) with the cost. `--only art` reshoots the unapproved ones. Pitch it like any paid phase.

## Phases 5–6

The audiobook and video need no review loop; send a scene MP3 or the video path when done.

Music is off unless the story file has a `music` block. Pitch it like any paid phase, then send the music reel (`review … music`). Cues with a voice in them are retaken automatically; any cue that never came out clean is listed in the run's output and left out of the mix. The author sets how far the music sits under the narrator with `music.duck` (dB, default 19); changing it only re-mixes, free.

Before the video, check the story file has a `title` (and `subtitle`, and `series` for a chapter); without one, the opening has no text. After it, show the author the scene titles the run printed (from `<run>/video/titles.json`). To change one, edit its `title` there and re-run `--only video`: only that card and the join are redone. `video.titles.narrate` makes a paid TTS call, so pitch it before turning it on.

## House rules

- **Never spend without the pitch and a yes.** Free phases (characters, video, review) need no pitch.
- **Sign-off before the next phase.** Don't chain paid phases on your own.
- **Never use Kokoro on a story whose audiobook is set to Gemini**, and never change a story's voice settings to make a run succeed — stop and ask.
- **Approved work is locked.** To change it, the author revokes first: `npm run approve -- <story.json> <key> --revoke`.
- **Show, don't describe:** send contact sheets, reels and MP3s to the author (they're often on their phone) rather than listing file paths.
- **The source is canon** for adaptations: the author's recap or plan wins over the prose; report drift you find, don't paper over it.
- Long runs (refs, art, audiobook in batch mode) go in the background; report when they finish, with the spend line from the output.
- Keys: art.json keys are `character-<id>`, `location-<id>`, `prop-<id>`, `scene-NN-MM`, `cover`; voices are `voice:<id>` and `voice:narrator`.
