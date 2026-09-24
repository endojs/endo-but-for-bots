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
  `codex-sandbox/src/codex-native-controller.js`. The current consumer audit is
  recorded in [Codex's design](../codex-sandbox/DESIGN.md#journal-and-checkpoint-responsibilities).
  Only the writer is wired into production; event semantics do not drive
  recovery, but chain/head verification gates appends and required write failure
  fences the session. Raw native identifiers, approval/denial observations and
  late-result diagnostics are not interchangeable with Floot's mediated effects.
  The separate thread checkpoint does drive reconciliation and must not be
  mistaken for duplicate history. Retain unique evidence pending a replacement
  diagnostic contract; the hash-chain/reader surface is not thereby justified
  as minimal. Entries and anchors share host filesystem authority, so separate
  capabilities do not defend against a host writer controlling both. The audit
  head and the runtime policy anchor are different mechanisms. No deletion,
  bounded-memory, live recovery or process-loss guarantee follows from this
  source-level ownership inventory.
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
not an actual container compaction run.

Claude's pinned `2.1.233` image was subsequently exercised on Tokyo against a
loopback synthetic API in a disposable, network-disabled container, without
credentials or host mounts. Manual compaction emits a boundary with retained
UUIDs, then a separate synthetic user summary matching its anchor UUID. The next
request demonstrably uses the summary plus an older retained assistant message;
that message precedes the boundary in the physical transcript. A suffix-only or
summary-only capture would therefore lose context. Stream and file metadata use
different field spelling. See endo-host's
`ops/claude-compaction-probe-20260924.md` and companion reproduction script.
Both containers were removed; no daemon deployment or session mutation occurred.
A subsequent seeded synthetic auto-compaction probe retained a native Bash
tool-use/result pair plus a runtime token-reminder attachment; the next request
consumed the intact pair with the reminder folded into the result. Native JSONL
can repeat retained UUIDs with identical context payloads but changed metadata.
Production projection must account for attachments and distinguish such repeats
from conflicting payloads. One automatic native-tool fixture is not proof of
Endo-effect reconciliation, repeated/interrupted capture or durable replay.
The existing host-side `makeTranscriptResume` helper is not a symlink-race-safe
reader of guest-writable content; do not extend it to ingest checkpoints.
An in-sandbox data-only capture using the existing process transport is the
bounded direction under review, not a new durable storage/lifecycle owner.

Implementation in progress: an image-baked helper reads the native JSONL inside
the sandbox after the CLI exits and returns a complete summary/retained-tail
projection through the existing process transport.
The client validates the whole capture before emitting a canonical checkpoint;
failure or cancellation publishes none.
Independent review found that failed capture could otherwise leave unrecorded
native compaction resumable on the next turn.
The implementation now invalidates live resume after every observed boundary,
including successful capture: the next turn restores host-selected records,
because reader delivery alone does not acknowledge durable journal storage.
Success/failure-to-next-turn regressions pass and independent review approves
this live-resume invalidation.
The first helper draft omitted token-budget reminders and refused signed thinking.
Following the operator decision below, the helper now also emits selected raw
native JSONL, retaining signed/redacted thinking, grouping and token attachments.
Only the portable projection omits these backend-specific blocks.
Duplicate comparison includes native content/signatures, not just projected text.
Twenty-four helper tests pass; targeted types and lint pass (one warning).
This native envelope is not yet threaded through the client, journal or writer;
the worktree must not be deployed as if native preservation were complete.
This work is uncommitted and undeployed; production acceptance remains outstanding.

Operator decision (2026-09-24): preserve backend-specific signed/opaque context;
do not deliberately omit reasoning to fit the current portable transcript.
The existing Claude writer splits message blocks into separate envelopes and
reconstructs tool adjacency, while `splitAtLastCompaction` expands the portable
tail and discards its original grouping.
Adding a thinking-text field would not preserve native continuation semantics.
Anthropic's [preserved-thinking documentation](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)
and [compaction binding rules](https://platform.claude.com/docs/en/build-with-claude/compaction-thinking-blocks)
also distinguish preserving bytes from preserving the prefix to which they bind.
The API rules are research evidence, not proof that our pinned CLI uses that
particular API compaction mechanism.

Next implementation contract to review:

- Keep one durable owner: store a data-only native context envelope in the
  existing Floot transcript journal, alongside the portable context projection.
  No filesystem path, executable operation, credential, or capability belongs
  in that envelope; backend context must never settle host effect evidence.
- Identify the format and producing runtime explicitly, and preserve native
  message grouping, signed/redacted blocks, ordered attachments, and the exact
  context cut represented by the envelope.
  Native restoration replaces only that covered context span; subsequent host
  records and unresolved effect evidence still have to be included exactly once.
  Repeated projection must preserve this coverage rather than expanding it twice.
- A matching adapter validates the envelope and restores it without rewriting
  its signed payloads.
  An incompatible adapter/format must report the incompatibility explicitly;
  silently falling back to a reasoning-free projection is not this decision.
- Determine which pinned-CLI envelope metadata and request-prefix inputs must
  survive restoration before selecting the serialized schema.
  System/tool changes can invalidate signed blocks even if their bytes survive;
  do not claim fidelity from a JSON round trip or a synthetic signature alone.
- Cover ordinary completed turns as well as compaction, cancellation and
  restart: preserving native context only at compaction leaves the same loss
  on a restart before the first checkpoint.
  Test journal reconstruction and actual pinned-CLI subsequent requests, then
  provider acceptance of real signed context where applicable.

The original helper's reasoning refusal and token-reminder omission were
temporary implementation limitations, not the selected final contract.
Independent review additionally found unchecked suffix ancestry.
The helper now validates a strict boundary/summary/suffix parent chain, rejects
divergent or missing ancestors and conflicting duplicate ancestry, and preserves
benign pre-boundary native metadata rewrites.
Independent review and 21 helper tests approve this limited supported shape.
An added generic hosted-turn test proves retained tool/answer context survives
same-journal reconstruction exactly once, without re-executing the tool.
It does not establish native signed-context fidelity or an actual daemon restart.
The full Claude suite passed 262 tests before the additional ancestry cases;
production types and root documentation gate pass, scoped lint has no errors.

Host probe commit `0417193` adds synthetic signed-thinking restoration evidence.
An isolated pinned-CLI run copied the full native JSONL into a fresh configuration
and resumed both copies with distinct prompts.
Assertions required fresh requests with those prompts and identical historical
message prefixes; two synthetic signed-thinking blocks and a retained tool pair
survived restoration.
This is evidence for preserving native grouping, not cryptographic validity:
the loopback fake API does not check signatures, the comparison excludes system
and tool headers, and the restored file still includes superseded history.
Host probe commit `be2e8ee` then exercised a pruned native copy: 60 rows became
11 retained-UUID/boundary/suffix rows, with identical historical request messages
and both synthetic thinking blocks preserved.
The experimental selector is not the production ancestry/duplicate validator.
The production journal/restore path and real signature acceptance remain untested.
The capture helper now preserves a native JSONL envelope alongside the portable
projection rather than dropping signed/opaque blocks.
Keep the envelope paired with its covered host context as one journal unit;
do not use a bare count of following flattened records as its coverage contract.
Ordinary-turn capture and incompatible-runtime refusal remain required work.
Further review excluded operational queue/progress/file-history/last-prompt
records from the native payload; last-prompt leaf metadata is validated but not
imported.
The helper suite now passes 25 cases, including metadata canaries.
A context-only pinned-CLI rerun reduced 58 rows to 8 while preserving the same
historical request messages and two synthetic thinking blocks.
An isolated on-disk counter verified one native Bash execution across both
original and restored runs, not a replay of the retained tool call.
This does not establish Endo-effect reconciliation or real signature acceptance.

Native-context wiring WIP (2026-09-24, uncommitted): the shared record now pairs
`format`, `payload` and a flat portable `context` in one immutable journal value.
`selectActiveTranscript` replaces the compaction-only selector and preserves an
atomic native snapshot plus its suffix across repeated selection.
The Claude client and translator pass the native capture through to hosted-turn
journaling; the native payload is not copied into UI segments or treated as a
tool execution.
Archive checkpoint indexing and context selection recognize this record.
Generic Responses, direct-provider and OpenCode restoration refuse unsupported
native context explicitly.
The Claude portable writer also refuses it until the sandbox-native importer is
implemented; this is intentionally not a deployable candidate yet.

Recovery now refuses ambiguous native restoration when prior, same-turn or later
selected turns contain unresolved/recovered effects or incomplete transcripts.
It preserves the journal evidence rather than rewriting signed tool IDs.
New regressions cover later-turn ambiguity and atomic hosted-turn journaling.
The initial combined schema/client/translation/index suite passed 123 tests;
the expanded suite passes 150 tests.
Shared declaration regeneration encountered TS5055 stale generated declaration
inputs; downstream type validation remains outstanding until those artifacts
are regenerated safely.
Independent review agents stopped on usage limits during this slice, so none of
these schema/storage/wiring changes has received final review or been committed.
Remaining implementation includes the sandbox-native importer, ordinary-turn
capture, runtime/account/prefix binding validation and actual journal-to-CLI
restoration acceptance.

Follow-up verification: regenerated the shared transcript declaration into a
temporary output directory and replaced only its ignored generated declaration;
the Claude downstream production typecheck now passes.
Hosted-turn now refuses native-context events when no durable transcript recorder
is supplied, instead of silently consuming and discarding their native payload.
Regressions verify both missing-recording and failed-write paths never seal a
completed transcript and interrupt the producer.
The full Floot runtime suite passes 685 tests; scoped wiring lint reports zero
errors and 48 warnings.
Floot's full TypeScript configuration still reports 99 errors in test files;
this is not a green full-package type gate, and no baseline attribution is
claimed here.
The separate source-only check attempted from a temporary config could not resolve
the Node type library, so it is not counted as successful verification.
The application work remains uncommitted, unreviewed as a whole and undeployed.

Sandbox importer WIP: `claude-sandbox/oci/restore-context.mjs` accepts one bounded
native-context value on stdin, checks the pinned version, session and current
workspace, and stages its bytes in an invocation-private sandbox directory.
It reruns the existing capture validator there and requires exact native-byte
and portable-context agreement before publishing to the sandbox configuration.
This reuses ancestry/block validation instead of introducing a second parser.
Operational queue/progress/file-history rows are refused, not imported.
Publication uses an exclusive temporary file and atomic rename; a leaf symlink
is replaced rather than followed.
No transcript-provided path determines an I/O destination.
The journal remains the durable owner; this output is a native projection.
The helper initially accepted only the observed compacted format; ordinary-turn
support was subsequently added as described below.
Appended portable suffix restoration remains unsupported.

Capture/import suites pass 34 tests, including exact-byte import, mismatched
format/projection/version/workspace, torn or divergent ancestry, queued-action
refusal, and an unchanged symlink target.
Claude production typechecking passes with the helper included.
The importer is now wired into the session client's non-live restoration path:
it runs in the existing slice, receives the atomic checkpoint only on stdin,
and must exit successfully with a validated session UUID before the client can
spawn Claude with the new prompt.
Its process is registered with the current turn's cancellation/termination
tracking; admission checks follow slice acquisition, helper acquisition, stdin
acquisition and helper completion.
Turn cleanup now runs even when preparation fails, not only after inference.
The portable host writer remains unused for native snapshots.
Native snapshots with subsequent records are explicitly refused pending suffix
restoration, rather than silently dropping those records.
Client tests cover ordering, failed import and cancellation during stdin
acquisition; combined client/importer tests pass 67 cases.
Claude production types pass; client scoped lint has zero errors (18 warnings).
The integration and importer safety/lifecycle changes still need independent
review and real sandbox acceptance before deployment.
Account/system/tool-prefix binding and real-signature acceptance remain separate
requirements; these local tests do not prove them.

Ordinary-turn capture WIP: the client records the main session's validated native
UUID from its init event and captures context after each successful native turn,
not only after a compaction notification.
The helper's generic capture mode scans boundary metadata with bounded frames,
then validates the selected native context on a separate pass.
When no compaction exists, it requires a complete parent chain rooted at null,
preserves signed/redacted native blocks, and emits portable dialogue without an
invented summary.
When a prior boundary exists, it resolves that boundary's retained IDs and suffix.
The importer uses the same generic validator, so ordinary context is importable.
Every observed native turn invalidates live resume at completion or failure;
the following turn selects host-journal context rather than trusting an
unacknowledged native store.

The combined client/capture/import suite passed 96 tests before the additional
ordinary-import round-trip case; Claude production typechecking passes.
Tests cover ordinary signed-block retention, boundary rediscovery, refusal of
an orphan suffix, and capture without a compaction event.
These fixtures do not replace actual pinned-runtime acceptance of the helpers.
Native suffix handling, prefix/account bindings, independent review and deployment
remain outstanding.

Actual helper acceptance (2026-09-24): isolated Tokyo runs used the candidate
capture/import sources with the pinned Claude image and a loopback fake API.
Automatic compaction selected 8 of 58 native rows, preserved two synthetic signed
thinking blocks, and produced identical historical request messages after import.
The native Bash counter remained one across original and restored continuations.
An ordinary first-turn round-trip selected 4 of 7 rows, preserved one synthetic
thinking block, and also produced identical historical messages.
Both disposable containers were removed; no production deployment occurred.
This validates helper transport, not real signature acceptance, account/prefix
compatibility, or complete journal-to-client recovery.
See `endo-host/ops/claude-compaction-probe-20260924.md` for the reproducible probe.

Independent review resumed and identified explicit deployment blockers:

- Failed/cancelled turns after a native snapshot currently prevent continuation,
  even without tool effects. Safe suffix/recovery handling is not implemented.
- Portable restoration writes `version: 'endo-restored'`, but native import
  requires the pinned CLI version. A newly portable-restored history must not
  publish a checkpoint that its next turn cannot consume.
- Runtime/model/system/tool/account binding compatibility remains unproved.

Review fixes in the working tree now reject missing journal context on subsequent
native sends instead of silently starting a new conversation, pass only bounded
session/boundary identities to capture instead of large metadata in argv, and
keep forensic transcript reads available after a failed checkpoint turn.
Model-context selection still refuses unresolved/recovered evidence; the forensic
fix does not authorize inference or settle any effect.
These fixes require the final review/test pass before application commits.

Scoped re-review approved those three corrective changes, not the whole candidate.
The focused Claude client/capture/import suites pass 99 tests; the forensic/context
selection suites pass 50 tests. Scoped ESLint reports zero errors and 26 warnings,
and the repository documentation gate passes.
The full Claude package typecheck reports 41 errors in test files (no baseline
attribution claimed); it is not a green full-package gate.
The reviewed helper probe is committed in endo-host as `a60b2ae`.
Application changes remain uncommitted and undeployed pending the blockers above.

Portable/native continuation follow-up: the importer now recognizes the current
portable writer's `endo-restored` provenance for text/tool dialogue only.
It does not relabel that data as CLI-authored, and signed/redacted blocks still
require the pinned native version.
A mixed-history test uses the actual portable writer, includes a settled tool
pair, appends signed native context, and verifies exact-byte restoration and
unchanged destination bytes after refusing forged portable provenance.
The pinned-runtime probe initially failed despite the unit round-trip: resuming
the portable seed appends a `mode` record after the context leaf.
Capture now excludes that operational metadata rather than restoring it.
The rerun selected 6 of 10 rows and preserved the identical historical messages
and one synthetic thinking block across fresh import.
Real signature acceptance remains untested.

Failed-turn continuation design constraint, established by current-code review:
the journal records host dispatch, terminal status and effects, but no durable
backend prompt-admission receipt.
The hosted runner's volatile `delivered` flag and absence of tool rows cannot
prove that no signed context was produced.
Do not fix retries by dropping failed turns or treating missing events as proof.
The next implementation needs two distinct cases:

- After confirmed producer exit, capture and journal a complete native checkpoint
  even if the turn failed; context completeness is distinct from terminal success.
  Require exact reconciled tool evidence, preserve the failure notice, and append
  any synthetic suffix without rewriting the native prefix.
- For a host-provable pre-send refusal, record non-admission/context-unchanged
  evidence durably before reusing the prior checkpoint.

Cancellation currently closes the reader before a final capture could be
delivered. It therefore needs an explicit post-stop checkpoint result path;
sending a checkpoint to the closed reader is not durability.
Incomplete capture or unknown effects must remain explicit restoration failures.
Required regressions include success/pre-send-failure/retry, signed-thinking
failure/retry, cancellation/restart/retry, unchanged native prefix bytes, one
failure notice, and continued refusal of unresolved tool effects.

Standalone helper slice: independent adversarial review approves committing the
two sandbox parser/importer helpers, their synthetic fixtures/tests, and OCI
source typechecking separately from runtime wiring.
The latest helper suites pass 41 tests, production Claude types pass, and scoped
lint reports zero errors and three warnings.
The final mixed-history Tokyo probe also asserts consumption of both portable
seed messages before capture/import; containers were removed afterward.
This slice does not add the helpers to an image or activate them in production.
Containerfile/client/shared-record/journal wiring remains uncommitted work;
the open continuation and signed-prefix gates above still block deployment.

Dialogue-suffix implementation WIP: the native importer now takes an explicit
`{checkpoint, suffix}` request, rather than accepting alternate legacy shapes.
It appends only message records using deterministic IDs chained to the capture
validator's leaf, preserves every original native byte, and revalidates the
combined projection before atomic publication.
Tool calls/results and opaque reasoning cannot be introduced through this suffix.
The first pinned-runtime test rejected synthetic rows lacking loader metadata;
the writer now includes the native envelope fields and uses the context leaf's
timestamp as the stable projection cut, not an invented new event time.
The rerun consumed exactly one separate assistant failure notice while retaining
the original complete API message prefix and synthetic signed-thinking block.
Real provider signature acceptance is still not established.

Adversarial review rejected the proposed failed-exit capture shortcut.
Producer exit plus structural validity is not a covered cut: the file may omit
the admitted prompt or streamed output that did not reach a complete native row.
Matching only the last complete frame also fails if a subsequent response streams
partial text before the process dies.
That enabling change was removed; nonzero exit and native `is_error` results
(including exit zero) do not publish replacement checkpoints.
The client tests assert no capture helper is spawned on those paths.
Recovery needs positive evidence of the admitted prompt after the pre-turn leaf,
all observed mainline complete frames, and no unmatched partial stream content.
Current-turn compaction needs its own tested coverage rule, not a guessed match.
The tentative journal complete-checkpoint/abort sealing tests are not evidence
that the real client can yet supply a certified failed-turn checkpoint.

Scoped suffix review approves the unwired helper/probe slice.
The strict auto-compaction probe selected 9 of 60 rows including the one synthetic
assistant notice, preserved two signed-thinking fixtures in unchanged API messages,
and verified one native tool execution across both continuations.
The combined Claude client/helper suite passes 105 tests and production types pass.
The bounded hosted-turn/projection slice passes 87 focused tests but remains
uncommitted integration work; its mock producer contract is not real capture proof.

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
