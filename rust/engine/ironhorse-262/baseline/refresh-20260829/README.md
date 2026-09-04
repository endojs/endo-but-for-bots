# Ratchet refresh snapshot — 2026-08-29

The authoritative whole-corpus totals at the head of the
`feat/ironhorse-test262-compliance-ratchet` PR, produced by
`scripts/full-run.sh --jobs 16` (oracle on, whole `test/**` tree) against
the same pinned corpus (`../../TEST262_REVISION`,
`tc39/test262@be13516fb644`) and Moddable XS oracle (`23b4d6b0a65f`,
XS 8.3.1) as the immutable 2026-08-08 starting snapshot in [`../`](../).

This refresh supersedes that starting snapshot as the **ratchet floor**:

1. **No path in [`covered.txt`](./covered.txt) may regress.**
2. **[`baseline.json`](./baseline.json)'s `failures` list is the complete
   permitted `ironhorse-failure` set** — empty at this refresh; any new
   entry is a regression unless a demonstrated oracle/harness cause
   reattributes it to infrastructure.
3. The exact-metering corpus under `../../cases/**` stays passing
   (`cargo test -p ironhorse-262`, which drives `--gate-meter-exact`).

Every failure cluster resolved on the ratchet branch is additionally
enforced by a dedicated dual-run regression suite under `../../tests/`
(`super_null_home_prototype`, `set_prototype_cycle`, `regexp_nul_subject`,
`iterator_protocol_errors`, `function_prototype_property`,
`error_stack_accessor`), so the resolved official cases stay resolved
independently of whole-sweep reruns.

The starting snapshot's totals, for the ratchet's before/after record
(52,092 discovered cases at engine `14f26d0a6`; discovery has since
narrowed to 51,976 — module cases now flow through the module pipeline
and report as named infrastructure outcomes rather than being folded in):

| Category | 2026-08-08 start | this refresh |
| --- | ---: | ---: |
| covered | 4,740 | 29,867 |
| ironhorse-failure | 19 | 0 |
| unsupported | 38,400 | 14,113 |
| skipped | 8,932 | 7,378 |
| infrastructure | 1 | 618 |
