# Endo Design Documents — Archive

Historical record for [`README.md`](README.md). The running “Layered on …”
groom notes and every superseded totals block live here so the index itself
stays lean. The index keeps only the single current-totals block; each grooming
pass appends its note to the top of the **Historical groom notes** section below
and moves the prior current-totals block into **Superseded totals**.

## Superseded totals

*Newest first. The live count is the current-totals block in [`README.md`](README.md).*

**Current totals (2026-08-16, post-2026-07-20-grooming rebase):** 43 Complete/Implemented, 22 In Progress, 40 Not Started, 32 Proposed, 2 Active, 7 Reference, 2 Deprecated, 3 Superseded (151 designs). This supersedes the counts in the historical summaries above. The 2026-08-16 pass adds [endo-claude](endo-claude.md) (Not Started), so Not Started goes 39 -> 40 and the design count 150 -> 151. The 2026-07-29 `pass-style-promise` rebase added [pass-style-promise](pass-style-promise.md) (Proposed), so Proposed went 31 → 32 and the design count 149 → 150; the 2026-07-20 grooming pass then flips [chat-pending-commands](chat-pending-commands.md) from In Progress to Complete (PR #133 merged to `llm` 2026-07-13), so Complete goes 42 → 43 and In Progress 23 → 22.

**Current totals (2026-07-22):** 44 Complete/Implemented, 22 In Progress,
43 Not Started, 37 Proposed, 2 Active, 13 Reference, 2 Deprecated, 3
Superseded (166 designs). This corrects the preceding historical snapshot
after filing the 17 unattended documents and recording the merged
`editMessage` successor as Complete.

**Totals:** 44 Complete/Implemented, 27 In Progress, 41 Not Started, 26 Proposed, 2 Active, 7 Reference, 2 Deprecated, 1 Draft, 2 Superseded (152 designs). 2026-08-16 adds `endo-claude` (Not Started) to M6 (MCP Bridge Hosting): `@endo/claude`, a hermetic `claude -p` whose only capability surface is one guest facet's MCP projection, the inverse direction of the minion.town mcp-endo-guest / mcp-daemon-guest-tools companions; Not Started 40 to 41, total 151 to 152; summary table, M6 constituent note, dependency graph, and per-design estimate synced. 2026-07-13 adds `ocapn-iroh-netlayer` (**Complete**), the iroh 1.0 QUIC netlayer for `@endo/ocapn` shipped as `@endo/ocapn-iroh`. 2026-07-24 adds `buffered-channel-exo-stream-consolidation` (**Complete**), the PR #486 review follow-up that consolidates the floot and claude-sandbox buffered reply channels onto a new push-fed `@endo/exo-stream` export; phases 1–2 (the `makeBufferedReader` primitive plus both package migrations) landed together on the floot–claude-sandbox integration branch, with the buffer-option semantics specified in the doc (no producer-side bound; the initiator's `iterateReader` `buffer` is prefetch-only for this channel); phase 3 (consumer flips to `iterateReader`, chat's `makeTextFeed` folded in, and the legacy surface dropped) has since landed too, so the design is Complete. 2026-07-16 adds `ocapn-orthogonal-persistence` (In Progress: the `@endo/thixotrope` prototype and the `@endo/captp` `provideImport` seam landed with the design; the XS engine adapter and durable host exports remain), In Progress +1, total 147 → 148. 2026-07-10 accepts the four-layer daemon-worker `importLocation` stack (`registry-capability`, `mvs-resolver`, `snapshot-mapper`, `daemon-worker-import-from-mount`): all four flip Proposed to Not Started together, with the canonical dependency-ordered build plan in `daemon-worker-import-from-mount` § *Phased Implementation*; the same pass recounts the table by tallying the status column of the summary table (the prose totals had drifted two designs low, 145 → 147). The recount, independent of the flips, corrects the prior prose by In Progress +2, Not Started −1, and Proposed +1 (two designs previously uncounted); the four Proposed to Not Started flips then add Not Started +4 / Proposed −4, so the buckets net to In Progress 24 → 26, Not Started 37 → 40, and Proposed 29 → 26, each reproducible by the same tally. 2026-07-09 revises `agentry-git-eval-scenarios` (Not Started) into a three-scenario git code-mode eval set: `stage-and-commit`, buildable `conflict-rebase`, and `stack-surgery` with fixture/scorer work landing behind a pending row while live activation depends on agentry-git-verb-gaps. 2026-07-08 adds `agentry-git-verb-gaps` (Proposed), the narrow local-git history-editing surface for the agentry `stack-surgery` eval lane. 2026-07-06 flips `daemon-agent-tools` from Not Started to In Progress: the reconciliation pass replaced its pre-trio `Dir`/`Shell`/`Git` sketch with the landed vocabulary (the filesystem and local-git tool groups shipped via the mount/git trio and `@endo/agent-tools` #523/#524), and the doc now carries the phased remaining work — the mount-derived `Shell` capability, the remaining file tools, the push tier, and provisioning — as buildable spec. 2026-06-25 adds the #416 pair: `endo-agent-tools` (In Progress, since #523 and #524 landed its first tools and the code-mode declaration renderer) and `agentry-agent-builder` (In Progress, its `defineAgent` builder core landed in #517; the extended surface is aspirational), and flips `agent-tools-mount-fs-tools` to Superseded (its raw-mount read tool is replaced by the canonical `ToolRecord` filesystem read tool). 2026-06-19 recounts the summary table (the prose totals had drifted four designs low — `137/18/29` → the recounted `141/21/28` across designs/In Progress/Proposed — and folds in the `fs-interface-consolidation` progress below). 2026-06-18 adds `fs-interface-consolidation` (In Progress), the sequenced follow-up that reduces overlap across the fs/name-hub guards once `fs-interface-reconciliation` aligned their names; all five phases have now landed — C2 shared records, C3/C4 daemon read-surface convergence (including the cross-surface mount unification and the blob range-I/O alignment), C1 EndoNameHub+EndoDirectory unification, and C5 dead-guard removal. The early "retire `BlobRef`" framing was reversed: `BlobRef` is the richest blob shape, so the daemon/lite blobs aligned **up** to its `getInfo`/`fetch` range-I/O surface (the shared `rangeReadMethodGuards` / `ReadableBlobRangeInterface`) and every public hash accessor moved to base64. The 2026-06-15 pass flips `break-dev-dependency-cycles` from In Progress to Complete (on `llm`) on the strength of cycle-graph verification (combined dep+devDep SCC count is 0; self-loop count is 0). 2026-05-27 adds `daemon-git-next-steps` (Proposed) as the forward-looking roadmap over the canonical git trio. Refreshed 2026-06-02 by the daemon-worker-import-from-mount decomposition: three new Proposed designs (`registry-capability`, `mvs-resolver`, `snapshot-mapper`) land as siblings of the repurposed integration-layer doc. The 2026-06-01 pass adds the **Peer App Sharing** milestone (formerly "Milestone A"; now Milestone 8 after the 2026-06-03 renumbering pass) including `app-sharing-milestone` and its three new Proposed designs (`familiar-deep-link-invitations`, `endo-app-sharing`, `familiar-app-ui-hosting`); see "Milestone 8: Peer App Sharing" below. Refreshed 2026-05-19 by a status-only sweep (consolidating the 2026-05-18 sweep with the 2026-05-19 batch update for 11 additional designs from closed PR #302) plus the patterns-diagnostic-feedback and ocapn-noise-session-reconnect Proposed entries; the 12-design jump in Complete/Implemented over the 2026-05-08 snapshot reflects shipped work whose Status field had not previously been updated, not new completions in that pass; see the corresponding "## Status" sections in each design file for evidence pointers (commit SHA or PR number). Totals reflect the 17 design files added on `llm` since the sweep's branch point (the endopi raft of `endopi` + 8 `endopi-*` gap-closing designs, `hardened-text-codecs-shim`, `hardened-url-shim`, namehub-interface-unification (Proposed) added by PR #117 on rebase, forge-gap-analysis (Reference) added 2026-05-20, the daemon mount and git capability trio: `daemon-mount-capabilities` + `daemon-git-capability` + `daemon-git-remotes`, `daemon-git-next-steps` (added 2026-05-27), and `gateway-package`, with the prior endo-gateway design folded into gateway-package and removed), plus the endo-gateway-mcp (Not Started) entry added 2026-05-29, the `daemon-worker-import-from-mount` (Proposed) entry added 2026-05-22, and the three layer-split designs from the 2026-06-02 refresh.

## Historical groom notes

*Layered on 2026-09-04 (created 2026-08-16, landed 2026-09-04): added
[worker-constraint-model](worker-constraint-model.md) (Proposed) to M11 (Rust
Daemon `endor`): an open, multi-axis worker-selection constraint schema
(runtime, persistence, version, target os/arch, each independently optional and
flexible-by-default) that replaces the closed `kind: 'locked' | 'node'` union
threaded through `manager.js`, the two `defaultWorkerKind`-reading resolution
sites, and the four supervisor `makeWorker` backends. Today's two kinds migrate
onto the runtime axis with zero behavior change and zero persisted-formula churn
(the migration is stated over the caller's explicit input, the predicate
today's `...(kind ? { kind } : undefined)` already uses, so the two seed values
keep their legacy `kind` record bytes and a `constraints` field appears only for
genuinely new axes), and the durable/orthogonal persistence (thixotrope #786 /
#989 / #281 / #984 / #813), version-pin, and target binary-fetch categories land
as typed `Not Started` extension points naming the exact seam each plugs into.
All five cross-document surfaces synced per `designs/AGENTS.md` § Progress
Tracking: the summary-table row, the M11 (Rust Daemon `endor`)
constituent-table row (and its milestone-rollup constituent count 6->7), the
dependency-graph node (`worker-constraint-model`, edge from
`ocapn-orthogonal-persistence`), the per-design size/duration estimate row (M11,
S-M / 3-4 days), and the "Recently added or revised" list. This addition is
Proposed +1, design count +1 against the live current-totals block (a delta line
records it in `README.md`; the maintainer's next grooming pass reconciles the
absolute running totals, which had drifted before this pass).*

*Layered on 2026-09-03 (client-side-bridge carve): re-worded **M3 (Remote
Access and Coding Capabilities)** — the first unfinished milestone, M1 and M2
being Complete — to name the two **client-side bridge** capabilities as its
now-first priority, from fresh concrete evidence (a 2026-09-02/03 liaison
session building a live counter on a minion.town clip hit the MCP/CapTP-bridge
byte-marshaling bottleneck: hand-typing tens of thousands of base64 chars, or
reverse-engineering CapTP to hand-write a ~10 KB client). The two halves of the
same bottleneck class — *get code/state across the MCP-daemon boundary without
an external LLM hand-marshaling bytes* — are (1) the **capability-addressed git
remote** (`git push` an artifact into an Endo directory; design
`git-remote-capability.md` on `kriscendobot/minion.town` PR #41, merged; endo
follow-on = the M3 git trio + `daemon-agent-tools` `makeGitRemoteTool` push tier,
Rust backing `endor-git-bindings` in M11) and (2) the **confined in-guest
agent** ([endo-claude](endo-claude.md), confinement core PR #1015 + child-guest
provisioning `endo-claude-agents-capability` PR #1102). Chose to **re-word M3
rather than splice a new milestone ahead of it**: M3 already owns the
git-remote follow-on substrate (git trio, agent-tools, mount, platform-fs) and
`endo-agent-tools` — the very prerequisite `endo-claude` depends on — so a new
milestone would either break the ledger's dependency invariant (each
milestone's deps live in earlier milestones, per PR #400) or force a disruptive
M3–M11 renumber; re-wording keeps the invariant intact. **[endo-claude](endo-claude.md)
moved M6 → M3** (a pointer left in M6, priority raised in M3, lowered in M6 —
never removed); its ~1-1.5 weeks moved with it (M6 added-effort ~3-3.5 → ~2
weeks). M6 keeps the inverse (external-client MCP-termination) direction. Added
four M3 table rows (git-remote-capability cross-repo companion, endo-claude,
endo-claude-agents-capability) and an M3 exit-criterion clause. No milestone
renumbering; every other milestone keeps its number and defers behind the
carved M3 head. Current-totals block unchanged: this pass adds no new repo
design *file* to the Summary table — `endo-claude.md` was already counted (2026-08-16
totals note), `endo-claude-agents-capability` is PR #1102 not yet on `llm`, and
`git-remote-capability` lives in `kriscendobot/minion.town`; the three appear
only as M3 milestone-table rows (cross-repo / in-flight companions).*

*Layered on 2026-07-30: added [cbor-encode-decode](cbor-encode-decode.md) to M4 (Networking): a packaging refactor that splits `@endo/cbor` into `@endo/cbor/encode` and `@endo/cbor/decode` subpath exports over an internal `internals.js` for the shared `canonicalInfo`/`CANONICAL_NAN`/bounds, so decoding consumers retain no encoding machinery and encoding consumers retain no decoding machinery; the root `.` re-export is preserved; follow-up to kriskowal's approving review of #885; summary table, M4 row, and per-design estimate synced.*

*Layered on 2026-08-24 (rolling index refresh): indexed six design files that had
landed on `llm` without a summary-table row — the Ironhorse trio
[ironhorse-engine](ironhorse-engine.md), [ironhorse-meter-opcode-cost-instrumentation](ironhorse-meter-opcode-cost-instrumentation.md),
and [ironhorse-test262-convergence](ironhorse-test262-convergence.md) (the latter two joining
`ironhorse-snapshot-store-seam` and `ironhorse-debugger-recovery-and-uncaught` in the M11
Rust-daemon table), plus [platform-neutral-hash](platform-neutral-hash.md),
[conservative-regexp-subset](conservative-regexp-subset.md), and
[readableblob-range-attenuation](readableblob-range-attenuation.md) — and reconciled stale
Status cells against each file's own header: the four-layer importLocation stack Proposed →
Not Started (the 2026-07-10 flip the prose recorded but the table never carried), the git
capability trio Proposed → In Progress, `daemon-agent-network-identity` /
`daemon-locator-terminology` / `agentry-git-verb-gaps` / `endopi-edit-tool` advanced to their
current in-progress state, and `endo-fs-seam-review-followups` Proposed → Complete. A fresh
Status-column tally supersedes the drifted historical totals; see the 2026-08-24 current-totals
line under the Summary table.*

*Layered on 2026-08-16: added [endo-claude](endo-claude.md) to M6 (MCP Bridge
Hosting): `@endo/claude`, a hermetically-sandboxed `claude -p` that provides an
Endo guest its LLM inference from a Claude subscription, confined so its only
capability surface is that one guest facet's MCP projection. The confinement is a
**combination** of flags, not `--bare` alone (`--bare` plus `--strict-mcp-config`
for MCP auto-discovery, plus `--setting-sources ""` for settings layers, plus
`--tools ""` plus `--disable-slash-commands` for built-ins and skills), then a
membership-validated facet-derived `mcp__<server>__<tool>` allow-list and never
`--resume`, run inside a required `@endo/claude-sandbox` OS slice for any
guest-influenced prompt. The inverse direction of the two minion.town companion
designs (mcp-endo-guest, mcp-daemon-guest-tools). Summary table, M6 constituent note,
dependency graph (including the `endo-posix-sandbox` prerequisite edge), per-design
estimate, and design-count totals synced; M6's own-work rollup now folds in
endo-claude's ~1-1.5 weeks.*

*Layered on 2026-08-14: revised
[endor-git-bindings](endor-git-bindings.md) after the Minion Town Git-remote
review reopened the backend choice. The design now binds a pinned, vendored
libgit2 through Rust, specifies Zig-based Windows/macOS/Linux cross-build and
native-run gates, and makes `rust/endor-git` plus its fixtures the shared seam
with Minion Town's smart-HTTP service; summary, M11, and estimate rows synced.*

*Layered on 2026-08-06: added
[endor-registry-proxy-worker](endor-registry-proxy-worker.md) to M11, moving
Endor package mapping into a compartment-mapper-backed XS worker and defining a
top-level packaged-application fixture corpus shared by Node,
compartment-mapper, and Endor; summary, dependency graph, M11 row, estimate,
totals, and timeline synced.*

*Layered on 2026-08-06: added [daemon-endor-sqlite-iterate-streaming](daemon-endor-sqlite-iterate-streaming.md) to M11 (Rust Daemon): a one-row XS SQLite cursor and `StatementSync.iterate()` parity surface that removes the pet-store startup's temporary all-rows allocation while preserving its final in-memory name map. Summary table, M11 row, dependency graph, estimate, totals, and timeline synced.*

*Layered on 2026-07-29: revised [conservative-regexp-subset](conservative-regexp-subset.md) to settle review choices for block-determinism safety, builder-selected corpus-backed limits, whole-string plus contains/composition modes, the XS `xsre` / #600 native direction, and the shared Node/compartment-mapper `endor` package-export condition.*

*Layered on 2026-07-22: retired the superseded `streamReply` roadmap entry in favor of the merged [daemon-message-streaming](daemon-message-streaming.md) revision surface, filed the previously unattended designs, and made the Minion Town federation experiment the roadmap's execution lead; existing milestone order remains the dependency order.*

*Layered on 2026-07-20 (weekly designs grooming pass): flipped [chat-pending-commands](chat-pending-commands.md) from In Progress to **Complete** (PR #133 merged to `llm` 2026-07-13, merge commit `82c81afa1`; landed as `packages/spaces-util/src/pending-commands.js` with the `#pending-commands-region` mount point in `packages/chat/chat.js`); summary, dependency-graph, milestone, and estimate rows and the totals synced (Complete 42 -> 43, In Progress 23 -> 22). Repaired dangling internal links: `cbors.md` -> `ocapn-tcp-syrup-framing.md`, the removed `endo-gateway.md` (folded into `gateway-package.md` via #343) -> `gateway-package.md` in `endo-gateway-mcp.md` and `registry-capability.md`, and the `d256.md` shorthand -> `daemon-256-bit-identifiers.md` in `chat-inventory-create-menu.md`. Renamed the framing design docs to the `-frame` convention (`cbors.md` -> `cbor-frame.md`, `syrups.md` -> `syrup-frame.md`, `ocapn-tcp-syrups-framing.md` -> `ocapn-tcp-syrup-framing.md`, matching the landed `@endo/syrup-frame` package and its `packages/syrup-frame` source references) per PR #804 review.*

*Last updated: 2026-07-13 (added [ocapn-iroh-netlayer](ocapn-iroh-netlayer.md) to M4 (Networking) as **Complete**: an iroh 1.0 QUIC netlayer for `@endo/ocapn` shipped as `@endo/ocapn-iroh`; summary table, M4 rows, dependency graph, and totals synced. Layered on 2026-07-16 (added [ocapn-orthogonal-persistence](ocapn-orthogonal-persistence.md) to M4 (Networking): a prototype distributed ocap machine, `@endo/thixotrope`, whose host daemon serves orthogonally persistent, sleepy CapTP workers as OCapN sturdy refs; the host persists its half of each worker session (slot counters, import descriptors, inbound-message journal) and resumes — not re-establishes — sessions across restarts via a new `@endo/captp` `provideImport` seam, with a deterministic journal-replay reference engine standing in for the `rust/endo/xsnap` snapshot engine; prototype, tests, and design landed together; summary table, M4 bucket, dependency graph, per-design estimate, and totals synced. Layered on the 2026-07-12 addition of [cbor-codec](cbor-codec.md) to M4 (Networking): a shared canonical-CBOR primitive codec package, `@endo/cbor`, extracted from the parallel head codecs in `packages/ocapn/src/cbor` and PR #124's `packages/slots/src/cbor.js` per kriskowal's follow-up request on the PR #124 review, with the daemon `envelope.js` codec as an optional later adopter and byte identity with `rust/endo/slots` enforced by shared golden vectors; summary table, M4 bucket and count, and per-design estimate synced. Layered on the 2026-07-10 acceptance and sequencing of the four-layer daemon-worker `importLocation` stack in M3: [registry-capability](registry-capability.md), [mvs-resolver](mvs-resolver.md), [snapshot-mapper](snapshot-mapper.md), and [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md) flip Proposed to Not Started together, and the canonical dependency-ordered build plan now lives in [daemon-worker-import-from-mount](daemon-worker-import-from-mount.md) § *Phased Implementation* (Phases 1–4 are the serial critical path to `endo run <mount>`; Phase 5 Rust drop-in and Phase 6 XS hosting are parallel-lane follow-ups over the landed `EndoMount.snapshot()` and `makeFromTree` substrate, which gates nothing). Reconciliation deltas: workspace-root discovery assigned to the mapper layer, the workspace-member `RegistryResolution` entry shape pinned in registry-capability (bare-name key, `workspace: true`, no `integrity`), and Phase 2's readable-tree fixture stance vs Phase 4's live-mount snapshot made explicit; summary table, M3 rows, and totals synced. Layered on the 2026-07-09 revision of [agentry-git-eval-scenarios](agentry-git-eval-scenarios.md) in M3 (Remote Access and Coding Capabilities): trimmed the `@endo/agentry` git code-mode eval set to `stage-and-commit`, `conflict-rebase`, and `stack-surgery`, with `stack-surgery` fixture/scorer work landing behind a pending row while live activation depends on [agentry-git-verb-gaps](agentry-git-verb-gaps.md); summary table, M3 row, and per-design estimate synced. Layered on the 2026-07-08 addition of [agentry-git-eval-scenarios](agentry-git-eval-scenarios.md) to M3: a small canonical git code-mode eval set for `@endo/agentry`. Layered on the 2026-07-06 addition of [exo-google-sheets](exo-google-sheets.md) to M7 (Weblets and Integrations): a Google Sheets connector, `@endo/exo-google-sheets`, presenting a spreadsheet as passable read-only / read-write facets over CapTP, backed by a plain `@endo/google-sheets` client that takes a fetch power from the endoclaw-oauth credential capability so the agent never sees the token; summary table, M7 bucket and count, dependency graph, per-design estimate, and milestone totals synced. Layered on the 2026-06-15 targeted post-event M2 closure: M2 (Project Hygiene) flipped to Complete on `llm` since turborepo is in place (PR #121 merged), `break-dev-dependency-cycles` is dissolved on `llm` (all five `@endo/<pkg>-test` sibling packages exist; combined dep+devDep SCC count is 0; self-loop count is 0); the residual upstream-ferry work on PR #235 against master is M2-orthogonal — the cycle is broken on the project branch and the substrate noise it produced is gone. Layered on the 2026-06-03 milestone renumbering pass per maintainer directive on PR #400 review: resequence to integer numbers starting at 1, with no later milestone depending on an earlier one, prioritizing work entrained by the hosted-Gateway-service north star and deferring work that is not. Old → new mapping: M0 → M1 (Complete), M½ → M2 (Complete), M1 → M3 (Remote Access & Coding Capabilities, the gateway substrate), M2 → M4 (Networking), M7 → M5 (Public Hosting & Billing), Milestone B → M6 (MCP Bridge Hosting), M3 → M7 (Weblets & Integrations), Milestone A → M8 (Peer App Sharing), M4 → M9 (UX & Tooling), M5 → M10 (Confinement & Ecosystem), M6 → M11 (Rust Daemon `endor`). Layered on the 2026-06-02 compound pass: (a) MCP-bridge rebucket that added the **Milestone B: MCP Bridge Hosting** cross-cutting cut (since renumbered to M6) and the hosted-Gateway public-hosting bucket (M7, now M5), raised `endo-gateway-mcp` as a Strategic Early Item (now M6 in its own right), and named the gateway-package implementation stack PRs #343, #388–#397 (phases 1–9 landed) under what is now M3; and (b) daemon-worker-import-from-mount decomposed into a four-layer stack per kriskowal CHANGES_REQUESTED on `endojs/endo-but-for-bots#358` (the original 1164-line monolith repurposed as the integration layer; three new sibling designs land alongside as `registry-capability`, `mvs-resolver`, `snapshot-mapper`; existing slug preserved). On the 2026-06-01 pass that added the Peer App Sharing cut (`app-sharing-milestone` + `familiar-deep-link-invitations` + `endo-app-sharing` + `familiar-app-ui-hosting`; now M8). On the 2026-05-22 monolithic `daemon-worker-import-from-mount` landing (sibling of `daemon-make-archive` § Phase 7 that ties `compartment-mapper.importLocation` to a `package.json`-rooted `EndoMount` source and the Rust `endor-npm-registry-proxy` + Go-like MVS resolver exposed as an `EndoRegistry` / `@registry` daemon capability). On the 2026-05-20 mount and git capability plans (three new design docs revised per design-panel review: structured-result-shape migration deferred to Phase 7, `tree(ref)` and `readOnly()` both live on the `Git` cap, `NativeGitBackend` hardening envelope split off the essential `GitBackend` contract, `EndoMountBacking` pinned to a hidden Exo facet, credential-injection mechanism named, native git pinned to >=2.30, restart-mid-operation tests added, open-question debt reduced from 20 to 2; landed on top of the same-day forge-gap-analysis Reference design and the same-day full grooming pass that reconciled milestone-totals, added the 2026-05-20 calibration round, re-projected the Summary by Milestone and Gantt, and refreshed Progress-as-of). On the 2026-05-19 status-only sweep that reconciled Status fields with shipped state on `llm`, the project-hygiene milestone (now M2) extracted from the gateway substrate, endopi raft added, PR #302 consolidation absorbed, and patterns-diagnostic-feedback added)*
