---
name: produce
description: Produce a Scriptorium story phase by phase with the author — cast sheet, reference portraits, voices, shots, audiobook, video — pitching the cost before each paid phase and getting sign-off before moving on. Use when the user wants to produce, illustrate, voice, cast, or review a story in stories/, or asks "what's next" on a story run.
---

# Producing a story, phase by phase

For a story not yet started (no story file), or someone new to Scriptorium, use the **new-story** skill first. It sets up the idea, the audience and the story file, then hands over to this one.

**With Docker** (the setup skill decides), every `npm run <command> -- <args>` here is `docker compose run --rm scriptorium <command> <args>`.

You are the interface to Scriptorium's pipeline. The author reviews and signs off on each phase; you run the commands, show the results, make the changes they ask for, and never spend money without showing the pitch first.

## The phases, in order

| # | Phase | Command | Output to review | Cost |
|---|---|---|---|---|
| 0 | Story | `npm run make -- <story.json> --only story` | `<run>/story.md` | ~$0.50/scene (Opus) |
| 1 | Characters | `npm run make -- <story.json> --only characters` | `<run>/characters.json` | free |
| 1½ | Canon check (stories from notes) | `npm run make -- <story.json> --only canon` | `review/rounds/NN-canon-check/legend.txt` | ~$0.15/scene (Opus) |
| 2 | Portraits | `npm run make -- <story.json> --only refs` | `npm run review -- <story.json> refs` | ~$0.05/image (batch) |
| 3 | Voices (Gemini only) | `npm run make -- <story.json> --only voices` | `npm run review -- <story.json> voices` | cents |
| 4 | Shots + cover | `npm run make -- <story.json> --only art` | `npm run review -- <story.json> shots` | ~$0.05/image (batch) |
| 5 | Audiobook | `npm run make -- <story.json> --only audiobook` | `<run>/audiobook/scene-NN.mp3` | ~$0.01/min (batch) |
| 5½ | Music (optional) | `npm run make -- <story.json> --only music` | `npm run review -- <story.json> music` | ~$0.18/cue incl. retakes (theme + 1 per scene) |
| 5¾ | Extras | `npm run make -- <story.json> --only extras` | the images in `<run>/art/extra/` | ~$0.05/image (key art ×3, box, cast photo, logo) |
| 6 | Video | `npm run make -- <story.json> --only video` | `<run>/video/story.mp4`, `<run>/video/titles.json` | free (local); a narrated title is one Gemini TTS line |

`<run>` is the story file's `"out"`. Every phase resumes and skips finished work, so re-running is safe.

**Order matters for cost:** let the author read `story.md` and run the canon check **before** portraits, voices and shots. A fix to the words after voicing means re-voicing, and after shots it means redrawing. A story voiced with Kokoro skips phase 3; its voices are assigned in the audiobook step.

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

## Asking the author

Every choice goes through the **AskUserQuestion** tool: 2–4 options, the suggested one first and marked "(Recommended)", and "Other" for their own words. Examples:
- **a pitch:** "Go ahead, about $0.42 (Recommended)" / "Not now";
- **an audition:** each candidate voice as an option;
- **the canon check's fixes:** "Apply all (Recommended)" / "Apply all but some" / "None";
- **approving a round:** "Approve all", or "Approve some" with the keys typed in Other.

Show what they need to see first (the contact sheet, the reel, the legend, the pitch) in a short message, then ask. Where the tool isn't available, ask one question in text and wait.

