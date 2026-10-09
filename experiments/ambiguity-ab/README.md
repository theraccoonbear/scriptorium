# Ambiguity A/B (#180)

**The question.** With writer's notes (#93), can the writer deliberately leave a loose end that the reviewers accept and the ending doesn't explain away, while a floating detail it never chose is still caught?

## Design
The same 3-scene story is written twice, with the same models (`story.recommended.config.json`): about 700–1,000 words a scene, `ambiguity: "some"`, and no author plan, so the setup ledger is live.

| Arm | Writer's notes |
|---|---|
| A | off (`writerNotes: false`): no notes channel, and the reviewers see none |
| B | on (the default) |

There are two probes, the same in both arms. They give a ground truth we control:
- **D, a deliberate loose end.** Scene 2's writer gets an author's note on every draft: *include this, never explain it: a church bell rings once at midnight, though the village has no church.* Arm B's writer can say so in its notes.
- **F, a floating detail.** *"Someone had left a muddy boot print on the ceiling above the bar."* is spliced into every scene-2 draft, after its second paragraph. The writer never chose it and no notes mention it, so it should be handled as an ordinary setup.

## Measures (per arm, in the report)
- **For each probe:**
  - whether it's in the committed scene 2;
  - the kind the archivist recorded;
  - whether it was paid off, and whether it's still open at the end;
  - reviewer issues that mention it, across every draft;
  - whether the writer's notes mention it.
- **The judge:** a separate read of the finished story, which labels each probe *explained*, *left open*, *dropped* or *absent*.
- **Cost and churn:** drafts per scene, and spend.

**Hoped for:** in B, D is recorded as an open question or motif, gets fewer reviewer issues than in A, and is left open at the end. F is recorded as a promise and paid off or flagged, in both arms. The failure to watch for is B waving F through as deliberate.

## Run
```bash
node --env-file=.env experiments/ambiguity-ab/run.ts            # one run of each arm, about $2.50
node --env-file=.env experiments/ambiguity-ab/run.ts --runs 3   # three of each, for variance
node experiments/ambiguity-ab/run.ts --mock                     # the harness on mock models, free
```
Runs and reports go to `runs/_scratch/ab-ambiguity/`. Their spend is tagged `experiment` and counts against no story's budget.
