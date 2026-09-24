# Current repository alignment with the hosted sandbox refactor

Date: 2026-09-24. Priority audit requested by the operator.
Application snapshot: `61e5375288ce9772b31c9a4997efb5e3809b6bff`.
Initial host snapshot: `60ee154`; the manifest integration was then uncommitted.
Follow-up host `62a1077` completes it with reviewed dependency wiring and tests.
No deployment or live-machine inspection was performed for this audit.

## Verdict

The main structural unification is implemented, but the refactor is not complete.
The three native backends actually use common provisioning, lifecycle, grants,
and execution-envelope code. Reimplementing those abstractions is not the next
step. Simplicity, bounded context, remaining ownership boundaries, and final
current-release acceptance still need evidence or work.

This audit evaluates the retained implementation against the design's
[motivation and decisions](../../designs/hosted-agent-sandbox-unification.md#motivation),
[factorization](../../designs/hosted-agent-sandbox-unification.md#factorization-and-adapter-responsibilities),
and phase exit criteria. Historical commit coverage is not a completion gate.
Older dated design/audit paragraphs are evidence of earlier states, not reliable
descriptions of today's source. This summary takes precedence for current status;
the main [architecture audit](ARCHITECTURE-AUDIT.md) retains detailed evidence.

## Requirements and current evidence

| Intended end state | Current evidence | Verdict |
|---|---|---|
| One provisioner, backend factory, supervisor and execution envelope | All three adapter factories/controllers delegate to `hosted-agent/src/session-provisioner.js`, `backend-factory-kit.js`, `session-supervisor.js`, and `execution-envelope.js`; shared provisioning conformance exercises each adapter | Structurally aligned; do not count thin declarative wrappers as duplicated lifecycle implementations |
| Guest is one authority domain; credentials remain outside it; inference and egress are separate grants | Shared provider issuer/service and execution envelope retain these boundaries; native configuration carries placeholders and scoped listener endpoints | Source alignment, not a fresh kernel-containment or credential-isolation acceptance result |
| Session-scoped revocable inference, no mandatory request/TTL lease, no ordinary per-turn sandbox replacement | Shared grant issuer and supervisor own session resources; Claude may spawn a native subprocess per turn inside the retained sandbox | Aligned in structure; provider access-token refresh is not a forbidden session lease; current long-run acceptance remains to be established |
| Vendor adapters own genuine protocol differences | Claude JSONL/process protocol, Codex app-server/checkpoints, OpenCode fork/import/SSE remain distinct | Appropriate differences, not a reason to force all clients into an identical implementation |
| One host-owned conversation/effect authority; native stores are projections | Floot journal feeds context/history; native restoration translates host-selected records; tree-based Floot state is refused rather than silently migrated | Aligned ownership direction. Codex's separate native audit/checkpoint evidence has a different claimed purpose and still needs a scoped retention justification |
| Shared framing, admission and cancellation semantics | Shared turn channel exists, but three client admission state machines remain; recent Claude/OpenCode pre-admission cancellation defects needed parallel fixes | Partial: common behavioral conformance is warranted before deciding whether more implementation sharing is useful |
| Bounded resident memory for long healthy work | `context-transcript.js` pages archived metadata but accumulates active/exception record arrays; without a checkpoint it selects all eligible nonpending history | Not complete. Per-value/per-turn bounds do not bound the whole context; direct Fae has no automatic compaction producer |
| Runtime/provider/account/model are separate concepts | Explicit session identity and discriminated runtime configuration exist; hosted plans carry account authority | Partial: account status discovery still uses runtime-derived pet names and keys in `floot/agent.js:2663` onward |
| Smaller common implementation; delete superseded paths | Vendor packages shrank, shared implementation grew substantially; generic sandbox `nativeProfile` path has now been retired locally with operator approval | Simplicity target not demonstrated. Removing this obsolete mode is progress, not proof of the overall target |
| One current set of guarantees and final conformance | Design contains overlapping historical status blocks; host revision pin is older than application HEAD | Not complete. Rebaseline documentation and candidate, then perform coordinated deployment and current cross-backend acceptance |

## Priority findings

### RA-01 — Demonstrate simplification, not merely relocation

The design explicitly asks for a smaller combined implementation and rejects
generalizing every old Codex protection. Measured tracked non-test JavaScript,
MJS, and TypeScript source (excluding declaration files) in the four backend/shared
packages grew from 25,463 lines at design baseline `4e2644c` to 39,713 at this
snapshot. Vendor packages together fell from 21,165 to 16,718; hosted-agent grew
from 4,298 to 22,995. Including sandbox, Floot, and daemon gives 87,053 to 112,657.

These counts include comments and types; scope additions and movement between
packages confound a causal complexity comparison. They do not prove that all
growth is unnecessary. They do refute treating code reduction as already proven.
The next review should list current owners and remaining parallel mechanisms,
identify removable code, and justify retained complexity by the stated goals.
Do not add another broad framework to satisfy a line-count target.

Concrete candidates:

- Backward-compatibility cleanup is explicitly in scope (operator, 2026-09-24):
  obsolete internal option/property names, state formats and old-image shims need
  no compatibility layer. Keep genuine requirements of current vendor protocols.
  Removed locally the OpenCode client rewrite from old bridge commentary events
  to thinking events. Current bridge output names thinking explicitly; generic
  commentary stays commentary. All 302 OpenCode tests pass and independent
  review approves. Retire old images before activation; no deployment claimed.
  Current-source follow-ups identified in the scan: Claude's ambient state-root
  fallback despite captured formula configuration; Floot creation's `model` alias
  and colon-encoded backend (the chat caller still needs porting); preset-prompt
  version migration; Codex's per-turn `developerInstructions` alias. These are
  not yet removed by this record. The Codex constructor/wire field of that name
  is current vendor vocabulary and must not be deleted with the per-turn alias.
- Removed locally: OpenCode's unused `src/container-mount-bridge.js` phase-one
  refusal facade and package export. Current setup neither imports nor mints it,
  and the shared backend factory already rejects unsupported container mounts.
  This deletes an obsolete entrypoint, not functional mount support. Repository
  and local host-source checks do not prove absence of every external persisted
  formula; obsolete instances require deliberate retirement before activation.
  All 302 OpenCode package tests pass; independent source review approves the
  deletion. No deployment or live formula inventory is claimed.
- Retired locally with explicit operator approval (2026-09-24): the generic
  sandbox `nativeProfile` mode, public export/types, old startup gate, profile-only
  observations, helpers and exclusive tests. Stale fields, including an explicit
  `undefined`, reject before resource acquisition. `makeResolved`, runtime scopes,
  policy rootless/namespace/mount checks, network identity checks, admission and
  common cleanup remain. Independent adversarial source review approves.
  Focused tests: 135 passed; direct full AVA: 463 passed with exit zero; package
  lint/types passed (28 warnings). An earlier wrapper printed 463 passes but
  exited nonzero without a failure summary; its cause is not established.
  This removes an intentionally retired public mode, not merely unreachable code.
  External callers/retained formulas must be retired before activation; no live
  inventory or deployment is claimed.
- Codex creates its private audit journal/anchors in
  `codex-sandbox/src/codex-native-controller.js:109`. Phase 4 expressly gates
  removal on replacement runtime evidence. State precisely what remains unique;
  do not confuse provider/native observations with Floot's mediated effects.
- Attachment-driven recreation in `floot/agent.js:2930` onward coordinates
  declared mounts, live incarnation forwarding and cleanup retries. It is not
  proven to be a duplicate durable owner. Its string-matched
  `unsettled Endo tool call` retry at `3024` is a concrete cross-layer coupling.

### RA-02 — Finish the bounded-context requirement

`floot/src/context-transcript.js:41` accumulates active and exception groups;
lines 75–129 reconstruct and flatten them. Its own read-view comment explicitly
states that archive I/O and active output still grow with history. Checkpoints
permit skipping superseded content, but do not create themselves or bound a long
active tail. Direct Fae currently has no automatic compaction producer.
OpenCode has explicit checkpoint capture, while the current Claude/Codex event
translators do not produce equivalent canonical compaction boundaries. Supporting
restoration from a supplied checkpoint is not proof of capturing native changes.

There is a second bound to address: `turn-journal.js:451` deliberately excludes
unresolved outcomes from archival. Repeated unresolved turns can exceed the
settled-turn window, despite the module header's unconditional bounded-memory
claim. Preserve that evidence; correct the claim and provide bounded storage/read
access rather than deleting uncertainty to meet a numerical limit.

This is the existing FA-01/FA-02 requirement, not a new historical-audit task.
Define the context/compaction policy and prove bounded assembly on long sessions,
while retaining unresolved effects and keeping full-history UI reads separate.
Do not silently truncate durable evidence or reintroduce arbitrary session expiry.

### RA-03 — Finish account identity at the discovery/presentation boundary

`floot/agent.js:2663–2761` derives account/admin capability names and quota keys
from backend names. One provider account exposed through multiple runtimes can
therefore appear as distinct accounts. Explicit account authority in hosted plans
does not resolve this application-facing coupling.

Expose account-authority/member identity and status capabilities explicitly from
discovery, without creating another credential owner. Runtime-specific model
admission remains separate. This extends FA-07's current ontology work.

### RA-04 — Verify common turn-admission behavior

The recent cancellation regressions demonstrate drift at a shared behavioral
boundary: preparation may finish after the caller cancels, but must not admit the
canceled prompt. Keep adapter-specific protocols; introduce a common conformance
matrix covering cancellation before preparation, during restoration, before
dispatch, and after dispatch, including failure/next-turn behavior.
Only factor implementation after the identical responsibilities are established.

### RA-05 — Rebaseline and accept the actual candidate

`endo-host/endo.rev:1` pins `d5d943d`, not this application snapshot. Historical
generations and prior green tests cannot certify the current branch. Before
deploying, reconcile retirement/preservation gates and unfinished host acceptance
runner changes. Preserve Secrets, renewal owners, host, and workspaces.

Then push/pin/deploy the paired repositories and test create, tools, cancellation,
restart/restore, network-policy changes and deletion across the supported backends.
Use Codex Luna and the auto-free route for Fae/OpenCode live tests. Native import
HTTP success is not enough: check actual subsequent context consumption.

Follow-up: host `62a1077` completes the acceptance runner's manifest safety
correction. It reuses the existing owner, adds no new storage format, and passes
54 Node tests plus five inert shell-wrapper tests with independent review.
This removes that local integration obstacle, not the remaining preservation,
paired-deployment, or live acceptance gates.

## Boundaries, not extra scope

- Native crash recovery/producer-quiescence redesign remains the explicit #1323
  follow-up. It must not be silently implemented here or counted as proved.
- Local-development storage FA-09 retains its recorded operator deferral.
- Direct Fae's inference loop still lives in `floot/agent.js`, unlike the hosted
  delegation path. Extracting it may improve separation, but this alone is not a
  failure of the three-native-backend unification goal or authorization to put
  Fae behind native sandbox machinery.
- Credential refresh, native protocol translation, distinct image overlays, and
  multiple physical records with genuinely different evidence roles are not
  automatically redundant.

## Validation and next sequence

Fresh targeted checks passed 100 tests: all three provisioning conformance suites,
the shared execution envelope, Floot runtime configuration and context projection.
Independent source reviews covered Floot ontology, daemon/journal ownership, and
native adapter/host integration. These are not live Podman, long-run memory, or
current-release deployment results.

1. Reconcile this current-state verdict with the open FA findings; use this map,
   not historical commit counts, to choose work.
2. Resolve RA-01's retained-mechanism decisions and RA-02's actual completion gap;
   implement RA-03/RA-04 as bounded contract/conformance work.
3. Finish the already-started acceptance-runner safety correction, then perform
   RA-05's paired deployment and acceptance, honoring preservation gates.
4. Update this document and the main audit with evidence as each item is addressed.
