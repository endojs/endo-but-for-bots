# Endo Design Milestones — Archive

Completed milestones move here from [README.md](README.md) once every
design in them has landed and the milestone's exit criterion is met (see
[AGENTS.md](AGENTS.md) § *Archiving Completed Milestones* for the rule).
Each archived milestone keeps its full detail — goal, design table, exit
criterion, and actual duration — so the archive reads as the delivery
history. The archived designs remain rows in the README summary table;
only the milestone sections move here. Ordered by milestone number.

---

## Milestone 1: Downloadable AI Agent Experience

(Was **Milestone 0** before the 2026-06-03 renumbering pass.)

**Archived:** 2026-08-17 — every design below is `Complete`; the exit
criterion (a downloadable Familiar app driving an agent with a local API
key) was met and the milestone has been closed since March 2026.

**Goal:** A Familiar application suitable for use on at least one
platform that folks can download and use to interact with an agent using
their own API key and local capabilities.

| Design | Status | Notes |
|--------|--------|-------|
| ~~daemon-256-bit-identifiers~~ | **Complete** | Core migration done |
| ~~daemon-form-request~~ | **Complete** | Fields as ordered array, CLI, Chat UI |
| ~~daemon-value-message~~ | **Complete** | `value` type, persistence, `submit()` delivery, Chat rendering, standalone `sendValue`, `send-value` CLI, daemon tests all done |
| ~~lal-reply-chain-transcripts~~ | **Complete** | Phases 1-4 implemented; Phase 5 (memory management) deferred as out-of-scope |
| ~~familiar-daemon-bundling~~ | **Complete** | esbuild bundles, Node download, Forge integration |
| ~~lal-fae-form-provisioning~~ | **Complete** | Manager/worker split, form-based config, inbox-replay recovery |
| ~~familiar-bundled-agents~~ | **Complete** | esbuild bundles, resource paths, env vars, daemon-node.js provisioning |

**Exit criterion:** There is a Familiar application suitable for use on
at least one platform that folks can download and use to interact with an
agent using their own API key and local capabilities.

**Actual duration:** 18 active work days (Feb 15 – Mar 5), primarily 1
developer (128 of 201 commits). 7 designs completed. Original estimate
was 3-4 days for the final item; revised to 0 remaining.
