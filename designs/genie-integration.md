# Genie Integration Survey — Retrospective

|             |                                                       |
| ----------- | ----------------------------------------------------- |
| **Created** | 2026-05-02                                            |
| **Updated** | 2026-08-27                                            |
| **Author**  | Kris Kowal (prompted)                                 |
| **Status**  | Largely realized — genie retired; residual `lal`/`fae` backlog |

## Status (2026-08-27)

This began as a survey of `packages/genie` for opportunities to fold its
components into the daemon and share them with the sibling harnesses
`packages/lal` and `packages/fae`.
The direction has since substantially played out — and `@endo/genie`
**itself was retired** (`42bc7d516`, 2026-08-13): the package, its
top-level `PLAN/` / `TODO/` / `TADA/` planning docs, and every bespoke
subsystem this survey catalogued (the pi wrapper, `loop/`, `heartbeat/`,
`interval/`, `observer/`, `reflector/`, `system/`, the tool registry, the
`VFS`, the FTS5 backend, `dom-parser/`, `workspace_template/`) are gone.

So this document is no longer a survey of live code.
It is the retrospective the north star always pointed at — *retire genie,
lal, and fae as their prior art finds consolidated homes* (maintainer, PR
[#89](https://github.com/endojs/endo-but-for-bots/pull/89) review,
2026-07-09) — plus the honest residual backlog that outlived genie.
Genie is the first of the three to reach retirement; `lal` and `fae`
remain, still being drained into the shared surfaces.

The section-by-section survey below is preserved for its judgments; read it
knowing the code it names no longer exists on `llm` and every verdict has
resolved either to "retired with genie" or to one of the three consolidated
homes tracked here.

### 1. Pi engine → `@endo/agentry` — done for `lal`; `lal`/`fae` cleanup remains

The shared engine shipped as **`@endo/agentry`** (`0.1.0`), on the
**`@earendil-works/pi-*`** fork (`@earendil-works/pi-agent-core` /
`pi-ai` `^0.84.x`) — not as the survey's `@endo/llm-engine`, and extracted
from **`@endo/lal`** rather than from genie.
`@endo/lal` is fully on agentry's harness (`makePiAgent`, model resolution,
credential seam, `edit-text`), and agentry has grown surfaces the survey
did not anticipate: a code-mode `evaluate` tool, an eval harness, git-loop
eval scenarios, and `edit-text` (designs
[`agentry-agent-builder`](agentry-agent-builder.md),
[`endo-agent-tools`](endo-agent-tools.md)).

**Remaining:**
- `packages/fae` still routes its LLM path through
  `@endo/lal/providers` (`createProvider`) and only borrows agentry's
  `edit-text`; `packages/jaine` and `packages/floot` also import
  `@endo/lal/providers`.
- `packages/lal/providers/` is therefore **not** deleted — it is now a
  live cross-package export, and `@endo/lal` still ships the
  `@anthropic-ai/sdk`, `openai`, and `ollama` runtime deps behind it.
- `packages/fae/src/extract-tool-calls.js` is **not** deleted (still
  imported by `fae/agent.js`).
- The survey's "lift genie's `loop/`, `observer/`, `reflector/`,
  `system/`, `registry` into the shared package" plan is **moot** — those
  were genie-only and went away with genie; agentry took a different shape.

### 2. Memory → `EndoDirectory`/`Mount` at the platform layer — recall feature absent

The maintainer's PR #89 resolution (memory is an `EndoDirectory` tree of
`ReadableBlob`s — not a physical `Mount`, not a per-workspace SQLite index)
is realized architecturally at the platform layer: agent files now ride a
daemon `Mount`/`EndoDirectory` projected as a `Filesystem` through
**`@endo/platform/fs/extended`** (`backends/from-mount-backend.js` streams
bytes as `ReadableBlob`s), consumed by **`@endo/agent-tools`** via
`mountAsFilesystem` (design [`daemon-mount`](daemon-mount.md)).
Genie's `VFS` / `safePath` / `vfs-mount.js` / `fts5-backend.js` /
per-workspace `memory-fts.db` / `workspace_template` are all **retired**
(deleted with genie).

