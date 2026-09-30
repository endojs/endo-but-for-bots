# Hosted-agent simplification audit

Date: 2026-09-24.
Starting revision: `a297668b2` on PR #1248.
This audits current source, not every historical commit or Tokyo's older release.
The target is one owner per responsibility, not the smallest possible line count.
Fae compaction remains on hold.
Process-loss recovery remains the separate investigation tracked in PR #1323.

Current deployment: generation 188 runs app `5adeb4aa9` and host `934204f`,
including the September 30 setup/model/MCP deletions and admission/dispatch
separation below. All four backends pass fresh lifecycle and ordinary restart
acceptance. Earlier not-deployed notes describe the state when those slices landed.
The architecture audit records exact coverage and the outstanding initial Claude
tool-seed capture omission; no universal capture or process-loss claim is made.

## Native-context mechanism inventory, 2026-09-30

Current-source follow-up at `59fe1a5bd`; this supplements the earlier inventory,
which predates most native capture/restoration code.

| Mechanism | Responsibility and decision |
|---|---|
| Claude `claude-context-coverage.js` | Transient comparison of observed stream, restored prefix and captured cut. Retain separately from parsing native files; it does not own durable conversation or certify host effects. |
| Claude `oci/capture-compaction.mjs` | Selects ordinary/compacted native chains inside the sandbox and preserves supported opaque/signed records. Retain; exports data to the existing Floot journal. |
| Claude `oci/restore-context.mjs` and `native-context-projection.mjs` | Reuse the capture validator and shared renderer to publish a disposable projection with preserved prefix bytes and permitted dialogue suffix. Retain; no additional durable owner. |
| Claude `claude-transcript-writer.js` | Still used for initial portable history and the approved transcript-continuity fallback. Not dead code: unlike native import, this cannot preserve signed reasoning. |
| Codex `oci/native-context.mjs` | Backend-specific rollout selection and rendering, including opaque compaction items and host-selected runtime metadata. Retain protocol-specific logic rather than merging unlike formats. |
| Codex `oci/context-io.mjs` | Sandbox-local file reads, mutation checks and no-overwrite projection publication. Retain this filesystem boundary separately from pure selection. |
| Codex `oci/context-command.mjs` and `src/native-context-transport.js` | Bounded one-shot exchange and owned helper cancellation/reaping. Retain separately from the long-lived app-server connection; neither owns conversation state. |
| Floot `hosted-turn.js`, `turn-journal.js`, `context-transcript.js` | Journal the native envelope before completion/acknowledgement and select host-owned context. Keep this shared ownership boundary; native payloads cannot settle host effects. |

Both adapters now define their native wire shape once in their own
`oci/native-context-shape.mjs`.
A coincidentally equal transport limit does not justify merging the different
native formats or adding another framework.
These retained layers explain responsibilities, not a claim that the overall
refactor is smaller or that lifetime context is bounded.

Follow-up deletions, 2026-09-30:

- Removed Codex `restoreCodexContext`'s unused `sha256` receipt and computation:
  `codex-client.js` reads only `sessionId` and `rolloutPath`.
  Exact-byte tests, atomic publication and no-overwrite checks remain.
  Do not confuse it with Claude's actively checked `prefixSha256` receipt.
- Moved Codex's whole-string `selectCodexNativeContext` convenience into its only
  test file; production keeps the incremental selector.
  This is surface cleanup, not a substantive complexity reduction.

All 429 Codex tests pass; independent review passes 57 focused tests.
Package typechecking still reports unrelated fixture errors, with none in the
changed files. Formatting passes.
No durable state owner, journal format or publication semantics change.
These image-source deletions are deployed in generation 186.
The rebuilt Codex image passed its hosted matrix and restart recall; its pin is
verified in the host ledger.
Fae compaction and evidence-storage scaling remain deferred as directed.

## Scope attribution against the design baseline, 2026-09-30

At `5b6ce56db`, shared hosted-agent source grew from 4,298 to 24,227 lines.
The following disjoint filename buckets reconcile its 19,929-line increase.
They are accounting categories, not a claim that each increase was necessary.
The counting exclusions and four-package totals are in RA-01 of the alignment doc.

