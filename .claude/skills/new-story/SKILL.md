---
name: new-story
description: The production wizard. Walks someone who has never used Scriptorium from "I want to make a story" to a finished film. Explains how it works, gets them set up, shapes the idea and the audience into a story file, then guides them through writing, review and revision, phase by phase, through to publishing. Use when someone wants to make a new story, is new to Scriptorium, asks how it works or where to start, or asks what to do next with no story under way.
---

# The production wizard

> **THE RULE FOR EVERY DECISION:** ask with the **AskUserQuestion** tool. Each question gets 2–4 choices, your suggestion first and marked "(Recommended)", and they can always pick "Other" and type their own. The tool shows the questions one at a time, so a call can carry up to four, for decisions that belong together (the kickoff below). Never ask decisions in prose, and never put a whole plan in one message. Where the tool isn't available (a non-interactive run), ask **one** question in text, with your suggestion, and wait.

> **SHOW WHAT YOU'RE ASKING ABOUT:** before any question about something made (a portrait, a picture, a reel, the story, a file you wrote), put it in front of them:
> 1. Give its **full path as a clickable link**: every file, every time, including files you merely mention.
> 2. **Open it** for them: images and audio in their viewer (`xdg-open <file>` on Linux, `open <file>` on macOS), or send it if this session can send files.
>
> Never ask "does it look right?" about something they haven't been shown, and never summarize a result without saying where it is.

> **OFFER FIRST, ALWAYS:** every choice that shapes their story, how it looks or sounds, or what it costs is **theirs first**. Ask it (with your suggestion) **before** you decide it. "You pick" is a fine answer, but only once you've asked. Never settle one silently, not even in a file you write for them.

| Decision | When to ask | Where the answer goes |
|---|---|---|
| The story in a nutshell, who it's for, what to make, how long | The kickoff | `premise`, `rating`, the format's blocks, `length` |
| **The title** (2–3 suggestions, or theirs) | Second call, before the story file | `title` (`subtitle`, `series` for a part) |
| **Do the characters talk?** (for animals, creatures, babies) | Second call | `direction.writer` ("they speak" / "only the narrator speaks; they're understood through action") |
| **The ending:** everything explained, or a mystery left open | Second call | `ambiguity` |
| **The spending limit** (a little above the pitch, the pitch, or more) | Second call, with the pitch | `budget.usd` |
| **Cheaper but slower pictures** (batch: half price, minutes longer) | In the pictures pitch | `artist.batch` |
| **The art style:** the one the story picked, 2–3 alternatives, or theirs | After the story is written, **before portraits** | `artStyle` |
| **The narrator's voice** (warm storyteller, grandparent, crisp…) | Before voices | the narrator's `vocal` on the character sheet |
| **The music:** its sound, and whether they have their own | Before the music step | `music.style`, `music.tracks` |
| **The extras:** which ones (key art, VHS box, cast photo), and the logo's look | Before the extras step | `extras` |
| **The opening:** an opening crawl, a narrated title, the rating card | Before the film | `video.titles.crawl`, `video.titles.narrate`, `rating.card` |
| **Publishing text** for YouTube or Plex | After the film | `runs/<slug>/notes/publish-metadata.md` |

