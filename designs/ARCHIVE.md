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

---

## Milestone 2: Project Hygiene

(Was **Milestone ½** before the 2026-06-03 renumbering pass.)

**Archived:** 2026-08-17 — all six designs are `Complete`/`Implemented`
on `llm` and the exit criterion (shared byte/encoding/test-helper libraries
factored out of per-package duplicates, the workspace devDep cycle dissolved,
CI hardened against npm lifecycle scripts, and a Chat-bundle build-and-load
smoke gate) was met on 2026-06-15.

**Goal:** Build-system and shared-library hygiene that does not deliver
user-facing capability on its own but unblocks (or cleans the substrate
for) the capability work in Milestone 3 (formerly M1). Extracted from
M1 (now M3) on 2026-05-14 once it became clear that several rows in
that table satisfied the two-question criterion: (a) not user-facing
capability, and (b) prereq or substrate-cleanup for the next milestone's
capability work. Surfacing them as a separate bucket lets M3's "Remote
Access and Coding Capabilities" exit-criterion remain readable as a
capability list rather than a capability-plus-hygiene mix.

| Design | Status | Notes |
|--------|--------|-------|
| ~~endo-bytes~~ | **Implemented** | New `@endo/bytes` package for portable `Uint8Array` helpers (`concatBytes`, `bytesEqual`, `bytesFromText`, `bytesToText`); retires duplicates in `cli`, `ocapn`, and `daemon` (PR #142); follow-up `bytesToImmutable`/`bytesFromImmutable` in 94ffbd401; ocapn refactor in PR #223; buffer-utils inlining in PR #227 |
| ~~chat-playwright-smoke~~ | **Complete** | Build-and-load smoke for the Chat bundle in the `browser-tests` job; PRs #91 (design), #94 (impl), #95+#104 (harden/import fixes) |
| ~~hex-package~~ | **Complete** | `@endo/hex` ponyfill shipped; consumer migration landed via `kriskowal-hex` follow-ups; synthetic `@endo/hex-test` lands Cut 2 of break-dev-dependency-cycles (PR #211) |
| ~~break-dev-dependency-cycles~~ | **Complete** (on `llm`) | Synthetic test-package factoring retires the workspace devDep SCC on `llm`: Cut 2 (`@endo/hex-test`, PR #211), Cut 3 (`@endo/zip` devDep delete, PR #209), Cut 4 (`@endo/harden-test`, PR #210), Cut 5 (`@endo/eventual-send-test`, PR #247), and Cut 1 (`@endo/ses-test`, PR #261) have all landed on `llm`. Verified 2026-06-15: combined dep+devDep SCC count is 0; self-loop count is 0; `scripts/check-dependency-cycles.sh 0` passes. The upstream-ferry mirror PR #235 against master is the master-side mirror of the same cuts and is M2-orthogonal — the cycle is broken on the project branch and the substrate noise is gone |
| ~~ci-no-npm-lifecycle~~ | **Complete** | `.yarnrc.yml` pins `enableScripts: false` and CI installs with `yarn install --immutable`; PR #126 merged 2026-05-15 (master-base mirror staged as PR #250) |
| ~~base64-native-fallthrough~~ | **Complete** | `@endo/base64` dispatches to `Uint8Array.fromBase64` / `toBase64` when available; landed on `llm` via `actual/master` merge (commit `7325bbe15`, from `endojs/endo#3216`) |

**Exit criterion:** The shared byte/encoding/test-helper libraries are
factored out of per-package duplicates (`@endo/bytes`, `@endo/hex` fully
migrated, `@endo/base64` native fast paths). The workspace devDep cycle
is dissolved so turbo's `^build` form prints no cycle warning. The CI
posture is hardened against npm lifecycle scripts. The Chat bundle has
a build-and-load smoke gate. None of these are user-visible features
on their own; together they remove substrate noise that otherwise
accompanies every M3 capability commit.

**Status:** **Complete** on `llm` as of 2026-06-15. All six rows above
are Complete or Implemented on the project branch. The remaining
upstream-ferry effort (PR #235 mirroring the cuts to master) is
tracked separately and is not a blocker for M2's exit criterion on
`llm`.