**Offer first.** Every choice that shapes the story, its look or sound, or its cost is the author's first. Ask it with your suggestion **before** a phase settles it; "you pick" is fine, but only after asking. At the phase boundaries:
- **before portraits: the art style.** Show the one the story picked (`node src/cli.ts bible --out <run>`, its ART STYLE line) and offer 2–3 alternatives suited to the story, or theirs. A change goes in `artStyle`, then a free `--only story` records it before any picture is made;
- **before voices: the narrator** (warm storyteller, grandparent, crisp…), written as the narrator's `vocal` on the character sheet;
- **in the pictures pitch:** cheaper-but-slower batch mode (`artist.batch`), or faster at full price;
- **before music:** its sound (`music.style`) and whether they have tracks of their own;
- **before extras:** which ones (key art, VHS box, cast photo) and the logo's look (`extras`);
- **before the film:** an opening crawl, a narrated title, the rating card (`video.titles.crawl`, `video.titles.narrate`, `rating.card`);
- **after the film:** whether they want publishing text.

## Before every paid phase: the pitch

Run `npm run pitch -- <story.json> --only <phase>` and tell the author, in a line or two, what it will make and cost, and the budget left (`story.budget.usd` in the story file). Wait for a yes. If the estimate exceeds the budget, say so and offer to raise it — never raise it yourself.

## Steering the writing

The author's words for each layer go in the story file's `direction`, and that layer reads them on every call:
- `writer`: voice, register, humour ("dry, deadpan; never explain the joke");
- `director`: what happens and its pacing;
- `critic`: what counts as a failure ("the hidden truth stated outright is a failure");
- `continuist`, `editor`, `archivist`, `artdirector`, `artist`, `voicedirector`, `musicdirector`, and the planning layers `creator`, `worldbuilder`, `beatgate`, `contextgate`, `worldgate`, `patchgate` take direction too.

Other levers:
- `artStyle` fixes the pictures' style.
- `"tension": [3, 5, 9]` pins the arc per scene (null leaves one to the planner).
- `"turns": [null, "the map is a forgery"]` pins what turns a scene.
- `"ambiguity": "tidy" | "some" | "lots"` sets how much is left unsaid.

Direction only shapes what's written next, so set it before the writing step.

**Changing written scenes:**
- **A detail** goes through the canon check (`--only canon`, then `npm run canon -- <story.json> --apply [--skip …]`), with a backup and only the changed shots marked for redrawing. If the fact isn't in the author's notes, the check can't know it: ask them to add it to their own notes (never edit those yourself), or with their OK put it in the plan you wrote (`<run>/notes/plan.md`) or on the character sheet.
- **A scene going the wrong way:** `npm run make -- <story.json> --only story --redo scene:N --note "what should change"`. Pitch it first: the pitch counts it as one scene's writing plus a read of each later scene.
  - Scene N alone is planned and written again with the note as the author's direction (its previous version is the reference), through the usual reviewers. It replaces the old version in the event log, which is backed up first; scene 1 keeps the story's foundation.
  - Each later scene, and its shots, is then read against the new one. What no longer fits becomes a canon round (`legend.txt`) for the author to pick from: `npm run canon -- <story.json> --apply [--skip …]`.
  - The scene's shot plan is dropped, so `--only art` plans it anew; revoke its approved shots first (the run lists them). `--only audiobook` re-voices only the changed paragraphs.
- **The story going the wrong way from a point on:** fork before it, `npm run fork -- --from <run> --at <scenes to keep> --out <new run>`, point the story file's `out` at the new run, set the direction, and run `--only story`.

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

**First, the art style** (see "Offer first"): every portrait, shot and cover will use it, so it's settled before the first picture is paid for.

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

**Sounds in the performance (optional):** `"audioTags": true` in `audiobook` (Gemini voices only) has the voice director mark laughs, sighs, gasps and pauses where the prose calls for them, performed inline. It's off by default. Offer it for a story with lively dialogue, and say it's a small extra call per scene. The run prints how many sounds each scene got and any marks it set aside. If a sound lands wrong, the author can narrow the list (`"audioTags": ["sigh", "short pause"]`) or turn it off. Either re-voices only the scenes it changes.

## Phase 4: shots

