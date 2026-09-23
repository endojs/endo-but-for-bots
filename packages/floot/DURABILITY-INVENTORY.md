# Floot retrospective durability change inventory

Snapshot: 2026-09-24.
This is the coverage ledger for [the architecture audit](ARCHITECTURE-AUDIT.md),
not a claim that all listed changes are correct or reviewed.

## Scope and interpretation

The application range is `3332f19283b38d0e75207218a30df94e44c6d98f` (excluded) through
`a3a239f80a903d4f00e1b2e24e1d604d3a03a499` (included): **479 commits**.
The host range is `73405ca4fc8314f7c1297290cb8e3ebd7e0dcb91` (excluded) through
`5959fbff2672355d03b3373f50ac4f110b8bcdc2` (included): **93 commits**.
Both ranges include all reachable commits, not just first-parent or locally authored commits.
Upstream changes, reversions, and later superseded implementations remain listed.
The seeds are reference points, not exclusions from the overall architecture audit:
earlier infrastructure still used by this refactor needs a separate retained-code inventory.

This ledger closes the missing enumeration for these two exact ranges.
It does **not** close the retrospective durability audit.
In particular, a commit subject, package name, or existing mention in the main audit
is not proof of correct ownership, replay, retirement, or restart behavior.

The following classifications are conservative path-based triage, not semantic review:

- **D**: every changed path ends in `.md`; no non-Markdown file appears in that diff.
  Instructions and design claims can still be wrong and require document review.
- **T**: every changed path is Markdown or lies below a `test/`, `tests/`,
  or `__tests__/` directory, and at least one is not Markdown.
  This does not establish that the tests are adequate or free of external effects.
- **R**: all other diffs, including runtime, configuration, dependencies, assets,
  deployment/operations code, and mixed changes.
  These require explicit durable-boundary classification; the label does not
  assert that every such commit adds durable state.

No row is implicitly marked reviewed.
A semantic review must identify the retained current implementation, the formula or
external-state owner (or why the change is deliberately ephemeral), replay/admission
and cancellation rules, evidence at the correct boundary, and remaining limitations.
A reverted change needs an explicit disposition, not a passing score.
Test-only commits can supply evidence for another row but cannot certify it by title.

## Coverage and next work

| Repository | D | T | R | Total |
|---|---:|---:|---:|---:|
| Application | 109 | 26 | 344 | 479 |
| Host | 23 | 0 | 70 | 93 |

For the R rows, prioritize the following connected ownership chains rather than
counting commits as independent features:

1. Daemon publication, factory disposal, native records, and private journals.
2. Credential/renewal owners, pool identity, grants, transport and listener lifetimes.
3. Session provisioning, sandbox process/mount ownership, and transcript restoration.
4. Catalog/UI projections and the host build/deployment/retirement operations.

