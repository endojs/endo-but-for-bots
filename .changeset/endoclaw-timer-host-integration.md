---
'@endo/daemon': minor
'@endo/cli': minor
---

Complete the EndoClaw interval scheduler's host integration (endoclaw-timer
design § Phase 4). The `interval-scheduler` formula now incarnates as the
`{ scheduler, schedulerControl }` facet pair rather than a single combined
capability: `scheduler` is the agent-facing facet (`makeInterval` / `list`),
and `schedulerControl` is the host-retained `IntervalControl` facet
(`pause` / `resume` / `revoke` / `setMaxActive` / `setMinPeriodMs` /
`listAll`). The host `makeIntervalScheduler(petName, options?)` method resolves
to — and stores under the pet name — this pair, so a host can grant the
scheduler to an agent while retaining control.

Adds the `endo interval list|pause|resume <name>` CLI, where `<name>` is the
pet name a scheduler was stored under: `list` reads the scheduler's intervals
through the agent-facing facet, and `pause` / `resume` drive the host-facing
control facet. `IntervalEntry` is now exported from `@endo/daemon` for the CLI
renderer.
