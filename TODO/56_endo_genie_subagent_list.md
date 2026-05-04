# Genie sub-agent — `listChildAgents`

Sub-task of
[`TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md`](../TADA/23_endo_posix_sandbox_phase3_5b_genie_subagent.md)
§ "Deliverables" — _`listChildAgents`_.

The dormant helper at
[`packages/genie/main.js:1313-1322`](../packages/genie/main.js)
already walks the `agentDirectory` pet-namespace entries.  Keep
its surface unchanged externally; document that each entry now
corresponds to a live sub-slice (`<agentName>-sandbox` in the
sandbox plugin's keyspace) **and** a guest (`<agentName>` in the
parent host's pet store).

- [ ] Re-export `listChildAgents` from
  [`packages/genie/main.js`](../packages/genie/main.js) (it is
  already `harden`-ed; the only change is the documentation
  comment update).
- [ ] **Optional liveness probe**: for each name, the helper may
  `await E(parentHost).has(agentName)` and report any tombstones
  the three-step teardown
  ([`55_endo_genie_subagent_remove.md`](./55_endo_genie_subagent_remove.md))
  skipped (defence in depth against a half-failed
  `removeChildAgent`).
- [ ] **Optional slice probe**: for each name, the helper may
  surface the slice's reported state from the sandbox plugin's
  keyspace so `/agents` (sub-task
  [`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md))
  can print one line per child with `(name, slice state, guest
  pet name)`.
- [ ] Document the keyspace split in `CLAUDE.md` § "Sub-agent
  spawning" (handled by
  [`60_endo_genie_subagent_docs.md`](./60_endo_genie_subagent_docs.md)).

Depends on:
[`54_endo_genie_subagent_directory.md`](./54_endo_genie_subagent_directory.md).

Blocks:
[`57_endo_genie_subagent_specials.md`](./57_endo_genie_subagent_specials.md).
