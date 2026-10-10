# Scriptorium

Scriptorium turns an idea into a story, an illustrated audiobook and a film. Most people opening this folder want to **make a story**, not change the code.

- **Someone new, or wanting to make a story** ("how does this work?", "I want to make a story for my kids"): follow the **new-story** skill. It's the production wizard, from the idea to the finished film.
- **Setting up keys and tools**, or a run failing on a missing key: the **setup** skill.
- **A story already under way** ("what's next?", reviewing pictures or voices): the **produce** skill.
- **Changing Scriptorium's code:** read `AGENTS.md` first.

**Docker is all a newcomer needs to install** (Node, ffmpeg and ImageMagick are in the image). With Docker, `npm run <command> -- <args>` becomes `docker compose run --rm scriptorium <command> <args>`; the setup skill decides which way to run.

Two things always hold, whoever you're helping:
- **Never spend money without a pitch and a yes.** Run `npm run pitch -- <story.json>` and say the cost.
- **The author's notes and approvals are canon.** Report drift; don't quietly change them.
- **`contexts/` is the author's.** You may scaffold empty folders there for them to fill. Never write, edit, copy, move or delete a file in it. Read it, and point story files at the author's files wherever they live. Whatever you compose (a plan from the chat, notes, publishing text) goes in `runs/<slug>/notes/`. The README's "Who writes where" has the full picture.
