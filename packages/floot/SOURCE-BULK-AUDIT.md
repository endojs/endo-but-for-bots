# Hosted source-bulk audit

Date: 2026-10-01.
Source revision: `9b888d1ccb702f67648509184d05b9edc0d113ee`, PR #1248.
This follows the explicit tool-outcome and initial Claude checkpoint fixes.
It audits current code and callers, not the PR's superseded implementations.
It supplements [refactor alignment](REFACTOR-ALIGNMENT.md), the
[simplification audit](SIMPLIFICATION-AUDIT.md), and the
[architecture audit](ARCHITECTURE-AUDIT.md).

## Findings

The four backend/shared packages contain **42,786 physical source lines**.
This is not the size of the whole repository or the whole Floot implementation.
`hosted-agent` holds 56.5%; provider/network and account/pooling code together
account for 58.0% of that shared package.
The ten largest files hold 30.7% of the four-package total.

Concrete unused surfaces and legacy compatibility paths remain, alongside
several small repetitions worth consolidating locally.
The immediate evidenced deletions are small, not thousands of lines.
The optional sharing/delegation subsystem is a larger scope decision, not dead code.
No evidence justifies replacing the current ownership layers with another framework.
The original smaller-combined-implementation target remains unproven.

The tables describe the initial audit snapshot; the progress section records
subsequent implementation.
The concrete deletion and compatibility candidates SB-01 through SB-08 are now
removed, reducing this same source metric to 42,610 lines.
Further implementation should follow deletion before abstraction, with independent
adversarial review and focused regression tests before each commit.

## Measurement and scope

Count committed `.js`, `.mjs`, and `.ts` paths in `hosted-agent`, `claude-sandbox`,
`codex-sandbox`, and `opencode-sandbox`.
Exclude `.d.ts`, `test`, `tests`, `fixtures`, `test-types`, and `test-fixtures`
directories and filenames containing `.test.` or `.test-d.`.
Count newline characters in each committed file, including comments, JSDoc,
type definitions, entrypoints and package operator scripts.
Do not count dependencies, generated declarations, bundles, tests or Markdown.
Floot, Fae, chat/UI, daemon, the host repository and images' installed software
are outside this four-package metric.
Absence of a final newline would not count an additional line under this method.

For reproduction, enumerate only the four package paths with
`git ls-tree -r --name-only REV -- packages/hosted-agent packages/claude-sandbox
packages/codex-sandbox packages/opencode-sandbox`, apply the exclusions above,
and count `\n` in `git show REV:PATH`.
Use committed contents rather than working-tree/generated files.

| Package | Files | Lines | Share | Design baseline `4e2644c` | Change |
|---|---:|---:|---:|---:|---:|
| hosted-agent | 81 | 24,157 | 56.46% | 4,298 | +19,859 |
| claude-sandbox | 27 | 7,077 | 16.54% | 6,484 | +593 |
| codex-sandbox | 34 | 6,892 | 16.11% | 7,901 | −1,009 |
| opencode-sandbox | 18 | 4,660 | 10.89% | 6,780 | −2,120 |
| Total | 160 | 42,786 | 100% | 25,463 | +17,323 |

Vendor packages total 18,629, down 2,536 from 21,165 at the baseline.
That reduction does not offset the shared package's growth.
Compared with `604ec1a8d`'s 42,712 lines, the two correctness fixes add 74:
52 in Claude and 22 in Codex, with no change to the shared-package count.
Their Floot/UI changes are outside this metric.

A supplemental lexical count uses the existing ESLint Espree tokenizer, with
latest ECMAScript, module syntax, locations and tokens enabled.
For each physical line, classify it as token-bearing if any token spans it;
otherwise distinguish whitespace-only from comment-only lines.
Multiline strings and punctuation count as token-bearing, not as comments.
This is not a count of statements, executable instructions or complexity.

| Package | Token-bearing | Comment-only | Blank | Total |
|---|---:|---:|---:|---:|
| hosted-agent | 16,110 | 7,241 | 806 | 24,157 |
| claude-sandbox | 4,868 | 1,975 | 234 | 7,077 |
| codex-sandbox | 5,332 | 1,330 | 230 | 6,892 |
| opencode-sandbox | 3,187 | 1,255 | 218 | 4,660 |
| Total | 29,497 | 11,801 | 1,488 | 42,786 |

27.6% is comment-only and 3.5% blank.
Deleting useful contract documentation would improve the gross number without
necessarily simplifying the implementation.
The gross count remains the baseline-comparable metric.

## Where the shared-package bulk lives