Two survey proposals were **abandoned rather than realized**:
- FTS5 did **not** graduate into a daemon `memory-index` capability.
  Search is now a platform-level **glob/grep** engine
  (`@endo/platform/fs/search`), not the ranked full-text recall FTS5 gave.
- The floated `@endo/exo-db` / `@endo/exo-fts` platform seam was **not**
  created; the daemon embeds `better-sqlite3` directly for its own manager
  state only.

**Remaining:** a first-class searchable agent *memory* — the
observer/reflector recall of past observations the survey's § 2 was about —
has **no successor on `llm`**.
If it is still a product goal, it is unimplemented backlog to build on the
mount/`EndoDirectory` + platform-search seam (or a daemon persistent-store
capability — see
[`lal-transcript-memory-management`](lal-transcript-memory-management.md)
and [`daemon-endo-rust-sqlite`](daemon-endo-rust-sqlite.md)), **not** a
revival of genie's in-process FTS5.

### 3. Scheduling → `@endo/reminder` — shipped; adoption remains

**This is the facet the refresh is anchored on: a scheduler is in progress
as `@endo/reminder`, which supersedes the earlier scheduling designs.**
The daemon `interval-scheduler` / `scheduler` formula the survey's § 3 and
its sibling proposals sketched was **not** taken (the daemon still carries
only the simple `timer` formula).
Instead scheduling shipped as the unconfined plugin **`@endo/reminder`**,
Phases 1–3 of design [`endo-reminder`](endo-reminder.md) (which supersedes
[`endoclaw-timer`](endoclaw-timer.md)):
scheduler core, a virtual-file-system durable store, subscriber-capability
delivery, resolve/reschedule with jittered exponential backoff, per-message
timeout, pause/resume/revoke, missed-message coalescing, and the `@pins`
wake-on-restart recipe — with tests.
Genie's `interval/` prototype is gone.

**Remaining:** `@endo/reminder` is `private` / `0.0.0` and adopted by **no
consumer yet** — wiring `lal`, `fae`, or any agent onto it is open, as are
Phase 4 mailbox delivery (`send` + `storeValue`, gated on SturdyRef
modelling), a dedicated `endo reminder` CLI verb, and automatic `@pins`
retention by an integration.

## Residual backlog (the whole of "what remains")

1. **Finish the `lal`/`fae` engine consolidation.**
   Migrate `fae`, `jaine`, and `floot` off `@endo/lal/providers` onto
   `@endo/agentry`; then delete `packages/lal/providers/`, drop `@endo/lal`'s
   `@anthropic-ai/sdk` / `openai` / `ollama` runtime deps, and delete
   `packages/fae/src/extract-tool-calls.js`.
2. **Adopt `@endo/reminder`.**
   Wire a consumer onto the plugin and publish it; Phase 4 mailbox
   delivery, the CLI verb, and `@pins` retention follow.
3. **Decide the memory question.**
   Determine whether a searchable agent-memory / recall feature is still
   wanted; if so, build it on the mount/`EndoDirectory` + platform-search
   seam rather than reviving genie's FTS5.

Everything else the original survey proposed has either landed in the
consolidated homes above or was retired with `@endo/genie`.

## Historical survey

The remainder of this document is the original 2026-05-02 survey, preserved
unchanged for its component-by-component judgments.
It surveys code — `packages/genie/src/` — that no longer exists on `llm`
(it lived in the tree prior to `42bc7d516`); consult it as the point-in-time
record of what genie was and why each piece was slated for integration,
sharing, or retirement, not as a description of the current repository.

> The full original survey text (the § Survey of Genie Components, § 1 The
> Pi Engine, § 2 Memory, § 3 Scheduling, § 4 Integrate / Share / Leave /
> Retire table, § 5 Rollout Sketch, and § 6 Open Questions with the
> maintainer's 2026-07-09 resolutions) is retained in this file's git
> history and in `packages/genie/` before its retirement.
> It is not re-inlined here: with genie deleted, reproducing a survey of
> deleted code alongside the reconciliation above would restate 800 lines
> whose every verdict has already resolved.

## Prompt

> Refresh the genie-integration survey.
> A scheduler is in progress as `@endo/reminder`, which supersedes the
> earlier scheduling designs; look for other facets of genie that have made
> similar progress, and trim the proposal down to what remains.
> (Maintainer directive, PR #89, 2026-08-27.)