Existing evidence and explicit deferrals remain in the main audit.
In particular, native process-loss recovery remains the separate
[#1323 research follow-up](https://github.com/endojs/endo-but-for-bots/pull/1323);
listing it here does not authorize its implementation or count it as completed.
Tokyo deployment, preservation gates, and live acceptance are independent checks.
The index itself reads local Git objects only; no daemon, Secret, or external resource
was created, inspected, renewed, stopped, or retired to generate it.

## Semantic evidence mapped in this pass

The 15 commits in `2deaf4f55..a3a239f80` were individually compared with their
source/test diffs and the main audit's evidence records by an independent reviewer.
The following 15-commit table cites previously recorded suite runs, not fresh
verification. Later sections identify their fresh runs separately.
These commits introduce no new durable
formula owner or persisted storage schema, but several change lifecycle ordering.
They are not interchangeable with purely presentational changes.
The other 394 application entries and 73 host entries still need explicit ledger
mapping, even where the main audit already contains relevant review evidence.
This is missing coverage mapping, not a claim that all those changes are unreviewed.

| Commit | Owner / boundary | Recorded evidence | Remaining limit |
|---|---|---|---|
| `11fbe8b0d` | Test only; existing journal/formula storage | `packages/daemon/test/floot-archived-context.test.js`: real retention threshold, archived checkpoint/certificate, selective reads, two graceful cold restarts, recall and effect marker retained; six adjacent cases | Local graceful daemon reconstruction, not abrupt loss, native compaction, full topology, heap bound, or Tokyo acceptance |
| `e9f949dca` | Deletes obsolete ephemeral legacy-import UI gating; journal authority unchanged | Held-resolution UI regression; chat 935 passed/10 skipped, space-floot 52 | Local UI only; type gate repaired by next commit |
| `1d18c8b19` | Test-only fake daemon/passable-stream narrowing | Chat 935 passed/10 skipped; full lint/typecheck | No new restart evidence |
| `a67f06294` | Factory closes ephemeral journal facets after incarnation drain and before replacement; durable namespace retained | `factory-network-policy.test.js`: held read, old-facet rejection, repeated rebind/history, poisoned-close refusal; Floot 654 | No measured heap reclamation or cross-worker exclusion |
| `ecc23e907` | Existing execution-state publication reordered: journal closure before running; ephemeral resume token | Six resume regressions: held read, poison, superseding stop, disposal, fresh observer, failed publication; Floot 660 | Mock lifecycle boundaries, not daemon crash recovery |
| `bf3e1ed21` | Factory retains failed construction/owners through rollback; incarnation-local failure registry | Lookup retry with large history, late-create termination retry, admitted deletion reaches cleanup; Floot 663 and seven adjacent daemon cases | Concurrent-disposal refusal is not successful retirement; no ordinary post-returned-agent failure seam established |
| `ab8d804ae` | Reconstructible catalog output-limit observation; existing broker supplies activation metadata | Descriptor/OpenRouter/config/controller tests; hosted-agent 697/1 skipped, OpenCode 289, Floot 663; native 47 plus typechecks | Route observations are not guarantees; native rebuild required; no live compaction/restart proof |
| `0dfe51513` | Documentation-only candidate provenance | Main audit and host `ops/native-checkpoint-deployment-20260923.md` | Prepared only; superseded by corrected candidate |
| `d5d943d33` | Immutable native source pin changed; no Endo durable state | Offline CLI probe reproduces inherited input-limit mismatch; external native fix 62 tests/1 skipped, types/lint | Actual algorithm lives in native fork, not this pin diff; no live compaction proof |
| `dce92c734` | Documentation-only corrected candidate provenance | App/native/host pairing, source/extraction/overlay digests, paired Nix preparation | Not activation or inference |
| `f67664282` | Ephemeral watcher fence; factory/journal authority unchanged | Eight new race regressions, 34 watcher tests, Floot 671, three adjacent real-daemon disposal tests | Adjacent tests do not exercise exact races; deadlines do not reclaim hung reads |
| `14074996c` | Existing Codex checkpoint ledger; terminal delivery retains uncertain-write failure | Six rejection/timing cases, one abort/no success, send fence, shutdown failure; Codex 322/client 94 | Injected persistence boundary, not physical fsync/crash/restart evidence |
| `5d419544e` | Test-only account authority/shape corrections | Real policy account binding, complete OAuth observation, narrowed values; Codex 322/full lint | Test validity, not deployment/restart proof |
| `6eef34a8e` | Existing abort path reports rejected exit observation truthfully | Three rejection cases retain partial output and diagnostic; Claude 219, adjacent OpenCode 35 | Failed wait and attempted kill do not prove retirement |
| `a3a239f80` | Ephemeral diagnostic deadline and late-read fence | Six regressions for deadlines, stalls, late settlements and closure; Claude 225, lint/docs | No cancellation of hung remote operations or synchronous-code preemption; not process retirement |

The main audit records these implementations as not activated on Tokyo.
Build preparation retained generation 169 / app `819aa18c8` as the active release.
This ledger pass does not re-query the machine or claim that historical observation
is a fresh live-state check.

### Initial session grant, transport and cleanup changes

These six diffs were compared with retained implementations and tests.
None adds a durable formula owner or exact daemon-restart proof.
Fresh local runs cover 63 hosted-agent grant/MCP/cleanup cases and four resource
registry cases; the latter are unit tests despite living in the daemon package.
The exact interrupted-turn admission regression also passes (one Floot test).

| Commit | Owner / boundary and evidence | Disposition and limit |
|---|---|---|
| `c6eb481a2` | Ephemeral session inference grant belongs to issuer/runtime; renewal remains a separate existing owner. Tests cover repeated requests, disconnect/revocation, acquisition/disposal, cleanup retry and account binding | Retained but evolved; original Codex factory/renewing wrapper removed. Not a durable session or renewal/restart proof |
| `c311b2f98` | Shared MCP socket/server/peers belong to session cleanup. Tests cover call drain, close-before-start, same-tick start/close, late acquisition and failed-close retry | Retained transport; original nondraining close superseded by `18de3ccc4`. Per-frame limits do not bound aggregate connections/queues/bytes |
| `ae9dcd3c8` | Ephemeral pinned tool catalog and synchronous admission counter; durable tool effects/evidence remain Floot journal responsibility. Tests cover catalog reuse, invalid/batch tools, admission bounds and release on failure | Retained bridge. Admission count does not cancel accepted effects or bound transport memory; no new replay policy |
| `6457a0c6e` | Abort signal closes new tool admission immediately; accepted effects retain original turn ID. Exact journal integration regression covers withheld interrupt acknowledgement and next-turn reuse | Retained. Previously admitted effects may finish intentionally; fake persistent powers are not cold-restart proof |
| `c29a9ebf1` | In-memory reverse-order cleanup scope retains failed releases and removes successful ones. Tests cover independent failures, single-flight retry and process-before-mount dependency | Helper retained; original three adapter integrations superseded. Current direct production consumer is OpenCode client mount cleanup. Scope cannot reconstruct process-loss ownership |
| `eacf0a30c` | Ephemeral per-session serialization/owner registry; durable session records remain separate. Tests cover serialization, stale release, retained failures and shutdown/acquisition fences | Retained through hosted aliases to daemon resource registry, consumed by shared factory kit. Registry unit tests do not establish daemon reconstruction |

The unification design's obsolete claim that all three adapters still use cleanup
scopes was corrected to describe the retained implementation.
Later shared-supervisor and generation-165 acceptance evidence remains separate;
it is not retroactively attributed to these initial helper extractions.

### Network and runtime-boundary changes

These five source/diff reviews map the next application changes without treating
historical test counts as proof of current kernel isolation or daemon reconstruction.
Fresh local runs: shared worker/egress/DNS/listener/network **62** tests, Claude MCP
cleanup **3**, OpenCode MCP cleanup **7**, Codex policy/runtime-verifier **13**.

| Commit | Owner / boundary and evidence | Disposition and limit |
|---|---|---|
| `ba4cdbb3e` | Session-owned MCP listener/socket retains failed close for retry and latches successful close. Real Unix-socket tests exercise failures, coalescing and successor preservation | Retained in shared mcp-server; old adapter implementations replaced. Local filesystem/lifecycle evidence, not restart proof |
| `6747bf5b0` | Existing egress authority and credential-free worker moved to hosted-agent; separate capability activates ephemeral listeners | Retained shared modules; source/bundled worker subprocess tests cover inference and ungranted activation refusal. Not Linux namespace containment or daemon replay proof |
| `9f2a754aa` | Codex CLI and tools share the outer guest authority; externalSandbox per turn, danger-full-access process/thread baseline, inner managed proxy disabled | Retained through client/transport/native controller; former factory composition replaced. Does not isolate commands from native state or inference. Local configuration/probe tests are not pinned CLI live acceptance |
| `c162186ed` | Removes synthetic address and NET_ADMIN helper; fixed loopback in shared unrouted namespace, existing runtime owns resolver/lock cleanup | Retained privilege removal; operator enablement and session egress grant remain required. Mocked Podman plus real worker checks do not prove kernel namespace restrictions |
| `d9a0f3106` | Pure network evidence validation/environment projection; existing grants own optional public egress | Shared by all three current adapters and execution envelope. Validation is not namespace attestation. Original OpenCode integration gap was closed by later work, not this commit |

The design's stale statement that OpenCode still awaits shared-network integration
is corrected to name the retained controller and execution-envelope path.

### Initial host configuration and preservation changes

These 13 host commits were compared with their diffs and retained implementations.
Historical deployment evidence is in FA-03/04/05/13 and the cutover records, not
a new live-machine check. Fresh local tests in this pass: inventory/host/archive
helpers **20**, image builder/checker **10**, holder recovery **9**, storage
maintenance **13**. The image tests include the new directory-flush correction
below; counts do not describe the unmodified historical builder.

| Commit | Owner / boundary and evidence | Disposition and limit |
|---|---|---|
| `3f5045f` | Removes legacy Claude setup-peer bootstrap; existing Secrets and hosted setup remain owners | Retained deletion; changing bootstrap does not retire already minted formulas; later cutover evidence is required |
| `c515378` | Removes unused OpenCode state option/environment; transcript continuity remains Floot-owned | Retained deletion; does not delete old state or establish CLI restore correctness |
| `d68f72c` | One-shot named-formula metadata inspector; no runtime-service lookup | Despite its docs subject, this adds executable code; incomplete fixed-name inventory, no native cleanup or archival proof |
| `be0803e` | Removes ignored native-profile Nix options/environment; effective policy controls slices | Retained deletion; old plans still require old-owner retirement, not migration or weakened parsing |
| `2bfebce` | Explicit storage-admitted all-image build; candidate manifest/lease and startup immutable-pin checker; fresh image/storage suites | Missing directory flush discovered and fixed below; candidate lease is not activation, and local mocked builds are not real OCI verification |
| `7402350` | Read-only formula metadata inventory verifies directory/blob identities before lookup; five original safety cases | Non-atomic root-reachable view, not complete dynamic membership or cleanup proof |
| `e0233ec` | Passive-directory traversal adds identity deduplication, binding budget and Secret-alias exclusions; nine current cases | Does not traverse guest stores or inspect native resources; budget is not a time/byte bound |
| `9d8f4a7` | Runbook-only coordinated cutover and lock/holder/preservation gates | Instructions are not execution evidence; later records supply actual cutover results |
| `8d4e918` | Approved built-in Floot host identity maps guest/handle references without resolving them; four cases | Can revive two built-in host workers; snapshot is not archive or cleanup |
| `f8b8589` | Operator-owned private recovery records retain holder-create intent and exact container/image IDs; nine current holder cases | Superseded permission handling corrected by subsequent commits; no automatic replay or destructive cleanup; lost create reply needs exact-name inspection |
| `0b0715f` | Existing daemon storage retains exact guest IDs in archive directory; identity/conflict/retry checks, seven current cases | Exclusive maintenance required: no CAS. Capability roots, not content backup. Historical snapshot reader still uses ordinary unbounded readFile |
| `11ed01d` | Attempted exclusive-primary-group admission for holder storage | Superseded by private recovery directory in e2e6f65 after live group membership disproved exclusivity; not the retained authorization rule |
| `e2e6f65` | Separates private holder records from shared deployment spool; fresh manifest identity/metadata captured before creates | Retained owner boundary; tests cover order and failed intent, not power-loss injection or hostile-directory races |

### Old-release retirement and restoration harness changes

Seven more host diffs/current implementations are mapped below.
Fresh local tests across six retirement/inventory/restoration suites: **44 pass**,
including the names-only legacy correction described in the main audit.
Mock preservation checks are not live cleanup acknowledgements.

| Commit | Owner / boundary and evidence | Disposition and limit |
|---|---|---|
| `9e062aa` | Exact historical six-session retirement via existing Floot/native owners; preserved Secrets/guest roots; separate stop/remove with operator external proof | Old-release topology and exclusive maintenance required. A test proof object cannot establish real container/mount absence |
| `a180f0a` | Candidate app/image pins and restoration ledger, no new runtime owner | Historical preparation, later pins supersede it; no acceptance inferred from candidate metadata |
| `1fa90d9` | Broker reference inventory over exact approved namespace identities without resolving custom members | Built-in workers may revive; nonmatching references do not prove global independence; current validation evolved |
| `ed57f5b` | Two approved legacy guest namespaces inspected without custom-member resolution | Built-in worker revival possible; not backup, global dependency discovery or cleanup |
| `88c5114` | Broker alias detachment with preserved credentials/archive identity checks | Original cancel-before-remove superseded by later names-only correction; held capabilities still require verified old-owner shutdown |
| `f502c87` | Requested backend/manifest/result coverage validation | Original create-before-write and ID replacement defect corrected locally by the version-two intent ledger described below; historical coverage tests alone did not establish durability. Deployment/live acceptance remain open |
| `e303296` | Four obsolete aliases targeted with exact metadata and preservation checks | Review found cancel could construct dormant code despite the helper comment. Corrected to names-only detachment; no producer shutdown/global revocation claim. Completed retries may fail safely after GC removes target metadata; no recovery redesign supplied |

### Generated configuration ownership chain

Three adjacent cleanup changes were independently traced to retained source.
Fresh podman-cleanup, bwrap, and lifecycle suites pass **107 tests** with exit zero
after rerunning with AVA cache-write permission. This is mock/local-process
evidence, not Linux isolation acceptance or reconstruction after daemon loss.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `9e79f1f68` | Podman acquire/remove/teardown retains operations and capacity through failed removal, fences acquisitions, and keeps configuration until release | Tests cover delayed creation, failed removal, sibling cleanup, capacity and attach closure. Later full-ID binding and uncertain native-producer witnesses strengthen the path; ownership remains process-local and does not resolve daemon-loss uncertainty |
| `f2658b4d6` | bwrap retains child stop/teardown ownership until `close`, not merely error or exit; bounded cleanup failure remains retryable | Tests cover close-after-error, delayed close, coalescing and sibling cleanup. No Linux namespace or restarted-owner proof follows from the stubbed macOS tests |
| `d38de219d` | Factory reap/dispose permanently fences admission while disposal remains retryable; driver teardown and mount cleanup precede release | Lifecycle tests cover delayed admission, rejected wait, SIGKILL without reap, retries and cancellation. Current shared slice registry supersedes the original handle set, but remains ephemeral; #1323 is still open |

Three further application changes are mapped to current source (2026-09-24).
Fresh `@endo/sandbox` generated-files, generated-file-storage, and podman-cleanup
suites pass **74 tests**. These are local filesystem and injected-process tests,
not real Podman/kernel or daemon-crash acceptance.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `a887b2115` | `generated-files.js` validates literal destination/content records before resource acquisition; no persistent owner added | Exact shape, canonical path and mount-overlap checks; production Podman also rejects additions to exact policy mounts. Tests cover rejection before probing/resolving mounts. Validation does not prove mounted filesystem isolation |
| `ea50a5e7c` | `generated-file-storage.js` owns an exclusively created private root and per-stage files; in-memory registry retains byte/entry charges until deletion succeeds | Filesystem tests cover partial writes, failed deletion/retry, concurrent reservations, held-write release/shutdown, writable aliases, and refusal of existing roots. Shared private-directory validation supersedes inline checks. No fsync publication/restart replay claim: root reuse is refused, and stale storage requires verified owner/container retirement |
| `3eb95cd26` | Podman slice owns a lazy generated stage; teardown drains operation removal and policy anchor cleanup before releasing files | Current `drivers/podman.js` retains the stage on any removal failure; runtime closes driver before allocator. Tests cover read-only mount encoding, lazy reuse, failed container removal, and staging/teardown races. The ownership registry is process-local; daemon-loss reconciliation remains #1323, not proven by retry tests |

### Factory and native-command ownership continuation

Five more adjacent application changes are mapped to retained implementation.
Fresh child-process, factory-owner, podman-policy, and podman suites pass **131
tests** with exit zero; podman-cleanup passed in the preceding 74/107-test runs.
The direct Node child test observes real closure; injected Podman tests do not
establish native Linux behavior. Optional Podman checks can return early when the
binary/runtime is unavailable, so the aggregate pass count is not live acceptance.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `e0f07b1ea` | Host-only factory kit fences admission, drains acquisitions and retains failed cleanup independently of public factory authority | Factory-owner tests cover late contexts, failed construction, sibling cleanup and cancellation. Later `9391a5a6b` retains `prepareSliceKit` before awaiting preparation; legacy drivers still transfer ownership only after successful preparation. Registry remains ephemeral |
| `9ce27aafb` | `startControlCommand` separates result settlement from direct-child/stdio closure; abort does not release ownership, and exited child identities are not signalled | Tests cover timeout, cancellation, errors, failed kill, inherited pipes and a real Node child. `spawnAndCollect` exposes only result and must not own creating effects. Direct closure is not descendant/engine quiescence or restart recovery |
| `a85f04772` | Every Podman invocation uses local-engine selection plus a local-ABI flag; no new persisted owner | Current `podmanArgs` prefixes probes, creates, starts and removals. Fixtures assert prefixes; optional configured-remote refusal test does not prove current Tokyo engine behavior. Locality cannot establish descendant termination |
| `9ba226e4b` | Podman preparation retains anchor/seccomp resources before acquisition, then transfers ownership without discarding failed rollback | Policy/cleanup tests cover held producers, failed anchor commands, seccomp cleanup and scoped sibling preservation. Later per-scope preparation supersedes driver-wide-only recovery; native closure/removal does not resolve uncertain producer effects |
| `e280c0ab8` | Producer scope and operation removal retain admission capacity/configuration until closure, producer completion and container cleanup are established | Tests distinguish no-child failure from uncertain/interrupted creation and delayed closure. Later full-ID and startup-witness changes strengthen the path. Retried cleanup may remain permanently refused on uncertainty; #1323 remains separate |

### Container identity and native closure

Three subsequent driver changes are mapped to current Podman source.
The current podman-cleanup, podman-policy, runtime, runtime-ownership-durability,
and owned-agent suites pass **153 tests**. This combines injected engine behavior
with real filesystem operations; it is not live Podman or daemon-loss acceptance.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `f5813d27d` | Operation cleanup starts with its reserved unique name, then switches permanently to an inspected full 64-character container ID | Regression replaces the name mapping after lookup and verifies start, signal and removal retries keep the original ID. Malformed lookup and cancellation are covered. Before successful lookup, name-based cleanup still relies on exclusive owner/name authority |
| `3960357ce` | Removal records a positive startup witness before erasing engine state; missing witness retains ownership even after successful removal | Tests verify positive witness, failed observation, retry before successful removal and refusal to invent evidence after removal. Current trusted startup gate also supplies a witness. Persistent uncertainty is deliberate refusal, not recoverability or proof that descendants stopped |
| `bb8c7fd55` | Driver tracks direct native closures across observers, producers, cleanup and attached processes; close fences ordinary commands before sealing all admission | Existing tests cover delayed closure, failed signaling, no late handle signals and immutable orphan IDs. Observer abort does not abort healthy producers; closure accounting is in-memory and does not survive daemon loss. #1323 remains the separate recovery gate |

### Runtime composition and host configuration inspection

Three following changes were independently mapped to retained source.
Runtime/ownership/owned-agent tests are included in the fresh 153-test run above.
The real-daemon failed-startup environment test passes after shortening its socket
fixture name for macOS; other environment-exposure tests were inspected but not
freshly rerun in this slice. None of this is a daemon crash/restart test.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `c87ff8260` | Runtime owns marker, generated storage, driver, factory and native scopes; successful native cleanup precedes storage/marker release | Tests cover acquisition cancellation, failed cleanup, exclusion and late controllers. Later `64b1de584` strengthens marker flushing. Existing markers/stale storage refuse reconstruction; no automatic crash recovery |
| `905cd44c2` | Owned-agent delegates to shared owned-native-service; module registry retains inert owner before open, closes the exact invocation and retries predecessor cleanup before replacement | Tests cover concurrent callers, cancellation, reconstruction races and successor protection. Later `cf9fdce82` extracts shared owner. Registry is ephemeral; independent workers rely on filesystem exclusion, not shared in-memory state |
| `bedcc52b8` | Host-only environment inspection reads local persisted caplet metadata without constructing it; no new schema or durable owner | Failed-startup test passes with real daemon. Source/tests isolate credential-bearing environment from ordinary formula records, diagnostics and guests and reject cross-peer inspection. No fresh full exposure-suite or restart evidence claimed |

### Provisioning, passive records and formula identities

Seven further application changes are mapped to current source and removals.
Fresh OpenCode setup/hosted-setup/runtime-setup/client/backend-factory suites pass
**74 tests**; daemon imported-reference/resource-registry/session-record-store/
directory suites pass **34 tests**. The real-daemon serial test `session records
retain exact references without activating clients` also passes after shortening
its socket fixture name. It checks graceful restart, passive inspection, retained
reference edges and exact-provider cleanup, not native process-loss recovery.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `6c8d83928` | Setup validates the captured formula ID and reads its persisted environment; shared logic now in hosted-agent/hosted-setup | Tests cover retained roots/entrypoints and placement. Original state-provider topology is superseded by native sandbox, broker and storage owners; not deployed cleanup evidence |
| `1a91a0fd4` | Passive opaque plans and exact dependency edges now live in daemon session-record-store/session-owner | Unit and real-daemon restart tests retain partial records and dependencies without activating clients. Single-store ownership required; check-before-remove is not atomic compare-and-delete |
| `bf62142db` | Client fences termination and retains failed containment/unmount/state cleanup; late acquisitions drain without guest readiness | Current tests cover failed disposal and late provisioning. Old client-module/provisioner paths were superseded by daemon provisioning and deleted; cancellation alone is not cleanup proof |
| `31fa9f011` | Import registrar associates only root peer-provide results with formula IDs, scoped to the exact importing context | Four tests cover late cancelled result, same-presence successor, preserved aliases and no inferred nested identities. Maps are ephemeral and reconstructed through peer provision; fresh multiplayer restart test not run here |
| `e16d21b07` | Historical static session-powers module deleted by `495486723` with legacy Claude client/form topology | File/export absent and deletion diff inspected. No retained module or new runtime owner to certify; stored historical formulas still require explicit operator retirement, not inferred graph absence |
| `9df03e624` | Daemon owns passive record implementation; sandbox re-exports shared in-memory cleanup registry | Record tests cover partial publication and failed cleanup; registry tests cover local serialization, stale release and shutdown. Durable directory edges are distinct from ephemeral cleanup callbacks. Later staged revision logic is not attributed to this original move |
| `e41697f63` | Directory formulation transfers one pin under graph lock; publication releases it in awaited finally, and host/guest construction adopts rather than duplicates it | Two directory regressions exercise concurrent publication and failed-publication collection. Source confirms current transfer contract; no fresh comprehensive host/guest bootstrap failure or crash proof |

### Session forwarding, native paths and endpoint cleanup

Five subsequent changes were traced to current source or explicit replacement.
Fresh daemon session-owner/session-protocol/native-session-owner, sandbox
native-factory/factory, hosted-agent session-state-storage/session-storage,
exo-stream endpoint-close and 9p-server mount-caplet suites all exit successfully.
The storage run reports 19 tests and the mounter run 34 tests.
These runs use local/injected authority and CapTP loopback; no new live native or
real-daemon restart result is claimed for this slice.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `6b1f06680` | Daemon session-owner uses passive records and fenced forwarding facets; failed cleanup retains exact identities before reference release | Owner/protocol tests cover failed stop/removal, reconstruction objects, delayed capability resolution and capability-free events. Native construction/native-closed acknowledgement are later strengthening; durable records alone do not establish crash recovery |
| `0cc29f1fd` | Host-only makeResolved accepts explicit paths and shares factory admission/cleanup; mounts are static and no daemon scratch is implicitly acquired | Native-factory tests cover cancellation and cleanup retention. Later checks reject imported capabilities; arbitrary host paths remain privileged authority, not guest-safe inputs or live isolation evidence |
| `190d1aa28` | OpenCode state primitive extracted to shared storage by `c91c3b8c6`; obsolete OpenCode provider removed by `d2959f834` | Shared descendants remain used by Claude/Codex. Original fixed-directory ownership was replaced by inode-bound unique allocation in `baecab949`; current fault tests cannot be credited to the old format. Native stop still requires independent proof |
| `a2cb55d81` | Mounter construction preserves cancellation promise inside a record instead of assimilating it; cancellation initiates registry shutdown | Tests cover local/presence/promised contexts, later cancellation and held mount admission. Awaited host close proves cleanup; formula cancellation or worker death alone does not. Real privileged mount/umount behavior is not exercised |
| `4c498b1bc` | Stream endpoint owns source lifecycle separately from stream outcome; explicit close fences admission, drains pulls and retries failed return | Reader/writer/bytes cases and CapTP loopback exercise failure vs cleanup, repeated close and done:false refusal. Later intrinsic promise adoption protects retained pulls. Hung source operations still require source-specific interruption; no persisted endpoint or restart recovery is introduced |

### Cursor, filesystem drain and caplet publication

Four more application changes are mapped to their retained ownership boundaries.
Fresh cursor/cursor-lifecycle suites pass 16 tests; 9p-server fs-bridge,
server-lifecycle and mount-caplet suites pass 56 tests.
Daemon publication validation is recorded in the main audit: four focused tests,
37 adjacent tests, and 11 marshal-publication/account-oracle lifecycle tests pass.
The latter include graceful daemon restart, not native process-loss recovery.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `5399817fc` | Each cursor listing owns its iterator, admitted pulls and retryable release; rewind installs a successor only after release succeeds | Tests cover held pulls, failed return, done:false, close during rewind and stale streams. State is ephemeral; resourceful iterators must retain failed cleanup themselves. Hung pulls can prevent close; no restart recovery |
| `93e2457fb` | 9P connection retains streams/files/cursors and pending filesystem operations after socket closure; bridge retains connection cleanup; mounter requires non-lazy unmount before bridge/storage release | 56 tests cover failed/held acquisition, drain, cleanup retry and path reservation. Historical client-module wiring was later deleted; shared mounter remains. Tests inject privileged mount commands; cancellation is not release proof and reservations do not exclude independent owners |
| `3353c5dad` | Lockfile adds workspace daemon and promise-kit dependencies for the preceding 9P change | Diff contains no external version change, durable schema or new runtime owner; lifecycle evidence belongs to the preceding row |
| `c5cf84243` | Fresh caplet worker identity is published before process acquisition; later retention callback owns acquired worker cleanup | Original @none regression passes but did not exercise automatic powers pins. Review reproduced a pin leak; `71dfde012` drains publications and releases transferred pins on failure. `4929571ea` verifies uncertain-write orphan reclamation and fixes test types. Subsequent pre-transfer/dependency fixes and remaining identity-key limits are listed under post-snapshot changes |

### MCP/provider admission and retained native construction

Four subsequent changes are mapped to current ownership boundaries.
Fresh hosted-agent MCP socket/provider-listener runtime suites pass 35 tests;
OpenCode MCP socket/broker suites pass 17. These require local socket/process
permissions; an initial sandbox-restricted attempt was not a valid passing run.
Daemon native-worker-lifecycle/native-session-owner/session-owner/session-protocol
suites pass 63 tests. One native-worker case forks a real child and distinguishes
CapTP pipe closure from process/stdio closure; most other native effects are injected.
The real-daemon native-session-owner restart regression also passes after using
the short fixture name `nat`: the original 120-character socket path exceeded
macOS's limit. This verifies explicit restart activation and exact dependencies,
not abrupt native loss or current live backend acceptance.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `18de3ccc4` | Inert MCP listener/server kits retain cleanup before startup, fence admission and drain calls; OpenCode delegates to shared mcp-server after `c311b2f98` | Held installation/listen/call, failed close and same-tick cancellation tests pass. External socket-path exclusivity required; hung calls can block close. Native owners must retain kits, not rely on convenience wrappers returning after failed rollback. No durable schema or crash recovery |
| `9843b3ab9` | Provider runtime owns lock/recovery/resolver/listener cleanup; shared broker service separately retains issuer revocation and runtime closure | Tests cover failed sweeps/releases, late acquisition, scoped retries and sibling preservation. Later shared-service/recovery changes supersede original composition. Injected engines/child fixtures are not live Podman or descendant-quiescence proof |
| `e0a67872a` | Worker context registers cancellation before acquisition; native power retains child until close rather than CapTP shutdown or exit alone | Lifecycle tests exercise post-fork failure, cancelled acquisition, descriptor release, delayed stdio closure and a real child. No daemon-loss recovery or process-tree quiescence guarantee; grace expiration requests force cancellation but does not prove closure |
| `2b7642dbe` | Session owner records worker/client identities before acquisition, lifecycle phases before activation, and native-closed acknowledgement before worker/reference release | Owner tests cover interrupted construction, fenced forwarding, exact dependencies and retry cleanup. Later staged binding revisions and transient tools are separate changes. Persistent plans do not by themselves prove native recovery or current live backend acceptance |

### Cancellation fences and transient session tools

Three further changes are traced to current context/host/session-owner code.
Fresh context/formula-cancellation/native-construction-cancellation/native-session-owner
suites pass 37 tests. Two real-daemon tests also pass after shortening only their
socket fixture names (`pend`, `tool`): prior 120-character paths exceeded macOS's
limit. The pending constructor's PID is absent after stop, its formula is removed,
and a sibling remains callable. The graceful-restart test refuses old tool authority
until explicitly reattached. These are not native process-loss recovery tests.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `dbc7e71e7` | Context cancellation fences later formula loading/evaluation and powers acquisition; cancelled dependency registration cannot revive missing controllers | Held formula-read/worker tests verify no late execution. Fence belongs to an incarnation, not durable revocation or cancellation of every already-admitted operation |
| `0ad523414` | Host construction retains original worker/client contexts; boxed formulation completion is distinct from constructor value; stop drains formulation then cancels without revival | Injected failures and real pending-constructor test cover no premature worker cancellation, no replacement acquisition and sibling preservation. Hung persistence may hold cleanup; abrupt loss remains separate |
| `d64ce9532` | Tool authority belongs to one activation, never persisted session references; replacement requires stop, and cleanup/reconstruction has no implicit tools | Unit and real graceful-restart tests cover identical/replacement tools, old resolver fencing and refusal of persisted tools role. Resolver fencing prevents new delivery, not revocation of a capability already handed out; controller/tool lifecycle must fence such authority |

### Per-request preparation and shared-service scopes

Five more changes are mapped to current preparation/issuance and service owners.
Fresh provider-scopes tests pass 12 cases; sandbox native-factory/owned-agent/runtime
suites pass 41. They use injected native effects and local ownership files, not
live Podman or daemon-loss recovery. Scope maps are deliberately ephemeral;
missing lookup after service loss is not evidence that native resources are gone.
Independent fresh runs pass 124 sandbox factory-owner/Podman-cleanup/Podman-policy
tests and 57 hosted-agent provider-grant-issuer/provider-listener-runtime tests.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `9391a5a6b` | Factory retains each Podman preparation kit before awaiting its value; failed preparation remains independently closeable | Per-preparation cancellation/late acquisition/sibling cleanup tests; legacy drivers without kits still transfer only on successful preparation. No process-loss ownership recovery |
| `9bf9f3856` | Each provider issue kit owns listener acquisition and revocation independently of the shared issuer/runtime | Failed issuance and cleanup remain addressable without closing sibling grants. Later runtime/recovery composition is not attributable to this original change; no live namespace release proof |
| `c7a741462` | Runtime exposes per-session native factory scopes over one driver/storage owner; failed scope close retains lookup and successful close removes only that exact owner | Tests cover late acquisition, sibling progress, shared allocation budget and failed operator shutdown. Shared copy-data checks reject imported authority in native inputs; ephemeral scope lookup is not a durable recovery ledger |
| `6ec0c08ac` | Provider scopes are inert until start and retain issue kits before acquisition; revoke drains observations and shared opening without owning operator shutdown | 12 tests cover failed cleanup, replacement, stale handles, sibling use and catalog read fencing. Supervisor must serialize replacement; hung admitted calls can block cleanup and absence after service loss is not release proof |
| `ec7929c92` | Native service constructor accepts null powers only; explicit-path host-only factory avoids importing daemon scratch authority | Tests reject non-null powers/imported capabilities and preserve cancellation through pending powers. Current owned-agent uses refusing makeNoHostScratch authority rather than granting a host provider; null construction does not make trusted host paths guest-safe |

### Broker composition, host environment and diagnostics

Four further changes are traced to current shared service/runtime implementations.
Fresh sandbox podman-host-environment/podman-policy suites pass 73 tests and
hosted-agent provider-listener-runtime passes 22.
Independent OpenCode opencode-broker-service/opencode-broker-service-agent suites
pass 15 tests; the service test exercises the shared kit after wrapper removal.
These are local and injected-process checks, not live Podman or daemon-loss recovery.

| Commit | Retained owner / boundary | Evidence and remaining limit |
|---|---|---|
| `712db8fd0` | Shared provider-broker-service composes retained per-session scopes, issuer and runtime; obsolete OpenCode wrapper removed by `8aa1edc99` | Tests cover inert construction, isolated revocation, cancelled/late acquisition and failed scope/operator cleanup. Scope maps and callbacks are ephemeral; formula-backed configuration does not reconstruct lost native resources |
| `cf9fdce82` | Broker agent uses makeOwnedNativeService to retain an inert service kit before opening; configuration comes from the formula environment and credential capabilities arrive through formula powers | Tests cover cancellation during powers acquisition, failed predecessor cleanup, duplicate live owners and replacement. Module owner registry is incarnation-local; independent workers require separate native exclusion. Later account-pool/catalog behavior is not attributed to this commit |
| `ae19ef2f9` | Podman driver/listener capture trusted operator engine environment once and reuse it for startup and cleanup; guest environment remains separate | Environment/policy/runtime tests verify restricted inheritance and local-engine controls. Later `dd705e037` supplies fresh copies to child processes. Operator configuration/default credential files remain trusted authority; allowlisting is not complete isolation or durable process ownership |
| `9a487b956` | Provider runtime drains stderr without giving log volume authority to close the inference pipe; diagnostics are optional observations | Runtime tests exercise repeated oversized chunks with diagnostics on/off. Later `96b32da43` replaces the original lifetime diagnostic ceiling with a copied 4096-byte prefix per chunk. No total log-volume bound, durable diagnostic journal or process-loss recovery is implied |

### Native startup gate and retired hosted profile

Two further changes are mapped, with a distinction between the retained generic
sandbox API and the current hosted execution envelope.
Fresh sandbox startup-gate/native-podman-profile/native-podman-mounts/
native-podman-operation suites pass 72 tests; runtime passes 20 and OpenCode
session-plan passes 17.
Shell protocol tests run local processes; procfs/cgroup/container observations
are injected and do not establish live Linux or Tokyo behavior.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `aaca97706` | Explicit native-profile Podman operations retain an inert trusted gate until identity, resource, mount and network observations succeed; ordinary operation owner retains failed removal and uncertain execution | Gate/operation tests cover held reads, cancellation before and after release issuance, first stdin, uncaptured stdout and failed-cleanup capacity. Current synchronous release and uncertainty semantics include later fixes. Image no-alias and trusted procfs/cgroupfs visibility remain host preconditions; seccomp mode does not prove filter contents. This branch is not used by the current hosted envelope |
| `3a95b12d7` | Original OpenCode recorded-profile parsing/request was removed by `1366b2e31`; current hosted plans reject the obsolete field. Generic sandbox export and native-scope profile guard remain | Current plan tests verify refusal; runtime tests verify exact profile shape before driver acquisition. FA-05 records the lower-level branch as a removal candidate pending public/retained-caller tracing. Historical controller tests do not prove current hosted limits or restart behavior |

### Native setup and shared session placement

Four more changes are traced to retained setup and storage owners rather than
treating their original deployment descriptions as current acceptance evidence.
Fresh shared session-plan/state-storage suites pass 22 tests, session-storage
passes two, and mount-caplet passes 34.
Independent OpenCode setup-host/setup-hosted/session-plan suites pass 44 tests.
State-storage interruption tests inject checkpoints and reconstruct local objects;
they do not establish native process quiescence or actual power-loss durability.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `c6033c49f` | Host setup mints the native sandbox service with persisted environment and a null-powers formula; existing service keeps its recorded configuration | Retained setup refuses bound legacy runtime and leftover ownership before replacement. Naming checks are not native stop proof, and setup does not retire old processes. Original OpenCode state-provider setup was subsequently removed |
| `30219602e` | Validated rootless mount-program settings travel in the passive session plan; shared workspace projection passes them to the session-owned mounter | Current plan and mount-caplet tests cover accepted/refused settings and cancellation/drain. Programs are trusted host configuration, not guest capabilities; injected mount commands do not establish live privileged unmount behavior |
| `c91c3b8c6` | Shared plan parsing, session-storage removal and native state placement replace adapter copies; recorded plans remain owned by the daemon session owner | Shared tests exercise normalized paths, storage removal and interrupted ownership publication. Later `baecab949` replaces original fixed-directory placement with unique inode-bound allocations; `1366b2e31` removes hosted native-profile parsing and `d2959f834` removes obsolete OpenCode state-provider wiring. Current ownership records are not independent proof of native stop; stable host roots and administrative serialization remain preconditions |
| `d96ec4e4e` | Lockfile adds only the local @endo/9p-server workspace dependency used by shared plan mount-program validation | No external version change, new formula owner or storage schema. Runtime evidence belongs to the preceding extraction and retained mount-program checks |

### Session service routing and Claude adoption

This pass fills two previously skipped OpenCode entries and maps the next two
Claude changes. The previous total of 81 unique mappings was correct, but its
description as the earliest 66 commits was not: `aabd998ba` and `b4767d5aa`
had been skipped. They are now explicitly covered below.
Fresh Claude native-controller/session-plan/session-storage-module suites pass
25 tests; independent broker/backend/setup/runtime-setup suites pass 40.
Independent OpenCode setup/runtime/plan/storage/backend suites pass 96 tests.
Two historical daemon regressions initially failed before their target assertions:
an overlong macOS socket path and a retired broker `models` fixture field.
The fixture corrections use a short unique configuration name and an isolated
broker worker with a test-only free-model catalog; no live inference is involved.
Both corrected daemon cases pass with their original lifecycle assertions intact,
plus broker-worker isolation and recorded free-route assertions.
They establish graceful stale-owner refusal and failed-activation cleanup wiring,
not successful native recovery or live Podman execution.
Current source comments were corrected where they still described unminted
Claude services or an authoritative durable OpenCode native conversation store.

| Commit | Retained owner / disposition | Evidence and remaining limit |
|---|---|---|
| `aabd998ba` | Setup mints daemon session services and records exact dependencies; later shared setup helpers retain this ownership boundary | Original OpenCode state-provider wiring was removed; current storage service has null powers and CLI state is ephemeral. Setup mocks do not prove process retirement or native restart |
| `b4767d5aa` | Hosted provision requests flow through the daemon session owner, with passive plan and storage roles distinct from the native controller | Later shared provisioner and transcript restoration replace original adapter-specific construction and native-store continuity. Current plan/dependency checks are not proof that lost native resources were released |
| `d1ede212e` | Claude passive plan, native controller, state-provider and storage roles remain; shared supervisor/envelope now own common lifecycle sequencing | 25 tests cover current parser, controller and storage behavior. Native state directories remain but restoration uses the stack's canonical transcript; original hosted native-profile field was removed. Native-effect injection is not daemon-loss recovery or live CLI acceptance |
| `db53b1040` | Daemon owner retains Claude plan and exact service identities; broker holds credential authority and grants session-scoped inference without handing credentials to the controller | 40 tests cover setup and broker routing. Inline provisioning moved to shared code, profiles were removed, catalog discovery replaced operator model lists, and pools replaced single-account assumptions. Incarnation-local grant/listener cleanup is not stop acknowledgement after process loss; #1323 remains open |

### Post-snapshot changes

- Collection draining now attempts queued siblings after a callback rejects,
  retaining all errors until the drain ends. A guest-construction regression
  reproduces stranded mailbox cleanup before the fix; a second variant checks
  multiple failed callbacks followed by successful cleanup. Failed callbacks
  are still not retained for retry; no global quiescence or recovery claim.
- Collection cancellation failures now reject before storage deletion, retaining
  original causes and reconstruction fences. A new injected-worker regression
  fails before the fix; 28 barrier/context/worker tests pass afterward.
  This reports failed disposal, not native quiescence or retry recovery.
- Collection now reports formula/pet-store deletion errors and preserves them
  alongside reclamation errors. Reconstruction fences and missing retry behavior
  are unchanged; the barrier suite adds single-store and combined-error checks.
- Collection barrier tests now characterize lost retry ownership after a
  transient formula deletion or scratch reclamation failure clears: later graph
  work succeeds but does not retry the original cleanup. Four cases pass.
  This is an unresolved defect, not recovery evidence; the main audit records
  reentrancy, cancellation and per-stage ownership constraints for the fix.
- Removed unused `formulateDirectoryForStore` and its internal type/host wiring
  after whole-repository caller and facet tracing; active directory construction
  and replay are unchanged. The 55 construction/directory/marshal tests, daemon
  types, changed-file formatting/lint and root docs pass; stale generated
  declaration handling and warning counts are recorded in the main audit.
- Application `12d79432a`, `19315967e`, `8ea9466d5`: guest and nested-directory
  construction reserve identities before writes, drain publication and release
  pins on failure. The current 44-case fault matrix passes; details and limits
  are in the main audit. `ab339180d` characterizes residual agent identity keys,
  still unresolved, without changing runtime credential handling.

- Application `71dfde012` and `4929571ea`: failed-publication pin release,
  error-path graph cleanup, and strengthened regression/type validation, as
  described above and in the main audit. Pushed to GitHub and Forgejo, not deployed.

- Host `f922568` restoration-ledger correction (2026-09-24): persist intent before remote
  create/seed/recall, refuse uncertain retries, preserve IDs, and atomically flush
  private manifests under exclusive phase locks. Cleanup holds both locks through
  deletion and validates complete version-two ledgers and exact two-turn evidence.
  Unknown-ID creation attempts remain inspectable. All 53 focused tests pass,
  independently rerun by the adversarial reviewer; four inert wrapper tests pass.
  This is local protocol/fault evidence, not live acceptance or power-loss proof.
  Legacy manifests require manual inspection; private ancestry and exclusive
  operator use are trusted. No exactly-once creation or UI exclusion is promised.

- Application `1aa668820`: documentation-only inventory and audit links, no runtime owner.
- Application `294121320`: documentation-only ownership mappings and design correction.
- Host `c98eb5d`: legacy detachment no longer calls host cancellation, which can
  construct dormant custom modules. Exact target identities and preservation
  checks remain; live holders still require old-daemon shutdown. Tests forbid
  cancellation, inject removal failure/reappearance, and distinguish effectful
  failure shutdown instructions from dry-run errors. Three prior cases fail on
  the old implementation; all 44 related helper tests pass after the fix.
  Independently reviewed and pushed, not executed on Tokyo.
  This changes maintenance actions, not daemon cancellation semantics or native
  recovery. A completed retry may still fail safely if GC removed old metadata.
- Host [`4e2a574`](https://github.com/kumavis/endo-host/commit/4e2a574fb57b3e32aa29ad60e0cbfd0f8990bb5b):
  candidate manifest publication now flushes file, renames, then flushes its
  directory before success. Three added cases distinguish ordering, failed file
  flush preserving the old manifest, and failed directory flush retaining an
  uncertain visible replacement while propagating failure and closing the fd.
  Two cases failed before the fix. All 32 image/holder/storage tests now pass.
  Independently reviewed and pushed to GitHub/Forgejo, not deployed.
  No new formula, authority, retention period, activation, or renewal behavior.
  This verifies publication ordering and injected I/O failures, not physical
  power-loss durability or adversarial mutation of the operator's directories.

## Reproduction

For each repository, resolve the seed and snapshot HEAD, then enumerate:

```sh
git log --reverse --format='%H%x09%s' SEED..SNAPSHOT_HEAD
git diff-tree --root --no-commit-id --name-only --no-renames -r COMMIT
```

Classify the changed paths using the definitions above.
Areas below are unique first path components, except that `packages/NAME/`
is displayed as `NAME`.
They are navigation aids, not an ownership analysis.
An empty diff must remain R for manual inspection; neither snapshot has one.
Future commits must extend the ledger or name the new unclassified range explicitly.

## Application commits

| Commit | Triage | Areas | Subject |
|---|---|---|---|
| [c6eb481a2](https://github.com/endojs/endo-but-for-bots/commit/c6eb481a26d83e825eb90ee2cee354e5ed352065) | R | codex-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): use revocable session inference grants |
| [c311b2f98](https://github.com/endojs/endo-but-for-bots/commit/c311b2f98af9fb7d27b90c7ec5d51e82af155b02) | R | claude-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share CLI MCP socket transport |
| [ae9dcd3c8](https://github.com/endojs/endo-but-for-bots/commit/ae9dcd3c87d64c07de81d53d5f8ba0632b09b3f1) | R | claude-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share MCP tool admission |
| [6457a0c6e](https://github.com/endojs/endo-but-for-bots/commit/6457a0c6e23683e94dc26192143b188acdd6538f) | R | designs, floot | fix(floot): close hosted tool admission on turn interruption |
| [c29a9ebf1](https://github.com/endojs/endo-but-for-bots/commit/c29a9ebf16505048a791c6dc6f05463529a753b6) | R | claude-sandbox, codex-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): retain failed session cleanup ownership |
| [eacf0a30c](https://github.com/endojs/endo-but-for-bots/commit/eacf0a30ca2ab2abebff68156c7060aaf6e116fb) | R | claude-sandbox, codex-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share session lifecycle registry |
| [ba4cdbb3e](https://github.com/endojs/endo-but-for-bots/commit/ba4cdbb3e2b5baa3e254c1e25a2a5a272dba6ed3) | R | claude-sandbox, opencode-sandbox | fix(sandbox): retry failed MCP socket cleanup |
| [6747bf5b0](https://github.com/endojs/endo-but-for-bots/commit/6747bf5b06e18409f9be157b2bed6bfaccda81f8) | R | codex-sandbox, designs, hosted-agent | refactor(hosted-agent): share public networking and listener image |
| [9f2a754aa](https://github.com/endojs/endo-but-for-bots/commit/9f2a754aa83a76c17d0b33a17a50abf5d46727ec) | R | codex-sandbox, designs | refactor(codex-sandbox): use the outer guest execution boundary |
| [c162186ed](https://github.com/endojs/endo-but-for-bots/commit/c162186ed361ab4c34239c6daddae21355b3a86d) | R | codex-sandbox, designs, hosted-agent | refactor(hosted-agent): remove privileged proxy address setup |
| [d9a0f3106](https://github.com/endojs/endo-but-for-bots/commit/d9a0f31060a93970fc49c0530c31a696ac69c3d1) | R | codex-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share public network launch configuration |
| [9e79f1f68](https://github.com/endojs/endo-but-for-bots/commit/9e79f1f68a45dd4bba0949babd72940998dc5ef4) | R | designs, hosted-agent, sandbox | fix(sandbox): Retain Podman cleanup ownership until reaped |
| [f2658b4d6](https://github.com/endojs/endo-but-for-bots/commit/f2658b4d63a7daf56387afbbee99144b87393c33) | R | designs, sandbox | fix(sandbox): Retain bwrap children until cleanup succeeds |
| [d38de219d](https://github.com/endojs/endo-but-for-bots/commit/d38de219dd1bafeaa2ca7cf2884e256531c9cd5c) | R | designs, sandbox | fix(sandbox): Retry disposal without losing cleanup ownership |
| [a887b2115](https://github.com/endojs/endo-but-for-bots/commit/a887b2115f26905429c7542b2d5ef188c14596ce) | R | designs, sandbox | feat(sandbox): Define literal generated configuration requests |
| [ea50a5e7c](https://github.com/endojs/endo-but-for-bots/commit/ea50a5e7c2af4940e8844e2fdc2b87ebc9e9d332) | R | designs, sandbox | feat(sandbox): add owned storage for generated files |
| [3eb95cd26](https://github.com/endojs/endo-but-for-bots/commit/3eb95cd262ef7eec1aa05943182aefe217b1c53b) | R | designs, sandbox | feat(sandbox): stage generated files for Podman operations |
| [e0f07b1ea](https://github.com/endojs/endo-but-for-bots/commit/e0f07b1ea1d62adfed1d6bfab3cf87522e362028) | R | designs, sandbox | feat(sandbox): retain factory shutdown ownership |
| [9ce27aafb](https://github.com/endojs/endo-but-for-bots/commit/9ce27aafb4c462c1a6ed3172cb23ea3451f9c68e) | R | sandbox | refactor(sandbox): expose control command closure separately |
| [a85f04772](https://github.com/endojs/endo-but-for-bots/commit/a85f0477295556a6ae5e4ee20dab9ba962cab572) | R | sandbox | fix(sandbox): require local Podman engine on every invocation |
| [9ba226e4b](https://github.com/endojs/endo-but-for-bots/commit/9ba226e4bad6563b612192e20e4f75b497d761f1) | R | sandbox | fix(sandbox): retain failed Podman preparation resources |
| [e280c0ab8](https://github.com/endojs/endo-but-for-bots/commit/e280c0ab81b78ce0f67f249e37cbb1f388bd957f) | R | sandbox | fix(sandbox): retain uncertain Podman operation creates |
| [f5813d27d](https://github.com/endojs/endo-but-for-bots/commit/f5813d27dd0b32da41fc06fd857fac12ced402ed) | R | sandbox | fix(sandbox): bind operation controls to full container IDs |
| [3960357ce](https://github.com/endojs/endo-but-for-bots/commit/3960357cee867b5704eddaccf2684620acf6cb76) | R | sandbox | fix(sandbox): retain unwitnessed Podman startup effects |
| [bb8c7fd55](https://github.com/endojs/endo-but-for-bots/commit/bb8c7fd5583411d46560c2aca26a0267557f1582) | R | sandbox | feat(sandbox): close owned Podman native command lifetimes |
| [c87ff8260](https://github.com/endojs/endo-but-for-bots/commit/c87ff8260b95b8ed6efb97e2b0acd904046ef9d5) | R | designs, sandbox | feat(sandbox): compose owned hosted Podman runtimes |
| [905cd44c2](https://github.com/endojs/endo-but-for-bots/commit/905cd44c26a51364068837c6cb9d60f8c6dd6096) | R | designs, sandbox | feat(sandbox): retain owned runtimes across daemon reconstruction |
| [bedcc52b8](https://github.com/endojs/endo-but-for-bots/commit/bedcc52b822be22728f000a75a7bf76184fa5d1b) | R | daemon | feat(daemon): expose persisted caplet environment to host owners |
| [6c8d83928](https://github.com/endojs/endo-but-for-bots/commit/6c8d83928aa302c17d68e742afd5da43d85de450) | R | designs, opencode-sandbox, sandbox | feat(opencode-sandbox): provision owned runtimes from effective configuration |
| [1a91a0fd4](https://github.com/endojs/endo-but-for-bots/commit/1a91a0fd453b0cddd0acb0e9ce8ce146e3fe7244) | R | daemon, designs, hosted-agent | feat(hosted-agent): retain passive session ownership records |
| [bf62142db](https://github.com/endojs/endo-but-for-bots/commit/bf62142db8b91d411a98e4496e4ffead6b51d722) | R | designs, opencode-sandbox | fix(opencode-sandbox): retain failed cleanup ownership |
| [31fa9f011](https://github.com/endojs/endo-but-for-bots/commit/31fa9f01108849af74541d3cfd271e3f65d4aad5) | R | daemon | fix(daemon): retain imported formula identities |
| [e16d21b07](https://github.com/endojs/endo-but-for-bots/commit/e16d21b07c790481eb9002221c8848773e8c6609) | R | claude-sandbox, daemon, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share static session powers |
| [9df03e624](https://github.com/endojs/endo-but-for-bots/commit/9df03e624d8fbb238e731fc7208c9d685e9366d0) | R | daemon, designs, hosted-agent, sandbox | refactor(daemon): own shared session records and cleanup registry |
| [e41697f63](https://github.com/endojs/endo-but-for-bots/commit/e41697f637f37cecc2bc64abba3e102b228bab74) | R | daemon | fix(daemon): balance directory construction pins |
| [6b1f06680](https://github.com/endojs/endo-but-for-bots/commit/6b1f06680f8e6684398032c1a75dbfba1bf9d560) | R | daemon, designs | feat(daemon): own session lifecycle behind forwarding facets |
| [0cc29f1fd](https://github.com/endojs/endo-but-for-bots/commit/0cc29f1fdac4bddbffb9d5e0082dfeb18d8f234b) | R | sandbox | feat(sandbox): prepare native slices from owned host paths |
| [190d1aa28](https://github.com/endojs/endo-but-for-bots/commit/190d1aa28f8234d50c83a6b4bd96d02fd6c35cf4) | R | opencode-sandbox | refactor(opencode-sandbox): separate native state storage from mounts |
| [a2cb55d81](https://github.com/endojs/endo-but-for-bots/commit/a2cb55d8164153c56e923a74e9deb8f970f332a3) | R | 9p-server, designs | fix(9p-server): preserve cancellation signal during mounter construction |
| [4c498b1bc](https://github.com/endojs/endo-but-for-bots/commit/4c498b1bc327ec3912170c4cdc8f323bf4fd072f) | R | exo-stream | feat(exo-stream): add explicit endpoint cleanup |
| [5399817fc](https://github.com/endojs/endo-but-for-bots/commit/5399817fce75f78ffdb1505233458f95c8077745) | R | platform | fix(platform)!: retain cursor cleanup until release succeeds |
| [93e2457fb](https://github.com/endojs/endo-but-for-bots/commit/93e2457fb1a62c08e6dc0770f942cf5bfa32876e) | R | 9p-server, claude-sandbox, designs, opencode-sandbox | fix(9p-server)!: retain mount ownership until filesystem drain |
| [3353c5dad](https://github.com/endojs/endo-but-for-bots/commit/3353c5dadf80f24aa37b922f1c6be032ddeebc21) | R | yarn.lock | chore: Update yarn.lock |
| [c5cf84243](https://github.com/endojs/endo-but-for-bots/commit/c5cf842433ba1e8904f5dfc38f41644dfe65f5b4) | R | daemon, designs | fix(daemon): publish fresh caplet workers before acquisition |
| [18de3ccc4](https://github.com/endojs/endo-but-for-bots/commit/18de3ccc4f60f148f4223c6fc99333535d6d1b44) | R | designs, hosted-agent, opencode-sandbox | fix(hosted-agent): retain MCP setup and drain admitted calls |
| [9843b3ab9](https://github.com/endojs/endo-but-for-bots/commit/9843b3ab9adf5f4c3a8853ea229458045cb8af83) | R | designs, hosted-agent, opencode-sandbox | fix(hosted-agent): retain provider setup cleanup ownership |
| [e0a67872a](https://github.com/endojs/endo-but-for-bots/commit/e0a67872aca683a2d55ec86611e0d2da144d27f4) | R | daemon, designs | fix(daemon): await native worker closure during cancellation |
| [2b7642dbe](https://github.com/endojs/endo-but-for-bots/commit/2b7642dbe5f17fb2a39c0551434422f9bec68fc5) | R | daemon, designs | feat(daemon): construct and activate retained native sessions |
| [dbc7e71e7](https://github.com/endojs/endo-but-for-bots/commit/dbc7e71e752e7ba512f2867264f491635b122742) | R | daemon, designs | fix(daemon): fence formula evaluation after cancellation |
| [0ad523414](https://github.com/endojs/endo-but-for-bots/commit/0ad5234140ada47ff9f8964c61fca606ebd76f30) | R | daemon, designs | fix(daemon): cancel retained native session construction |
| [d64ce9532](https://github.com/endojs/endo-but-for-bots/commit/d64ce9532860389b223970cbc65086d50826b972) | R | daemon, designs | feat(daemon): attach transient tools to native sessions |
| [9391a5a6b](https://github.com/endojs/endo-but-for-bots/commit/9391a5a6b48d8eab2abc37ef860f5c38b4088c1d) | R | designs, sandbox | fix(sandbox): retain cleanup per Podman preparation |
| [9bf9f3856](https://github.com/endojs/endo-but-for-bots/commit/9bf9f3856fd5641f99b00757198f32a36dca1ac8) | R | designs, hosted-agent, opencode-sandbox | fix(hosted-agent): retain cleanup for each provider issuance |
| [c7a741462](https://github.com/endojs/endo-but-for-bots/commit/c7a74146276e1c3512e90eab2f8491f974f3d749) | R | daemon, designs, sandbox | feat(sandbox): expose shared native cleanup scopes |
| [6ec0c08ac](https://github.com/endojs/endo-but-for-bots/commit/6ec0c08aca14561606da6aa2fc08a447497951c7) | R | designs, hosted-agent | feat(hosted-agent): expose retained provider scopes |
| [ec7929c92](https://github.com/endojs/endo-but-for-bots/commit/ec7929c92fbfd462a7a072323115f01cc6dc8908) | R | designs, sandbox | refactor(sandbox): construct native services with null powers |
| [712db8fd0](https://github.com/endojs/endo-but-for-bots/commit/712db8fd0d8d5e4108d5752d12a55debd0416569) | R | designs, opencode-sandbox | feat(opencode-sandbox): compose retained broker service scopes |
| [cf9fdce82](https://github.com/endojs/endo-but-for-bots/commit/cf9fdce826aa63168c13f21ad299d8172ce1d8a9) | R | daemon, designs, opencode-sandbox, sandbox | feat(opencode-sandbox): retain native broker service ownership |
| [ae19ef2f9](https://github.com/endojs/endo-but-for-bots/commit/ae19ef2f917b95ba9678ccba9246baa6429bf03e) | R | designs, hosted-agent, opencode-sandbox, sandbox | fix(sandbox): share captured Podman control environments |
| [9a487b956](https://github.com/endojs/endo-but-for-bots/commit/9a487b95693de0c35d5c6deafa08b23343c9049d) | R | designs, hosted-agent | fix(hosted-agent): keep inference alive through verbose stderr |
| [aaca97706](https://github.com/endojs/endo-but-for-bots/commit/aaca977068bfee4987df657441f96b4136b91fd3) | R | designs, sandbox | feat(sandbox): verify native Podman operations through a startup gate |
| [3a95b12d7](https://github.com/endojs/endo-but-for-bots/commit/3a95b12d7d0f0c7a774c6f4aea6b5b1396afca99) | R | designs, opencode-sandbox, sandbox | feat(opencode-sandbox): record and request the native Podman profile |
| [aabd998ba](https://github.com/endojs/endo-but-for-bots/commit/aabd998bad035c841d4f4d77fbf0e53959ef50d3) | R | daemon, designs, opencode-sandbox | feat(opencode-sandbox): mint the daemon-owned session services at setup |
| [b4767d5aa](https://github.com/endojs/endo-but-for-bots/commit/b4767d5aa62861a201a51c67455a62b56fd807cb) | R | daemon, designs, opencode-sandbox | feat(opencode-sandbox)!: provision sessions through the daemon owner |
| [c6033c49f](https://github.com/endojs/endo-but-for-bots/commit/c6033c49ff03388aa046b744b6081d728231f3b1) | R | designs, opencode-sandbox | feat(opencode-sandbox)!: mint the native runtime as the primary runtime |
| [30219602e](https://github.com/endojs/endo-but-for-bots/commit/30219602e6aea9c4cf56d974e2091365c5469a85) | R | 9p-server, designs, opencode-sandbox | feat(opencode-sandbox): record the rootless mount settings in each plan |
| [c91c3b8c6](https://github.com/endojs/endo-but-for-bots/commit/c91c3b8c63e57f443537c2e305896b909f83c4f5) | R | designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share the session plan, storage, and state primitives |
| [d96ec4e4e](https://github.com/endojs/endo-but-for-bots/commit/d96ec4e4ea72f8df3e3b46674cc4d521cca9b9e7) | R | yarn.lock | chore: Update yarn.lock |
| [d1ede212e](https://github.com/endojs/endo-but-for-bots/commit/d1ede212e5ea3c213d37a56a8df57d0b6a46f45f) | R | claude-sandbox, designs | feat(claude-sandbox): add the daemon-owned Claude session plan and controller |
| [db53b1040](https://github.com/endojs/endo-but-for-bots/commit/db53b104055df69bac262c9116aca57c4175835c) | R | claude-sandbox, daemon, designs, hosted-agent, opencode-sandbox | feat(claude-sandbox)!: route hosted sessions through the daemon owner and an Anthropic broker |
| [95bc54880](https://github.com/endojs/endo-but-for-bots/commit/95bc5488024905a6bf7896e074d658635022fd4e) | D | designs | docs: reconcile the design index totals after rebasing onto llm |
| [32ec2be40](https://github.com/endojs/endo-but-for-bots/commit/32ec2be40e7ec6d4cb5d895906d21f0678fe9950) | T | sandbox | test(sandbox): give observed startup-gate refusals a CI-safe deadline |
| [6d297f140](https://github.com/endojs/endo-but-for-bots/commit/6d297f1401c7edace7bd977a27b6d10f0fbc6e07) | T | sandbox | test(sandbox): accept a retained uncertain operation after a deadline reap |
| [91287398c](https://github.com/endojs/endo-but-for-bots/commit/91287398cd80d5c9899690ab1103cc7a055a142a) | R | agent-tools, exo-stream | fix(exo-stream): declare closeable streams as intersections |
| [c4bcf2275](https://github.com/endojs/endo-but-for-bots/commit/c4bcf22751a697ce95134e6b9a1d41c7b375d6dc) | T | platform | test(platform): re-pin the cached-fs transcripts after cursor cleanup |
| [366f2c6e9](https://github.com/endojs/endo-but-for-bots/commit/366f2c6e98143ac4c98431410b1ff83b57085b8e) | R | opencode-sandbox | fix(opencode-sandbox): lint the in-slice bridge under the repository rules |
| [f006c749e](https://github.com/endojs/endo-but-for-bots/commit/f006c749e4ab2aa433d7c157a80b6bba801dc79b) | R | opencode-sandbox | fix(opencode-sandbox): type the broker transport and client plan |
| [dd705e037](https://github.com/endojs/endo-but-for-bots/commit/dd705e0373697943e66d0aba76c88fe2e7657d44) | R | hosted-agent, sandbox | fix(sandbox,hosted-agent): hand each Podman process a copy of the captured env |
| [8e260a48e](https://github.com/endojs/endo-but-for-bots/commit/8e260a48eb85df6dc662726f3a7f9cbbf8c44602) | T | space-nixos-admin | test(space-nixos-admin): let the fake applier outwait a saturated runner |
| [30af6a089](https://github.com/endojs/endo-but-for-bots/commit/30af6a08970be395cb7b2e7cf3d4faf8093e84a2) | R | eslint.config.js | chore(eslint): ignore the OpenCode OCI spike harness like other standalone scripts |
| [498654d52](https://github.com/endojs/endo-but-for-bots/commit/498654d52707ff519b39cec48028f3423477ed7b) | R | opencode-sandbox | chore(opencode-sandbox): satisfy shellcheck in the OCI build and spike scripts |
| [e47c6cfa3](https://github.com/endojs/endo-but-for-bots/commit/e47c6cfa36af2957973e4507dc1366f32d4fb215) | T | daemon | test(daemon): accept the Linux refusal shape in the backend acceptance tests |
| [2731a96da](https://github.com/endojs/endo-but-for-bots/commit/2731a96dace4e4c6cce0932463d537b9c1ad0d22) | R | chat, space-floot | fix(space-floot): size the header's journal and network controls to their labels |
| [b85e0c816](https://github.com/endojs/endo-but-for-bots/commit/b85e0c816bc983342568e772eb7b9d26dcc7cc1b) | R | claude-sandbox | fix(claude-sandbox): restore the managed-credentials caplet module path |
| [00ad7b6e5](https://github.com/endojs/endo-but-for-bots/commit/00ad7b6e5e9ddf31f30724f1b079383e844a9c4c) | R | claude-sandbox, opencode-sandbox | fix(sandbox): create the sandbox directory before probing inside it |
| [5e94e663a](https://github.com/endojs/endo-but-for-bots/commit/5e94e663a4f0ddcee5f6317bd59a76dd3122ce3c) | R | fae, floot, lal | feat(floot): add Secrets-backed OpenRouter provider for Floot and Fae |
| [199252059](https://github.com/endojs/endo-but-for-bots/commit/199252059a53a215960f4335797f2294fce3161a) | R | claude-sandbox, hosted-agent, opencode-sandbox | feat(hosted-agent): let a broker log why an upstream request failed |
| [d89c89c2f](https://github.com/endojs/endo-but-for-bots/commit/d89c89c2f1b4e63063f7a851f16e2e7c12982d1d) | R | claude-sandbox | fix(claude-sandbox): admit the OAuth beta route in the broker policy |
| [a144237cc](https://github.com/endojs/endo-but-for-bots/commit/a144237cc9fdcd079022e27f2602b54c8f3483ec) | R | claude-sandbox | Revert "fix(claude-sandbox): admit the OAuth beta route in the broker policy" |
| [8e90f65f0](https://github.com/endojs/endo-but-for-bots/commit/8e90f65f0f678cf80effbccf05892af2a8bcc33f) | R | claude-sandbox, hosted-agent | feat(hosted-agent)!: admit a bounded query in an inference route |
| [5173330d2](https://github.com/endojs/endo-but-for-bots/commit/5173330d276473f4fab1747c7739591469d6088a) | R | hosted-agent | feat(hosted-agent): report why an upstream refused, to the host only |
| [6cd58e3cc](https://github.com/endojs/endo-but-for-bots/commit/6cd58e3cc5367e1f25e6b9f0548170ce5c481263) | R | hosted-agent | feat(hosted-agent)!: forward the harness's headers; the broker adds the credential |
| [418a4cffc](https://github.com/endojs/endo-but-for-bots/commit/418a4cffc01d499aa5484d0e431341555c84decf) | R | hosted-agent | feat(hosted-agent)!: check outbound header shape, not a foreseen name |
| [f5a4adfe3](https://github.com/endojs/endo-but-for-bots/commit/f5a4adfe377f99ff391c6eb6a43b4569dccfc652) | R | hosted-agent | fix(hosted-agent): name which request-stage check refused, and allow HTAB |
| [f24b255bb](https://github.com/endojs/endo-but-for-bots/commit/f24b255bba297c2c27325ae2c2c9ab55c59165ae) | T | hosted-agent | test(hosted-agent): a bounded query is an exact target, not a smuggled one |
| [e834f15b8](https://github.com/endojs/endo-but-for-bots/commit/e834f15b82ab18b8e3b849e0c97f2e9af8ffd7f1) | R | hosted-agent | fix(hosted-agent): a grant's headers are optional, not merely nullable |
| [8d6fac389](https://github.com/endojs/endo-but-for-bots/commit/8d6fac3892a76d194b280cd9218ea9f8a1ef2344) | R | hosted-agent | refactor(hosted-agent): drop a route binding the shape rule already subsumes |
| [6d92480d8](https://github.com/endojs/endo-but-for-bots/commit/6d92480d8071dd2e90811fb610069388ec5238c2) | T | hosted-agent | test(hosted-agent): pin the widened request path, and the bounds that remain |
| [75bc605ee](https://github.com/endojs/endo-but-for-bots/commit/75bc605ee92efecd1951b0632faa79153019cbe0) | R | claude-sandbox, opencode-sandbox | fix(sandbox): probe inside the sandbox directory without creating it first |
| [ee91b2f31](https://github.com/endojs/endo-but-for-bots/commit/ee91b2f319e9eee3630c96ce05fd2d31b2c5afe3) | R | endo-fs-asset-server | fix(endo-fs-asset-server)!: refuse a capability this server cannot walk |
| [c08a3c177](https://github.com/endojs/endo-but-for-bots/commit/c08a3c1776d4509d13f487db8a5f93380f63fac9) | R | floot, yarn.lock | fix(floot): project a git or Mount workspace before publishing it |
| [f76cedd1a](https://github.com/endojs/endo-but-for-bots/commit/f76cedd1a32b7fe526fddbfb4fc5401c0e9203e1) | R | claude-sandbox, hosted-agent, opencode-sandbox | fix(hosted-agent)!: reclaim a lost worker's recorded mount, don't strand it |
| [6a84419d1](https://github.com/endojs/endo-but-for-bots/commit/6a84419d1aa7ae90932d0d183a87139af2198a33) | R | claude-sandbox, endo-fs-asset-server, floot, hosted-agent, opencode-sandbox | fix(hosted-agent): dispose the listener a passing assertion now binds |
| [c811a84a9](https://github.com/endojs/endo-but-for-bots/commit/c811a84a93d004d315759f5f8bd3076ed8c31e0a) | R | claude-sandbox, hosted-agent, opencode-sandbox, sandbox | fix(hosted-agent): pin an image by digest alone, not by tag AND digest |
| [40ba08d3b](https://github.com/endojs/endo-but-for-bots/commit/40ba08d3b82708ec7614295db2a8a3fcec363634) | R | codex-sandbox | fix(codex-sandbox): refuse an unpinned slice image at construction, not per session |
| [39fd686ab](https://github.com/endojs/endo-but-for-bots/commit/39fd686ab24b183eef59a9964a31bb086fbd5c4b) | R | codex-sandbox, sandbox | feat(codex-sandbox): the host-side pieces the Codex backend has been building in-process |
| [06f745f78](https://github.com/endojs/endo-but-for-bots/commit/06f745f7832d011dd021a67e7dedad1dc35cf774) | R | hosted-agent | feat(hosted-agent): a managed credential that can be renewed, not only read |
| [fb641a860](https://github.com/endojs/endo-but-for-bots/commit/fb641a860f3b746472f2439c0145a799d90e13a0) | R | codex-sandbox | feat(codex-sandbox)!: take the Codex backend off @agent and off a one-shot setup |
| [26287567a](https://github.com/endojs/endo-but-for-bots/commit/26287567a252750691b64bf73bd3b7b90ac689a3) | R | codex-sandbox | fix(codex-sandbox): a null scratch provider closes `make`, it does not forbid scratch |
| [4a4749a56](https://github.com/endojs/endo-but-for-bots/commit/4a4749a5618f538d353d0e2e2073de7a2aa8e4c3) | R | codex-sandbox | fix(codex-sandbox): a rerun must retain the backend, not mint a second listener |
| [ab9ae68be](https://github.com/endojs/endo-but-for-bots/commit/ab9ae68bea870c8264d1347ca6b742179b93ce0e) | R | floot | fix(floot): refuse to publish a workspace with no readable index |
| [0cca82bea](https://github.com/endojs/endo-but-for-bots/commit/0cca82bea5a60546d85950b176923a3750d24d53) | R | designs, sandbox | feat(sandbox)!: let a fixed role be capability-backed, and refuse nested mounts |
| [4c2283cb2](https://github.com/endojs/endo-but-for-bots/commit/4c2283cb2eb88146761db4ee5e5f02a06d84e9bd) | R | codex-sandbox, hosted-agent | refactor(hosted-agent): share the attested policy, parameterised by profile |
| [d418384af](https://github.com/endojs/endo-but-for-bots/commit/d418384afae489398ae02582cd7289c5b877d5f2) | R | claude-sandbox, hosted-agent, opencode-sandbox, yarn.lock | refactor(hosted-agent): share the workspace 9P projection |
| [380f4aacd](https://github.com/endojs/endo-but-for-bots/commit/380f4aacdc20252ae91e83086b337729d072eaca) | R | codex-sandbox, designs, sandbox | feat(codex-sandbox)!: the workspace is the session's tree, not a volume |
| [2beb482f2](https://github.com/endojs/endo-but-for-bots/commit/2beb482f2fb9ddb81f4758a81d4bde967214abbd) | D | designs | docs(design): record what step 4 of the slice convergence needs first |
| [9b01cce7d](https://github.com/endojs/endo-but-for-bots/commit/9b01cce7d06aa707d3d7bf7a422cb8f778884a01) | D | designs | docs(design): the step 4 blocker is MCP, not OpenCode's SQLite |
| [7d58738c1](https://github.com/endojs/endo-but-for-bots/commit/7d58738c11869f6a25e7366c2a06fb151196e263) | D | designs | docs(design): the provider sidecar holds no credential; recommend (2) |
| [744af5c3c](https://github.com/endojs/endo-but-for-bots/commit/744af5c3ce4d9df67db795835e5e3fb42800aa17) | D | designs | docs(design): the state row is a durability question, not a mount kind |
| [4a71b989c](https://github.com/endojs/endo-but-for-bots/commit/4a71b989c93c9b8e47f44a2378a3bd6322f21de3) | D | designs | docs(design): the stack already owns the transcript; adopt continuityContext |
| [d5c90d432](https://github.com/endojs/endo-but-for-bots/commit/d5c90d432b5968fa414b5eaebd4d2a7fc027be33) | D | designs | docs(design): restore the transcript natively, unbounded, without a preamble |
| [ec9bfbfa7](https://github.com/endojs/endo-but-for-bots/commit/ec9bfbfa7aa9e593d264eb5717a06999685156a3) | D | designs | docs(design): accept the Claude transcript-format coupling, with its obligation |
| [817c74bf0](https://github.com/endojs/endo-but-for-bots/commit/817c74bf078ae1124158ae357d0228553442455c) | D | designs | docs(design): OpenCode takes a remote MCP server; Claude's is unverified |
| [2fdc08230](https://github.com/endojs/endo-but-for-bots/commit/2fdc0823054ce05fe5e92fe2461112ed3e3234e0) | D | designs | docs(design): transcript restoration, the neutral record stream, order, tests |
| [c13ba0a7b](https://github.com/endojs/endo-but-for-bots/commit/c13ba0a7bbd173744283abda22d28d9994b831f9) | R | hosted-agent | feat(hosted-agent): the stack's own transcript record stream |
| [027e55ed4](https://github.com/endojs/endo-but-for-bots/commit/027e55ed4716b2a89889bc7cfd6763b0fbf16ad8) | R | floot | feat(floot): project the tree into the transcript record stream |
| [3e680010b](https://github.com/endojs/endo-but-for-bots/commit/3e680010b7a4f767855e87bbb9d9f80da4116fe9) | R | floot | feat(floot): record the backend's compaction boundary in the journal |
| [983685820](https://github.com/endojs/endo-but-for-bots/commit/98368582029f36a99750ebceb54334678c0291cd) | R | floot | feat(floot): hand hosted backends the conversation as transcript records |
| [111904231](https://github.com/endojs/endo-but-for-bots/commit/1119042310a2f5c946d0c8111d0659adac28b814) | D | designs | docs(design): the real transcript stores, observed on Tokyo |
| [a605ac441](https://github.com/endojs/endo-but-for-bots/commit/a605ac44168960751d455f63fe2f7207fc76f05d) | R | claude-sandbox | feat(claude-sandbox): write a transcript from the stack's records |
| [008febc3e](https://github.com/endojs/endo-but-for-bots/commit/008febc3ec8c1ae33f4a70e1d4451f2f3d0daca2) | R | claude-sandbox | feat(claude-sandbox): restore the conversation when the store is empty |
| [09cf0fc78](https://github.com/endojs/endo-but-for-bots/commit/09cf0fc782519c5f871c867c57c0c24cecf2c956) | R | codex-sandbox | feat(codex-sandbox)!: no preamble, no arbitrary bound on restoration |
| [ed152dce4](https://github.com/endojs/endo-but-for-bots/commit/ed152dce4cd5f2dd1ab6c32047d034abe9b41751) | R | claude-sandbox, hosted-agent | test(hosted-agent): shared restoration conformance, run against Claude |
| [53956f4a2](https://github.com/endojs/endo-but-for-bots/commit/53956f4a2fed5280533bc15234eddca728945872) | D | designs | docs(design): MCP on loopback needs the listener image, not just a port |
| [b1de53d27](https://github.com/endojs/endo-but-for-bots/commit/b1de53d2775c2798a9f0d990cc15b4a5298abe9c) | R | codex-sandbox, sandbox | feat(sandbox)!: attest a host bind as a host bind |
| [421d1231c](https://github.com/endojs/endo-but-for-bots/commit/421d1231cc4f37df4d895d67b569b0543ba28400) | R | claude-sandbox, hosted-agent, opencode-sandbox | feat(claude,opencode): declare the hosted mount profiles |
| [40a10848c](https://github.com/endojs/endo-but-for-bots/commit/40a10848c5dcddd6213c3a3c76fda1c770d90d87) | D | designs | docs(design): record the slice convergence as landed but for the controllers |
| [ec032d33c](https://github.com/endojs/endo-but-for-bots/commit/ec032d33ca62d97cf5b6df99beef65ca477f0a5d) | R | sandbox | feat(sandbox): offer the attested path on a native scope |
| [33ff95844](https://github.com/endojs/endo-but-for-bots/commit/33ff9584441284b07517721727c88b48040c830f) | R | codex-sandbox, hosted-agent | feat(hosted-agent): share the slice resource profile and its ceiling |
| [55e6bca73](https://github.com/endojs/endo-but-for-bots/commit/55e6bca73454fa9689901440ba9a6d9d77dabc5c) | R | claude-sandbox | feat(claude-sandbox)!: run the slice under the attested policy |
| [de8ad3a72](https://github.com/endojs/endo-but-for-bots/commit/de8ad3a72665b905a7d1647b41212d70d041a286) | R | opencode-sandbox | feat(opencode-sandbox)!: run the slice under the attested policy |
| [22ed11e77](https://github.com/endojs/endo-but-for-bots/commit/22ed11e7770da880c244214ce16198e0751a5da5) | T | designs, sandbox | docs(design): the slice-mount convergence is landed |
| [044cae987](https://github.com/endojs/endo-but-for-bots/commit/044cae98751cddcbe823102e7a9ec81764f36b5d) | D | designs | docs(design): the rule that decides which stores the stack may write |
| [138ae76fc](https://github.com/endojs/endo-but-for-bots/commit/138ae76fc06a47c210cd732b9d50313bf603570d) | D | designs | docs(design): OpenCode's import must emit events, not rows |
| [4d07c1072](https://github.com/endojs/endo-but-for-bots/commit/4d07c1072c31ca6bbd1e061f5e3b6eb1a9fd6a02) | R | claude-sandbox, hosted-agent, opencode-sandbox | feat(claude,opencode): check the attested slice at the authority handoff |
| [b718f30c9](https://github.com/endojs/endo-but-for-bots/commit/b718f30c91f6a7f98341a506fd30216b067effed) | D | designs | docs(design): Claude's HTTP MCP support verified on the pinned image |
| [7b57fce58](https://github.com/endojs/endo-but-for-bots/commit/7b57fce583755b19f297027ce58b09aebc788db5) | D | designs | docs(design): why OpenCode's import is opencode's design question |
| [3fb9c4252](https://github.com/endojs/endo-but-for-bots/commit/3fb9c425200c96630dcf8a96bb2f92ec5a7ab1b8) | R | codex-sandbox, hosted-agent, opencode-sandbox | feat(opencode-sandbox): restore the stack's record when a session has none |
| [f7460e4dc](https://github.com/endojs/endo-but-for-bots/commit/f7460e4dcd9734c578e7a2120b7367f49919a0da) | D | designs | docs(design): step 5 lands in its lesser form |
| [9d3bd7b0e](https://github.com/endojs/endo-but-for-bots/commit/9d3bd7b0e8fa3e9bd052dbd2d73ed8dde3491bc2) | R | opencode-sandbox | feat(opencode-sandbox): the session history import, as a build-applied patch |
| [28090b4b5](https://github.com/endojs/endo-but-for-bots/commit/28090b4b5d2ba8277d9837e731c4ed34aea5ec73) | R | opencode-sandbox | feat(opencode-sandbox): restore through the import route, falling back to text |
| [273f3a618](https://github.com/endojs/endo-but-for-bots/commit/273f3a6181fe1988498aa3149d621ae16f391b68) | R | opencode-sandbox | feat(opencode-sandbox)!: no durable store; the stack holds the conversation |
| [2bbfe36eb](https://github.com/endojs/endo-but-for-bots/commit/2bbfe36eb79ba9a073576bf066d8a8cf8f515fe5) | D | designs | docs(design): step 5 closed for OpenCode, open for Codex as a decision |
| [362011c3f](https://github.com/endojs/endo-but-for-bots/commit/362011c3f5d9851cb487022d9cd438aca8ed6ebe) | R | codex-sandbox, hosted-agent | feat(codex-sandbox): restore the thread through inject_items |
| [d3b8d4cc4](https://github.com/endojs/endo-but-for-bots/commit/d3b8d4cc4a5bae9892164af9c676369d669a13b8) | D | designs | docs(design): correct the Codex entries; all three restore faithfully |
| [0cc91ef2b](https://github.com/endojs/endo-but-for-bots/commit/0cc91ef2b0e855837d858d4252ad54a6f5e31ce7) | R | codex-sandbox, sandbox | fix(sandbox): an adapter granting no host scratch still needs a provider |
| [dc8f883e1](https://github.com/endojs/endo-but-for-bots/commit/dc8f883e1c187e57a7c46d7fe7e8589a14384012) | R | sandbox | fix(sandbox): the attestation must admit the bind kind it now declares |
| [96c919615](https://github.com/endojs/endo-but-for-bots/commit/96c9196151bd22ecdd15e2857a5ce66051f2802b) | R | sandbox | fix(sandbox)!: map the daemon onto the uid the policy declares |
| [c34d62bcd](https://github.com/endojs/endo-but-for-bots/commit/c34d62bcd039fc1d772afba2ff1b535c04c5aa64) | D | designs | docs(design): what the deploy found, and the trade keep-id records |
| [006db33aa](https://github.com/endojs/endo-but-for-bots/commit/006db33aa3f84d872cf9e24416551d3b22b48d84) | R | codex-sandbox, opencode-sandbox | fix(codex,opencode): a session must survive the incarnation that made it |
| [0ff5c7e9f](https://github.com/endojs/endo-but-for-bots/commit/0ff5c7e9f586a510e3e82f6f1f0fc362f139f3b2) | R | floot, opencode-sandbox | feat(floot,opencode): make the handed-over transcript observable |
| [35af362bb](https://github.com/endojs/endo-but-for-bots/commit/35af362bbd52e866765d3cdc36c571684e1a3014) | R | codex-sandbox, floot | fix(floot)!: the replay limit refused a conversation for being long |
| [0f9121909](https://github.com/endojs/endo-but-for-bots/commit/0f9121909400f8d914c8e5fcc34a735e4d2b63c7) | R | claude-sandbox, opencode-sandbox | fix(claude,opencode)!: the backend dropped the transcript before the client |
| [f0cc1d541](https://github.com/endojs/endo-but-for-bots/commit/f0cc1d541cc5ff57465e3318f7e110ed3d83893f) | D | designs | docs(design): the restore that was really a store, and what the deploy found |
| [5edcf9eb3](https://github.com/endojs/endo-but-for-bots/commit/5edcf9eb3d7102bd2688f77bb8ebf648e739c0de) | R | claude-sandbox | fix(claude-sandbox): the restored conversation file held the session plan |
| [afb0fc307](https://github.com/endojs/endo-but-for-bots/commit/afb0fc307882506173cb825ebdbed64be5d1f48f) | R | opencode-sandbox | feat(opencode-sandbox): the bridge names what it understands |
| [01c677576](https://github.com/endojs/endo-but-for-bots/commit/01c677576fd74f990bb4a079194ac2bfc62ce01e) | R | codex-sandbox | fix(codex-sandbox): recover a dead incarnation's lease on both paths |
| [6bd4882da](https://github.com/endojs/endo-but-for-bots/commit/6bd4882da2aa4048f4f61efb5a7f2b2e3e59914c) | D | designs | docs(design): the seven the deploy found, and the case that proves it |
| [d2e9b314a](https://github.com/endojs/endo-but-for-bots/commit/d2e9b314a0693fc45d821b6cd17521cb68192678) | D | designs | docs(design): Codex cannot reopen a session, and it is not the lease fix |
| [cb0cb6ddd](https://github.com/endojs/endo-but-for-bots/commit/cb0cb6ddd56daf83c8b9f9c5d0ee99fe80b9ffb3) | R | codex-sandbox | fix(codex-sandbox): the lease holder can reopen the workspace it holds |
| [796e849dd](https://github.com/endojs/endo-but-for-bots/commit/796e849ddfae2128dc56c39291e007eb8a978909) | D | designs | docs(design): three wrong explanations for the Codex lease, recorded |
| [db681499c](https://github.com/endojs/endo-but-for-bots/commit/db681499c081a8122224c261081dbc0d025fff2b) | D | designs | docs(design): Codex's store is a rollout file and the index is derived |
| [e52376f06](https://github.com/endojs/endo-but-for-bots/commit/e52376f0631af565793373248049c02f2beafe58) | D | designs | docs(design): correct the rollout comparison — no thread is ever live |
| [a55175d78](https://github.com/endojs/endo-but-for-bots/commit/a55175d784a273f16791da9ea5fb492f5f7562f1) | R | codex-sandbox, opencode-sandbox | fix(codex,opencode)!: restoration is faithful or it fails |
| [3e130f7c0](https://github.com/endojs/endo-but-for-bots/commit/3e130f7c0bb49dc80c6f3c79941ba7d672d1665d) | R | claude-sandbox | fix(claude-sandbox)!: a surviving store does not decide the conversation |
| [8d915852f](https://github.com/endojs/endo-but-for-bots/commit/8d915852fbfbcfef6e064d739ebb13671b39f2d2) | D | designs | docs(design): vendor Paseo's report, and compare the opposite bet |
| [b2a318a6b](https://github.com/endojs/endo-but-for-bots/commit/b2a318a6bedd78a256dead5e6e33a01008a7e7bf) | D | designs | docs(design): the plan, ordered by what is broken |
| [53ad6e03e](https://github.com/endojs/endo-but-for-bots/commit/53ad6e03edf20d120ffbb2ef96436adb879c00ae) | R | designs, opencode-sandbox | build(opencode-sandbox)!: the fork carries the change, not a patch file |
| [99fbe43ea](https://github.com/endojs/endo-but-for-bots/commit/99fbe43ea41483d5f70b1a8b928f6306510135d8) | D | designs | docs(design): the image pin is read once and then never again |
| [3e918d889](https://github.com/endojs/endo-but-for-bots/commit/3e918d88916c665631888d555b991faa99f2e250) | R | opencode-sandbox | fix(opencode-sandbox): the import route takes ModelV2.Ref, not a flat id |
| [5c5e2d643](https://github.com/endojs/endo-but-for-bots/commit/5c5e2d643bc7fc2f00e8e81c1ca92f711356f45f) | D | designs | docs(design): the OpenCode import route does not work |
| [517c0c5a7](https://github.com/endojs/endo-but-for-bots/commit/517c0c5a71a63cfa77fd94a33c7fc7fa47b2eed0) | D | designs | docs(design): spike — the import mechanism works, the patch does not |
| [a4297d12f](https://github.com/endojs/endo-but-for-bots/commit/a4297d12fd4ed460eecbe1f0a9990d007f3dc6b5) | D | designs | docs(design): the import writes to a store the prompt never reads |
| [8744ac672](https://github.com/endojs/endo-but-for-bots/commit/8744ac672e1d5093b44db2b225e735b06670e2de) | D | designs | docs(design): OpenCode restores — verified on the deployment |
| [63d629461](https://github.com/endojs/endo-but-for-bots/commit/63d6294613dc9fa113bfddc4986736ae1fc709df) | D | designs | docs: restore the sentence the rebase resolution truncated |
| [86b9f7771](https://github.com/endojs/endo-but-for-bots/commit/86b9f7771dd3fe97003bf60ef7e416b18ae22224) | R | hosted-agent | chore(hosted-agent): regenerate the composite tsconfig |
| [dc6e8bcc1](https://github.com/endojs/endo-but-for-bots/commit/dc6e8bcc1f52959f36f0b06115d3da794877956a) | R | codex-sandbox | fix(codex-sandbox): the lease refusal says which lease and whose |
| [470c45b97](https://github.com/endojs/endo-but-for-bots/commit/470c45b9711b68c327961395a29fb31495914b78) | R | claude-sandbox, codex-sandbox, floot | fix(codex-sandbox): use the refusal the app-server gave |
| [399ffa797](https://github.com/endojs/endo-but-for-bots/commit/399ffa797f0750d36fdcc66cb5fb71e8758d3a9d) | D | designs | docs(design): the Codex lease, and the plan the reviews ask for |
| [c966c4866](https://github.com/endojs/endo-but-for-bots/commit/c966c486641521e0f0cc94a3f7336ccfd1bface1) | D | designs | docs(design): the OpenCode grant leak is step 0, not a supervisor step |
| [5350fa11c](https://github.com/endojs/endo-but-for-bots/commit/5350fa11c2aebdf0be14f65cd78fa372e0769484) | T | designs, opencode-sandbox | test(opencode-sandbox): pin that terminate revokes the grant, exactly once |
| [1e163d953](https://github.com/endojs/endo-but-for-bots/commit/1e163d953e55d513f94ab8668d8089a324ce8406) | D | designs | docs(design): state which phase gates are open, and what closes them |
| [806b80840](https://github.com/endojs/endo-but-for-bots/commit/806b80840992479f8b5b594d0003ac6bcd6d7c02) | R | claude-sandbox | fix(claude-sandbox): the surviving store no longer decides the conversation |
| [ae1b81298](https://github.com/endojs/endo-but-for-bots/commit/ae1b812988778f4ccde6acc8dfe3664cdff50db4) | R | codex-sandbox | fix(codex-sandbox): a thread inherited across incarnations is superseded |
| [6b4983932](https://github.com/endojs/endo-but-for-bots/commit/6b4983932ad144cd33e1a447a2e06213b648473a) | D | designs | docs(design): step 1 is two parts done and one to deploy |
| [0428e75ff](https://github.com/endojs/endo-but-for-bots/commit/0428e75ff2f1d755027b6349623bcb55a7aaaf32) | R | scripts | fix(ci): give an oversized package its own eslint process |
| [87c0150c1](https://github.com/endojs/endo-but-for-bots/commit/87c0150c1bc5607b935df6d4ebf9d34279ece541) | R | claude-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): share native session supervision |
| [fa1d91ac6](https://github.com/endojs/endo-but-for-bots/commit/fa1d91ac67ef164f87777e8776f8713f1c0be3be) | R | claude-sandbox, designs, hosted-agent, opencode-sandbox | fix(hosted-agent): fence grants before ordered namespace cleanup |
| [343990b29](https://github.com/endojs/endo-but-for-bots/commit/343990b296245d153615e18bae90f4f735433dcc) | R | daemon, designs, hosted-agent | feat(hosted-agent): forward native session checkpoint operations |
| [0c047c73f](https://github.com/endojs/endo-but-for-bots/commit/0c047c73f768b239148bac3e418d75394c937a8f) | R | codex-sandbox, daemon | fix(daemon,codex-sandbox): two type errors the parsing failures were hiding |
| [812f10b47](https://github.com/endojs/endo-but-for-bots/commit/812f10b47b35aa1aa4ab2d11979df9b2845af18b) | R | codex-sandbox, hosted-agent | refactor(codex): use shared session ownership and directory storage |
| [1cf9ae7ff](https://github.com/endojs/endo-but-for-bots/commit/1cf9ae7ff680d69f34506e696842d6180ee4cc10) | R | yarn.lock | chore: Update yarn.lock |
| [b9bd65509](https://github.com/endojs/endo-but-for-bots/commit/b9bd655094e8b698d0937020a8ab8544b8235033) | R | codex-sandbox, hosted-agent | refactor(hosted-agent): isolate Codex subscription translation |
| [d7518cb41](https://github.com/endojs/endo-but-for-bots/commit/d7518cb4159eebe3cb9abf14da60678359641189) | R | codex-sandbox | fix(codex): resolve empty Floot thinking selection to model default |
| [efa589d27](https://github.com/endojs/endo-but-for-bots/commit/efa589d27795fa4101d246efdb84b4e7fbf2ff53) | R | 9p-server | fix(9p-server): bound Unix socket paths before native acquisition |
| [59226eb58](https://github.com/endojs/endo-but-for-bots/commit/59226eb58a9c3786a39089bc8d53b6d087970ec5) | R | codex-sandbox | fix(codex): use policy-compatible reserved CLI state directory |
| [4aec7f1de](https://github.com/endojs/endo-but-for-bots/commit/4aec7f1de68096e693cabde8ab5a33a75b77ec2d) | D | designs | docs(hosted-agent): record Codex shared lifecycle acceptance |
| [c8ff7b57e](https://github.com/endojs/endo-but-for-bots/commit/c8ff7b57ed3e745e6b1fa6e388baefa7de681f8a) | R | claude-sandbox, hosted-agent, opencode-sandbox | refactor(hosted-agent): share rootfs parsing across adapters |
| [f388c66b6](https://github.com/endojs/endo-but-for-bots/commit/f388c66b6ab35f7360455082a01f8150b9dabf5f) | R | claude-sandbox, codex-sandbox, daemon, floot, hosted-agent, opencode-sandbox | feat(hosted-agent): stop sessions by identity without deleting state |
| [369664476](https://github.com/endojs/endo-but-for-bots/commit/369664476b5e7b3cf2c81bd979ab728cc66e24bd) | R | chat, floot, space-floot | feat(floot): add durable operator emergency stop and explicit resume |
| [cd589619e](https://github.com/endojs/endo-but-for-bots/commit/cd589619eaef7bcac45c151c6c46bb07bdfd137e) | R | floot | refactor(floot): avoid copying journal history on every event |
| [11bfb2feb](https://github.com/endojs/endo-but-for-bots/commit/11bfb2feb1d4c013b61a812d0bec966f5d42f5d7) | R | chat, floot, space-floot | fix(floot): preserve uncertainty without blocking unrelated work |
| [50d036bc7](https://github.com/endojs/endo-but-for-bots/commit/50d036bc7dbf3cea072ff587229141e66e3ed5dd) | R | claude-sandbox, codex-sandbox, exo-stream, floot, opencode-sandbox | refactor(hosted-agent): bound push event queues with consumer credit |
| [68c2f80f3](https://github.com/endojs/endo-but-for-bots/commit/68c2f80f37f1db50fc77e2bd47fecc5863c5a44b) | R | exo-stream | fix(exo-stream): type the bounded reader's iterator and syn argument |
| [96d908978](https://github.com/endojs/endo-but-for-bots/commit/96d9089783798617362d84b5b2e7482dfc09d5d9) | D | designs | docs: record sandbox unification UA deployment and remaining work |
| [4564a7d0f](https://github.com/endojs/endo-but-for-bots/commit/4564a7d0f40d543e0ac2a7bd72e696ff1bb934b2) | T | floot, hosted-agent | fix(floot,hosted-agent): type three test helpers the root program rejects |
| [d8f6fbe08](https://github.com/endojs/endo-but-for-bots/commit/d8f6fbe0884144d7d146a895b4a218cf24d14f2b) | T | exo-stream | style(exo-stream): use a numeric separator in the bounded-channel test timeout |
| [2223be7e0](https://github.com/endojs/endo-but-for-bots/commit/2223be7e042f5fa27aa15016b58a9dff1fb6f8a7) | R | chat, floot, lal, space-floot | feat(floot): select backend before model and offer free OpenRouter models |
| [959059d38](https://github.com/endojs/endo-but-for-bots/commit/959059d386d7381f71ed88c99ce49394a524c736) | R | chat, floot, space-floot | feat(floot): name the Endo-confined direct backend Fae |
| [9b299c6cc](https://github.com/endojs/endo-but-for-bots/commit/9b299c6cce99871bf7fc2646961aab67095c59e1) | R | claude-sandbox, designs, hosted-agent, opencode-sandbox | fix(hosted-agent): refuse a retained broker whose image pins changed |
| [009a4a9c7](https://github.com/endojs/endo-but-for-bots/commit/009a4a9c72c257a294de310403de0e9185daf659) | R | codex-sandbox, designs, hosted-agent, opencode-sandbox | test(hosted-agent): every adapter passes the shared restoration conformance |
| [1a92d6a57](https://github.com/endojs/endo-but-for-bots/commit/1a92d6a57e9b28607a3650f1d295acd81b23bd19) | R | claude-sandbox, codex-sandbox, designs, hosted-agent, opencode-sandbox | fix(hosted-agent): the policy anchor ends on SIGTERM, so the daemon stops in seconds |
| [33636a05f](https://github.com/endojs/endo-but-for-bots/commit/33636a05fbc1f8478caede3fea2eb3d8bf0947d4) | R | chat, floot, space-floot | feat(floot): the turn journal has no lifetime ceiling |
| [f5ddfadfd](https://github.com/endojs/endo-but-for-bots/commit/f5ddfadfd17620eacce2f095a7ff07c49331671a) | R | codex-sandbox, floot, opencode-sandbox | refactor(floot,codex,opencode): per-turn ceilings move to where the state is retained |
| [2cb4abe15](https://github.com/endojs/endo-but-for-bots/commit/2cb4abe1578a2b8dc84e8faba4b12704d7cb8ee4) | R | codex-sandbox | fix(codex-sandbox): the audit journal has no lifetime ceiling |
| [c21316ce2](https://github.com/endojs/endo-but-for-bots/commit/c21316ce203e093acb0d4504be2e427aa7c899df) | R | floot | fix(floot): the turn journal never removes what the conversation wrote |
| [5691554a5](https://github.com/endojs/endo-but-for-bots/commit/5691554a5de81ef1965850d1eb1cdc00a2d40cec) | R | codex-sandbox | fix(codex-sandbox): no call count, wall clock or tool timeout ends a turn by default |
| [d4cf3ebed](https://github.com/endojs/endo-but-for-bots/commit/d4cf3ebed4ddfca0cca91208b13b87aed261bb70) | R | opencode-sandbox | fix(opencode-sandbox): no wall clock ends a turn by default |
| [2dc7c4f4d](https://github.com/endojs/endo-but-for-bots/commit/2dc7c4f4dd333a5e94558496ba0b578ac80292d7) | D | designs | docs(design): record the Phase 4 journal and ceiling work |
| [7f8eee056](https://github.com/endojs/endo-but-for-bots/commit/7f8eee056f90c36b4be006a3216c55bccf94f721) | R | claude-sandbox, codex-sandbox, designs, hosted-agent, opencode-sandbox | refactor(hosted-agent): one current-specifier module, imported where it is used |
| [24eecb8fe](https://github.com/endojs/endo-but-for-bots/commit/24eecb8fe936b6ae8594b437d2060388f996574d) | R | floot, hosted-agent | refactor(floot): delete the direct Claude path and the text-form continuity |
| [71ca2040e](https://github.com/endojs/endo-but-for-bots/commit/71ca2040eb1a6c45310db1ec58b6285bbf1a74f8) | R | claude-sandbox, codex-sandbox, designs, floot, hosted-agent, opencode-sandbox, yarn.lock | refactor(hosted-agent,floot): one turn channel and one journaled tool dispatch |
| [2e03b3181](https://github.com/endojs/endo-but-for-bots/commit/2e03b3181b9204a64d57eb541997aa3f246d64c0) | D | claude-sandbox, codex-sandbox, designs, floot, hosted-agent, opencode-sandbox | docs: one set of guarantees across the hosted sandbox packages |
| [4f7e72b09](https://github.com/endojs/endo-but-for-bots/commit/4f7e72b0906070261211149743c51b6d655b5fb4) | D | designs | docs(design): Phase 5 status and the deleted-code list |
| [96b32da43](https://github.com/endojs/endo-but-for-bots/commit/96b32da43095082825e6e846971f60d5fd4ea75a) | R | designs, floot, hosted-agent | fix(hosted-agent,floot): no lifetime ceilings on the policy audit or listener diagnostics |
| [94e9b9d3b](https://github.com/endojs/endo-but-for-bots/commit/94e9b9d3b11d0a5b1415e95d86b45cbcc94bf090) | D | designs | docs(design): what each still-open item would take |
| [ab98a601a](https://github.com/endojs/endo-but-for-bots/commit/ab98a601ab0f34fd2ae35c2f387fb77008bd768b) | R | claude-sandbox, codex-sandbox, designs, hosted-agent, opencode-sandbox, sandbox | fix(sandbox,hosted-agent): podman keeps no journal copy of container stdio |
| [676bc8341](https://github.com/endojs/endo-but-for-bots/commit/676bc83418e80ee3cce3e328812fdc0699351830) | R | claude-sandbox, designs, hosted-agent, opencode-sandbox | fix(hosted-agent): broker and listener failures are always logged |
| [f8a6a63f1](https://github.com/endojs/endo-but-for-bots/commit/f8a6a63f19e8cd86ae058da9e355a83bc0cbfb61) | R | daemon, endo-fs-asset-server, floot, yarn.lock | feat(endo-fs-asset-server): the server is the retention root for what it serves |
| [7aca1679b](https://github.com/endojs/endo-but-for-bots/commit/7aca1679bf8eb8cac237c86968ee5a7d2e32365e) | R | daemon, endo-fs-asset-server, floot | fix(endo-fs-asset-server,daemon,floot): what three adversarial reviews found |
| [895330583](https://github.com/endojs/endo-but-for-bots/commit/89533058358a6bec3f409412655c8ffda9453323) | R | endo-fs-asset-server, floot | fix(endo-fs-asset-server,floot): second review round — a probe that reaches the target |
| [c5114d931](https://github.com/endojs/endo-but-for-bots/commit/c5114d931fe073b35ed3225bb04fe5abec6b58f8) | R | space-floot | fix(space-floot): the status circle is always a circle, in one of three states |
| [c72b2b84f](https://github.com/endojs/endo-but-for-bots/commit/c72b2b84f70781e1366f2c084af12ee22f929a68) | R | chat, space-floot | feat(space-floot,chat): a session's row says what backend and model it runs |
| [f5cc639bc](https://github.com/endojs/endo-but-for-bots/commit/f5cc639bc43a5537afec2a158a16c16cff8779d1) | R | exo-stream | fix(exo-stream): a buffered reader lets go of what it has delivered |
| [4b0dda7e4](https://github.com/endojs/endo-but-for-bots/commit/4b0dda7e4bcc885aff0e37b2400386a8a6a13481) | R | floot | feat(floot): a session and the session list can be subscribed to |
| [0678ba96c](https://github.com/endojs/endo-but-for-bots/commit/0678ba96cbae72a2a2c62b8562b251cd71a45109) | R | floot | feat(floot): messages waiting their turn are the daemon's, and durable |
| [5b396fbf3](https://github.com/endojs/endo-but-for-bots/commit/5b396fbf3c13e6c2e6ab8ad70eb8afd678f28f2c) | T | floot | style(floot): prettier on publish-tool.test.js |
| [0eacf6ece](https://github.com/endojs/endo-but-for-bots/commit/0eacf6ecedbbbee891974a7772678a096300279f) | R | chat, space-floot, yarn.lock | feat(chat,space-floot): the Floot space subscribes to the daemon instead of driving it |
| [08b24dc92](https://github.com/endojs/endo-but-for-bots/commit/08b24dc92d2473805c76d405405c52dea85f0f4c) | R | hosted-agent | feat(hosted-agent): a backend may say what a system prompt must know about it |
| [9d88508f6](https://github.com/endojs/endo-but-for-bots/commit/9d88508f6c208e600832229b29dfd9470a4fa789) | R | chat | feat(chat): the Floot space says its sessions are spoken |
| [ae963f0b8](https://github.com/endojs/endo-but-for-bots/commit/ae963f0b8600c2adba9586668cb4b3b8ab91b5a6) | R | floot | feat(floot): system prompts are composed from a standard base |
| [b12bc4f76](https://github.com/endojs/endo-but-for-bots/commit/b12bc4f766416d4216172b31ecd562da613547f6) | R | claude-sandbox, codex-sandbox, opencode-sandbox | feat(claude-sandbox,codex-sandbox,opencode-sandbox): declare the prompt environment |
| [32c7e978c](https://github.com/endojs/endo-but-for-bots/commit/32c7e978c17eb0fdcc6f6118144f54b0e9b6b483) | R | lal | fix(lal): an OpenRouter request that delivered nothing is asked again, and says why it failed |
| [3bbac1299](https://github.com/endojs/endo-but-for-bots/commit/3bbac129968568f991a73895ec80b49da782d252) | R | fae | fix(fae): exec says what is not there, and explains a parse failure by its cause |
| [c99233905](https://github.com/endojs/endo-but-for-bots/commit/c9923390512d3e6d6c3811a096ced390ef751fef) | R | chat, floot | fix(floot): each tool call is shown once; failed turns are logged, attributed and counted |
| [dce9bae6c](https://github.com/endojs/endo-but-for-bots/commit/dce9bae6cfce09b6fa7b5ea9319d0d2bf5d73260) | D | designs | docs(design): hosted agent subscriptions — status, pools, draining, delegated shares |
| [1a50cda5e](https://github.com/endojs/endo-but-for-bots/commit/1a50cda5ea53b2ea52c8710d458deb2573a4123b) | R | hosted-agent | feat(hosted-agent): token usage in five disjoint counts, and a context reading |
| [89f0ea0fd](https://github.com/endojs/endo-but-for-bots/commit/89f0ea0fdc0b2c1439eb6cc7bddaebdd6f84df54) | R | claude-sandbox, codex-sandbox, opencode-sandbox | fix(claude/codex/opencode-sandbox): usage counts the cache, and says how full the window is |
| [19caea9f7](https://github.com/endojs/endo-but-for-bots/commit/19caea9f71a2fd923dcf9a6319981cfef7d0a0d5) | R | lal | feat(lal): OpenRouter and Anthropic report disjoint usage and the last request |
| [d8e6b2727](https://github.com/endojs/endo-but-for-bots/commit/d8e6b2727aae789b6081aa87f632062b978f1341) | R | chat, floot, space-floot | feat(floot): a session knows how full its window is, and counts cached tokens |
| [2e7df2a79](https://github.com/endojs/endo-but-for-bots/commit/2e7df2a794e63ee23c2a702cf4cfb7a72812c04c) | D | designs | docs(design): subscriptions phase 1 status, and where it differs from the design |
| [c8a2defa9](https://github.com/endojs/endo-but-for-bots/commit/c8a2defa90d718f4ebe090dedb16af2624ce5017) | R | hosted-agent | feat(hosted-agent): a broker reads the account's rate-limit headers, and an oracle publishes them |
| [8411a63f0](https://github.com/endojs/endo-but-for-bots/commit/8411a63f0adc69c86d9f05bf99f912f1a23cc39c) | R | claude-sandbox, codex-sandbox, opencode-sandbox | feat(claude/codex/opencode-sandbox): each subscription gets an account oracle |
| [c3f4170cd](https://github.com/endojs/endo-but-for-bots/commit/c3f4170cd40fb61b36893cd62c7932f3a15e3e57) | R | chat, floot, space-floot | feat(floot): views subscribe to what each backend's account has left |
| [af64260ef](https://github.com/endojs/endo-but-for-bots/commit/af64260efe46a25bfb339c0817e7620c898ceaa8) | D | designs | docs(design): subscriptions phases 2 and 3 status, and where they differ |
| [2f0e05b47](https://github.com/endojs/endo-but-for-bots/commit/2f0e05b4718d90ec4f01cd33790cb0f694bbe081) | R | hosted-agent | feat(hosted-agent): the provider response as a bytes exo-stream, read ahead of |
| [3afce0f9d](https://github.com/endojs/endo-but-for-bots/commit/3afce0f9d33938fa153af2ac41a0adaec997c0a5) | D | designs | docs(design): subscriptions phase 4 status, and why the producer cannot cap read-ahead |
| [662c11748](https://github.com/endojs/endo-but-for-bots/commit/662c11748d176e131e7faa0d347c42d446070f45) | T | hosted-agent | test(hosted-agent): drain the bytes stream without an unused binding |
| [8be6fa8ff](https://github.com/endojs/endo-but-for-bots/commit/8be6fa8ff41c25eea05641e4daa8daddf0e40b81) | R | designs, hosted-agent | feat(hosted-agent): several subscriptions behind one broker, drained soonest to expire, with handover |
| [3677d6272](https://github.com/endojs/endo-but-for-bots/commit/3677d62723e980273f7f362e85162d42297b4557) | R | hosted-agent | feat(hosted-agent): a broker service over a namespace of subscriptions, and an oracle for each |
| [31fece7e3](https://github.com/endojs/endo-but-for-bots/commit/31fece7e390821762e2b7ea4f866339bee126161) | R | codex-sandbox | feat(codex-sandbox): one backend over several ChatGPT subscriptions |
| [a38331865](https://github.com/endojs/endo-but-for-bots/commit/a383318652e6cff3b6c155a32eb1eff28a5d39c4) | R | chat, floot, space-floot | feat(floot): a session may be pinned to one of its backend's subscriptions |
| [81369fa47](https://github.com/endojs/endo-but-for-bots/commit/81369fa473344e222ef0c3343fd714dc895f7b94) | D | designs | docs(design): subscriptions phases 5 and 6 for Codex, and where they differ |
| [6f60fb327](https://github.com/endojs/endo-but-for-bots/commit/6f60fb3270f320132398dfc010855bb60ccedee2) | R | hosted-agent | feat(hosted-agent): redeem a banked rate-limit reset, with the key stored first |
| [accd3486c](https://github.com/endojs/endo-but-for-bots/commit/accd3486c09127ff2925cb377755bced7b18870e) | R | codex-sandbox | feat(codex-sandbox): the call that redeems a ChatGPT rate-limit reset |
| [67dd237ea](https://github.com/endojs/endo-but-for-bots/commit/67dd237ea455f32ff1c9eb52f15ab7063de418b7) | R | chat, floot, space-floot | feat(floot): a person can redeem a banked reset from the Subscriptions panel |
| [8ed4c927a](https://github.com/endojs/endo-but-for-bots/commit/8ed4c927a7f13af45e30ef91fc28f2eea256b009) | D | designs | docs(design): subscriptions phase 7, and where it differs |
| [05e2de89a](https://github.com/endojs/endo-but-for-bots/commit/05e2de89aecc3ba268630015b58a45cdfc872f0a) | R | hosted-agent | feat(hosted-agent): read what a response cost from the provider's own stream |
| [7cad94ba3](https://github.com/endojs/endo-but-for-bots/commit/7cad94ba35651178f60308aba392469638b11017) | R | hosted-agent | feat(hosted-agent): the broker as a Subscription, and usage settled per request |
| [1c15b9dfb](https://github.com/endojs/endo-but-for-bots/commit/1c15b9dfbbe7dfa605da072709aca609686621d3) | R | hosted-agent | feat(hosted-agent): shares, a subscription within limits its grantor chose |
| [27775d408](https://github.com/endojs/endo-but-for-bots/commit/27775d4086cbcf1e4195813b48a417d5ccdb2271) | R | hosted-agent | feat(hosted-agent): provision shares, and hold somebody else's in a pool |
| [4ca749392](https://github.com/endojs/endo-but-for-bots/commit/4ca74939210ee5733c2bca1bd9d26d07a94205d7) | R | claude-sandbox, codex-sandbox, opencode-sandbox | feat(sandboxes): publish each broker as a Subscription; Codex may hold a share |
| [9c3f22a85](https://github.com/endojs/endo-but-for-bots/commit/9c3f22a8545083957dea6dcae06e3d30c2272a8d) | D | designs | docs(design): subscriptions phase 8, and where it differs |
| [b844ff373](https://github.com/endojs/endo-but-for-bots/commit/b844ff373702772b291e246710abf44bc0ca9677) | R | hosted-agent | feat(hosted-agent): lanes set aside in a pool, and status that does not echo |
| [ddd16b14f](https://github.com/endojs/endo-but-for-bots/commit/ddd16b14fa4c6bc92f5988c8848b753c27e95eaf) | R | hosted-agent | feat(hosted-agent): a delegated runner, a backend within its operator's limits |
| [4d3da91e0](https://github.com/endojs/endo-but-for-bots/commit/4d3da91e0041a5f9a726603c93f2825bd2a919ae) | R | codex-sandbox, space-floot | feat(codex-sandbox): lanes and delegated runners in the Codex setup |
| [12c637a73](https://github.com/endojs/endo-but-for-bots/commit/12c637a73bfa4109cab4f0247e10de2957e67795) | D | designs | docs(design): subscriptions phase 9, in part, and what is not built |
| [58818cd57](https://github.com/endojs/endo-but-for-bots/commit/58818cd57d9b5d871df4d889f1d8f11da30c8979) | R | claude-sandbox, designs | feat(claude-sandbox): pool hosted subscription credentials |
| [53eff5867](https://github.com/endojs/endo-but-for-bots/commit/53eff5867398742190c753f47c27fe6fa3cd72b6) | R | hosted-agent | feat(hosted-agent): keep renewable OAuth access tokens in memory |
| [3ed6cb98a](https://github.com/endojs/endo-but-for-bots/commit/3ed6cb98afe5949cc1525acda8f07f6ac1da9a36) | R | claude-sandbox, designs | feat(claude-sandbox): renew subscription logins and read usage |
| [00799f3f5](https://github.com/endojs/endo-but-for-bots/commit/00799f3f53b6c8eb5cab5cb6ced259a08ea7fdea) | R | claude-sandbox | fix(claude-sandbox): compare stable pool credential identities |
| [494bcce4f](https://github.com/endojs/endo-but-for-bots/commit/494bcce4ff1668e827454077cbc02d3384b7f590) | D | claude-sandbox, designs | docs(claude-sandbox): record deployed renewal and restart status |
| [0954c792d](https://github.com/endojs/endo-but-for-bots/commit/0954c792d3e8e41953583b84086b59c2dc5f3a32) | R | chat | feat(chat): simplify Secrets cards and sort by pet name |
| [015bf10b9](https://github.com/endojs/endo-but-for-bots/commit/015bf10b9a6d4d4ccfe370e4b6d4b6183545f85a) | R | claude-sandbox, exo-stream, hosted-agent | fix(claude-sandbox): backpressure event delivery and diagnose queue limits |
| [b8152fe5f](https://github.com/endojs/endo-but-for-bots/commit/b8152fe5fe7f78c446915140d0de621ce0dad1c7) | R | designs, floot | fix(floot): recover durable tool evidence in failed transcripts |
| [be3390398](https://github.com/endojs/endo-but-for-bots/commit/be3390398a19c1556f65995fc6a7de8613530c5f) | R | chat, space-floot | feat(floot): show remaining provider quota meters |
| [86066250a](https://github.com/endojs/endo-but-for-bots/commit/86066250a4183f6690e07f2561b9486ea6875586) | R | floot | fix(floot): deduplicate Endo MCP execution evidence |
| [7e83a6fe2](https://github.com/endojs/endo-but-for-bots/commit/7e83a6fe2caab83088fab6ccff7e58d15cfe9cc0) | R | chat, designs, floot, opencode-sandbox, space-floot | feat(floot): show inline public reasoning with elapsed time |
| [254cecea6](https://github.com/endojs/endo-but-for-bots/commit/254cecea65e3151385bfaa60e5091b8a62e6fbd3) | R | opencode-sandbox | fix(opencode): normalize pinned bridge reasoning events |
| [e3c2cc38a](https://github.com/endojs/endo-but-for-bots/commit/e3c2cc38ac50e6fa778beb3c8b4658bb7a6d2941) | D | designs | docs(floot): record inline reasoning deployment acceptance |
| [8df7c95eb](https://github.com/endojs/endo-but-for-bots/commit/8df7c95ebf5eb41ed571d30fb60d0fddf41547c1) | R | chat, claude-sandbox, designs, floot, opencode-sandbox, space-floot | feat(floot): configure session internet and thinking levels |
| [22599f148](https://github.com/endojs/endo-but-for-bots/commit/22599f148cff5969fa55088ec8aecc5d1eab2d3e) | R | space-floot | fix(floot): clarify unknown capacity and tolerate display clock skew |
| [21bcb3d04](https://github.com/endojs/endo-but-for-bots/commit/21bcb3d04438ae313a172c9b691a7a8f4f5b17d5) | R | sandbox | fix(sandbox): admit attested public DNS resolver mounts |
| [8583b3cc4](https://github.com/endojs/endo-but-for-bots/commit/8583b3cc43ad1c6369941c8fe69322ad48b9396a) | D | designs | docs: record Tokyo session controls acceptance |
| [d841fe117](https://github.com/endojs/endo-but-for-bots/commit/d841fe117e5040cac098146b92a0e6f6493e29dc) | R | claude-sandbox, codex-sandbox, hosted-agent, opencode-sandbox | refactor(sandbox): share a pinned development image across harnesses |
| [9c56e7d43](https://github.com/endojs/endo-but-for-bots/commit/9c56e7d43c4d22cdf876a5c2c752126be11ceab2) | R | hosted-agent | fix(sandbox): normalize shared image IDs for Podman reuse |
| [79a0a03bf](https://github.com/endojs/endo-but-for-bots/commit/79a0a03bf808fdf70d128d1b3850796517fc1b9b) | D | designs | docs: record shared harness image build status |
| [9f77a8d71](https://github.com/endojs/endo-but-for-bots/commit/9f77a8d71e4a25d68e2767d81acaf23b8bf6320b) | D | designs | docs: update harness alignment capacity blocker |
| [2877dfbb9](https://github.com/endojs/endo-but-for-bots/commit/2877dfbb90744dcebf596526ec598fa4159d23a3) | R | space-floot | fix(space-floot): preview commands in collapsed actions |
| [dbf81d46a](https://github.com/endojs/endo-but-for-bots/commit/dbf81d46a485d1b1b7cead0902e9fdf71b00eaad) | R | opencode-sandbox | feat(opencode-sandbox): offer OpenRouter free model routing |
| [cdccdbb88](https://github.com/endojs/endo-but-for-bots/commit/cdccdbb8836ce8275f1f1c2eddb21573dcb4c3b9) | R | codex-sandbox | refactor(codex-sandbox): remove redundant scratch mount |
| [8846ff8b7](https://github.com/endojs/endo-but-for-bots/commit/8846ff8b72dc3f76612547470ff00e198ddda773) | D | designs, floot | docs(floot): track architecture audit and legacy retirement |
| [ddaf88e63](https://github.com/endojs/endo-but-for-bots/commit/ddaf88e632f30e866f2f6f01e1504f2272f87238) | R | claude-sandbox, floot | refactor(claude-sandbox): stop provisioning legacy form topology |
| [433a21757](https://github.com/endojs/endo-but-for-bots/commit/433a21757dba8ece5df0a76a5d6aa1a7057cf8b4) | R | floot, opencode-sandbox | refactor(opencode-sandbox): remove obsolete client formula entrypoint |
| [701653d65](https://github.com/endojs/endo-but-for-bots/commit/701653d6585e23304a4fe152bd26f79df619e910) | R | floot | fix(floot): restore archived turns and full provider context |
| [d2959f834](https://github.com/endojs/endo-but-for-bots/commit/d2959f83472d1530ac5da14541f2638a18809ed4) | R | daemon, floot, hosted-agent, opencode-sandbox | refactor(opencode-sandbox): remove unused CLI state service |
| [575b45f68](https://github.com/endojs/endo-but-for-bots/commit/575b45f689d60b4e5b8052cfb9cddd5a20318120) | D | floot | docs(floot): record Tokyo legacy retirement inventory |
| [9c64b53a3](https://github.com/endojs/endo-but-for-bots/commit/9c64b53a376905e8c096d62f2b16a5cd16eef7da) | T | claude-sandbox, daemon, floot | test(daemon): preserve coverage before legacy Claude removal |
| [1366b2e31](https://github.com/endojs/endo-but-for-bots/commit/1366b2e31941eb9af28f552ce77bd93a04e49b5e) | R | claude-sandbox, codex-sandbox, daemon, floot, hosted-agent, opencode-sandbox | refactor(hosted-agent): remove ignored native resource profiles |
| [495486723](https://github.com/endojs/endo-but-for-bots/commit/495486723f6ec3a76c913fd02ae721d1c248882c) | R | claude-sandbox, floot, hosted-agent, opencode-sandbox | refactor(claude-sandbox): remove legacy form and client topology |
| [5eeb1e8bf](https://github.com/endojs/endo-but-for-bots/commit/5eeb1e8bfa0113d64aa2face5b53a67ff5d319c8) | D | floot | docs(floot): prioritize preservation-safe coordinated cutover |
| [056310a75](https://github.com/endojs/endo-but-for-bots/commit/056310a757cf3724c7a12bde7b33b4a9835eddb8) | D | floot | docs(floot): record image pipeline and retirement inventory progress |
| [1b9e5ad3a](https://github.com/endojs/endo-but-for-bots/commit/1b9e5ad3a1abc839f168f1d6bf266cfce0b05848) | D | floot | docs(floot): record recursive inventory and successful release staging |
| [585b8fab3](https://github.com/endojs/endo-but-for-bots/commit/585b8fab31a3cc5d9dacdf814095256f322de803) | D | floot | docs(floot): record preserved workspace roots and live build findings |
| [69cf1dee6](https://github.com/endojs/endo-but-for-bots/commit/69cf1dee67b657c3990fcf09eee21b48ca5caf6d) | D | floot | docs(floot): record built images and preserved session retirement |
| [bb8ca75d1](https://github.com/endojs/endo-but-for-bots/commit/bb8ca75d15bfc4a1fcee9fcf8af4e5749e18bb5a) | D | floot | docs(floot): record coordinated Tokyo cutover and acceptance failure |
| [03fed9a26](https://github.com/endojs/endo-but-for-bots/commit/03fed9a26bd65250065c538c05bfc66b1c295f1b) | R | codex-sandbox | fix(codex-sandbox): attest the shared development image environment |
| [b8a785561](https://github.com/endojs/endo-but-for-bots/commit/b8a7855617433912bb52190ebb0836563707fa4e) | D | floot | docs(floot): record Codex image contract correction |
| [c50222e3d](https://github.com/endojs/endo-but-for-bots/commit/c50222e3d2a5fd96250aca92d0aaaf012d78d79a) | D | floot | docs(floot): record four-backend restart acceptance progress |
| [c314e9a16](https://github.com/endojs/endo-but-for-bots/commit/c314e9a167056c6763cc2c0fbbf90789b1deec41) | D | floot | docs(floot): distinguish cancellation from uncertain tool effects |
| [46e4e5de1](https://github.com/endojs/endo-but-for-bots/commit/46e4e5de17a2cafcc087d947edf71598872aa467) | D | floot | docs(floot): close cutover gates and retain follow-up findings |
| [8aa1edc99](https://github.com/endojs/endo-but-for-bots/commit/8aa1edc992450fbc7f09b83cf18e4b85148a3aa8) | R | floot, opencode-sandbox | refactor(opencode-sandbox)!: remove obsolete broker service wrapper |
| [db12c4af4](https://github.com/endojs/endo-but-for-bots/commit/db12c4af4d6f3203afa38efb1d28f288ca535ec0) | R | floot | refactor(floot)!: require session creation options records |
| [886192baf](https://github.com/endojs/endo-but-for-bots/commit/886192baf9d8303c4e193d260ca0571e142f54e6) | R | claude-sandbox, floot, opencode-sandbox | refactor(hosted-agent)!: remove obsolete credential entrypoint shims |
| [c24d84d1c](https://github.com/endojs/endo-but-for-bots/commit/c24d84d1c5e64fce435ced6193a9b3c6f420684a) | R | floot | refactor(floot): remove redundant usage cache persistence |
| [a0911be55](https://github.com/endojs/endo-but-for-bots/commit/a0911be55614b7c1b2c308a8058700d071eaeefe) | R | floot | refactor(floot)!: remove legacy session registry imports |
| [4d67375f6](https://github.com/endojs/endo-but-for-bots/commit/4d67375f625ea0785e9d020fecede605cec2f29d) | D | floot | docs(floot): specify private journal creation and revival boundary |
| [162b9d6ef](https://github.com/endojs/endo-but-for-bots/commit/162b9d6efb09a0b66f4d5d2f3dd810f3141bbbd1) | R | floot | refactor(floot)!: remove private journal migration imports |
| [d2fde94c5](https://github.com/endojs/endo-but-for-bots/commit/d2fde94c5466273a01c9e3ea8332b172894706ab) | T | floot | test(floot): type private journal fault injection hooks |
| [81f3428e3](https://github.com/endojs/endo-but-for-bots/commit/81f3428e3731bcd761c78ba4ff76dfc1500aebd5) | R | floot, opencode-sandbox | refactor(opencode-sandbox)!: restore only from canonical transcripts |
| [209c5c40c](https://github.com/endojs/endo-but-for-bots/commit/209c5c40cd03a8e62208cbe9b945e7ee2a8a6dbd) | D | floot | docs(floot): prioritize provider-backed model discovery |
| [3f49b2ee1](https://github.com/endojs/endo-but-for-bots/commit/3f49b2ee1601c29f87852c8c5573b76113d81786) | R | floot, hosted-agent | feat(hosted-agent): read provider model catalogs without inference |
| [275710d5a](https://github.com/endojs/endo-but-for-bots/commit/275710d5ac8ac468bc943f778ddaaa6d3ac9b0e7) | R | floot, hosted-agent | fix(hosted-agent): reject pool member authority rebinding |
| [65e939889](https://github.com/endojs/endo-but-for-bots/commit/65e93988924ec379739e8de0f7f2bdc517964f0d) | R | chat, floot, space-floot | feat(floot): make backend model selection searchable |
| [870acdbfa](https://github.com/endojs/endo-but-for-bots/commit/870acdbfa5b778d115fff98ef38b99bae24a0b07) | R | floot, hosted-agent | fix(hosted-agent): fail closed on mount inspection errors |
| [c645f567f](https://github.com/endojs/endo-but-for-bots/commit/c645f567f7ffde7529dce9e778d0dea98e2db00d) | R | codex-sandbox, floot | fix(codex-sandbox): flush checkpoint directory updates before acknowledgement |
| [84e97d0bd](https://github.com/endojs/endo-but-for-bots/commit/84e97d0bd18ef10a849cff88040c620b875de647) | R | daemon, floot | fix(daemon): retain marshal dependencies through durable publication |
| [f024c02c1](https://github.com/endojs/endo-but-for-bots/commit/f024c02c1cdc14e7692a2c7c0b497b6f1ab27a28) | R | codex-sandbox, daemon, floot, hosted-agent, opencode-sandbox | feat(hosted-agent): expose account-scoped provider model discovery |
| [65b06b58a](https://github.com/endojs/endo-but-for-bots/commit/65b06b58ab147d40d2243923237822b886457828) | R | floot, opencode-sandbox | refactor(opencode-sandbox): remove unobserved construction prompts |
| [baecab949](https://github.com/endojs/endo-but-for-bots/commit/baecab949f0bda5f78272e3d3cfd78bafdaa65fa) | R | claude-sandbox, codex-sandbox, floot, hosted-agent | fix(hosted-agent)!: publish inode-bound native state allocations |
| [486b1364d](https://github.com/endojs/endo-but-for-bots/commit/486b1364d57bb83e4630a9c8fd0633a583b9a72e) | R | claude-sandbox, floot | refactor(claude-sandbox): remove unobserved construction prompts |
| [40ba9133b](https://github.com/endojs/endo-but-for-bots/commit/40ba9133bece79cedadb623e8f855f8d1a20a9f5) | T | floot, hosted-agent | test(hosted-agent): verify native state recovery after process loss |
| [cef5de259](https://github.com/endojs/endo-but-for-bots/commit/cef5de259db88edc209f5dc196bf9238249f62cf) | R | daemon, floot | fix(daemon): fence formula reconstruction through disposal and collection |
| [b130a0a5f](https://github.com/endojs/endo-but-for-bots/commit/b130a0a5fd1cb8aa4b5276533dff7a4416bede1d) | R | daemon, floot, hosted-agent | fix(hosted-agent): persist pool capability identities before admission |
| [0d66bd945](https://github.com/endojs/endo-but-for-bots/commit/0d66bd9453f281378eadf7bdc412aa75bdba3625) | R | claude-sandbox, codex-sandbox, daemon, floot, hosted-agent, opencode-sandbox | fix(hosted-agent): require original scope closure before native cleanup |
| [df563d028](https://github.com/endojs/endo-but-for-bots/commit/df563d028f2aa82b98d1caa3893a8a545ae851c5) | R | yarn.lock | chore: Update yarn.lock |
| [64b1de584](https://github.com/endojs/endo-but-for-bots/commit/64b1de584d2868b7ccbed260f258d5d23f22c855) | R | floot, sandbox | fix(sandbox): flush exclusive runtime ownership before effects |
| [d54eef291](https://github.com/endojs/endo-but-for-bots/commit/d54eef291c9ed8c0c77dbbef6f6d73f15d64d71d) | R | daemon, floot | fix(floot): drain factory incarnation before reconstruction |
| [e9478d846](https://github.com/endojs/endo-but-for-bots/commit/e9478d8469b5b944f5de544b9b28ae7b2a48157c) | R | daemon, floot, hosted-agent | fix(hosted-agent): fence and drain retired pool members |
| [ce8ba0a10](https://github.com/endojs/endo-but-for-bots/commit/ce8ba0a104f23067880ed9f3ed53e9c74c901c79) | R | daemon, floot, hosted-agent | fix(hosted-agent): drain account oracle before formula replacement |
| [d702826b5](https://github.com/endojs/endo-but-for-bots/commit/d702826b5f95e3d311a41aaa678decfbdb4d2052) | R | chat, claude-sandbox, codex-sandbox, floot, hosted-agent | fix(hosted-agent): align provider and session type contracts |
| [bb84da921](https://github.com/endojs/endo-but-for-bots/commit/bb84da92189511647a887fa467e0bcaa4b03e09d) | R | floot | fix(floot): validate watch events before caching and delivery |
| [6d9675ae6](https://github.com/endojs/endo-but-for-bots/commit/6d9675ae6a88724afecdce4fca71f2934a00e781) | R | floot, scripts, typedoc.json | fix(docs): check package-local production source roots |
| [cdf8d32c8](https://github.com/endojs/endo-but-for-bots/commit/cdf8d32c85591093da017b855703f208d6d1b5e9) | R | floot, opencode-sandbox | fix(opencode-sandbox): describe bridge and transcript input shapes |
| [bd1b79996](https://github.com/endojs/endo-but-for-bots/commit/bd1b799960ba26e9a9f6c80bb5147df2b0c4a915) | D | floot | docs(floot): gate native recovery redesign on scope review |
| [974130642](https://github.com/endojs/endo-but-for-bots/commit/974130642ad52b184f0f046c8e020cf72f786804) | D | floot | docs(floot): record existing shutdown boundary evidence |
| [de13cfa28](https://github.com/endojs/endo-but-for-bots/commit/de13cfa28dfab34665aa49bf7e765ee63995ab50) | D | designs, floot | docs(floot): separate native recovery investigation from refactor |
| [111a5bb35](https://github.com/endojs/endo-but-for-bots/commit/111a5bb356c1d803962a078be3b3370fed5f28a4) | D | designs, floot | docs(floot): link native recovery tracking PR |
| [3fa2cb2aa](https://github.com/endojs/endo-but-for-bots/commit/3fa2cb2aa264b49d559a4b83785c02d3821adb23) | R | claude-sandbox, codex-sandbox, endo-fs-asset-server, floot, hosted-agent, platform | fix(types): preserve public native and HTTP declarations |
| [d56d83d92](https://github.com/endojs/endo-but-for-bots/commit/d56d83d92f6aa828de7032c5900947ed1ca13836) | R | yarn.lock | chore: Update yarn.lock |
| [64176d7d5](https://github.com/endojs/endo-but-for-bots/commit/64176d7d554450c0274eca684edd9a091f7210a3) | R | chat, claude-sandbox, codex-sandbox, designs, floot, hosted-agent, opencode-sandbox, space-floot | feat(hosted-agent): provider-backed model discovery end to end |
| [d15617459](https://github.com/endojs/endo-but-for-bots/commit/d15617459ec59559e03360d03aa1e2385b5ee890) | D | floot | docs(floot): record the discovery commit and the pending cutover |
| [de0ca9740](https://github.com/endojs/endo-but-for-bots/commit/de0ca9740abcf34efd512dc274c1e3f5c0207e4c) | D | designs, floot | docs(floot): record the discovery cutover and the restart regression |
| [2cfcfeb02](https://github.com/endojs/endo-but-for-bots/commit/2cfcfeb026d2f3deb1af277ec18d286d70087b6c) | R | claude-sandbox, codex-sandbox, daemon, floot, hosted-agent, opencode-sandbox | Revert "fix(hosted-agent): require original scope closure before native cleanup" |
| [96caf0c3c](https://github.com/endojs/endo-but-for-bots/commit/96caf0c3cf8fc82b236d0b558d1948461698c70c) | D | designs, floot | docs(floot): record the teardown eviction and the second activation |
| [ca05516db](https://github.com/endojs/endo-but-for-bots/commit/ca05516dbcf52d68b473352263e6b19618b55abc) | R | chat, floot | feat(floot): list models in the picker's order; make no session on load |
| [5c3ed7c96](https://github.com/endojs/endo-but-for-bots/commit/5c3ed7c969ff68529ac26453b1072aeb910f5862) | D | floot | docs(floot): record the picker-order deployment |
| [4411c058e](https://github.com/endojs/endo-but-for-bots/commit/4411c058e692c2d20f3ca8fe3b280c31f182aa5c) | R | chat, floot, space-floot | feat(space-floot): fold thinking into the collapsed actions group |
| [16417f876](https://github.com/endojs/endo-but-for-bots/commit/16417f876105a7092c29ab52044108979d08bca7) | D | floot | docs(floot): record the thinking-fold deployment |
| [e4ef04e90](https://github.com/endojs/endo-but-for-bots/commit/e4ef04e902a7a6ed9d3daad3f8483c226a34aa73) | D | floot | docs(floot): close FA-07's register row and record the third cutover |
| [f1bdfcdd2](https://github.com/endojs/endo-but-for-bots/commit/f1bdfcdd2dcb4192040cf16e861a94a9aec3d9ab) | D | floot | docs(floot): reconcile FA-11/FA-12 and record Tokyo's legacy retirement |
| [4c0d1cb67](https://github.com/endojs/endo-but-for-bots/commit/4c0d1cb671dc2329e5dc2dd90818222d8b9ea8cd) | T | codex-sandbox | test(codex-sandbox): expect the allocated CLI home path |
| [d0e75f44f](https://github.com/endojs/endo-but-for-bots/commit/d0e75f44f51c762fdbfc8a979922ade4d1b8b298) | R | claude-sandbox, codex-sandbox, hosted-agent, opencode-sandbox | refactor(hosted-agent): one session provisioner and backend factory for the hosted adapters |
| [23bd0debe](https://github.com/endojs/endo-but-for-bots/commit/23bd0debed1e8ab8d0fc6e119ce6c777d6930993) | D | designs, floot | docs(floot): record the FA-06 provisioning extraction |
| [fc8607b8e](https://github.com/endojs/endo-but-for-bots/commit/fc8607b8e853d9718d88f8313ceffa1a2ae3f2d0) | R | claude-sandbox, codex-sandbox, hosted-agent, opencode-sandbox | refactor(hosted-agent): one execution envelope for the hosted native controllers |
| [597e3df6d](https://github.com/endojs/endo-but-for-bots/commit/597e3df6d251935f406adc61830ff8e41998929f) | D | designs, floot | docs(floot): record the FA-06 execution envelope |
| [b4a371712](https://github.com/endojs/endo-but-for-bots/commit/b4a371712504deeba0d24f8eb7473f718b889e6c) | T | floot | test(floot): rename a shadowed variable in the subscription fixture |
| [bded70bb2](https://github.com/endojs/endo-but-for-bots/commit/bded70bb2e210d7e814d9fe8073e8ad6df7d104b) | R | chat, floot | refactor(floot): one reply fold, one turn-message converter, one transcript delta |
| [f49d9eb2b](https://github.com/endojs/endo-but-for-bots/commit/f49d9eb2b3ad8e5bf73e0e81eacf3a59a4e7130c) | R | yarn.lock | chore: Update yarn.lock |
| [999c40d26](https://github.com/endojs/endo-but-for-bots/commit/999c40d26d684651c8f097703af5f1ddff66ffcb) | D | floot | docs(floot): record the FA-10 fold, converter and delta extraction |
| [08d66281a](https://github.com/endojs/endo-but-for-bots/commit/08d66281a9300e98b94dadb7a3ab92da9da9660e) | R | floot, hosted-agent | refactor(floot): one reconciliation of a turn's tool evidence, one pairing rule |
| [6d960a87b](https://github.com/endojs/endo-but-for-bots/commit/6d960a87ba5010de960a95f8956198f65564bcb0) | D | floot | docs(floot): record the FA-10 reconciliation and pairing slice |
| [42ee29075](https://github.com/endojs/endo-but-for-bots/commit/42ee29075966e7595086e24a9d2694168ca15d3a) | R | claude-sandbox, codex-sandbox, daemon, floot, hosted-agent, opencode-sandbox | feat(hosted-agent): rebind a session's image, account and service bindings under explicit authorization |
| [b20357a9f](https://github.com/endojs/endo-but-for-bots/commit/b20357a9f95467e9d8cf61a909de9a42e7a096b6) | D | designs, floot | docs: record FA-08 rebindable session bindings |
| [e1ad34345](https://github.com/endojs/endo-but-for-bots/commit/e1ad343454564875579c02e31e7ca97a97fe344e) | D | floot | docs(floot): scope FA-09 local development storage |
| [26ccd941d](https://github.com/endojs/endo-but-for-bots/commit/26ccd941df0105fb6eaeaec63c4116d8fdd54900) | D | floot | docs(floot): record generation 165 as the deployment of FA-06, FA-08 and FA-10 |
| [b7514bec9](https://github.com/endojs/endo-but-for-bots/commit/b7514bec96fd1d7e1ce96fcbc62632dd2eff1959) | D | floot | docs(floot): correct the audit's status lines to the deployed record |
| [c3669475f](https://github.com/endojs/endo-but-for-bots/commit/c3669475f5941893b1c375405234286099c43536) | R | daemon, designs, floot | fix(daemon): publish a session revision as one transition |
| [497411672](https://github.com/endojs/endo-but-for-bots/commit/4974116729b0527f4de8b08635b78ca50b141cf9) | D | designs, floot | docs(design): plan one binding vocabulary for every hosted session |
| [65a3f7b62](https://github.com/endojs/endo-but-for-bots/commit/65a3f7b62bdc03b34364707cab9ae78608272b40) | D | designs | docs(design): plan readers refuse unknown fields |
| [c12752d31](https://github.com/endojs/endo-but-for-bots/commit/c12752d31f893ba596c46f08eb2fab2527683d2f) | D | designs | docs(design): give the binding-vocabulary note its vocabulary, schemas and interfaces |
| [d8718a1ca](https://github.com/endojs/endo-but-for-bots/commit/d8718a1ca9d7686bb9ea652e2950a034ebc7739a) | R | claude-sandbox, codex-sandbox, designs, floot, hosted-agent, opencode-sandbox | refactor(hosted-agent)!: one image field and no unknown fields in a session plan |
| [d71d0c343](https://github.com/endojs/endo-but-for-bots/commit/d71d0c34387c22dae3e4eb09de0af90ea7177e55) | R | claude-sandbox, codex-sandbox, daemon, designs, floot, hosted-agent, opencode-sandbox | refactor(hosted-agent)!: one account authority id in every plan, profile, catalog and grant |
| [5b8674613](https://github.com/endojs/endo-but-for-bots/commit/5b86746132b79db8a573b790e168f8ea9e512320) | R | daemon, floot | fix(daemon): persist pet-store bindings before publication |
| [6d84fbe1a](https://github.com/endojs/endo-but-for-bots/commit/6d84fbe1ac55c859a6a9439e9fa56e61cf24d107) | D | floot | docs(floot): record acceptance runner verification |
| [a16df39e9](https://github.com/endojs/endo-but-for-bots/commit/a16df39e975f133796ae3bcaeeac5389b114e95f) | R | floot, hosted-agent | feat(floot): inspect recorded and proposed session bindings |
| [eeb50a24c](https://github.com/endojs/endo-but-for-bots/commit/eeb50a24c254e85d336c09d92aab708c199c1d41) | R | claude-sandbox, floot, hosted-agent | fix(hosted-agent): repair binding vocabulary public types |
| [ee426e320](https://github.com/endojs/endo-but-for-bots/commit/ee426e320f69c24a806e01302064e6e647c868da) | R | claude-sandbox, codex-sandbox, floot, hosted-agent | fix(hosted-agent): align activation and deletion state authority |
| [1ab38304c](https://github.com/endojs/endo-but-for-bots/commit/1ab38304c7ee45079de1daa79e29c5668fe8fb4a) | R | claude-sandbox, codex-sandbox, designs, floot, hosted-agent | fix(hosted-agent)!: pin native state roots in session plans |
| [9bad75389](https://github.com/endojs/endo-but-for-bots/commit/9bad75389abaf2f58c86338a36a9e4c82e2b8c1d) | D | floot | docs(floot): record live rebind acceptance gate |
| [c44871e38](https://github.com/endojs/endo-but-for-bots/commit/c44871e38f795bb0e5bf24ff6c3ae6c5317cf538) | R | floot | fix(floot): preserve subscription pins on restoration |
| [72a8dbf5a](https://github.com/endojs/endo-but-for-bots/commit/72a8dbf5a881555b51538765ec89ef1bc45ef61c) | R | floot, hosted-agent | fix(hosted-agent): unwind partial pool construction |
| [630a70810](https://github.com/endojs/endo-but-for-bots/commit/630a70810f0b7a76c8a9c771a0a7a08c32faa7bd) | R | floot | fix(floot): retire private journals on terminal deletion |
| [293e49aed](https://github.com/endojs/endo-but-for-bots/commit/293e49aedbdef0e4dc901a9a003322e966a5b559) | T | daemon, floot | test(floot): verify journal retirement across daemon restarts |
| [1462831db](https://github.com/endojs/endo-but-for-bots/commit/1462831db9b3504cac4a5c0a071af3078cf13178) | T | daemon, floot | test(floot): restore factory disposal coverage after catalog refactor |
| [4b425552f](https://github.com/endojs/endo-but-for-bots/commit/4b425552f9447f40d7798bf3304c54e5c13c1067) | T | daemon, floot | test(floot): capture cross-session impact of guest collection |
| [a362dbd78](https://github.com/endojs/endo-but-for-bots/commit/a362dbd787e617e98ce85904b10bdbac0ca9f4f5) | D | floot | docs(floot): record coordinated cutover preparation |
| [4883e2dea](https://github.com/endojs/endo-but-for-bots/commit/4883e2dea57c25f63f8d2d7374ba8547d33ae8d6) | D | floot | docs(floot): record guarded retirement dry run |
| [8fa56d576](https://github.com/endojs/endo-but-for-bots/commit/8fa56d576deb64f77916f0f43cf5b4f701cf6ef0) | D | floot | docs(floot): record generation 166 deployment and seed acceptance |
| [aa9cf284f](https://github.com/endojs/endo-but-for-bots/commit/aa9cf284f5c126ad3aeb19c4949c7290a3c6b433) | D | floot | docs(floot): reconcile audit status with deployed refactor |
| [89ae41661](https://github.com/endojs/endo-but-for-bots/commit/89ae41661aee10fd5e8e70bfc42bf4331b05dfa0) | R | floot, lal | fix(lal): reject empty OpenRouter completions without replay |
| [dba20cd18](https://github.com/endojs/endo-but-for-bots/commit/dba20cd1838d019988e3eabf7627c3f753c4762c) | D | floot | docs(floot): record deployed empty-response fix and recall test |
| [aa6cc27e3](https://github.com/endojs/endo-but-for-bots/commit/aa6cc27e3d17a2b4534dac3c8a87355e627efff4) | D | floot | docs(floot): record live provider-only rebind evidence |
| [92633b74d](https://github.com/endojs/endo-but-for-bots/commit/92633b74d09de417bf688c63e831e95c23549d00) | D | floot | docs(floot): close live rebind acceptance cases |
| [8a4335171](https://github.com/endojs/endo-but-for-bots/commit/8a43351712bfaa09d0bbecb7a3bc279659a55f16) | R | floot | feat(floot): page committed archives through stable read views |
| [539568efa](https://github.com/endojs/endo-but-for-bots/commit/539568efab46627673a972320af69bafe39c9131) | R | floot | fix(floot): honor recorded compaction in provider replay |
| [b3ea00b7b](https://github.com/endojs/endo-but-for-bots/commit/b3ea00b7bf8c546b60c95422c060fdb9e713d7b5) | R | floot, opencode-sandbox | fix(opencode-sandbox): import only active transcript context |
| [06d114d32](https://github.com/endojs/endo-but-for-bots/commit/06d114d32080552432b9442f4b4fdf4bdc176e46) | R | floot, lal | fix(floot): retain usage for rejected provider replies |
| [1feef3866](https://github.com/endojs/endo-but-for-bots/commit/1feef38668a8c2ad56792cd646e052153f245e3b) | R | floot, lal | fix(lal): preserve error usage and fence inference retries |
| [819aa18c8](https://github.com/endojs/endo-but-for-bots/commit/819aa18c8aea939c50ae875805d49d8e2c1616fc) | R | yarn.lock | chore: Update yarn.lock |
| [23030739d](https://github.com/endojs/endo-but-for-bots/commit/23030739d09b66f75738fa53d83ed01f4a449382) | D | floot | docs(floot): record context and accounting deployment |
| [660bfd39f](https://github.com/endojs/endo-but-for-bots/commit/660bfd39f07ceb97d38a32dc6f7a9de6ae3d2320) | R | floot, hosted-agent | feat(hosted-agent): represent retained compaction context |
| [d5da86dc8](https://github.com/endojs/endo-but-for-bots/commit/d5da86dc86fd6c787a7e7c0def15f4ce6a989595) | R | floot | fix(floot): preserve settled compaction context through turns |
| [674703c3e](https://github.com/endojs/endo-but-for-bots/commit/674703c3efff0c900728e8319706315cd7c0cc49) | R | floot | feat(floot): persist ordered transcript journal records |
| [ac132c5b5](https://github.com/endojs/endo-but-for-bots/commit/ac132c5b54fe7a255b2fc019c64feed57d197267) | R | floot | fix(floot): recover ordered hosted context across interrupted turns |
| [52873c213](https://github.com/endojs/endo-but-for-bots/commit/52873c213c6bccd42ed90b37178fd3b8e99cef9f) | D | floot | docs(floot): record native checkpoint producer and integration gates |
| [01bc4750e](https://github.com/endojs/endo-but-for-bots/commit/01bc4750eeafd2b266803489bf3b8211b38772c2) | R | floot, opencode-sandbox | feat(opencode): project authoritative compaction context |
| [49b81673e](https://github.com/endojs/endo-but-for-bots/commit/49b81673ed4bd73fef745c64e8c85a5a26aedbbd) | R | floot, opencode-sandbox | feat(opencode): deliver compaction checkpoints with continuity fencing |
| [347c31dee](https://github.com/endojs/endo-but-for-bots/commit/347c31deea458dbd819dda932acbd6e31f948a6f) | R | floot, opencode-sandbox | fix(opencode): disable unrecorded background context pruning |
| [3f680bbca](https://github.com/endojs/endo-but-for-bots/commit/3f680bbca3db66249a9e4874326a966edfa2a384) | D | floot | docs(floot): record runtime model limit and acceptance gaps |
| [eb5916e07](https://github.com/endojs/endo-but-for-bots/commit/eb5916e07411e7f9fa5517a5144e89128d8352e1) | R | floot, hosted-agent, opencode-sandbox | fix(opencode): apply observed route context limits at activation |
| [12cd5e853](https://github.com/endojs/endo-but-for-bots/commit/12cd5e8538b346cd87f51ed8a0f3eb0f728f4fb8) | R | floot | fix(floot): journal direct-provider dialogue before tool effects |
| [0e2fefc44](https://github.com/endojs/endo-but-for-bots/commit/0e2fefc440d34ce7a42847b337cc7e851be3b525) | T | daemon, floot | test(floot): verify direct journal across daemon restarts |
| [f7cd0ee42](https://github.com/endojs/endo-but-for-bots/commit/f7cd0ee427f0bc166379928bbc5750aa10233f2e) | D | floot | docs(floot): map tree retirement before bounded context reads |
| [f2e0bcd14](https://github.com/endojs/endo-but-for-bots/commit/f2e0bcd1436da8488a722b822181a63672baa557) | R | floot | fix(floot): journal backend checkpoint before acknowledgement |
| [4656d7af7](https://github.com/endojs/endo-but-for-bots/commit/4656d7af76fe4ee30a0d4a674733566527c97167) | R | floot | fix(floot): preserve mail receipt metadata in turn journal |
| [b74d30f50](https://github.com/endojs/endo-but-for-bots/commit/b74d30f505bb79fcf722883c78d67dc8e7739484) | R | floot | fix(floot): journal thinking presentation before settlement |
| [853dd077a](https://github.com/endojs/endo-but-for-bots/commit/853dd077a313281d691bdfbcd765de8dc2c48965) | R | floot | fix(floot): recover backend checkpoints from completed journal turns |
| [0d3c206e3](https://github.com/endojs/endo-but-for-bots/commit/0d3c206e3c6692e4940dcc71b4c7e37a00ff552d) | R | floot | refactor(floot): derive usage solely from the turn journal |
| [59fc98686](https://github.com/endojs/endo-but-for-bots/commit/59fc986869613fb9df22aa9d0f94cbad013729d3) | R | floot | refactor(floot)!: replace conversation tree with journal projections |
| [dd2e36015](https://github.com/endojs/endo-but-for-bots/commit/dd2e3601513a62834568128709bf649fb22605cb) | R | floot | chore(floot): remove unused conversation tree dependency |
| [ae5891c28](https://github.com/endojs/endo-but-for-bots/commit/ae5891c2824f0fc73002b1bed1951f6ca62d15af) | R | yarn.lock | chore: Update yarn.lock |
| [31d84b7d6](https://github.com/endojs/endo-but-for-bots/commit/31d84b7d67e183d134593a6ad68b830f310ef13d) | R | floot | feat(floot): index transcript kinds in journal events |
| [6d09c9011](https://github.com/endojs/endo-but-for-bots/commit/6d09c9011bca72f15ce8259a12ecfbee50dd94d6) | R | floot | feat(floot): select active context without superseded prose |
| [b203d8cdc](https://github.com/endojs/endo-but-for-bots/commit/b203d8cdc200669739a602cdc0661fdfd46d026a) | R | floot | refactor(floot): page pinned context metadata reads |
| [bf49cb5d0](https://github.com/endojs/endo-but-for-bots/commit/bf49cb5d009872a571cea756bd01bb271ab2c25e) | R | floot | feat(floot): index archived compaction in journal snapshots |
| [ad3ffcebd](https://github.com/endojs/endo-but-for-bots/commit/ad3ffcebd92cf5949113aa205d3bac206ae5463c) | R | floot | perf(floot): reuse reconciled archived tool evidence |
| [ef99e8bbf](https://github.com/endojs/endo-but-for-bots/commit/ef99e8bbf416447a63bc00e0370899640615d0d5) | R | floot | refactor(floot): remove alternate tree input from recovery |
| [7275afa72](https://github.com/endojs/endo-but-for-bots/commit/7275afa72b4c8102f1d9c63f42b6dec133853c62) | R | floot | refactor(floot): persist explicit session backend and model identity |
| [25e264f90](https://github.com/endojs/endo-but-for-bots/commit/25e264f90c50e52c2b1e81b415288deaef3de7ea) | R | daemon, floot | refactor(floot): discriminate streaming runtime configuration |
| [5f784fb91](https://github.com/endojs/endo-but-for-bots/commit/5f784fb91d3a0005955e3f2102cc321f06983611) | R | claude-sandbox, floot | fix(claude-sandbox): preserve structured turn failure diagnostics |
| [3171d21c8](https://github.com/endojs/endo-but-for-bots/commit/3171d21c804c5cf93d101f146ffcf43ff5a5c973) | T | floot | test(floot): verify direct delegation identity after reconstruction |
| [7ee35f808](https://github.com/endojs/endo-but-for-bots/commit/7ee35f808af05e93de79eacf2141cfe99699d0a0) | R | floot | fix(floot): fence stale provider cache fills after refresh |
| [2deaf4f55](https://github.com/endojs/endo-but-for-bots/commit/2deaf4f55ab7c3ff27a940fce4f74d264c0cafd1) | R | floot | fix(floot): isolate refreshed catalogs and drain their owners |
| [11fbe8b0d](https://github.com/endojs/endo-but-for-bots/commit/11fbe8b0d40feb53114b0518b06853ebc1722313) | T | daemon, floot | test(floot): verify archived context across daemon restarts |
| [e9f949dca](https://github.com/endojs/endo-but-for-bots/commit/e9f949dca675df6ddb7eb6bec89d889c1c8ec3f0) | R | chat, floot, space-floot | refactor(floot): remove obsolete migration recovery UI |
| [1d18c8b19](https://github.com/endojs/endo-but-for-bots/commit/1d18c8b19e504765941e6ccc2ca8af2dd807b30c) | T | chat, floot | test(chat): restore type-safe Floot fixture contracts |
| [a67f06294](https://github.com/endojs/endo-but-for-bots/commit/a67f06294a6504c14dba6796c658204018d06fc8) | R | floot | fix(floot): close journal facets before incarnation replacement |
| [ecc23e907](https://github.com/endojs/endo-but-for-bots/commit/ecc23e907c464c76ad231f9c01ddf56d9b2df11c) | R | floot | fix(floot): drain stopped journals before resuming sessions |
| [bf3e1ed21](https://github.com/endojs/endo-but-for-bots/commit/bf3e1ed213bccda8587bda96e8093cf1dcc8c5fe) | R | floot | fix(floot): retain failed setup owners through journal cleanup |
| [ab8d804ae](https://github.com/endojs/endo-but-for-bots/commit/ab8d804aee760b1dc08f3b7737bb59c0acbd1381) | R | floot, hosted-agent, opencode-sandbox | fix(opencode): preserve observed provider output limits |
| [0dfe51513](https://github.com/endojs/endo-but-for-bots/commit/0dfe51513e01feed56b3e2a4d100b2e50868a8ab) | D | floot | docs(floot): record provider-limit candidate preparation |
| [d5d943d33](https://github.com/endojs/endo-but-for-bots/commit/d5d943d3389465a3c0ae2e569d585e483dd76e29) | R | floot, opencode-sandbox | fix(opencode): pin context-bounded compaction runtime |
| [dce92c734](https://github.com/endojs/endo-but-for-bots/commit/dce92c7344a2fe86b08b6d282acb035d8fbc5fc0) | D | floot | docs(floot): record corrected compaction candidate |
| [f67664282](https://github.com/endojs/endo-but-for-bots/commit/f67664282badcb55d8722d05817bc2b9411cbc42) | R | floot | fix(floot): fence ended session watchers |
| [14074996c](https://github.com/endojs/endo-but-for-bots/commit/14074996c9dcee47f7cb1bf7b27c12aa85633b5d) | R | codex-sandbox, floot | fix(codex): terminate readers after checkpoint write failure |
| [5d419544e](https://github.com/endojs/endo-but-for-bots/commit/5d419544eafadb279e1f05a4a50d99ee0d6d4bb3) | T | codex-sandbox, floot | test(codex): align fixtures with current authority contracts |
| [6eef34a8e](https://github.com/endojs/endo-but-for-bots/commit/6eef34a8e883fd1eb126e90a77eb167318e348a9) | R | claude-sandbox, floot | fix(claude-sandbox): abort when process exit observation fails |
| [a3a239f80](https://github.com/endojs/endo-but-for-bots/commit/a3a239f80a903d4f00e1b2e24e1d604d3a03a499) | R | claude-sandbox, floot | fix(claude-sandbox): bound stderr diagnostic collection |

## Host commits

| Commit | Triage | Areas | Subject |
|---|---|---|---|
| [3f5045f92](https://github.com/kumavis/endo-host/commit/3f5045f92ef15b65a303ea527d7f0bedf36838fa) | R | modules | refactor(endo): stop provisioning legacy Claude credential forms |
| [c5153784d](https://github.com/kumavis/endo-host/commit/c5153784d2dee52f0a86fbc709aebff7991d2738) | R | hosts, modules | refactor(endo): remove unused OpenCode state configuration |
| [d68f72c94](https://github.com/kumavis/endo-host/commit/d68f72c94e8ed833cf820bd31896e765b5f49ab9) | R | README.md, ops | docs(endo): record read-only hosted retirement inspection |
| [be0803ed5](https://github.com/kumavis/endo-host/commit/be0803ed51a570a7014d7691d10e4fadc54af0f4) | R | hosts, modules | refactor(endo): remove ignored hosted native profiles |
| [2bfebce4d](https://github.com/kumavis/endo-host/commit/2bfebce4d72260902063cf84479dd1822780ac1f) | R | hosts, modules, ops | fix(endo): provision pinned hosted images with guarded builds |
| [7402350fc](https://github.com/kumavis/endo-host/commit/7402350fc29af3d2becfab316174ba46f472023a) | R | ops | ops(endo): inventory retirement roots without reviving services |
| [e0233ec75](https://github.com/kumavis/endo-host/commit/e0233ec75de2948f51e5db3c181465b919f3a91b) | R | ops | ops(endo): include passive directory members in retirement inventory |
| [9d8f4a7d8](https://github.com/kumavis/endo-host/commit/9d8f4a7d83d8d0125f1e689c1fe83dd564a21485) | D | ops | docs(endo): define preservation-safe hosted cutover procedure |
| [8d4e918b0](https://github.com/kumavis/endo-host/commit/8d4e918b048b9cf45d99eef110cf3e68d5123875) | R | ops | ops(endo): map Floot session guest roots before retirement |
| [f8b85898d](https://github.com/kumavis/endo-host/commit/f8b85898d4ca80d8f6873d6d815f6fbd3a6aa080) | R | ops | ops(endo): protect first-cutover images with stopped holders |
| [0b0715f2a](https://github.com/kumavis/endo-host/commit/0b0715f2a01e58c2d2cf9757e1c9311cfe34deff) | R | ops | ops(endo): retain Floot workspace guest roots before session reset |
| [11ed01d76](https://github.com/kumavis/endo-host/commit/11ed01d76f4705ad99f382e2c9ee31496158fa7b) | R | ops | fix(endo): accept exclusive service group in image build spool |
| [e2e6f65be](https://github.com/kumavis/endo-host/commit/e2e6f65bece7b79cc5aca20299f569bf323cca4d) | R | ops | fix(endo): isolate image holder recovery from shared deploy spool |
| [9e062aa78](https://github.com/kumavis/endo-host/commit/9e062aa78e6029e66bcb6ead87b2cafcac6d64c0) | R | ops | ops(endo): gate old Claude session retirement on preserved roots |
| [a180f0a42](https://github.com/kumavis/endo-host/commit/a180f0a42ee520d7f0a738dc818e086b07241d6b) | R | endo.rev, hosts, ops | deploy(endo): stage coordinated shared-base hosted release |
| [1fa90d97e](https://github.com/kumavis/endo-host/commit/1fa90d97e3fbeb45d0e756fc0ffcd7262e88b3a3) | R | ops | ops(endo): inventory old broker reference chains safely |
| [ed57f5b46](https://github.com/kumavis/endo-host/commit/ed57f5b4638fae3dc960c3efcb4b83c16e6f942c) | R | ops | ops(endo): inspect legacy guest dependencies without reviving producers |
| [88c5114d3](https://github.com/kumavis/endo-host/commit/88c5114d3bdb1ac293a06a7ac9185e08de041264) | R | ops | ops(endo): gate broker retirement on preserved identities |
| [f502c87de](https://github.com/kumavis/endo-host/commit/f502c87de1d1a9516a81ad6306c443dd70c760d6) | R | ops | test(endo): reject incomplete restoration backend coverage |
| [e303296f0](https://github.com/kumavis/endo-host/commit/e303296f059e67b9014f16cc2f6b8306f81c9db4) | R | ops | ops(endo): retire exact obsolete hosted formulas safely |
| [3a4bdb7c1](https://github.com/kumavis/endo-host/commit/3a4bdb7c1b029a49f68989c7b606abdd8b31ba74) | R | ops | test(endo): exercise hosted tools and network policy with durable evidence |
| [f48d95d65](https://github.com/kumavis/endo-host/commit/f48d95d654036c7f336021b9341b859bf7023f78) | R | endo.rev | deploy(endo): pin shared-image Codex verifier correction |
| [91eb78593](https://github.com/kumavis/endo-host/commit/91eb785937692156f38be26b04d44befe59448bf) | R | ops | test(endo): allow isolated direct-provider restoration acceptance |
| [336ae3dbb](https://github.com/kumavis/endo-host/commit/336ae3dbb4c8885bc6dbeda381dc6836c8501b14) | D | ops | docs(endo): record cutover acceptance progress and remaining gates |
| [1ee433059](https://github.com/kumavis/endo-host/commit/1ee4330591724c572fbd08a387ad4a83e384ccd3) | R | ops | test(endo): validate real hosted tools and in-flight cancellation |
| [c9f7ca9f7](https://github.com/kumavis/endo-host/commit/c9f7ca9f7bcd19280c616ee9035456377a8bf42b) | R | ops | test(endo): verify direct provider tool use and streaming cancellation |
| [63902cffd](https://github.com/kumavis/endo-host/commit/63902cffd9f9438bf9356541037c7d37b329b2e7) | R | ops | test(endo): distinguish buffered provider cancellation evidence |
| [3f2106da5](https://github.com/kumavis/endo-host/commit/3f2106da5b76adeb77592156a029b1156cccd105) | D | ops | docs(endo): record tool policy and cancellation findings |
| [629c227b0](https://github.com/kumavis/endo-host/commit/629c227b0f80ef84be7cd2932e64ff7bf16c9966) | R | ops | test(endo): preserve uncertain effects in cancellation acceptance |
| [bc66623fb](https://github.com/kumavis/endo-host/commit/bc66623fb2cf4654b9e9604c47140244b0eee310) | R | ops | test(endo): scope restoration acceptance cleanup to verified identities |
| [7b584a2fe](https://github.com/kumavis/endo-host/commit/7b584a2fe4ecbb7551cff953c5750de4e78e9137) | R | ops | docs(endo): verify shared-image restoration conformance |
| [49466db4c](https://github.com/kumavis/endo-host/commit/49466db4ccbc6ab4be2bd7e4cf7ae9db51e21f2a) | D | ops | docs(endo): close scoped cutover acceptance and cleanup |
| [228558562](https://github.com/kumavis/endo-host/commit/2285585624327140cfa3e5b72d998d0f06f2e713) | R | ops | ops: prepare workspace preservation for second hosted cutover |
| [9245afca2](https://github.com/kumavis/endo-host/commit/9245afca22d16aa7b54c7be1be2bebef9248907e) | R | endo.rev, hosts, ops | ops: pin private journal and fresh OpenCode cutover candidate |
| [68402d70f](https://github.com/kumavis/endo-host/commit/68402d70f8483ceb25f9c5733651690d53566dee) | R | ops | ops: scope broker retirement inventory to approved snapshot |
| [14568eb24](https://github.com/kumavis/endo-host/commit/14568eb245645585328a83c6eca189369c0b307a) | R | ops | ops: retire archived direct-provider session through lifecycle API |
| [9bd218af7](https://github.com/kumavis/endo-host/commit/9bd218af72a6fc1f97afd5d0ea9951c19defe6d6) | D | ops | docs: record coordinated cleanup deployment and preservation |
| [ed22ee30c](https://github.com/kumavis/endo-host/commit/ed22ee30c2c04abe6c2dbec8e23cbea64df283b7) | R | ops | test: accept current Floot session identities in cutover drivers |
| [5a8e5f452](https://github.com/kumavis/endo-host/commit/5a8e5f45235802371a1d546944b279a2e4db9bf6) | R | ops | test: require Luna and free OpenRouter routes for acceptance |
| [84a6b90dc](https://github.com/kumavis/endo-host/commit/84a6b90dc4971a143165d4a3912531732a7744d8) | R | endo.rev, hosts, modules, ops | deploy: pin discovery release; remove the NixOS Codex model list |
| [a3b7b6532](https://github.com/kumavis/endo-host/commit/a3b7b6532df1d4f00c0839098cdda22af8d505e5) | R | ops | ops: name the restoration cleanup's manifests; accept a later turn |
| [aedb83014](https://github.com/kumavis/endo-host/commit/aedb83014ccf422b64783b3e27bff237d89b4635) | R | ops | ops: record the discovery cutover; pin Claude acceptance; read quoted commands |
| [72490dcb0](https://github.com/kumavis/endo-host/commit/72490dcb0a90512ba7c97d5e69ff1605453a9532) | R | endo.rev | deploy: pin the release without the fail-closed native teardown |
| [5c9029c76](https://github.com/kumavis/endo-host/commit/5c9029c76547b11fa818fb5d751d394d2003839a) | R | ops | ops: record the second activation; cleanup helper accepts any seed day |
| [05c275ba8](https://github.com/kumavis/endo-host/commit/05c275ba833b043bbe9406bea6b697263ce47f85) | R | ops | ops: choose the subscription check's model by policy, not by row order |
| [83b5639a6](https://github.com/kumavis/endo-host/commit/83b5639a6f9a7e519828a4279a544321b8dbe270) | R | endo.rev | deploy: pin the picker-order release |
| [c2cf720e4](https://github.com/kumavis/endo-host/commit/c2cf720e450c05d9fb360bc8a413f4ebb201abd2) | D | ops | ops: record the third activation (picker order, no session on load) |
| [4f3e2bc09](https://github.com/kumavis/endo-host/commit/4f3e2bc09ac1bd76e121e12463f7138bb7481819) | R | endo.rev | deploy: pin the thinking-fold release |
| [a3b57642a](https://github.com/kumavis/endo-host/commit/a3b57642a3d16265e60c8c8a606ee7e1173f8217) | D | ops | ops: record the fourth activation (thinking folded into actions) |
| [92002a4b3](https://github.com/kumavis/endo-host/commit/92002a4b3a5903d23cc279f223efe8e9f34f85d5) | R | ops | ops: FA-11/FA-12 legacy retirement helpers and inventory reconciliation |
| [b090439d1](https://github.com/kumavis/endo-host/commit/b090439d10a66acc5f88ea3ba85bba5661fe24b9) | D | ops | ops: record the FA-11/FA-12 retirement run (generation 163, 2026-09-22) |
| [acd3e4dbc](https://github.com/kumavis/endo-host/commit/acd3e4dbc33c90fc0e6a589f51b37fe44f566334) | R | endo.rev | deploy: pin the FA-06/FA-08/FA-10 release |
| [2df64cafc](https://github.com/kumavis/endo-host/commit/2df64cafc86568979b6f338065eb473024669944) | R | hosts | deploy: name the primary Codex Secret codex-subscription-1 |
| [a29a17af7](https://github.com/kumavis/endo-host/commit/a29a17af7cf83a5d890713ae050209473cfde5e5) | R | ops | ops: record the fourth cutover (generation 165, wipe model) |
| [eebdda453](https://github.com/kumavis/endo-host/commit/eebdda453df8ff424aa7cba17cf209a2324834ff) | R | ops | ops: read the Codex plan image from rootfs |
| [338d594cc](https://github.com/kumavis/endo-host/commit/338d594ccb30be146544b14cae7dba6a0493e264) | R | hosts, modules, ops | config: declare each hosted backend's account authority |
| [2a059a2c0](https://github.com/kumavis/endo-host/commit/2a059a2c0613e638fec194965d45d97e0038b03d) | R | ops | fix(ops): stop acceptance runners on failed evidence |
| [f2fa6c75e](https://github.com/kumavis/endo-host/commit/f2fa6c75e06f301503523da64123be6f399469f9) | R | ops | test(ops): prepare guarded live rebind acceptance |
| [5827da08d](https://github.com/kumavis/endo-host/commit/5827da08d34c350789cce7db7a455037a1d6bbc8) | R | endo.rev, ops | deploy: pin prebuilt binding-vocabulary release |
| [b66c1a075](https://github.com/kumavis/endo-host/commit/b66c1a075bf3acee7dec87191392e4aed330a75f) | D | ops | docs: record paired build and maintenance startup gates |
| [bcdfb9430](https://github.com/kumavis/endo-host/commit/bcdfb943035718a83ae0f5088bb7f0b2b1a221aa) | R | ops | fix(ops): detach old broker names without reviving formulas |
| [efe67487e](https://github.com/kumavis/endo-host/commit/efe67487e228e2e153808db13b691f0dc9aebfc6) | R | ops | chore(ops): inspect workflow stores before hosted cutover |
| [d696a8820](https://github.com/kumavis/endo-host/commit/d696a8820ec08c2b88cf14fe7e3dad9ebb59dae7) | R | ops | chore(ops): verify workflow startup records before retirement |
| [03c0a837e](https://github.com/kumavis/endo-host/commit/03c0a837e5d3f518b7210fe1015d2447eb56369e) | D | ops | docs(ops): record preservation-safe generation 166 cutover |
| [29fdf23a3](https://github.com/kumavis/endo-host/commit/29fdf23a3b567f4d63e059eeff752694f518936f) | D | ops | docs(ops): record policy cancellation and cleanup acceptance |
| [72e531f84](https://github.com/kumavis/endo-host/commit/72e531f84ab87a15c3996501125c80ee4e5ef041) | D | ops | docs(ops): record restoration passes and empty Fae failure |
| [31a820a3f](https://github.com/kumavis/endo-host/commit/31a820a3f40b4f71dcf5fab2e312ea47f2837fd5) | R | endo.rev, ops | chore(deploy): pin empty OpenRouter response validation |
| [ad6c56bf2](https://github.com/kumavis/endo-host/commit/ad6c56bf22c3f806ece51054a040f7fc5528d73b) | D | ops | docs(ops): record generation 167 restoration acceptance |
| [7708500a2](https://github.com/kumavis/endo-host/commit/7708500a2d63bf89c2e0063fa809139435119eab) | R | ops | chore(ops): scope broker retirement for live rebind acceptance |
| [f69038a9e](https://github.com/kumavis/endo-host/commit/f69038a9e2246ef799c298e7582de73b3bc74f68) | R | ops | fix(ops): accept released incarnation refs after native stop |
| [d567fb19f](https://github.com/kumavis/endo-host/commit/d567fb19f3860d92f9f157d2c31d7af092ee05dc) | D | ops | docs(ops): record provider-only rebind acceptance |
| [ede85c6e5](https://github.com/kumavis/endo-host/commit/ede85c6e53e8673a05bf65a55ea4b480be16686f) | R | ops | test(ops): permit guarded image and provider rebind cutover |
| [18115b4f9](https://github.com/kumavis/endo-host/commit/18115b4f96d6b76ce40837bd723e3bd6dead5cb1) | R | hosts, ops | chore(deploy): prepare OpenCode image rebind candidate |
| [84a25c57d](https://github.com/kumavis/endo-host/commit/84a25c57d65e054d7c0c0a039848b7cfb0540d4f) | R | ops | docs(ops): verify image rebind and restoration on generation 168 |
| [7dbf7c365](https://github.com/kumavis/endo-host/commit/7dbf7c36520b13e18d1a4c294bb1512248d43c0b) | R | endo.rev, ops | deploy: pin context restoration and usage accounting fixes |
| [59d1856c5](https://github.com/kumavis/endo-host/commit/59d1856c50ced39602ca9810e3554aa93de38948) | D | ops | docs(ops): record generation 169 restoration acceptance |
| [de4cb38c2](https://github.com/kumavis/endo-host/commit/de4cb38c26b5ed7f4462f7e28fe428a47b301b5b) | R | endo.rev, hosts, ops | chore(host): pin native compaction checkpoint candidate |
| [5d1a60c26](https://github.com/kumavis/endo-host/commit/5d1a60c26b9a2d7e26a91dd5f556cd7cee74481a) | R | ops | fix(ops): inspect persisted direct-provider sessions |
| [397875433](https://github.com/kumavis/endo-host/commit/397875433bbd443f56bc6c6a5e931630e3d077c9) | R | ops | chore(ops): scope OpenCode broker image cutover |
| [344c2ff88](https://github.com/kumavis/endo-host/commit/344c2ff8840c710d36d8635a7db82bde657b42f2) | D | ops | docs(ops): record cutover approval boundary |
| [b9672a0ba](https://github.com/kumavis/endo-host/commit/b9672a0ba356123abd323fb4675fb45c75994632) | R | ops | docs(ops): prepare latest Floot audit candidate without activation |
| [90f80f925](https://github.com/kumavis/endo-host/commit/90f80f9258a53f87d894c8852baea6fb82009c00) | D | ops | docs(ops): record successful latest audit prebuild |
| [bc3fa5a17](https://github.com/kumavis/endo-host/commit/bc3fa5a17ee709354e9360d4a46fcebc0b562d44) | R | endo.rev, hosts, ops | chore(host): pin latest Floot audit deployment candidate |
| [2945ed9b4](https://github.com/kumavis/endo-host/commit/2945ed9b4afd147d69e09338d57bb7684e82ae08) | D | ops | docs(ops): record paired audit candidate preparation |
| [6ecef6e91](https://github.com/kumavis/endo-host/commit/6ecef6e91b8656aed845c4d71377d5fb7e7ec735) | R | endo.rev, ops | chore(endo): prepare audited provider refresh candidate |
| [5f46ddece](https://github.com/kumavis/endo-host/commit/5f46ddece83ff98769b31d7257f8358da741695b) | D | ops | docs(ops): record latest paired candidate preparation |
| [9dd03ff93](https://github.com/kumavis/endo-host/commit/9dd03ff93a19d5e25224c8beacf2566ffbf3ecdd) | D | ops | docs(ops): record fresh mixed-session retirement preflight |
| [15ea8c3c6](https://github.com/kumavis/endo-host/commit/15ea8c3c6a185e7809c507d9495217cc22627184) | R | ops | ops: prepare provider-limit native image candidate |
| [9636e419f](https://github.com/kumavis/endo-host/commit/9636e419fb7b07d07b7a135c258f965533cfbab3) | R | endo.rev, hosts, ops | ops: pin rebuilt provider-limit candidate |
| [54ef09944](https://github.com/kumavis/endo-host/commit/54ef099445b3ccba072b7134745172c8163fd2a1) | D | ops | docs(ops): record paired provider-limit preparation |
| [fc32194d0](https://github.com/kumavis/endo-host/commit/fc32194d06027f57bd96d045f944ccaad3da4ff2) | D | ops | docs(ops): gate activation on native window correction |
| [95e0d8814](https://github.com/kumavis/endo-host/commit/95e0d88147988e58e6f8353fb035e5b82fa809f8) | R | endo.rev, hosts, ops | ops: prepare context-bounded compaction candidate |
| [5959fbff2](https://github.com/kumavis/endo-host/commit/5959fbff2672355d03b3373f50ac4f110b8bcdc2) | D | ops | docs(ops): record corrected candidate preparation |