| Shared-package category | Baseline | Current | Change |
|---|---:|---:|---:|
| Provider/public network | 2,836 | 8,120 | +5,284 |
| Accounts/catalogs/credentials/pools/reset | 891 | 5,974 | +5,083 |
| Lifecycle/policy/storage | 0 | 3,440 | +3,440 |
| Delegated runners/subscription sharing | 0 | 2,114 | +2,114 |
| Setup/specifiers | 0 | 1,868 | +1,868 |
| MCP | 0 | 728 | +728 |
| Transcript/channel/usage | 0 | 871 | +871 |
| Other | 571 | 1,112 | +541 |

For reproduction, assign basenames by first matching prefix in this order:
`delegated-runner|subscription-share|share-meter`;
`account|reset-|subscription-(pool|lister|module|admin)|broker-subscription|pool-|managed-|memory-oauth|model-catalog|backend-catalog|anthropic-model|codex-model|openrouter-|rate-limit`;
`hosted-setup|hosted-backend-setup|current-specifier`;
`session-|execution-envelope|backend-factory-kit|recorded-cleanup|cleanup-scope|workspace-projection|hosted-agent-policy`;
`mcp-`; `transcript-records|turn-channel|token-usage`; `provider-|public-`; other.
These map to the table's categories, not its displayed row order.

Actual caller comparison distinguishes relocation from additional contracts:

- Public egress, egress listener and DNS listener total 1,009 lines now and at
  baseline in Codex (435/341/233). Baseline `hosted-subscription.js` used them.
  Moving them into hosted-agent did not add 1,009 lines to the combined system.
- The two baseline MCP implementations total 1,189 lines; the current shared
  modules total 728 plus adapter configuration wrappers. Current controllers
  call the shared bridge/server. This is real consolidation, but 461 is not an
  exact net saving because retained wrapper responsibilities must also count.
- Baseline Claude/OpenCode provisioning modules total 1,577 lines, with further
  mount/revoke/dispose plumbing inside clients. The current shared provisioner,
  supervisor and envelope replace those live ownership paths. Their category
  also includes explicit plans, recorded cleanup and common policy/storage;
  subtracting only 1,577 would not be a like-for-like complexity comparison.
- Codex's baseline volume/provider/registry files total 1,035 lines. Their removal
  is concrete simplification, but shared native storage also serves Claude and
  must not be attributed entirely to replacing Codex's old volumes.
- The shared broker replaces composition in Codex's `hosted-subscription.js` and
  OpenCode's broker, and the old 337-line shared lease issuer is gone. Its larger
  replacement also handles durable configuration, pooling and delegation.
- Delegated runners/shares add separately delegated session ownership, quotas
  and nested sharing, with live setup/formula callers. Accounts now add pool
  selection, exact identity publication, reset administration and provider model
  discovery beyond baseline observation. Native capture/import adds opaque
  continuation beyond baseline portable history. These explain scope growth;
  they do not demonstrate minimal implementations or waive the size requirement.

All three adapters call the shared factory, provisioner, supervisor, execution
envelope and recorded-storage implementation. This inspection found no remaining
parallel vendor lifecycle algorithm. Request-shape checks and persisted-plan
authorization checks protect different boundaries; session-storage and native
state-storage own different resources and are not interchangeable duplicates.
RA-01's numerical target remains unproven; do not remove working safety or
delegation contracts solely to force the total below the original baseline.

The follow-up removes Codex's sole-caller `codex-session-storage.js` parser-injection
wrapper, calling the same shared factory from its unchanged formula entrypoint.
This is surface cleanup only: roots, state authority and plan parsing are unchanged.
OpenCode's cleanup comment now describes conditional recorded reclamation instead
of claiming reconstruction always refuses. No new recovery guarantee is added.
Validation: 430 Codex tests, 30 OpenCode controller tests, scoped lint, formatting
and the root documentation gate pass. This final wrapper/comment slice is not
deployed; generation 186 contains the preceding native-context cleanup.

## Decisions on remaining parallel mechanisms

### Account model authority and adapter deletions, 2026-09-30

