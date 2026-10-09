---
name: produce
description: Produce a Scriptorium story phase by phase with the author — cast sheet, reference portraits, voices, shots, audiobook, video — pitching the cost before each paid phase and getting sign-off before moving on. Use when the user wants to produce, illustrate, voice, cast, or review a story in stories/, or asks "what's next" on a story run.
---

# Producing a story, phase by phase

For a story not yet started (no story file), or someone new to Scriptorium, use the **new-story** skill first. It sets up the idea, the audience and the story file, then hands over to this one.

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
- `voices.mp3`: every voice sample, each announced by the narrator, narrator first. The legend (`voices.txt`, also printed) says who speaks at what time, with which voice. `voices-share.txt` is the same list with names and times only, for the author to pass on. `voices/` has one MP3 per voice.

**Review rounds.** Everything else the author is asked to look at goes in `<run>/review/rounds/NN-<kind>-<subject>/`, made by the pipeline:
- **Image redos, retakes and reshoots:** a `--redo` or any art run that changes up to 40 images writes `changed.jpg` (just those images) and a `legend.txt`.
- **Voice auditions:** `npm run audition` writes `all.mp3` (every candidate, 2 s apart) and a `legend.txt` (see Phase 3).

Send the author only files from `review/` or the newest round, always with the legend. They're often on their phone, so don't just paste paths. **Never improvise review files**: no hand-made montages, preview folders, scratch scripts or share lists. If something the author needs to see isn't covered, say so and propose adding it to the pipeline.

## Before phase 0: who is it for?

Ask the author who the story is for **before anything is written**. A rating changes how every scene is written, so it can't be bolted on afterwards.
- **For an audience** (a child's age, or a rating: G, PG, PG-13, R, NC-17, or TV-Y … TV-MA), add a `rating` to the story file:
  - `"rating": "PG"`, or
  - `{ "base": "PG", "age": 8, "forbid": […], "flag": […], "allow": […] }`.

  Ask what to **forbid** outright (fears, topics the family avoids), what to **flag** for parents, and what to **allow** above the rating.
- **The film opens on a rating card** (green, "rated by the author") unless `"card": false`.
- **The story check comes first:** the first `--only story` run checks the premise and plan against the rating before writing a word.
  - **Refused** ("can't be told at that rating"): the premise itself is past the rating. Say so plainly and offer a different rating or a gentler premise. Never look for a way around it.
  - **A list of plan conflicts:** go through it item by item with the author. For each, add it to `allow`, raise the rating, soften the plan, or set `acceptPlan` so the censor softens it scene by scene.
- **After writing,** show the author `<run>/rating.md`: what the censor changed in each scene and what a parent should know. The censor is a hard block, so a scene that keeps failing stops the run. Read its notes with the author rather than retrying blindly.

## Before phase 0: how long?

A story can be given a running time: `"length": { "minutes": 12 }`, with `"scenes": 3` inside it to fix the scene count. It becomes each scene's word budget at the narrator's pace: 156 words a minute, or this run's measured pace once there's an audiobook. The climax gets a bigger share and a quiet scene a smaller one. An explicit `sceneWords` overrides it. Without `length`, scenes are 1,200–1,800 words.

- **The fit check comes first:** the first `--only story` run checks the premise and the author's plan against the running time. If the plan needs more than 25% over, the run stops with nothing written and the options listed in `<run>/length.md`. Go through it with the author:
  - **stretch:** raise `minutes` to what the plan needs;
  - **cut:** remove or merge plan items, least needed first;
  - **split:** make it a series, at the break point the check suggests;
  - **compress:** `"fit": "compress"` keeps the plan, and the director tightens it to fit.

  A plan that needs well under the time is only a warning: the scenes get room to breathe, or ask for fewer minutes.
- **While writing:** the director sizes each beat to its scene's budget. A draft more than 15% over its budget is trimmed once by the editor.
- **After writing:** the story step prints each scene's words and minutes against its budget, flagging any as long or short. Re-running `--only story` on a finished story is free and prints the same readout. Show it to the author with `story.md`.
- **The pitch** gives the running time ("~12 min read aloud (asked 12)").
- `"fit": "off"` skips the check.

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

**After the sheet changes on a written story:** run `npm run make -- <story.json> --only canon` (about $1 with Opus for 6 scenes; pitch it). Send its `legend.txt` in the review format, and let the author choose which fixes to apply with `npm run canon -- <story.json> --apply --skip …`.

## Phase 2: portraits

After `--only refs`, build the contact sheet (`npm run review -- <story.json> refs`) and send it to the author. Then, per image:
- **Approve:** `npm run approve -- <story.json> character-lemuel location-ditch ...`
- **Redo with notes:** `npm run make -- <story.json> --only refs --redo character:hellga --note "older, a burn scar on the left cheek"`
- **Fix the source:** if the look is wrong because the description is, edit `characters.json` instead — a changed sheet entry remakes that portrait on the next `--only refs`.
After a redo, send the round's `changed.jpg` (the path is printed). Move on when the author has approved the portraits they care about.

## Phase 3: voices

After `--only voices`, build the reel (`npm run review -- <story.json> voices`) and send it with its legend (who speaks when, with which voice; walk-on parts the narrator reads are listed at the end). Then:
- **Approve:** `npm run approve -- <story.json> voice:narrator voice:lemuel ...`
- **Audition new voices:** when the author wants a voice changed ("deeper", "stockier"), run `npm run audition -- <story.json> lemuel --direction "<how they should sound now>"` (cents). It reads their reel line in their current voice and five library voices the voice director picks for that direction; `--voices a,b,c` auditions specific voices instead. Send the round's `all.mp3` and `legend.txt`. When they choose, `npm run audition -- <story.json> lemuel --pick N` pins the voice in the story file, makes the direction their vocal line on the sheet, and remakes their sample and the reel. Send the new reel.
- **Recast from scratch:** edit the character's `vocal` on the sheet, then `npm run make -- <story.json> --only voices --redo voice:lemuel`.
- A voice can also be pinned by hand in the story file: `audiobook.geminiVoices: { "lemuel": "<voice id>" }`.
- **Speech check:** every Gemini take is checked against its script and redone when a word comes out wrong. Lines still wrong after 3 takes go in a `speech-check` review round: send its `legend.txt` and tell the author. When a name keeps failing, propose a pronunciation (`audiobook.pronunciations`) and confirm it with the author.
- **Narrator or own voice:** `"voiced": true|false` on the sheet moves a speaker between the cast and the narrator (then re-run `--only voices`).

## Phase 4: shots

`--only art` plans shots for every scene that has none, then renders them. Send the shots contact sheet (`npm run review -- <story.json> shots`), scene by scene. Approve good shots by key (`scene-03-07`); approved images are never redone. After redos, retakes or reshoots, send the round's `changed.jpg` rather than whole scenes.
- **Redo a shot:** `npm run make -- <story.json> --only art --redo scene-03-07 --note "what's wrong"` (the note stays with that shot). `--redo scene:3` re-plans scene 3's shots.
- **Fix one detail of a good shot:** `npm run make -- <story.json> --only art --edit scene-03-07 --note "the change"` edits the image itself and keeps everything else. A redo re-rolls the whole picture. To edit an earlier take the author preferred, add `--source art/previous/<key>/<take>.jpg`. When a person in it looks wrong (a face, a costume), add `--with character-<id>` or `--with scene-NN-MM` (a shot that has it right): text alone can't carry a likeness. Key art and the cast photo take `--edit` too, with `--only extras` (`--edit extra-keyart-16x9`). Revoke an approval first, as for a redo.
- **Notes say what should be there, never what shouldn't.** "He stands on the floor among the crowd", not "not on a table": naming the unwanted thing puts it in the picture.
- **Reshoots:** after any reference changes, `npm run reshoot -- <story.json>` lists the shots drawn from the old version (⟳ on the contact sheet) with the cost. `--only art` reshoots the unapproved ones. Pitch it like any paid phase.

## Phases 5–6

The audiobook and video need no review loop; send a scene MP3 or the video path when done.

Music is off unless the story file has a `music` block. Pitch it like any paid phase, then send the music reel (`review … music`). Cues with a voice in them are retaken automatically; any cue that never came out clean is listed in the run's output and left out of the mix. The author sets how far the music sits under the narrator with `music.duck` (dB, default 19); changing it only re-mixes, free.

**The author's own music:** ask whether they have any pieces of their own (a friend's, a licensed track) and where each should play. Copy the files into `music/` beside the story file and add them to `music.tracks`, each with `from` and `to`:
- the part names are `rating`, `opening`, `crawl`, `card N`, `scene N`, `end`, `credits`, `next`;
- a piece spans every part between `from` and `to`, and loops if it's short;
- ask how they'd like it credited (`credit`).

