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
| Codex audit writer; Floot journal | Native approvals, denials, identifiers and late-result diagnostics are not all mediated Endo effects. Audit write failure currently fences the adapter. | Retain unique diagnostics and current writer integrity checks; remove the unused reader API. A broader diagnostic replacement requires an explicit contract, not deletion disguised as deduplication. |
| Codex audit entries; audit anchors | Append recovery checks chain continuity and detects missing/changed entries before continuing. | Operationally used, not dead code. Both trust the host; this is not protection from a host writer. The extra mechanism's cost remains a candidate for a separately reviewed diagnostic simplification. |
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

1. Direct-provider setup can fall back to plaintext `authToken` after Secrets
   provisioning fails; `fae/src/credentials.js` accepts that old configuration.
   This is real compatibility code, not a provider protocol requirement.
   Remove it in a dedicated credential-contract change, preserving explicitly
   unauthenticated local providers and testing failure before persistence.
   This is independent of the held compaction work.
2. Session `getAccount()` still uses the factory-wide direct-provider oracle even
   for hosted sessions, while settings use explicit account bindings.
   Define session reporting for pinned and automatically pooled accounts; do not
   misrepresent the direct account as the selected runtime's account.
3. The exported streaming-agent constructor still defaults journal storage to
   guest powers, although the factory supplies private journal storage.
   Require explicit storage in a bounded API-contract change with test-fixture
   conversion; do not quietly change durable ownership during cleanup.
4. Codex's `locateSessionDirectory` state-provider method has no production caller.
   It is another exported API retirement candidate, not evidence that the state
   provider or its directory ownership checks are unnecessary.
5. The audit writer's integrity/anchor mechanism is live but not proven minimal.
   A simpler diagnostic contract must decide what write failure means and which
   diagnostics must survive before removing its operational checks.

## Validation and conclusion

Independent adversarial review approved each deletion slice and this inventory.
The five affected full package suites pass 2,593 tests, with one hosted-agent test
skipped; scoped lint has no errors.
Full-suite verification also corrected old account-publication setup fixtures in
a separate test-only change, preserving their positive provisioning assertions.
Further type-check limitations and test results are recorded in the parent
[alignment audit](REFACTOR-ALIGNMENT.md#ra-01--demonstrate-simplification-not-merely-relocation).
Runtime JavaScript has 291 fewer lines in this pass (including comments, excluding
tests and documentation).
This pass removes concrete parallel and unused APIs without adding a framework.
It does not prove that the entire refactor is smaller than its original baseline,
nor close the remaining credential, account-reporting, storage-contract or
diagnostic decisions above.
No deployment or new crash-recovery guarantee is claimed.