Codex's hosted `run.models()` used the native app-server catalog, while creation
and admission used the provider/account catalog. Claude and OpenCode already use
the latter for their hosted lists. Native descriptors were reduced to the same
shared shape; no hosted consumer needed distinct native capability metadata.
Codex now calls the existing `catalog.offered(subscription)` too: automatic pools
exclude pinned-only members, and an explicitly pinned session lists only its
account's models. The native-model normalization module and export are deleted.
The low-level native query and its supervisor/daemon proxies are now deleted.
Transport initialization tests use the existing checkpoint acknowledgement path;
startup failure, cancellation, teardown and inherited-auth coverage remain.
All 430 Codex tests, six supervisor tests and 16 session-owner tests pass.
The three affected package typechecks and scoped lint pass; independent review
approves the deletion and retained coverage.
No credential owner, model admission rule or persisted plan changes.

OpenCode's sole-caller storage parser-injection wrapper is also deleted.
Its durable `make` module now calls the same shared storage constructor with the
same roots and parser; the formula entrypoint is retained unchanged.
Unused adapter MCP constants are removed without changing socket/config paths.
These changes are not yet deployed.

Setup follow-up removes the redundant remove-before-copy publication step and
reuses `bindFlootBackend` in Codex. Directory `copy` already owns replacement;
prepublication failure keeps the old binding, and retry remains possible.
All 57 setup tests and both affected package typechecks pass; independent review
approves. No persistent schema or environment names change. Not deployed.
OpenCode's diagnostic-only MCP configuration file and adapter transport wrapper
are now removed, retaining its actual `OPENCODE_CONFIG_CONTENT`.
The shared MCP transport owns sockets and relay lifetime; adapters own only the
configuration their native runtime actually consumes.
Transport-only consumers omit the existing config builder; Claude still supplies
its builder and receives its required config file under the same lifecycle fences.
The seven transport tests now live in hosted-agent rather than OpenCode.
Those tests, 22 focused Claude tests and all 299 remaining OpenCode tests pass.
Root type build, all 14 type-contract tasks and documentation pass (zero errors,
180 warnings); affected typechecks and scoped lint pass.
Independent review approves. No durable owner or storage schema changes.
Not deployed.

The context review also reproduced a distinct intent/execution conflation:
an `onBegun` cancellation before any native send leaves a cancelled turn carrying
`nativeContextFormat`; a later Codex turn refuses it as unsafe native evidence.
The correction separates admission (`begin`) from a write-ahead
`dispatch-intent` acknowledged before either runtime may send.
A declared context format is not evidence of native dispatch, and an empty
observed stream is not proof that no dispatch happened.
The journal explicitly records `not-dispatched` or `possibly-dispatched`.
Only the former is omitted from model continuation; both remain in history.
The marker is conservative across a lost acknowledgement and never claims that
the backend executed anything or stopped safely.
This is a journal-format replacement, not a migration: legacy admission events
and version-2 snapshots/archives are rejected.
Deployment must retire affected test sessions first, preserving host, Secrets,
renewal owners and workspaces.
All 777 Floot tests pass; Floot types and lint pass (zero errors, 286 warnings).
Clean root type build, all 14 type-contract tasks and docs pass (zero errors,
180 warnings). Independent adversarial review approves. Not deployed.
Do not repair this by silently treating all empty cancelled turns as safe or by
overloading transcript completeness with an undocumented dispatch guarantee.

Next verified duplication: context projection's `comparable()` duplicates
Claude's `toolInput()` object/wrapper conversion from the transcript writer.
Do not delete evidence deduplication: late host-only/unsettled evidence remains
eligible after a newer checkpoint, and deleting matching would repeat it.
Reuse the existing adapter-owned conversion through a local comparison-key
function supplied at Floot's composition boundary for `claude-code-jsonl-v1`;
other formats should compare exact arguments.
Keep pairing, late-result reconciliation and collision handling in Floot.
No remote API, descriptor schema, codec registry or durable state is needed.
Test real writer/read-back equivalence for whitespace, scalar, array, null and
malformed arguments, changed results, and isolation from non-Claude formats.