Covered parts get no generated cue, and `"generate": false` means no score at all. Laying the tracks happens in the video step and is free, so after adding one, re-run `--only video` and send the film or a clip.

Before the video, check the story file has a `title` (and `subtitle`, and `series` for a chapter); without one, the opening has no text. After it, show the author the scene titles the run printed (from `<run>/video/titles.json`). To change one, edit its `title` there and re-run `--only video`: only that card and the join are redone. `video.titles.narrate` makes a paid TTS call, so pitch it before turning it on.

## House rules

- **One command at a time per run is enforced.** `make`, `canon --apply` and `audition` hold `<run>/.lock`. A second one waits for the first and says what it's waiting for (`--no-wait` stops instead). To queue follow-up work, just run the next command, in the background. Never hand-roll waits (`pgrep` loops can match their own command line and deadlock). `approve` and the read-only commands (`pitch`, `review`, `spend`) don't lock.
- **When a phase is fully approved, suggest a cleanup.** Run `npm run cleanup -- <story.json>` (a dry run) and show the author what it would move to the trash and how much. Use `--apply` only on their yes.
- **What's waiting on the author comes from `npm run review -- <story.json> pending`,** never from memory. Each open round shows what it waits on and the exact files to look at. Put those absolute paths in the review request, grouped by round, and send the files themselves when the author is on their phone. When the author says a round is dealt with and nothing records it (a speech check listened to, a note seen), close it with `npm run review -- <story.json> done <N> [--note "…"]`.

- **A missing key or tool:** when a phase fails on one, run `npm run doctor -- <story.json>` and fix what it marks ✗ (the `setup` skill covers getting keys).
- **Never spend without the pitch and a yes.** Free phases (characters, video, review) need no pitch.
- **Sign-off before the next phase.** Don't chain paid phases on your own.
- **Never use Kokoro on a story whose audiobook is set to Gemini**, and never change a story's voice settings to make a run succeed — stop and ask.
- **Approved work is locked.** To change it, the author revokes first: `npm run approve -- <story.json> <key> --revoke`.
- **Show, don't describe:** send contact sheets, reels and MP3s to the author (they're often on their phone) rather than listing file paths.
- **The source is canon** for adaptations: the author's recap or plan wins over the prose; report drift you find, don't paper over it.
- Long runs (refs, art, audiobook in batch mode) go in the background; report when they finish, with the spend line from the output.
- Keys: art.json keys are `character-<id>`, `location-<id>`, `prop-<id>`, `scene-NN-MM`, `cover`; voices are `voice:<id>` and `voice:narrator`.