`--only art` plans shots for every scene that has none, then renders them. Send the shots contact sheet (`npm run review -- <story.json> shots`), scene by scene. Approve good shots by key (`scene-03-07`); approved images are never redone. After redos, retakes or reshoots, send the round's `changed.jpg` rather than whole scenes.
- **Redo a shot:** `npm run make -- <story.json> --only art --redo scene-03-07 --note "what's wrong"` (the note stays with that shot). `--redo scene:3` re-plans scene 3's shots.
- **Fix one detail of a good shot:** `npm run make -- <story.json> --only art --edit scene-03-07 --note "the change"` edits the image itself and keeps everything else. A redo re-rolls the whole picture. To edit an earlier take the author preferred, add `--source art/previous/<key>/<take>.jpg`. When a person in it looks wrong (a face, a costume), add `--with character-<id>` or `--with scene-NN-MM` (a shot that has it right): text alone can't carry a likeness. Key art and the cast photo take `--edit` too, with `--only extras` (`--edit extra-keyart-16x9`). Revoke an approval first, as for a redo.
- **Notes say what should be there, never what shouldn't.** "He stands on the floor among the crowd", not "not on a table": naming the unwanted thing puts it in the picture.
- **Reshoots:** after any reference changes, `npm run reshoot -- <story.json>` lists the shots drawn from the old version (⟳ on the contact sheet) with the cost. `--only art` reshoots the unapproved ones. Pitch it like any paid phase.

## Phase 5¾: extras

`--only extras` (after the cover is approved) makes:
- **Generated, and approved like art:**
  - key art in three shapes, reframed from the cover: `extra-keyart-2x3`, `extra-keyart-16x9` and `extra-keyart-1x1`. The 16:9 one is the film's opening backdrop;
  - the cast photo, posed (`extra-cast`) and on set (`extra-cast-set`).
- **Put together from those, free:**
  - the VHS box (`art/extra/box/`; `"extras": { "box": false }` skips it);
  - the title logo (`--redo extra-logo` designs it again).

Settings live under `extras`:
- `keyArt` and `castPhoto` take `style` and `direction`;
- `logo` takes `mode` (`drawn` or `typeset`), `font`, `treatment` (gilded, bronze, silver, iron, parchment or plain), `arc`, `caps`, or the author's own `file`.

Approve these like art. `--redo extra-keyart-2x3,…` retakes one; `--redo extras` re-plans them all. `--edit extra-cast --note "…"` fixes a detail. After a new cover, reframe the key art and re-render the video (free) so the opening shows it.

## Phases 5–6

The audiobook and video need no review loop; send a scene MP3 or the video path when done.

Music is off unless the story file has a `music` block. Pitch it like any paid phase, then send the music reel (`review … music`). Cues with a voice in them are retaken automatically; any cue that never came out clean is listed in the run's output and left out of the mix. The author sets how far the music sits under the narrator with `music.duck` (dB, default 19); changing it only re-mixes, free.

**The author's own music:** ask whether they have any pieces of their own (a friend's, a licensed track) and where each should play. Offer a folder to drop them in (scaffold `contexts/<slug>/music/` and give its path), or use them where they already are (absolute paths are fine). Never copy them yourself. Point `music.tracks` at them, each with `from` and `to`:
- the part names are `rating`, `opening`, `crawl`, `card N`, `scene N`, `end`, `credits`, `next`;
- a piece spans every part between `from` and `to`, and loops if it's short;
- ask how they'd like it credited (`credit`).

Covered parts get no generated cue, and `"generate": false` means no score at all. Laying the tracks happens in the video step and is free, so after adding one, re-run `--only video` and send the film or a clip.