| Mechanisms | Different responsibilities | Decision |
|---|---|---|
| Floot lifecycle registry; daemon session record | The registry stores application identity, captured configuration and references. The daemon record stores the execution plan, dependency identities and incarnation lifecycle. | Retain. Neither is a second conversation store; runtime removal and conversation deletion are different operations. |
| Pending queue; Floot turn journal | The queue holds submissions not yet admitted to inference. The journal records admitted turns, dialogue, mediated effects, outcomes and context. | Retain the admission boundary. Do not discard queued submissions to avoid a separate durable record. |
| Floot journal; native turn ledger/thread checkpoint | Floot owns conversation and effect evidence. Native checkpoints reconcile adapter requests and native acknowledgement after restoration. | Retain reconciliation, not a competing source of conversation truth. Native context is projected from host-selected journal records. |
| Codex diagnostic writer; Floot journal | Native approvals, denials, identifiers and late-result diagnostics are not all mediated Endo effects. Required diagnostic write failure fences the adapter. | Retain diagnostic events and full payload storage, not a second effect authority. The V2 writer serializes writes and fences its incarnation after any uncertain write. |
| Codex diagnostic entries; former audit anchors | Both were under the same trusted host; a separate anchor was not an independent security boundary. | Remove anchors, chain hashes and prepared-head replay. Existing atomic entry storage is the commit boundary. Reconstruct from contiguous entry names and the V2 tail. Historical tamper/suffix-deletion detection and prepared-anchor repair are explicitly no longer promised. |
| Session provisioner; supervisor; execution envelope | The provisioner creates/reopens durable plans. The supervisor owns one live incarnation and its cleanup. The envelope acquires and verifies granted execution resources. | Retain these phases. All three backends already call the shared implementations. Do not create a fourth lifecycle abstraction. |
| Cleanup scope/resource registry; recorded cleanup | Live registries retain acquired handles and failed release attempts. Recorded cleanup acts on recorded paths when those handles no longer exist. | Retain the distinction. Recorded-path probes do not prove native process shutdown; #1323 remains open. |
| Session storage; native state storage | Session storage removes plan-owned directories and preserves external workspaces. Native state storage owns CLI state placement and private records. | Retain the authority/placement distinction. Do not treat naming similarity as duplicate ownership. |
| Three native clients | Claude uses subprocess JSONL, Codex app-server requests/dynamic tools, and OpenCode bridge/SSE. | Retain protocol state machines. Shared admission/cancellation conformance is the next evidence needed before extracting more code. |
| MCP configuration adapters | Claude requires `mcpServers`/stdio; OpenCode requires its `mcp` local-server shape. Socket ownership and relay transport are already shared. | Retain configuration builders; remove duplicate unused startup/cleanup convenience paths. |
| Inference proxy; public egress proxy | Inference injects host-held credentials to fixed provider destinations. Public egress grants arbitrary public destinations without credential access. | Retain separate grants, policy and revocation. Combining them would conflate authority. |
| Managed static credentials; renewable credentials; pool identity journal | Static credentials delegate Secret reads. Renewable owners exchange and rotate credential material. Pool records bind exact member capabilities across reconstruction. | Retain these distinct responsibilities. No new credential owner is introduced by discovery. |
| Account bindings; account source/oracle; reset administrator | Bindings declare account identity and runtime uses. Sources/oracles observe capacity. Administrators hold reset authority and intent records. | Retain explicit separation. UI identity must not derive from an observer or runtime name. |

