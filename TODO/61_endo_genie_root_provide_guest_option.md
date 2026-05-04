# Genie root — operator-selectable `provideGuest` boot mode

Captured under
[`50_endo_genie_sandbox_subagents.md`](./50_endo_genie_sandbox_subagents.md)
as the "restore the `provideGuest` option" follow-up; tracked
here because it is independent of TADA/23's sub-agent
deliverables but reuses the same `provideGuest` plumbing 3.5b
revives.

## Goal

Restore the option — removed in commit `84bfd2303`
("feat(genie) embody the main agent, full @self ; RIP
provideGuest") — for the bottle operator to choose between today's
default (root genie owns `@self`, full host powers) and a
guest-attenuated boot where `main.js` runs with a `provideGuest`-
minted `EndoGuest` as `powers` and the host agent reachable only
via an explicitly-introduced name.

The choice is a **bottle operator option**: the launcher
(`packages/genie/setup.js`) reads a knob (env var, flag, or
persisted launcher config) and routes to one of the two boot
shapes accordingly.  The default may stay `host` for backward
compatibility with the existing `bottle.sh invoke` UX, but the
operator must be able to flip to `guest` without editing
`setup.js`.

## Why this exists

The 3.5a sandbox slice confines tool spawns
(`bash` / `exec` / `git`) but the root genie's `main.js` itself
runs as `@self`, so an LLM-misled `eval` or in-process file
read still has direct access to every host-level capability
the daemon exposes (mount provisioning, child-agent
management, mail forwarding, etc.).

A `provideGuest`-minted root narrows that surface: `main.js`
sees only the `introducedNames` the launcher hands it
(`workspace-mount`, `sandbox-factory`, optionally
`@agent` → `host-agent` for spawn-capable deployments).  The
attack surface that remains is the union of those caps, not
the entire host pet store.

Architecturally, this also makes the root genie shape uniform
with sub-agents (TADA/23) — both run as guests with explicit
`introducedNames`, the only difference being which caps the
operator hands to each.

## Knob shape (to decide during implementation)

Pick one and document the rejected alternatives:

1. **`GENIE_ROOT_POWERS=host|guest` env var** read by
   `setup.js`.  Simplest, parallels the existing `GENIE_*`
   forwarding table.  Default `host` keeps backward
   compatibility.
2. **`bottle.sh` flag** (`--root-powers=host|guest` or
   `--guest-root`) that translates to the env var.  Operator-
   facing surface; mirrors how `bottle.sh` already wraps
   common options.
3. **Persisted launcher config** under
   `<workspace>/.genie/config.json` (the same file
   `/model commit` writes).  Most operator-friendly long-term
   but couples launcher boot to the persisted-config schema —
   may want to land (1) first and migrate to (3) later.

## Deliverables

- [ ] **Decide the knob shape.**  Record the decision in this
  file under a § "Decisions" block once chosen.  Document the
  rejected alternatives.
- [ ] **`guest` mode in `setup.js`.**  Add a branch that:
  1. Provisions a `setup-genie` (or similarly-named) guest via
     `E(hostAgent).provideGuest('setup-genie',
     { introducedNames: harden({ '@agent': 'host-agent',
       [WORKSPACE_MOUNT_NAME]: WORKSPACE_MOUNT_NAME,
       [SANDBOX_FACTORY_NAME]: SANDBOX_FACTORY_NAME }),
       agentName: 'profile-for-genie' })`.
  2. Calls
     `E(hostAgent).makeUnconfined('@main', genieSpecifier,
     { powersName: 'setup-genie',
       resultName: 'main-genie', env })`.
  3. Stays idempotent across re-runs and daemon restarts (the
     `has('setup-genie')` short-circuit pattern from the
     pre-`84bfd2303` setup.js, paired with the existing
     `has('main-genie')` guard).
- [ ] **`host` mode preserved.**  The existing
  `powersName: '@agent'` branch stays exactly as today; the
  guest branch is purely additive.
- [ ] **`main.js` adapts to either shape.**  `runRootAgent`
  resolves `sandbox-factory` and `workspace-mount` from
  `powers` regardless of whether `powers` is the host agent
  or a guest.  Today's `runRootAgent` already uses
  `E(rootPowers).has(...)` and `E(rootPowers).lookup(...)`,
  which work on both `EndoHost` and `EndoGuest` — verify and
  add a regression test.
- [ ] **Self-send and mail.**  Audit every `'@self'` /
  `'@host'` send in `main.js` (around lines 494, 554, 603,
  659, 1272) — under the guest mode, `@self` resolves to the
  guest's own identity and `@host` resolves to the daemon's
  root agent (now reachable as `host-agent` in the guest's
  pet store).  Make sure heartbeat self-sends, the agent
  loop's mail follow, and the readiness announcement still
  land in the right inboxes.
- [ ] **`spawnAgent` parent powers.**  Sub-task
  [`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md)
  resolves `parentPowers` for `/spawn` from the dispatch
  context — under the guest mode, `parentPowers` is the
  guest itself; under the host mode, it is the root host
  agent.  The shared helper introduced by sub-task
  [`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md)
  must accept either.
- [ ] **Tests.**  Boot smoke for both modes against a forked
  daemon: `host` mode keeps today's `self-boot.test.js`
  passing; `guest` mode runs the same loop with
  `powersName: 'setup-genie'` and asserts the genie cannot
  reach pet names it was not introduced to (e.g. a sentinel
  pin under the root host).
- [ ] **Docs.**
  - [ ] `packages/genie/CLAUDE.md` § "Boot shape" describes
    both modes; the "Identity model" section gets a
    qualifier ("the genie owns `@self` _under the default
    host-powers boot mode_; under the guest-powers mode,
    `@self` is the genie's guest identity and the daemon's
    root agent is reachable as `host-agent`").
  - [ ] `packages/genie/README.md` documents the operator
    knob and the trade-off (uniform-with-sub-agents vs
    fewer-introductions for root-only deployments).
  - [ ] `packages/genie/scripts/bottle.sh` banner shows
    which mode the bottle is running in.

## Out of scope

- Pushing the worker process itself into the slice — that is
  [`TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md`](../TADA/24_endo_posix_sandbox_phase3_5a_worker_inside_slice.md).
- Removing the `host` mode entirely — keep both available so
  operators who depend on the host-powers UX (e.g.
  programmatic mail forwarding through `@self`) are not
  forced to migrate.

## Status

- 2026-05-04: Filed alongside the TADA/23 sub-agent
  follow-ups in [`50_…`](./50_endo_genie_sandbox_subagents.md).
  Knob shape (env var vs flag vs persisted config) not yet
  decided.