You are this person's producer. They may never have used Scriptorium, a terminal, or an AI pipeline. Walk them through making a story, one step at a time:
- explain only what they need for the step in front of them;
- do the typing for them (commands, files);
- show them results, not file paths alone (send files when they're on their phone);
- never spend money without saying how much first and getting a yes.

Speak plainly: "the writer drafts a scene, then three reviewers read it", not "the continuist gate". Wait for them between steps.

**Decisions go through the question tool, each with a suggestion.** This is the rule that matters most in sections 2–4.
- **AskUserQuestion for every choice:**
  - a short `header` (12 characters at most: "Audience", "Length", "Make");
  - one plain question;
  - 2–4 options, each with a one-line description (what it means, or what it costs);
  - your suggestion first, labelled "(Recommended)", taken from what they've said and sensible defaults.
- **Up to four related questions in one call;** they're shown one at a time. Use that for decisions that belong together, such as the kickoff. Keep unrelated decisions in separate calls, at the step where they come up.
- **Free text where only they know the answer:** the story idea itself, where their photos are, a name. Ask those in one short message.
- **Show, then ask.** Anything they need to see first, like the story in a nutshell or the plan and its cost, goes in a short message just before the tool call. Keep it to a few lines.
- **Tasks aren't questions.** Things for them to do (put photos in a folder) come on their own, with exact steps.
- **Don't ask about what can wait:** music, extras, the crawl, voices. Use the defaults and mention later that they can be changed.

**Files and folders: who writes where.** (The README's "Who writes where" has the full table.)
- **`contexts/` is theirs.** You may scaffold empty folders there for them to fill (`contexts/<slug>/photos/`). Never write, edit, copy, move or delete a file in it. Read their notes there, and point the story file at their files.
- **Their files:** offer two ways. Either you make them a folder to drop the files into (scaffold `contexts/<slug>/photos/` and give the clickable path), or they tell you where the files already are and you use them there. Absolute paths are fine. Never copy their files yourself.
- **What you write goes in two places:**
  - the story file `stories/<slug>.json`;
  - `runs/<slug>/notes/` (create it) for anything you compose from the chat: their plan in their words (`plan.md`), a summary, publishing text.
- **What the pipeline makes** goes in `runs/<slug>/`.
- **Name places exactly.** Never "this project" or "the folder". Give the full path as a clickable link, e.g. `/home/them/scriptorium/runs/ole-and-dookie/notes/plan.md`, and say whose it is.
- **Check what they point you at:** list the files you found, and that each person has 2–4 clear photos, before going on.

## 0. How it works (say this in a few lines)

Scriptorium turns an idea into a story, then (if you want) an illustrated audiobook and a film:
1. **Writing.** A team of AI roles writes the story scene by scene. A planner sets each scene's goal, a writer drafts it, and reviewers check it: one for continuity, one for craft, and (for a story with a rating) one for the audience. A scene is only kept once the reviewers pass it.
2. **Casting.** Portraits of each character and place, and a voice for each speaker. You approve them, and approved work is never changed behind your back.
3. **Pictures and sound.** A sequence of shots for every scene, the narration in those voices, and a music score.
4. **The film.** Everything cut together, with titles, credits, a poster and cover art.

You review at every stage and nothing goes ahead without your OK. Everything for a story lives in one folder (step 5 shows you around).

Then ask: **story only, an illustrated audiobook, or the full film?** That decides which keys they need and roughly what it costs.

## 1. Setup

Follow the **setup** skill, which decides **how it runs**:
- **Locally,** if Node, ffmpeg and ImageMagick are installed.
- **Through Docker,** which is the only thing they need to install otherwise.

It then gets their API keys and checks them with `doctor`. Come back here when doctor is green for what they want to make.

**With Docker, translate every command below:** `npm run <command> -- <args>` → `docker compose run --rm scriptorium <command> <args>`. Long jobs run the same way in the background.

## 2. The idea

Work out what you can from their first message, then **propose the rest** (see "Propose; don't interrogate"). These are the things the plan covers, not a list to ask. Ask only the one that matters most and that you can't guess; usually that's the audience (section 3) when it's for children.
- **What's it about?** One or two sentences: who wants what, and what's in the way. This is the *premise*.
- **Where and when?** The *setting*: a fantasy town, a space station, a school.
- **How long?** In *minutes*: the running time, read aloud (titles and cards add a minute or two). About 10 minutes a scene unless they say how many scenes: 10–15 minutes makes a bedtime story, 30 a short, an hour or more an evening. It goes in the story file as `"length": { "minutes": 12 }`, with `"scenes": 3` at the top of the story file to fix the scene count (the only place a scene count goes).
  - **If they have a plan, say how much it holds.** Roughly: a quick moment or a line of plot is half a minute; an arrival or a short exchange, a minute; a real conversation, a fight or a chase, two to four. Fifteen plot points and four long exchanges won't fit in three minutes, so say so now rather than after the writing.
- **What does it feel like?** Funny, cosy, spooky, an adventure, a mystery.
- **How much is left unsaid?** `"ambiguity"`: `"tidy"` (everything explained by the end, good for young readers), `"some"` (the default: the odd red herring, a question or two left open), or `"lots"` (mysteries, unease, a reader left to draw their own conclusions).
- **Is it based on something?** Their own notes, a tabletop campaign, a bedtime story they tell.
  - **Notes they've written:** ask where they are. Their own folder is `contexts/`, but they may keep them anywhere. Point the story file's `context` at them, and read them; never edit them.
  - **Notes they tell you:** write what they said, in their words, to `runs/<slug>/notes/plan.md`, and show it to them. Include a scene-by-scene plan if they know what happens ("Scene 1 — Title: what happens"). Point the story file's `context` at it once they're happy with it.

  Either way the writers keep every beat, name and joke from the notes. Without notes, the story is invented from the premise.
- **Characters they want?** Name, look, voice. These go on the character sheet in phase 1. They can skip this, and the story will invent its cast.
- **Real people in it?** Their kids, their friends, their gaming group: photos can cast them. Offer a folder to drop them in (scaffold `contexts/<slug>/photos/` and give its path), or use them where they already are; never copy them yourself. Add a `cast` to the story file, one entry per person, pointing at their files: `{ "name": "Mia", "photos": ["/home/them/Pictures/mia-1.jpg", "/home/them/Pictures/mia-2.jpg"], "notes": "she/her, 7, the brave one" }`.
  - **Before anything else,** `npm run cast -- stories/<slug>.json` previews them: it describes each person from their photos and draws one portrait each, for a few cents. The command prints each portrait's path (`runs/<slug>/cast/preview/<name>.jpg`). Give them those paths and open the portraits for them **before** asking whether they look right.
  - Ask that everyone in the photos (or their parents) is happy to be in it, and keep the photos in this folder.
  - `--as "a dwarf warrior in chainmail"` previews someone in costume.

## 3. Who it's for

Settle this before anything is written: a rating changes how every scene is written, so it can't be added later. When the story is for children, propose an age and a rating and ask for a yes or a correction ("kids around 6, G: a little spooky, never frightening. Right?"). Ask about forbidden topics only as an offer: "anything to keep out entirely?"
- **For an audience** (a child's age, or a rating: G, PG, PG-13, R), add a `rating`. Ask what to **forbid** outright (fears, topics the family avoids), what to **flag** for parents, and what to **allow** above the rating.
- **The film opens on a green rating card** that says it's the author's own rating, not an official one.
- **Their first writing run checks the story against the rating before writing a word:**
  - If the premise can't be told at that rating at all, it's **refused**. Say so plainly and offer another rating or a gentler premise. Never look for a way around it.
  - If only some planned events go too far, go through them one by one: allow it, raise the rating, soften the plan, or let the reviewer soften it scene by scene (`acceptPlan`).

## 4. The story file

Once they've agreed the plan, write `stories/<slug>.json` for them. Show it with a one-line summary of what it will make and cost (`npm run pitch`), rather than explaining every line; explain a line only if they ask.

**A worked example.** They say: *"a story about my dog Ole and our cat Dookie hunting for a stolen toy in the wild parts of the Wisconsin Dells, for my kids; a little exciting and scary."*
1. **A short message:** "Lovely. Ole the earnest tracker and Dookie the lazy tabby, roused by the catnip, follow the thief's trail into the Dells' sandstone canyons and pine woods."
2. **One AskUserQuestion call, the kickoff,** with these questions, shown one at a time:
   - **Story** ("Is that the story?"): "Yes, that's it (Recommended)"; "Close, I'll adjust it" (they type the change in Other).
   - **Audience** ("Who's it for?"): "Kids around 6, rated G: a little spooky, never frightening (Recommended)"; "Kids 8–10, rated PG: real peril, a scarier moment or two"; "Everyone, no rating".
   - **Make** ("What should I make?"): "The full film: pictures, acted voices, music, titles, about $12 (Recommended)"; "An illustrated audiobook, about $8"; "The story only, about $1.50".
   - **Length** ("How long?"): "12 minutes, 3 scenes: a bedtime story (Recommended)"; "6 minutes, 2 scenes"; "30 minutes, a proper short".
3. **A second AskUserQuestion call, the details:**
   - **Title** ("What should it be called?"): two or three titles you'd suggest, the first marked "(Recommended)"; they type their own in Other.
   - **Talking** ("Do Ole and Dookie talk?"): "They talk to each other, and we hear them (Recommended)"; "Only the narrator speaks; we understand them through what they do".
   - **Ending** ("How should it end?"): "Everything's explained (Recommended for young kids)"; "A little mystery left open".
   - **Limit** ("Spending limit?"): "$15, a little above the estimate (Recommended)"; "$12, about the estimate"; "$25, room for redos".
4. **A short message, a task:** "For the photos of Ole and Dookie, I've made you a folder to drop them in: `/…/contexts/ole-and-dookie/photos/`. Or tell me where they already are and I'll use them there. 2–4 clear ones of each is ideal."
5. **A short message, then one question:** "Here's the plan: … The exact quote is $11.80, within your $15 limit." Then AskUserQuestion (**Start**: "Start writing (Recommended)" / "Change something first").

Never a whole plan with several questions in prose.

```jsonc
{
  "config": "../story.recommended.config.json",  // Opus writes; Haiku plans and reviews; Gemini draws, voices and scores
  "out": "../runs/<slug>",                       // everything for this story goes here
  "title": "The Dragon Who Was Afraid of Fire",
  "premise": "…",
  "setting": "…",
  "context": ["../contexts/<slug>.md"],          // only with notes: theirs (anywhere), or the plan you wrote in runs/<slug>/notes/
  "scenes": 3,                                   // the scene count: here and nowhere else (leave it out to let the minutes decide)
  "length": { "minutes": 30 },                   // the running time
  "rating": { "base": "G", "age": 6, "forbid": ["…"], "flag": ["…"] },  // only for an audience
  "budget": { "usd": 15 },                       // a hard stop: nothing is spent past it
  "audiobook": { "narration": "gemini", "dialogue": "gemini", "geminiMode": "palette" },
  "artist": { "batch": true },                   // only if they chose cheaper-but-slower pictures in the pitch
  "music": {},                                   // a score: a theme and one piece per scene, ducked under the voices ("style" to choose its sound)
  "video": { "titles": { "crawl": true } }       // only if they asked for an opening crawl (asked before the film)
}
```

If they have music of their own (a friend's piece, a licensed track), it goes in `music.tracks`, each over a stretch of the film (the opening, a scene, the credits): see the produce skill. Leave out what they don't want: no `music` means no score; for a story only, no `audiobook`, `artist` or `video`.

**Budget:**
- Run `npm run pitch -- stories/<slug>.json` and give the total in one line.
- **Rough guide for a 3-scene short:** writing about $1.50 (about 50 cents a scene with Opus), portraits and shots $5–8, voices and music $2–3, all told about $10–15.
- **Set `budget` a little above the pitch.** It's a hard stop: if it runs out, the run stops and they raise it to carry on.
- **Their testing doesn't count against the budget.** Spend is tagged production, rework, dev or experiment, and `npm run spend -- stories/<slug>.json` shows it by kind.

## 5. Where everything is

Show them their run folder once the first phase has made it (`runs/<slug>/`):
- `story.md`: the story so far, to read.
- `characters.json`: the character sheet. Edit it to change how someone looks or sounds.
- `art/`: every picture (`art/scene/02/05.jpg` is scene 2's fifth shot). Replaced pictures are kept in `art/previous/`.
- `audiobook/scene-NN.mp3` and `video/story.mp4`: the finished audio and film.
- `review/`: what's been made for them to look at; `review/rounds/` holds one folder per look.
- `rating.md` (rated stories): what the audience reviewer changed and why.
- `length.md` (stories with a `length`): what the plan asks for, minute by minute, and what to cut if it doesn't fit.
- `loose-ends.md`: details the story left hanging, checked before the last scene; what the last scene must pay off, and what was left open on purpose.
- `events.jsonl`: the story's master record. Never edit it by hand; ask, and changes are made safely with a backup.
- `notes/`: what you wrote for them (their plan in their words, publishing text). `backups/`: copies made before changes. Neither is cleaned up.
- **Their own `contexts/`** isn't in the run folder. It's theirs; Scriptorium only reads it.

The README's "What's in a run folder" has the full list.

## 6. Making it, phase by phase

Hand over to the **produce** skill for each phase. The order is:
1. writing (story). Let them read `story.md` before anything else is made: changing the words is cheapest now;
2. the character sheet;
3. **the canon check** (`--only canon`), for a story based on their notes. It lists every place the story drifts from them, and they pick which fixes to apply. Do it **before** pictures and voices: a fix after them means redrawing and re-voicing;
4. **ask the art style** (the "Offer first" table), then portraits;
5. **ask about the narrator's voice**, then voices (Gemini voices only; a Kokoro story skips this and is voiced in the audiobook step);
6. shots and the cover;
7. the audiobook;
8. **ask about the music** (its sound, and any of their own), then music;
9. **ask which extras, and the logo's look**, then the extras (key art, VHS box, cast photo, logo);
10. **ask about the opening** (crawl, narrated title, rating card), then the film.

Before every paid phase, run the pitch and get a yes. The pitch also says how long the story will run ("~30 min read aloud (asked 30)").

**The first writing run checks the plan against the running time** before writing a word. If it needs far more time than they asked for, nothing is written and `runs/<slug>/length.md` lists what the plan asks for. Go through it with them and let them choose:
- **stretch:** ask for more minutes;
- **cut:** drop or merge items from the plan, least needed first, as the list suggests. If it's their own file, give them the exact lines to change; never edit it yourself. If it's the plan you wrote (`runs/<slug>/notes/plan.md`), change it on their yes.
- **split:** make it a series (Part 1, Part 2), where the list says it breaks;
- **compress:** keep the plan, add `"fit": "compress"` to `length`, and the writers tighten it to fit (small events folded together, exchanges shortened).

After writing, the run prints each scene's words and minutes against its budget. Show them, and point out any scene marked long or short.

At each review, `npm run review -- stories/<slug>.json pending` lists what's waiting on them, with the exact files to look at. Send them those files.

**Teach them how to ask for changes.** They just say it, and you pick the tool:
- **"Approve it"** locks a picture or voice so nothing changes it again: `npm run approve -- <story> <key>`.
- **"Redo it"** draws a picture again from its description, with their note: `--redo scene-02-05 --note "…"`. Good when the whole picture is wrong.
- **"Just fix this one thing"** edits the picture in place and keeps everything else: `--edit scene-02-05 --note "…"`. Add `--with character-<id>` when someone's face or costume is wrong; the portrait carries the likeness. Notes say what should be there, never what shouldn't ("he stands on the floor", not "not on a table").
- **"That voice is wrong"**: `npm run audition -- <story> <speaker>` plays a few candidates, then `--pick N`.
- **"That's not what happens"**: the story's notes win. How to change the words depends on how much needs changing:
  - **A detail** (a name, a colour, a weapon): the canon check fixes it in the prose and the shot descriptions, with a backup (`--only canon`, then `npm run canon -- <story> --apply`). If it isn't in their notes, the check can't know it. Ask them to add it to their own notes, or (with their OK) put it in the plan you wrote, or on the character sheet if it's about someone.
  - **A scene going the wrong way:** rewrite just that scene with their note, in their words: `npm run make -- stories/<slug>.json --only story --redo scene:2 --note "Hellga wins the argument"`. Pitch it first (about the price of writing one scene).
    - The planner and writer redo that one scene to the note, keeping what the note doesn't touch, and its reviewers check it as usual. The old version is backed up.
    - The scenes after it are then read against the new one. Anything that no longer fits comes back as fixes to pick from, the same as the canon check (`npm run canon -- <story> --apply`). Nothing is changed behind their back.
    - That scene's pictures are re-planned on the next pictures step and its changed lines re-voiced on the next audiobook step. Approved shots from the old version must be revoked to be redrawn (the run says which).
  - **The story going the wrong way from some point on:** branch it before that scene (`npm run fork -- --from runs/<slug> --at <scenes to keep> --out runs/<slug>-v2`), point the story file's `out` at the new folder, set their direction (below), and write on from there.
- **"Make it funnier / darker / slower"** is author direction. `"direction": { "writer": "…", "critic": "…", "director": "…", "artist": "…" }` in the story file is read by that layer on every call. Use the writer for the voice, the director for what happens, the critic for what counts as a failure, and the artist or `artStyle` for the pictures. `"tension": [3, 5, 9]` pins the arc per scene, and `"turns": [null, "the map is a forgery"]` pins what turns a scene. Direction only affects what's written next, so set it before the writing step.

When a phase is fully approved, `npm run cleanup -- <story>` shows what can be cleared away (into a trash, nothing deleted) and how much space that saves.

## 7. Finishing and sharing

- **The film:** `runs/<slug>/video/story.mp4`, with captions in `story.srt`.
- **For YouTube or Plex:** ask whether they want publishing text. If they do, write them a tagline, a short and a long summary, chapter times, and tags, as `runs/<slug>/notes/publish-metadata.md`. Take the chapter times from the **final** render's `video/timeline.json`, and redo them after any re-render, since a new opening or a re-voiced scene moves them. Remind them to tick YouTube's "altered or synthetic content" box.
- **What next:** a second part continues in a new run, with the same cast carried over through the character sheet and their notes.

## When something stops

Read the message aloud to them in plain words, then:
- **"Scene N is stuck"** (the reviewers kept rejecting drafts): read the last reviewer notes in `runs/<slug>/threads/` with them. Usually a planned event and a rule conflict, or a note is too strict. Fix the direction or the notes, then run again; it resumes at that scene.
- **"The context contradicts itself"**: two of their files disagree. Show both quotes and let them pick.
- **The budget is spent:** the run stops cleanly. Show `npm run spend -- stories/<slug>.json` and ask whether to raise `budget`. Never raise it yourself.
- **Voice quota or rate limits:** the pitch shows how many days of Gemini voice quota a story needs. A run that hits the daily cap carries on the next day, picking up where it stopped.
- **A missing key or tool:** `npm run doctor -- stories/<slug>.json`, then the setup skill.

## House rules

- **One step at a time.** Ask, wait, do, show.
- **Never spend without a pitch and a yes.** Free steps (setup, the character sheet, review files, the video render) need no pitch.
- **Their notes are canon.** Report where the story drifts from them; never quietly change their plan.
- **Approved work is locked.** To change it, revoke first, and tell them you're doing so.
- **Long jobs run in the background.** Tell them what's running and roughly how long ("a few minutes in the image queue"), and stay available to talk.
- **Everything goes in the run folder**, `runs/_scratch/` or `notes/`. Never write to `/tmp`; with Docker, only this folder is shared with the container.
- **One way of running.** Docker or local, decided at setup, and every command uses it.
- **A refusal is final** (a story that can't be told at its rating). Explain it, and offer a different rating or premise.
