# eval/ — the Agent C eval spine (Increment 2)

The fitness function for the self-tuning harness (see `../SELF-IMPROVEMENT-ROADMAP.md` §2 + §6).
Built host-level (it imports the **real** `agent-caps.mjs`, which has host-absolute paths — so it
runs as Agent C on the host, not in the confined Blacksmith).

## Run

```bash
node eval/eval.mjs --all --repeats 3            # run every obstacle on the baseline arch
node eval/eval.mjs --obstacle attenuation       # one obstacle (substring match)
node eval/eval.mjs --all --arch arch-XXXX --model openrouter:... --repeats 5
```

It runs each obstacle's `grade()` `--repeats` times, records a run to the tree, and prints the
cross-run table (latest per obstacle×arch×model) + a per-(arch, model) pass-rate summary.

## Shape

- `eval.mjs` — CLI.
- `harness.mjs` — `runObstacle(mod, {arch, model, repeats})` → a cell (passRate over repeats).
- `tree.mjs` — the architecture-performance tree. An **arch** = a harness config; its identity is a
  **config_digest** (sha256 of the knobs) + a label (decision D6). A **run** = one batch of cells for
  (arch, model). `addArch`, `recordRun`, `configDigest`, `loadTree`. → `results/tree.json` + `results/runs/`.
- `aggregate.mjs` — port of the obstacle-course `aggregate.py`: `dedupeLatest` + `summarize` + `printTable`.
- `obstacles/<id>/grade.mjs` — each exports `meta` + `grade({model})` → `{passed, checks:[{name,pass,detail}]}`.

## Obstacles

- `07-capability-attenuation` — graded on the **live** field-agent cap model: `makeFieldAgent()` →
  `share('reference')` attenuates a sub-cap to exactly `[reference]` (it lacks the root's destructive
  powers), `revoke()` kills the swissnum (`nodeFor` → null); plus the canonical read-only-facet
  primitive (get works, mutator absent → throws). Deterministic — no LLM, no GPU, no network.

## Next (roadmap §6)

- LLM-graded obstacles (drive the real `runAgent`); conversation-**seeded** obstacles from the
  **prompt-harvest** pipeline (§6b, anonymized); the **orchestration-search** + per-model **champion**
  runners (§6c/d) that vary the arch config and adopt winners. Tie each new obstacle to a real ask.