Primary implementation references are `floot/agent.js`, `floot/src/pending-queue.js`,
`floot/src/turn-journal.js`, `daemon/src/session-record-store.js`,
`hosted-agent/src/session-provisioner.js`, `session-supervisor.js`,
`execution-envelope.js`, `session-storage.js`, `session-state-storage.js`,
`recorded-cleanup.js`, and the three native controllers.
The Codex writer/checkpoint distinction is detailed in
[Codex's design](../codex-sandbox/DESIGN.md#journal-and-checkpoint-responsibilities).

## Deletions in this pass

- Remove the old shared and Claude/OpenCode rootfs-selection parsers, their
  exports and exclusive tests.
  Current setup resolves image pins; the shared plan parser requires pinned OCI
  placement; controllers report that validated plan value directly.
  The removed selection parsers accepted `host-bind`, `minimal` and default image
  selection but had no runtime callers.
  The formerly used formatting wrapper is replaced by the validated plan value.
  Generic sandbox support for other rootfs modes is not removed.
- Remove both `startMcpSocketServer` convenience functions.
  Production already retains `makeMcpSocketServer` before startup so failed cleanup
  remains retryable.
  Tests now use the same lifecycle and register teardown before acquisition.
- Remove Codex's unused audit-reader facet and its content-read plumbing.
  Production uses only the writer; content storage, append integrity, repair and
  native thread reconciliation remain.
  Serialized appends also make reader-era concurrent recovery memoization redundant.
- Remove obsolete preset prompt examples and their legacy composition helper.
  Creation composes the current prompt explicitly; restoration uses the captured
  prompt, not today's preset.
- Remove the session-watch transcript reexports and the hosted session-registry
  alias module.
  Consumers name the existing implementation directly; no replacement abstraction
  or storage format is added.

These are source/API retirements, not live resource cleanup.
The removed functions are not persisted `make` formula entrypoints.
Old deployments still require the coordinated retirement/deployment plan already
recorded in the alignment audit.

## Remaining findings, not hidden by the deletions

1. Completed: remove plaintext `authToken` fallback from both provider setup
   paths, the credential resolver and the provider cache.
   Inline runtime-config fields reject even when empty or beside a Secret.
   A failed Secret import cannot publish a replacement provider config.
   Tokenless local-provider configurations remain supported.
   Explicit raw-token form imports are still stored in daemon form messages before
   import; use an existing Secret reference to avoid that separate ingestion path.
   No historical credential erasure or compaction work is claimed.
2. Completed: session `getAccount()` and `accountStatus` select published accounts
   by the session's backend and optional subscription pin on the same use binding.
   Automatic pools report configured candidates, not current eligibility, route
   or the payer of past turns.
   Available usage remains session-wide and is not priced against an unrelated
   account; an unloaded session reports usage unavailable rather than starting a
   backend merely to read account status.
   Factory-level direct-provider observation remains a distinct API.
3. Completed: the exported streaming-agent constructor requires explicit
   `journalPowers`; missing or null storage refuses before guest access.
   Callers must supply private storage, not a guest-visible namespace.
   Capability identity cannot establish privacy, so status reports `explicit`
   rather than inferring private ownership from unequal objects.
   The factory still supplies its existing private storage adapter; no durable
   owner, storage format or formula dependency changes.
   Standalone test fixtures explicitly supply their intended storage.
4. Completed: removed Codex's unused `locateSessionDirectory` method and its
   exclusive test.
   Current controllers prepare the host-record directory before reading the
   checkpoint; the old pre-provision lookup explanation no longer applied.
   State ownership, separate CLI homes, symlink refusal and removal checks remain.
5. Completed: Codex's V2 diagnostic writer retains event kinds, full payload
   storage and awaited required writes, but removes hash-chain/head machinery.
   Any rejected write permanently fences that writer instance, since the write
   may have landed; a reconstructed writer cannot overwrite a landed entry.
   Contiguous filenames and the last entry's binding/version are checked without
   scanning every historical payload.
   This assumes one writer per session under the existing owner, not new
   cross-process exclusion or process-loss recovery.
   Old anchored layouts and V1 tails refuse and require session retirement.
   Floot effects and the operational native thread checkpoint are unchanged.

## Validation and conclusion

Initial deletion pass: independent adversarial review approved each deletion slice and this inventory.
The five affected full package suites pass 2,593 tests, with one hosted-agent test
skipped; scoped lint has no errors.
Full-suite verification also corrected old account-publication setup fixtures in
a separate test-only change, preserving their positive provisioning assertions.
Further type-check limitations and test results are recorded in the parent
[alignment audit](REFACTOR-ALIGNMENT.md#ra-01--demonstrate-simplification-not-merely-relocation).
Runtime JavaScript has 291 fewer lines in this pass (including comments, excluding
tests and documentation).
This pass removes concrete parallel and unused APIs without adding a framework.
Follow-up implementation closes items 1 through 5 above under their stated
contracts.
The follow-up full suites pass: Floot 713, Codex 423, and Fae 174 plus two
expected failures (successful exit). Two real-daemon account-publication and
Codex context-restoration regressions pass. Independent adversarial review
approved each follow-up slice, including a final 26-test passive-account check.
Scoped lint has no errors, and the root documentation/API gate passes.
Test-inclusive type checks retain unrelated fixture errors; no changed production
source type errors were reported. Fae compaction remains on hold.
Item 3 subsequently passes all 714 Floot tests and seven real-daemon journal,
retirement and native-context restart tests. Scoped lint and the root
documentation/API gate pass; the factory's existing storage ownership is retained.
It does not prove that the entire refactor is smaller than its original baseline.
Tokyo activated the explicit-storage revision `d8d8db599` on generation 170.
Initial setup rejected legacy Claude/Codex credential wrappers.
The approved renewal-owner retirement archived the old generations and recreated
owners over the same Secrets, without clearing uncertain-renewal markers.
Live metadata checks preserve all six Secrets, four archived guest/workspace roots, eight
old renewal roots, and retained account/reset journals.
All four backends pass model discovery; direct Fae passes free-route tool use
and pending-turn cancellation.
Hosted acceptance exposed OpenCode catalog-ID normalization and Claude/Codex
native-context completion failures; fixes and renewed acceptance are in progress.
The OpenCode fix preserves provider-scoped IDs and passes 304 tests.
The Codex correction permits its app server and serialized context helper to
coexist, dividing the existing aggregate memory/PID/CPU ceilings across three
containers (including the anchor); other backends retain one operation.
Its full suite passes 425 tests, and shared/controller checks pass 75 with one skip.
Claude now reports static coverage phase/check diagnostics without weakening
validation (175 coverage/client tests pass); its underlying failure is still under
investigation.
See the host repository's
`ops/explicit-journal-deployment-20260924.md` for exact pins and evidence.
No successful cross-backend acceptance or new crash-recovery guarantee is claimed.

### Deployment follow-up, generation 173

Item 3 and bounded live fixes are pushed and deployed (`cc4228989`).
Fae and OpenCode pass restart/recall; Codex and OpenCode pass tool use,
public/private/off network checks and cancellation evidence under generation 171.
Claude's validated capacity-notification handling passes 432 local tests, but
generation-173 tests expose further message-delta framing and reconstructed-block
equality failures. JSON-string equality is independently property-order-sensitive;
its role in the live mismatch still needs structural evidence.
Codex's fresh seed completes, but recall reaches a stopped native incarnation;
separate new-session grant admission loses its inner diagnostic reasons.
These remaining protocol/restoration findings require scoped follow-up, not a
silent relaxation of context coverage or expansion into the deferred process-loss
design. The refactor's cross-backend live acceptance is not complete.

### Claude validation follow-up, September 25

Generation 174 deployed `696e06289`: context comparison now ignores JSON object
property order while retaining exact values/key sets, and message deltas accept
the provider's nullable `container` and `stop_details` fields only when null.
All 449 Claude tests passed, with independent adversarial review.
Fresh live tests still failed: the tool turn at assistant-block equality, and
the short response later in native capture.
These fixes therefore do not establish the full cause or successful acceptance.

Reviewed diagnostic revision `3b4575efd` adds fixed-field mismatch categories and
static local capture rejection reasons, never transcript values or unknown keys.
All 454 Claude tests pass; no acceptance predicate is relaxed by diagnostics.
Read-only inspection of the retained short transcript identifies unsupported
`agent_listing_delta` and `skill_listing` attachments.
They contain actual model-visible guidance, not merely accounting metadata.
The pinned Claude CLI omits these attachments from the public event stream;
its initialization catalog does not attest their complete contents.
The approved guest-domain design permits native context mutation; provider
authenticity is not a prerequisite for preservation (see the scope correction in
[refactor alignment](REFACTOR-ALIGNMENT.md)).
Support must preserve these context-bearing records and their ordering without
silently treating them as inert or using them to certify host tool effects.
The earlier proposed request-side authenticity gate was outside that scope.
Native tool blocks also carry `caller`, but without the original partial stream
that is only a candidate explanation for the tool mismatch, not a proven cause.
No failed inference was replayed and no uncertainty marker was cleared.

### Claude user-acceptance findings, September 25

Operator testing on generation 175 found every Claude session unusable after
its first message. Three independent causes, plus one deployment gap:

- Generation 175's Claude setup refused the new image: the retained broker
  pins its image, so sessions kept the generation-170 image and its capture
  helper. The broker name was retired with the Claude sessions (operator
  approved) and setup minted a broker on the configured image.
- Tools called with no arguments stream no input JSON. The coverage check
  treated that as missing input (`observe/assistant, check=10`); it now means
  the start block's exact `{}`, still compared against the completed block.
- `agent_listing_delta` and `skill_listing` attachments are now accepted, with
  exact key sets, by both the daemon validator and the in-image capture helper.
  They are preserved in order as native-only context, never as dialogue or
  tool-effect evidence.
- Completed tool results may interleave a still-streaming assistant block only
  when each names a completed, not yet answered tool call.
- The prompt process's stdin is ended at spawn. The open pipe cost three seconds
  per turn and put a CLI warning into user-visible failure text.

Still open: after any failed capture, Floot refuses every later turn in that
session ("Native context cannot conceal unresolved or recovered tool evidence"),
including after a turn with no tools. That permanence is a design decision, not
a parser defect, and is not changed here. Failure text is also shown raw.

Generation 176 then exposed one more capture gap: the CLI's `ai-title` row
(session title, no uuid) failed the helper's identity check. Generation 177
(`aadc49ce4`) skips it with the other operational rows. On generation 177, live
two-turn probes pass for a greeting, three no-argument Endo tools, and two shell
commands with arguments; each follow-up answers from the prior turn's context.
Restart restoration and the cross-backend matrix were not rerun.

Both open items above are now addressed (`88f9deb23`, `66511734c`,
`3f611a638`). A backend declaring `continuity: 'transcript'` (Claude) resumes
portably after a failed capture: the checkpoint's portable context, later
records, and every piece of evidence the native bytes could not cover, until
the next turn captures a new checkpoint. This deliberately reverses the earlier
"no lossy fallback" choice for such backends: evidence is never hidden, but
native reasoning continuity is lost for that stretch. Codex
(`opaque-reconciled`) still refuses. Failed turns now read plainly in the UI,
with the raw reason under Details; model context keeps the raw detail.

Operator follow-ups the same day: capture accepts the CLI's `task_reminder`
attachment, and coverage lets a built-in (non-`mcp__`) tool's stored input
carry CLI schema defaults such as Edit's `replace_all` (`3cf0031c9`; MCP tools,
Endo's host tools among them, still match exactly). Capture failures after a
covered, successful reply are no longer fatal (`adf25f948`): the turn completes
without a checkpoint and the next one restores portably; operators see a static
warning. Deployed as generations 179 and 180 with live probes passing.

Duplicate check merged (2026-09-30, `d2effd167`): the attachment allowlist that
the daemon validator and the in-image capture helper each carried, and the
record identity pattern and 16 MiB transport limit repeated across five Claude
files, are one module, `oci/native-context-shape.mjs`, copied into the image
beside the helpers and imported by the daemon. A test fails if the shape is
written down a second time or if the Containerfile misses a module a helper
imports. Not deployed: the Containerfile changes the Claude image digest, which
is broker identity.

Same day, the same for Codex (`0385937c5`: the envelope bound and identity
pattern of three in-image helpers and the host transport, one module, image
digest moves), and the Claude and OpenCode `setup-hosted.js` scripts now run
one shared sequence, `hosted-agent/src/hosted-backend-setup.js` (`a26ae97da`):
their 211 identical lines are written once, each adapter keeps only what is its
own, and both adapters' setup suites pass unchanged. Codex's setup script is
structurally different and stays separate.
