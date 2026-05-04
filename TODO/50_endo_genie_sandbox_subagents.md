# Endo genie sandbox — Phase 3.5b sub-agent follow-up tracking

Parent TADA:
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md).

Mirrors the [`TADA/30_endo_genie_sandbox.md`](../TADA/30_endo_genie_sandbox.md)
decomposition Phase 3.5a got, but lives under `TODO/` because
implementation has not started — TADA/23's prerequisite status block
notes 3.5b is blocked on TADA/22's deliverables landing first, and
those are tracked under TADA/30–41.

- [x] create `TODO/` task follow-ups for the deliverables in
  `TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`
  (the original bullet referenced TADA/22; corrected to TADA/23 to
  match the file name and the sub-agent scope of this index)
- [x] also restore an option so that the root genie can be made to
  work with a mere `provideGuest` again, rather than full host
  powers — filed as
  [`61_endo_genie_root_provide_guest_option.md`](./61_endo_genie_root_provide_guest_option.md)
- [x] whether to grant the root genie such broad host powers should
  be a bottle operator option — captured inside
  [`61_…`](./61_endo_genie_root_provide_guest_option.md) as the
  `GENIE_ROOT_POWERS=host|guest` (or equivalent) launcher knob

## Follow-ups (TADA/23 deliverables)

One file per non-struck deliverable in TADA/23 § "Deliverables".
Ordered roughly by dependency (top-to-bottom can be picked up in
sequence; siblings within a level are independent).

- [ ] [`51_endo_genie_subagent_fork_slice.md`](./51_endo_genie_subagent_fork_slice.md)
  — sub-slice mint via `SandboxHandle.fork()`, pinned at
  `<agentName>-sandbox`.
- [ ] [`52_endo_genie_subagent_provide_guest.md`](./52_endo_genie_subagent_provide_guest.md)
  — sub-agent identity via `provideGuest` with the sub-slice in
  `introducedNames`.
- [ ] [`53_endo_genie_subagent_worker_boot.md`](./53_endo_genie_subagent_worker_boot.md)
  — sub-agent worker boot via daemon `makeUnconfined` (host-side,
  parallel to 3.5a Decision 2 / TADA/22).
- [ ] [`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md)
  — `agentDirectory` tracking (`<agentDirectory>/<agentName>`
  locator pin in the parent's pet namespace).
- [ ] [`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md)
  — `removeChildAgent` three-step teardown (slice → guest →
  directory entry).
- [ ] [`56_endo_genie_subagent_list.md`](./56_endo_genie_subagent_list.md)
  — `listChildAgents` (with optional liveness probe).
- [ ] [`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md)
  — `/spawn`, `/agents`, `/remove-agent` builtins in the specials
  dispatcher.
- [ ] [`58_endo_genie_subagent_dispose_cascade.md`](./58_endo_genie_subagent_dispose_cascade.md)
  — parent-disposal cascade verification (no orphaned sub-slice
  scratch dirs).
- [ ] [`59_endo_genie_subagent_tests.md`](./59_endo_genie_subagent_tests.md)
  — acceptance tests for both attenuation modes, both backends.
- [ ] [`60_endo_genie_subagent_docs.md`](./60_endo_genie_subagent_docs.md)
  — `CLAUDE.md` / `README.md` / `PLAN` / sandbox README doc updates.

## Additional follow-up — root genie guest mode

Independent of TADA/23's deliverables; tracked here because it
reuses the same `provideGuest` plumbing 3.5b revives for sub-agents
and reaches the same architectural goal — attenuating LLM-misled
host access.

- [ ] [`61_endo_genie_root_provide_guest_option.md`](./61_endo_genie_root_provide_guest_option.md)
  — operator-selectable `provideGuest` boot for the root genie,
  restoring the pre-`84bfd2303` "RIP provideGuest" shape behind a
  launcher knob.

The struck "land `main.js` inside the sub-slice" deliverable in
TADA/23 is filed as a follow-up parallel to
[`TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md`](../TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md);
no TODO file is created for it here.

## Prerequisite status

TADA/23 § "Prerequisite status" notes that 3.5b is blocked on 3.5a's
deliverables landing in code.
The status of each 3.5a deliverable lives in TADA/31–41; pick up
3.5b sub-tasks once the upstream blockers in
[`TADA/40_endo_genie_sandbox_tests.md`](../TADA/40_endo_genie_sandbox_tests.md)
§ "Blockers" close (specifically the `setup.js` `'@agent'` worker
regression and the `provideHostPath` surface mismatch — both fire
on every `bottle.sh invoke` and would cascade into 3.5b's
`fork()`-on-the-root-slice path).
