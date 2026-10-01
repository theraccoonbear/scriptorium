# Scriptorium — rules for agentic contributors

You are probably an AI coding agent. This file is how this repo wants to be worked on.
Read it before you touch anything.

## What this is

A gated agentic narrative engine. **Creatives** produce story canon; **gates** review it.
No creative output enters the story until its gate is green.

```
worldbuilder  → worldgate  →
creator/director → beatgate →
writer → continuist ∥ critic →
archivist → patchgate → commit → artdirector (optional, ungated)
```

## Commands

| Task | Command |
|---|---|
| Typecheck (strict, must be 0) | `npx tsc` |
| Tests (must be 13+ pass, 0 fail) | `node --test` |
| Mock story end-to-end | `npm run story:mock` |
| Live run | `npm run story -- --max-attempts inf --scenes 3` |

Run **all three** of typecheck/tests/mock before you consider work done, and
paste the result into the PR.

## Branching and merging

- One branch per issue: `feat-<slug>-<issue#>` or `fix-<slug>-<issue#>`
  (e.g. `feat-continuist-mustreveal-1`).
- Branch from `main`. **Nothing reaches `main` except through a GitHub PR.**
  Create it with `gh pr create`, wait for green, merge with `gh pr merge`.
  Docs and meta included — no direct pushes.
- Reference the issue in the commit or PR body (`Closes #N`) so GitHub closes
  it on merge.
- PR description must say: what changed, why, which issue it closes, and how
  you verified it (typecheck / tests / mock run).

## Test coverage (required)

- **New functionality, bug fixes, and regressions need tests** added under
  `test/` before the PR merges. No test, no merge.
- Prompt-only changes (system prompt text): tests don't read prompts except
  via contract tests — assert the required sections exist so the contract
  can't silently regress (see `test/roles.test.ts`).
- Engine/behavior changes: extend the mock-provider fixtures (pattern:
  `MockProvider.rejectFirstOn` + `story.config.json`).
- Bugs found in a live run get a regression test that fails without the fix
  whenever that is mechanically possible.

## Hard invariants (do not weaken these)

1. **Every creative is gated.** Never route a creative's output past its gate,
   and never "commit as-is" in unbounded mode (`--max-attempts inf`). A red
   artifact must never enter canon.
   *Exemption:* the Art Director (`artDirect()`) is deliberately ungated. It
   runs after commit and writes image-gen prompts (`scene_art`, `cover_art`
   events) that are presentation metadata, not story facts — `replay()`
   ignores them and they never touch the bible. Its failures are logged and
   swallowed so they can't fail a scene that is already canon. Don't add a gate.
2. **One Issue shape.** `Issue { type, entity, constraint, detail }` lives in
   `src/types.ts`. Gate prompts get it from the shared `ISSUE_SCHEMA` /
   `ISSUE_RULES` constants in `src/roles.ts`. Never hand-write an issue shape
   into a single gate's prompt — that is exactly how the critic/continuist
   drift bug happened.
3. **One gate runner.** All gates go through `runGate()`; all creative
   feedback blocks go through `feedbackBlock()`. If you need a new gate, add a
   prompt + a thin wrapper, not a new plumbing path.
4. **CRAFT never blocks.** Style opinions belong in the critic's `review`
   text. Blocking issue types are enumerated; additions need a reason in the
   issue that proposed them.
5. **Repeat detection keys on `type + constraint`.** `issueKey()` in
   `src/engine.ts` is the dedup contract. Prose quotes change every rewrite;
   rules do not.
6. **Secrets and output stay out.** Never commit `.env`, API keys, or anything
   under `runs/` (story output). `.gitignore` already covers them — do not
   remove entries. Config files may name env vars (`apiKeyEnv`), never values.

## TypeScript rules

- Node 26 runs `.ts` directly via type stripping. **No build step, no emit.**
- `erasableSyntaxOnly`: no enums, no namespaces, no parameter properties,
  no `import =`. Use `const` objects and plain classes.
- Relative imports carry the `.ts` extension (`./roles.ts`).
- Strict `tsc` is the contract: if types make something awkward, the design is
  wrong — fix the design, don't cast your way past it.
- Domain types live in `src/types.ts`. Prompts are data (template literals);
  prompt text changes are code changes and belong in the diff.

## Testing reality check

- `node --test` uses the mock provider (`story.config.json`); gates return
  green by default. **Tests do not read prompt text.** A prompt-only change
  passes tests by construction — reason about it manually or add a fixture
  (see `MockProvider.rejectFirstOn` for the existing pattern).
- A run directory (`runs/story-<ts>/`) is a full audit trail: every role call
  is written as `.md` (system prompt + prompt + raw response). When debugging
  behavior, read the files — don't guess from code.

## Style

- Commit messages: imperative mood, reference issues.
- Comments explain *why*, not *what*.
- Log lines use `src/colors.ts` (`c.ok` / `c.fail` / `c.retry` / `c.dim`) and
  role labels via `c.label(role, model)`.