These disjoint filename buckets use the first-match rules already recorded in
[the scope-attribution inventory](SIMPLIFICATION-AUDIT.md#scope-attribution-against-the-design-baseline-2026-09-30).
They are accounting buckets, not separate architectural components or proof
that each added responsibility belongs in this PR.

| Category | Lines | Share of shared package |
|---|---:|---:|
| Provider/public network | 8,048 | 33.31% |
| Accounts/catalogs/credentials/pools/reset | 5,974 | 24.73% |
| Lifecycle/policy/storage | 3,438 | 14.23% |
| Delegated runners/subscription sharing | 2,114 | 8.75% |
| Setup/specifiers | 1,865 | 7.72% |
| MCP | 735 | 3.04% |
| Transcript/channel/usage | 871 | 3.61% |
| Other | 1,112 | 4.60% |
| Total | 24,157 | 100% |

Within provider/network, the broker and broker service total 3,519 lines;
grant issuer 864; listener runtime 689; fetch transport 562; inference listener
330; public egress/proxy/DNS 1,009; and remaining scope, pipe, path, usage and
worker/network helpers 1,075.
The baseline already contained the same 1,009 public-network lines in Codex.
Their relocation is not new combined source growth.

### Ten largest files

All paths below are relative to `packages/` and all measurements use the same scope.
These ten files total 13,116 lines.

| File | Lines | Retained responsibility |
|---|---:|---|
| `codex-sandbox/src/codex-client.js` | 2,184 | App-server turn protocol, native context, cancellation and settlement |
| `hosted-agent/src/provider-broker.js` | 1,819 | Credentialed inference routing, transport and usage settlement |
| `hosted-agent/src/provider-broker-service.js` | 1,700 | Broker composition, account/pool selection and listener ownership |
| `claude-sandbox/src/claude-client.js` | 1,430 | Claude stream state, native capture, cancellation and settlement |
| `opencode-sandbox/src/opencode-bridge.mjs` | 1,204 | OpenCode event/protocol bridge and native checkpoint handling |
| `hosted-agent/src/hosted-setup.js` | 1,199 | Durable setup/publication of brokers, accounts, shares and runners |
| `opencode-sandbox/src/opencode-client.js` | 977 | Client process/transport, turns, context and cancellation |
| `claude-sandbox/src/claude-context-coverage.js` | 878 | Trusted coverage checks over observed stream and captured native cut |
| `hosted-agent/src/provider-grant-issuer.js` | 864 | Grant admission, issued authority and revocation/cleanup ownership |
| `hosted-agent/src/delegated-runner.js` | 861 | Separately delegated session admission and lifetime ownership |

File size is a useful review locator, not sufficient grounds to split a module
or delete a trust boundary.

## Concrete deletion and compatibility candidates

Caller searches covered the committed application repository and host operator
scripts, including dynamic imports; tests are distinguished from runtime callers.
The operator clarified on October 1 that this code has no out-of-repository
users: Tokyo is its only consumer.
Unused exports can therefore be removed outright; remaining test/operator
callers must still be migrated while preserving their cleanup and state contracts.
The candidate table records the initial findings; progress below supersedes its
prospective wording as each deletion lands.

| ID | Candidate | Evidence and smallest next change |
|---|---|---|
| SB-01 | Seven unused setup wrappers | Claude/OpenCode `src/hosted-runtime-setup.js`: `resolveFuturePath`, `readSliceImageReference`, `resolvePinnedImageRef`; Codex: only `readSliceImageReference`. Shared setup replaced their callers. Remove exports, now-unused imports and exclusive tests. Keep Codex's other two helpers: its `setup-hosted.js` still calls them. Host `ops/storage-session-pins.mjs` reads other exports, not these seven. |
| SB-02 | Pool's unused `forget` and `standings` methods | `subscription-pool.js` lines 701–739 are test-only; its production owner in `provider-broker-service.js` calls `forSession`. Remove the alternate surface and exclusive tests, retaining bounded selection state and refusal behavior. Do not introduce a deletion callback solely to supply `forget` a caller. |
| SB-03 | Missing-method subscription compatibility | `subscription-lister.js` lines 56–60 silently treat “has no method” / “is not a function” as an empty list. Current provider scopes implement `subscriptions`, including the single-account empty case. Remove this legacy catch and its test; keep actual outage timeout/stale-cache behavior. |
| SB-04 | Pre-watch account-source compatibility | `account-oracle-module.js` lines 68–85 introspect whether old sources offer `watch` / `refresh`. Current `account-source.js` implements both; unsupported active refresh is already an explicit no-op. Remove the old-method negotiation, not legitimate absence of an account source. |
| SB-05 | Unowned MCP startup convenience | `mcp-socket.js`'s 25-line `listenMcpSocket` is used only by the shared setup helper in `test/mcp-socket.test.js`. Production uses the inert listener kit with cleanup custody before acquisition. Migrate that unit-test helper to the owned API, then delete the redundant export. |
| SB-06 | Redundant acquisition conveniences | `makePodmanProviderListenerRuntime`, value-only runtime `start`, and callable grant issuance have no production callers using these conveniences, but tests and opt-in operator probes still do. They are not dead today. Migrate those callers to the existing owned kits before deleting the alternate surface. |
| SB-07 | OpenCode broker version export | `OPENCODE_BROKER_VERSION` in `opencode-broker.js` has no other tracked references. Remove the unused constant/export after confirming it is not an intended external protocol contract. |
| SB-08 | Codex's alternate persistence callback | `codex-client.js`'s `saveThreadId` fallback has test callers; the controller and README use `saveThreadState`. It is a public low-level option, not automatically dead. Prefer one complete persistence contract after deciding/removing the alternate API; retain operational checkpoint durability. |

SB-01 through SB-05 are the strongest small deletion slices.
Compatibility with external users or deprecated development infrastructure is
not a requirement here.
None of these candidates warrants a new framework or a broader lifecycle rewrite.

## Repetition to reduce after the deletions

| ID | Repetition | Bounded consolidation and important difference |
|---|---|---|
| SB-09 | Four guest-publication loops in `hosted-setup.js` | The loops near 333, 445, 654 and 842 move guest handles/names only when source exists and destination is free. A local helper can remove repeated mechanics while retaining publication order, partial-setup behavior and no-overwrite rules. Keep account, reset, share and runner ownership separate. |
| SB-10 | Delegated model/effort/system-prompt validation | `delegated-runner.js` repeats these field checks in create and turn paths near 484 and 568. Use a local pure validator, retaining create's explicit-model requirement, network/storage admission and the narrower turn option set. |
| SB-11 | Codex bounded JSON response reader | `codex-sandbox/src/subscription-auth.js` repeats byte counting, fatal UTF-8 decoding and JSON parsing already present in shared `bounded-json`. Reuse that reader only if unconditional reader cancellation in the current `finally` is preserved. JWT, endpoint and account/renewal semantics remain Codex-specific. |
| SB-12 | Backend model projection | `backend-catalog.js` repeats eligible-account selection and first-descriptor-wins model union near 298 and 351. A local projection helper is sufficient; keep distinct resolution errors, defaults and effort admission. |
| SB-13 | Byte-oriented JSONL framing | Codex and OpenCode protocols repeat bounded byte accumulation, newline splitting, fatal decoding and final-line handling. Share only pure framing, with separate JSON/schema checks and diagnostics. Their limits differ: Codex 1 MiB, OpenCode 34 MiB. Do not include Claude's currently different unbounded/nonfatal line splitter without a separate contract decision. |
| SB-14 | Retained broker-profile parsing | The three `*-broker-service-agent.js` adapters validate the same six retained fields and three settings, then add provider-specific fields. One existing shared record/parser can own the common shape, preserving provider-local fields, closed-shape validation, field order and pre-acquisition refusal. Old-profile diagnostic refusal is not legacy acceptance. |
| SB-15 | Session identity pattern | `hosted-agent/src/session-state-storage.js` repeats the pattern exported by `session-plan.js`. Reuse the existing definition if dependency direction permits; this is a one-line shape duplication, not grounds for a new module hierarchy. |

SB-09 through SB-12 are local mechanics with clear existing owners.
SB-13 and SB-14 need cross-adapter tests before extraction; similarly named
protocol concepts do not establish equivalence.
The observed byte-framing overlap is roughly 55–60 lines per implementation,
not evidence that whole clients can be merged safely.

## Scope and ontology questions, not automatic deletions

1. **Sharing/delegation, 2,114 lines.** Broker publication/republishing and formula
   modules are live; the creation helpers have no current application production
   invocation, but are exported and documented operator provisioning APIs.
   Tokyo's current account configuration uses its own Secrets rather than
   consuming remote shares.
   Decide whether this extra feature belongs in the refactor; moving files alone
   does not reduce combined complexity.
   A scope reduction must also remove setup, exports, configuration and tests.
2. **Pool weight.** `weight` is validated and returned as metadata, but current
   selection uses standing, reset, usage and ordering, not weight.
   Document the actual contract or remove the inert option; do not add weighted
   scheduling simply to make an unused knob meaningful.
3. **Delegated storage bound extension.** `enforcesStorageBound` gates a runner
   option, but no current native adapter declares it; only test doubles do.
   This is an unimplemented extension point rather than supported native storage
   enforcement.
   Removing it must preserve refusal, not silently accept a bound without enforcement.
4. **Generic journal placement.** `makeAccountJournal` in `account-oracle.js` is
   reused by pools, reset intents, shares and runners.
   It is one storage mechanism, not five parallel account journals.
   A clearer name/location may improve ontology, but is not a source-size saving.
5. **Claude checkpoint comments.** Comments claiming there is no checkpoint
   predate native capture.
   Distinguish native context capture from the adapter's operational acknowledgement;
   fix misleading documentation rather than deleting a working acknowledgement path.
6. **Reset-provider response guesses.** Codex reset response normalization accepts
   several provider outcome/status names.
   The provider protocol needs evidence before reducing that live boundary.
   This audit neither spends reset credits nor proves those alternatives unnecessary.

## Parallel mechanisms justified by different owners

- Credentialed inference and uncredentialed public egress authorize different
  destinations, credentials and metering; neither is a duplicate of the other.
- HTTP inference, HTTP/CONNECT proxying, DNS and MCP use different protocols.
  Buffered inference API requests, internal streaming fetches and wrapped subscriptions
  all have live callers; the retired public text-stream protocol is already gone.
- Listener capacity, request concurrency and delegated share budgets measure
  different resources.
  They should not become one generic quota merely because all are numeric.
- Account source, observation oracle, exact-authority binding, pool selection,
  credential renewal and reset-intent journal have different authority/state roles.
  Static keys and renewable credentials are not interchangeable credential owners.
- Native clients differ in wire protocol and supported continuation semantics.
  Codex's diagnostic audit, operational checkpoint and Floot's durable conversation
  evidence are not three competing conversation authorities.
- In-sandbox native capture and trusted host coverage protect different trust
  boundaries; their equivalent shapes and ancestry predicate are already shared.
- Current-specifier rebasing is required for durable formulas across releases,
  not an old-property-name compatibility wart.
- Adapter setup/controller entrypoints are thin live composition.
  Rejection of retired factory/mounter profiles is a refusal boundary, not evidence
  that the remaining entrypoints accept deprecated modes.

These responsibilities justify boundaries, not every line currently within them.
In particular, large broker buffered/streaming branches merit an equivalence audit
around EOF, cancellation, usage and settlement before any attempted merger.
The source review does not establish that either branch is dead.

## Recommended sequence and progress

1. Remove SB-01 through SB-05 in small reviewed commits, maintaining relevant
   setup, pool/refusal, account refresh and MCP acquisition tests.
2. Decide alternate public/operator API contracts SB-06 through SB-08, then
   migrate their callers before removal.
3. Consolidate local repetition SB-09 through SB-12 without moving authority.
4. Decide whether optional sharing/delegation and inert weight/storage knobs
   belong in this release.
   Do not bury that scope decision in an abstraction commit.
5. Only then consider pure framing/common-profile extraction SB-13 through SB-15,
   with differential protocol and closed-shape tests.
6. Remeasure this same committed four-package scope after each slice and update
   candidate status here; document source moved outside the scope separately.

### Implementation progress, 2026-10-01

- **SB-01 and SB-07 done:** removed all seven unused adapter setup wrappers,
  their exclusive tests and the unused OpenCode broker version export.
  Codex's two live resolver helpers, current-pin checks and host storage-pin
  readers remain. This removes 51 source lines in the four-package metric
  (Claude 20, Codex 6, OpenCode 25), plus 102 exclusive test lines.
  The committed source count after this slice is 42,735 versus 42,786 above.
  Full suites pass: Claude 539, Codex 431, OpenCode 298.
  Independent review reruns 60 focused setup/runtime/broker tests; all pass.
  Package ESLint and Claude/Codex runtime type checks pass; root docs reports zero errors.
  Full package type checks encounter existing stale declaration/fixture typing,
  tracked separately rather than reported as a clean gate.
  No image helper, durable owner, format or release pin changes; not deployed.
- **SB-05 and SB-06 done:** removed the MCP startup convenience, asynchronous
  listener-runtime constructor, value-only listener start and callable issuer.
  Tests and opt-in operator probes use the existing owned kits; cleanup custody
  is retained before acquisition, and rejection retains scoped retry handles.
  No second acquisition API, cleanup owner or lifecycle framework replaces them.
  This removes 54 source lines; probes under `test/` are excluded from the metric.
  The committed count after this slice is 42,681.
  Full shared-package tests pass: 776, with one existing skip, after granting
  permission for local socket fixtures. The first sandboxed run failed from
  local socket denial and is not recorded as green.
  Focused migration tests pass: 113 shared, eight Claude and ten OpenCode;
  independent review reruns 73 shared and those 18 broker tests successfully.
  Hosted types, scoped ESLint, operator syntax and formatting pass.
  Existing pins and persisted authority are unchanged; live Podman probes were
  not run and this source cleanup is not deployed.
- **SB-02 through SB-04 done:** removed unused pool `forget`/`standings`, the
  old-broker missing-method-to-empty-list fallback, and observe-only account
  source negotiation.
  Pool selection, refusal persistence, stale-list handling and absent-source
  fallback remain; current account sources expose observe, watch and refresh.
  Regression tests exercise the production selection and active-refresh paths,
  and distinguish an unavailable broker from an explicit empty list.
  This removes 69 source lines; the committed count after this slice is 42,612.
  Focused tests pass: 32 pool/list/oracle/source tests; independent review reruns
  51 pool/list/oracle/setup tests successfully.
  The full shared suite above includes this slice; hosted types and scoped ESLint pass.
  No stored credential, renewal owner, journal format or release pin changes;
  not deployed.
- **SB-08 done:** removed Codex's identity-only `saveThreadId` fallback.
  The required `saveThreadState` writer accepts identity, tool-set binding and
  recovery state; a missing or invalid writer is rejected before transport setup.
  The controller already supplies the complete durable writer.
  Synthetic client fixtures now explicitly supply full-state writers, and tests
  check both initial and terminal records and refusal on persistence failure.
  Creation, write-ahead, settlement, reconciliation and acknowledgement ordering
  stay on the existing state writer and ledger; no second journal or continuation
  owner is added.
  This removes three source lines; the committed count after this slice is 42,609.
  The full Codex suite passes 432 tests; independent review reruns all 116 client
  tests, including restore, cancellation, rotation and failed persistence.
  Scoped ESLint and the runtime type check pass; fixture/declaration typing is
  reconciled separately rather than hidden by casts or suppressions.
  Existing native records and release pins are unchanged; not deployed.
- **Validation reconciliation done:** narrow declaration regeneration exposed
  stale protocol/test inference rather than runtime defects.
  Codex's tool projection now declares its actual optional result fields, keeping
  unvalidated wire values unknown; Claude fixtures name their reader and tuple domains.
  No assertion or hostile-input case is removed, and no suppression or runtime
  parser change is introduced.
  Independent review identified an overstrong status type; it was corrected to
  unknown and rechecked before commit.
  Both full Claude and Codex type checks pass, as does the hosted type check.
  Independent focused validation passes 42 tests; fresh full suites pass Claude
  539, Codex 432 and OpenCode 298, alongside the 776 shared tests above.
  Four-package ESLint reports zero errors (480 warnings); root docs reports zero
  errors (180 warnings). Formatting and diff checks pass.
  Ignored generated declarations are not committed.
  The one added source annotation brings the final count to **42,610**, a net
  reduction of **176** from the 42,786-line audit snapshot, not source moved elsewhere.
  Counts are hosted-agent 24,034, Claude 7,057, Codex 6,884 and OpenCode 4,635
  across the same 160 files.
  All eight concrete candidates are closed; SB-09 through SB-12 local repetition
  and the separate scope decisions remain next, not implemented by this slice.
  No host configuration, image pin, stored authority or workspace changes; not deployed.
- **SB-09 done:** four guest-publication loops now use one private
  `finishGuestMoves` helper in `hosted-setup.js`.
  Source-exists/destination-free checks, short-circuiting, handle-before-powers
  ordering and rejected-move propagation are unchanged; `has` plus `move` is
  still not an atomic publication protocol.
  Account, reset, share and runner owners keep their separate setup and journals.
  Twelve regressions cover the four callers' held first moves, interrupted
  second moves with the same retained namespace, and occupied destinations with
  stray root names preserved.
  Focused setup/backend-setup tests pass: 47; hosted types, scoped ESLint and
  formatting pass. Independent review checks publication semantics and reruns tests.
  This removes 21 source lines, bringing the committed count to 42,589.
  No durable format, formula identity or release pin changes; not deployed.

Audit status: measured and caller-reviewed; implementation progress is above.
Fae compaction and evidence-storage scaling remain deferred as directed.
Process-loss/quiescence research remains outside this implementation sequence in
[draft tracking PR #1323](https://github.com/endojs/endo-but-for-bots/pull/1323).
Application work stays on [PR #1248](https://github.com/endojs/endo-but-for-bots/pull/1248),
with host deployment/evidence on [endo-host PR #1](https://github.com/kumavis/endo-host/pull/1).
