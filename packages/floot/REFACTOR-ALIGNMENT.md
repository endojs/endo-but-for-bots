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
  Removed Claude's ambient state-root fallback: state providers now require the
  root captured in their formula options, as current setup already supplies.
  Missing or empty captured roots refuse rather than use process environment;
  conflicting ambient configuration cannot retarget storage after restart.
  No new durable owner or format is introduced. Independent review approves;
  all 237 Claude tests pass, including eight focused storage tests. Scoped lint,
  formatting and production-source types pass; the full test-inclusive typecheck
  still has 25 pre-existing fixture errors. No deployment is claimed.
  Removed Floot creation's `model` alias and colon-encoded backend inference;
  the chat caller now sends canonical `backendId` and `modelId` only. Obsolete
  `model` fields reject before registry load or resource acquisition, even when
  empty, undefined or accompanied by canonical fields. Model IDs containing
  colons remain intact, including current OpenRouter routes; they no longer
  select a backend implicitly. All 674 Floot tests pass locally.
  Removed Codex's per-turn `developerInstructions` alias at both the adapter and
  direct client boundary. Presence rejects before turn reservation or transport
  work; current callers use `systemPrompt`. The constructor configuration and
  app-server wire field retain `developerInstructions`, which is current vendor
  vocabulary. All 321 Codex tests pass, including 99 focused client/tool tests;
  scoped lint passes with 13 warnings. Independent source review approves. No
  durable state or owner changes, and no deployment, are claimed.
  Removed preset-prompt version migration and missing-prompt reconstruction.
  Registry recovery requires the captured nonblank prompt and does not rewrite
  it from today's preset, creation metadata or deployment environment. Custom
  and delegated prompts remain exact snapshots. The unused recovery-only
  `FLOOT_SYSTEM_PROMPT` setup setting and migration markers are removed. Preset
  catalog examples remain descriptive, not a recovery source. Creation rejects
  blank custom prompts before registry work, preventing a new session from
  violating the recovery contract. Full Floot tests pass (677 with the separate
  cache cleanup); scoped lint has no errors. Independent review caught and
  prompted correction of the initial creation/recovery mismatch.
  The test-inclusive typecheck reports 99 fixture errors, none in changed
  production source or the new registry regressions; it is not a green gate.
  No deployment is claimed.
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
  old `unsettled Endo tool call` retry was a concrete cross-layer coupling.
  The shared supervisor wraps this refusal in
  `AggregateError('Codex native cleanup pending')`, so the top-level message
  matcher missed it; the test's fake admin incorrectly threw an unwrapped error.
  Removed the polling timer, retry limit and message matcher. Codex now drains
  already-admitted calls in its existing termination path, and Floot awaits
  ordinary termination. The previous actual-dispatch fence prevents late intent
  audit continuations from starting new effects during this drain.
  A real-supervisor test verifies independent grant fencing, sandbox closure and
  revocation while the tool is held; stop completes only after settlement.
  The attachment test holds termination and proves the tool can return before
  the successor is created, avoiding a self-deadlock. Late audit failures remain
  failures, and a genuinely hung call keeps completion pending, not containment.
  Independent adversarial review approves; full Codex/Floot suites pass 325/677
  tests, production Codex types pass, scoped lint has no errors (73 warnings).
  No new owner or schema, no process-loss claim, and no deployment.

### RA-02 — Finish the bounded-context requirement

Operator priority clarification (2026-09-24): defer storage scaling and an
unresolved-evidence admission budget until actual pressure warrants them; the
system is still experimental. Preserve the limitations below, but do not add
inference refusals or a paged-evidence storage redesign as speculative scaling.
This does not establish bounded memory or resolve model-context compaction.

`floot/src/context-transcript.js:41` accumulates active and exception groups;
lines 75–129 reconstruct and flatten them. Its own read-view comment explicitly
states that archive I/O and active output still grow with history. Checkpoints
permit skipping superseded content, but do not create themselves or bound a long
active tail. Direct Fae currently has no automatic compaction producer.
OpenCode has explicit checkpoint capture, while the current Claude/Codex event
translators do not produce equivalent canonical compaction boundaries. Supporting
restoration from a supplied checkpoint is not proof of capturing native changes.

Protocol investigation (2026-09-24): the locally installed Codex CLI matches the
image's `0.152.0` pin. Its generated experimental JSON schema exposes
`ContextCompactionThreadItem` with only `id` and `type`; raw
`CompactionResponseItem` carries encrypted content, not a portable plaintext
summary. Reproduce with `codex app-server generate-json-schema --experimental
--out <temporary-directory>`. Do not synthesize a canonical summary from these
notifications. Faithful capture needs an authoritative replacement-context export
or a deliberately designed opaque checkpoint contract. This is schema evidence,
not an actual container compaction run. Claude's pinned protocol still needs a
dummy-data capture before claiming its summary/retained-tail mapping is known.

There is a second bound to address: `turn-journal.js:451` deliberately excludes
unresolved outcomes from archival. Repeated unresolved turns can exceed the
settled-turn window. The module header's earlier unconditional bounded-memory
claim is now corrected. Preserve that evidence; storage/read redesign is
deferred rather than deleting uncertainty to meet a numerical limit.

