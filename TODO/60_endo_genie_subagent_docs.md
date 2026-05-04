# Genie sub-agent — documentation updates

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _Docs_.

Once the sub-agent capability is live, update each surface that
today documents `spawnAgent` as deferred so future readers see the
shipped shape.

- [ ] [`packages/genie/CLAUDE.md`](../packages/genie/CLAUDE.md)
  § "Sub-agent spawning" — flip from "deferred" to a description
  of the live capability.  Cross-link the `/spawn`, `/agents`,
  `/remove-agent` builtins (sub-task
  [`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md))
  and the flat-naming convention `<agentName>-sandbox` (TADA/23
  Decision 2).  Document the keyspace split: locator under
  `<agentDirectory>/<agentName>` (parent guest's pet store) vs
  slice handle under `<agentName>-sandbox` (sandbox plugin's
  daemon-state).
- [ ] [`packages/genie/README.md`](../packages/genie/README.md)
  — add a "Sub-agents" section explaining the two attenuation
  modes (scoped within parent vs. wholly separate) and the
  operator UX (`/spawn` and siblings).
- [ ] [`PLAN/endo_posix_sandbox.md`](../PLAN/endo_posix_sandbox.md)
  § "Phase 3.5b" — add a "landed" pointer once this task closes,
  plus a forward pointer to the still-open
  "sub-agent worker inside sub-slice" follow-up parallel to
  [`TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md`](../TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md).
- [ ] [`packages/sandbox/README.md`](../packages/sandbox/README.md)
  § "Nested slices" — cross-link the genie integration as a
  worked example of the attenuation rules (scoped sub-path mount
  + `private` network inheritance).
- [ ] [`packages/genie/CLAUDE.md`](../packages/genie/CLAUDE.md)
  § "Boot shape" — note that the same `provideGuest` plumbing
  3.5b uses for sub-agents is also reachable for the root genie
  via the operator-selectable knob filed under
  [`61_endo_genie_root_provide_guest_option.md`](./61_endo_genie_root_provide_guest_option.md);
  cross-link both directions.

Depends on: every preceding 3.5b sub-task that introduces a
user-visible surface (the docs describe what those landed).

Blocks: nothing inside 3.5b.