**The opening and the ending** (all in the story file, re-rendered free with `--only video`):
- **The title:** `title`, `subtitle`, and `series: { "next": "Part 2" }` for a chapter, which adds a "To be continued" ending and a "Next:" card. Without a `title` the opening has no text. `video.titles.ending` sets the ending card's words.
- **The opening sequence:** the title logo over the 16:9 key art, then (optionally) the crawl, with the theme or the author's own music under both.
- **The crawl:** `video.titles.crawl` takes the author's own text (a string or a list of paragraphs), or `true` to have the writer draft one from their notes, stopping just before scene 1. The draft lands in `<run>/video/titles.json` under `crawl`. Show it to the author; their edits there stick.
- **A narrated title and crawl:** `video.titles.narrate: true` has the narrator read the title and the crawl. These are paid TTS lines (cents), so pitch it.
- **The rating card** (rated stories) opens the film unless `"card": false`.
- **Scene titles:** show the author the titles the run printed (from `<run>/video/titles.json`). To change one, edit its `title` there and re-run `--only video`: only that card and the join are redone.

**Publishing:** write `notes/publish-metadata.md` (tagline, summaries, tags, chapters). Take the chapter times from the **final** render's `video/timeline.json`, and redo them after any re-render. Remind the author to tick YouTube's "altered or synthetic content" box.

## House rules

- **One command at a time per run is enforced.** `make`, `canon --apply` and `audition` hold `<run>/.lock`. A second one waits for the first and says what it's waiting for (`--no-wait` stops instead). To queue follow-up work, just run the next command, in the background. Never hand-roll waits (`pgrep` loops can match their own command line and deadlock). `approve` and the read-only commands (`pitch`, `review`, `spend`) don't lock.
- **When a phase is fully approved, suggest a cleanup.** Run `npm run cleanup -- <story.json>` (a dry run) and show the author what it would move to the trash and how much. Use `--apply` only on their yes.
- **What's waiting on the author comes from `npm run review -- <story.json> pending`,** never from memory. Each open round shows what it waits on and the exact files to look at. Put those absolute paths in the review request, grouped by round, and send the files themselves when the author is on their phone. When the author says a round is dealt with and nothing records it (a speech check listened to, a note seen), close it with `npm run review -- <story.json> done <N> [--note "…"]`.

- **A missing key or tool:** when a phase fails on one, run `npm run doctor -- <story.json>` and fix what it marks ✗ (the `setup` skill covers getting keys).
- **A stuck scene** ("scene N is stuck: … drafts"): read the last reviewer outputs in `<run>/threads/` with the author. Usually a plan item and a rule conflict, or a direction is too strict. Change the direction or notes and run again; it resumes at that scene. Raise `maxDraftsPerScene` only when the drafts are converging.
- **Spend that isn't the story's:** testing, debugging or an experiment shouldn't count against the author's budget. Run it with `--cost-kind dev` (or `experiment`), or under `runs/_scratch/`. Re-tag past spend with `npm run spend -- <story.json> --retag --cost-kind dev --after <ts>`. `npm run spend -- <story.json>` shows spend by kind.
- **Never spend without the pitch and a yes.** Free phases (characters, video, review) need no pitch.
- **`contexts/` is the author's.** You may scaffold empty folders there for them to fill. Never write, edit, copy, move or delete a file in it; read it. What you write goes in the story file or `<run>/notes/` (see the README's "Who writes where").
- **Sign-off before the next phase.** Don't chain paid phases on your own.
- **Never use Kokoro on a story whose audiobook is set to Gemini**, and never change a story's voice settings to make a run succeed — stop and ask.
- **Approved work is locked.** To change it, the author revokes first: `npm run approve -- <story.json> <key> --revoke`.
- **Show, don't describe:** send contact sheets, reels and MP3s to the author (they're often on their phone) rather than listing file paths.
- **The source is canon** for adaptations: the author's recap or plan wins over the prose; report drift you find, don't paper over it.
- Long runs (refs, art, audiobook in batch mode) go in the background; report when they finish, with the spend line from the output.
- Keys: art.json keys are `character-<id>`, `location-<id>`, `prop-<id>`, `scene-NN-MM`, `cover`; voices are `voice:<id>` and `voice:narrator`.