The journal also retains every event/content/archive name in a lifetime Set.
Its private storage wrapper separately retained a copy of all factory host names
per open session. The latter duplicate cache is now removed locally: serialized
scoped existence checks enforce immutability, while explicit listings fetch and
filter current names. The same owner, namespace and failed-write poison remain;
no schema or inference policy changes. Independent review approves; 21 focused
tests and 676 full Floot tests pass, scoped lint has no errors (nine warnings).
Transient full listings, the journal's own name Set and the daemon's pet-name
index remain; this is simplification, not a claim of globally bounded memory.

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

Proposed implementation boundary (2026-09-24; not landed): each trusted setup
producer atomically publishes one complete source record in the existing profile's
`account-bindings` directory. Records carry the existing oracle identity and
capability, provider metadata, explicit runtime/member uses, and an optional
paired reset-admin identity/capability. No new credential or renewal owner is
introduced. Deduplicate only identical account authorities, never matching
labels, provider names or pool-member strings. Failed source discovery may keep
old display data but must not authorize reset actions. Reset actions must bind
both account and admin identity so a stale UI cannot target a replacement admin.
The direct provider uses the same publication contract; backend descriptions
remain capability-free model/runtime metadata.

Permission review paused the production identity/reset-authority rewrite pending
explicit operator approval. Preparatory publication/discovery code and a daemon
restart regression are uncommitted drafts, not deployed or certified. Keep this
slice separate from independently authorized cancellation conformance work.
The draft is preserved in local Git stash
`5e3145554e77402d23f8dc9debeafe881b4e241c`, named
`RA03 account binding draft awaiting explicit approval`, not in the candidate
working tree. Its incomplete setup conversion caused one full-suite setup test
failure before isolation; do not treat that draft as validated or apply it without
the pending approval.

### RA-04 — Verify common turn-admission behavior

The recent cancellation regressions demonstrate drift at a shared behavioral
boundary: preparation may finish after the caller cancels, but must not admit the
canceled prompt. Keep adapter-specific protocols; introduce a common conformance
matrix covering cancellation before preparation, during restoration, before
dispatch, and after dispatch, including failure/next-turn behavior.
Only factor implementation after the identical responsibilities are established.

The shared cancellation test work reproduced a further Codex defect: interrupting
a held `thread/inject_items` restoration marked the active turn interrupted but
waited for a native turn announcement; once import completed, the client still
sent the canceled prompt through `turn/start`. The regression observes that
forbidden prompt, rather than treating a timeout alone as proof. A local fix
distinguishes prompt admission from preparation, checks cancellation at the actual
transport write, and waits for already-owned preparation/persistence before
settling the turn. It fences successors before releasing the turn reservation.
Independent adversarial review approves. Full package suites pass: Claude 237,
Codex 323 and OpenCode 302; focused client suites pass 47, 97 and 35 respectively.
Codex production-source types, scoped lint and formatting pass. The shared
test-only harness covers held preparation/restoration, canceled-prompt admission
and each adapter's declared successor disposition. Codex additionally holds its
write-ahead save and attempts a successor in the interrupt-completion microtask.
No new durable owner or schema is introduced. Existing native post-admission
interrupt tests remain; this is not an exhaustive cross-backend lifecycle matrix.
Not deployed. Persistence drain is not claimed to have a deadline, interrupt
completion alone is not proof of native quiescence, and this does not solve
process loss.

A further held-intent regression reproduced an Endo tool executing after shutdown:
the client checked admission before its asynchronous intent audit, but not at the
actual tool dispatch. The local fix checks closing/terminated in the dispatch
microtask, with no await before the effect. The test uses the real shared
supervisor and proves independent fencing, pending stop during the held write,
and zero tool calls after release. No storage schema or durable owner changes;
an intent alone is still not evidence of execution or success. This does not yet
by itself change the separate termination/refusal contract described under RA-01;
the subsequent drain cleanup there builds on this fence.
The full Codex package passes 324 tests and the client suite passes 98;
production-source types and scoped lint pass (15 warnings, no errors).
The regression failed before the fix with an observed `lookup` execution.
Not deployed; Tokyo's prepared `63aa1a8c4` candidate predates this fix.

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

After the prompt/configuration and private-cache cleanup, nine daemon-backed
regressions pass: Floot factory lifecycle, journal retirement, direct-provider
journaling and archived context across cold restart. They exercise the committed
cleanup on the local daemon; they do not validate the pending account-binding
draft or replace Tokyo acceptance.

1. Reconcile this current-state verdict with the open FA findings; use this map,
   not historical commit counts, to choose work.
2. Resolve RA-01's retained-mechanism decisions and RA-02's actual completion gap;
   implement RA-03/RA-04 as bounded contract/conformance work.
3. Finish the already-started acceptance-runner safety correction, then perform
   RA-05's paired deployment and acceptance, honoring preservation gates.
4. Update this document and the main audit with evidence as each item is addressed.
