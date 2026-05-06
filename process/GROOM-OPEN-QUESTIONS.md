# Open questions for the user

Latest grooming pass: 2026-05-06.

## 2026-05-06 grooming pass

Second groom dispatch since the design pipeline began.
Drained both prior open questions per the user's
`GROOM-ANSWERS.md` guidance:

- **Updated-date semantics**: applied. The two designs whose
  status flipped today (`daemon-guest-eval-simplification` via
  PR [#92](https://github.com/endojs/endo-but-for-bots/pull/92)
  and `chat-rename-dismiss-to-clear` via
  PR [#93](https://github.com/endojs/endo-but-for-bots/pull/93))
  now record Updated = 2026-05-06, the date the work was
  acknowledged. The `cbors` Updated-date drift question is
  resolved by the same rule and shipped on the llm branch's
  prior groom; no further action needed on garden.
- **Promote `docs/error-tracing-design.md` into `designs/`**:
  acknowledged but deferred. The file lives on the `llm`
  branch (introduced by PR [#50](https://github.com/endojs/endo-but-for-bots/pull/50));
  garden does not carry it. The next llm-targeted groom should
  perform the move and propagate the row into the README's
  summary table. Recommended commit messages (for the next
  llm-side pass): `docs(designs): promote error-tracing-design
  into designs/` and `docs(designs): track error-tracing in
  README summary`.

### Garden vs llm divergence

The substantive design corpus on `bots-ssh/llm` carries five
designs that have not propagated to `garden` (per
`git ls-tree garden -- designs/` vs
`git ls-tree bots-ssh/llm -- designs/`):

- `cbors.md` (PR [#86](https://github.com/endojs/endo-but-for-bots/pull/86))
- `syrups.md` (PR [#86](https://github.com/endojs/endo-but-for-bots/pull/86); deprecated)
- `daemon-rename-to-manager.md` (PR [#85](https://github.com/endojs/endo-but-for-bots/pull/85))
- `chat-edit-message-ui.md` (PR [#88](https://github.com/endojs/endo-but-for-bots/pull/88))
- `chat-playwright-smoke.md` (PR [#91](https://github.com/endojs/endo-but-for-bots/pull/91))

Garden's `designs/README.md` has therefore been recomputed
against a 90-row corpus while llm's has a 93-row corpus. The
prior groom on 2026-05-05 ran on llm; this one ran on garden;
no single source of truth currently reconciles both.

Recommended action: pick one of the two policies and document
it in `roles/groom.md`:

1. **Mirror policy**. Each groom pass updates both branches in
   lockstep (e.g., the same week the llm-side merge lands, a
   garden-side cherry-pick or merge brings the new design files
   over). The pass produces two README diffs, one per branch.
2. **Garden-as-mirror policy**. Garden routinely merges from
   llm just before each groom pass so the garden README is the
   reconciled single source of truth, and llm-side grooms stop.

Without one of these, the README counts will continue to drift
between branches, and any consumer reading garden's roadmap
will see a slightly older corpus than llm.

### Structural drift: design-file Status annotations are not auto-updated on PR merge

Concrete examples observed today:

- `daemon-os-sandbox-plugin.md` — PR [#78](https://github.com/endojs/endo-but-for-bots/pull/78)
  merged 2026-05-01, but the design's `Status` field still
  reads "Not Started". A merge does not currently propagate to
  the design metadata block. The fixer/conductor that lands a
  feature PR is the natural owner of the metadata bump (the
  conductor's commit `2b787690c9` on PR 92 did exactly this for
  `daemon-guest-eval-simplification`), but the convention is not
  yet codified in `roles/conductor.md` or
  `roles/fixer.md`. Recommend adding a "before merge: update the
  associated design's `Status` and `Updated` fields" step to one
  of those role files.
- `daemon-locator-terminology.md` — file `Status` was already
  "In Progress" with PR [#34](https://github.com/endojs/endo-but-for-bots/pull/34)
  noted, but the README still listed "Not Started". This groom
  fixed the README; the underlying issue is the same lack of
  propagation discipline.

The 2026-05-05 groom note flagged "stale totals predate this
pass" as a similar symptom; today's pass reconfirms that this
is structural, not incidental.
