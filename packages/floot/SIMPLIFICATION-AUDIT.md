# Hosted-agent simplification audit

Date: 2026-09-24.
Starting revision: `a297668b2` on PR #1248.
This audits current source, not every historical commit or Tokyo's older release.
The target is one owner per responsibility, not the smallest possible line count.
Fae compaction remains on hold.
Process-loss recovery remains the separate investigation tracked in PR #1323.

## Decisions on remaining parallel mechanisms

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
No deployment or new crash-recovery guarantee is claimed.
