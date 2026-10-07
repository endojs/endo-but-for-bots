# Durable POSIX environments and shell capabilities

| | |
|---|---|
| **Created** | 2026-10-01 |
| **Updated** | 2026-10-07 |
| **Author** | kumavis (prompted) |
| **Status** | Initial implementation complete; Tokyo acceptance passed |

## Implementation status

2026-10-02: initial implementation passed Tokyo acceptance on generation 194,
app `854a4c5aae573b669692fd132bcd30cbb0cc3926`, host
`1f2a4bdc027089096a6cea27d549903e527c2b6b`.
Generation 195 added the DNS and request-body follow-up below.
Generation 196 added safe stream-failure diagnostics on 2026-10-05.
Generation 197 added the dependency-install networking repairs described below.
Generation 200 ran app `69d7ef537de40b99e3823998b105a955fb246baf`,
host `04b95a754af32d67e1f9c554a45e7e2b24f60793`, with the host-side CapTP
answer-release correction, per-invocation Shell timeout overrides and shared
first-turn compaction described below.
An October 6 unattended Luna run now verifies execution of the scoped JavaScript
test lane, with three automatic first-turn checkpoints. It is not an all-green
repo or clean end-to-end response: eleven test failures remain, and the final
chat response reached the 48-tool-step cap after the report was written.
The shared direct-provider guard is now 1024 rounds in source, including
standalone Fae (previously 32). Local tests cover exact exhaustion, explicit
overrides and a normal final answer beyond the old 48-round cutoff. A round
is one provider response plus its requested tools, not one individual call;
the final answer also consumes a round. Generation 201 now deploys this default;
a fresh unattended end-to-end response remains under test.
The operational guards listed below now have generous defaults and explicit
operator settings. Local tests and adversarial review cover their configuration
and durable replay. Generation 201 is live with app
`1bda964b842c080519b801d274ff4f0135a58346`, host
`7d07e051ceeb63684910ce7b29c4b3bd2f257656`, and one rebuilt credential-free
listener at `sha256:8602ffe7480daae287db41c8bf6e9068d5827174ed7883d66db4bb19cb0a6651`
for the development runner and all three hosted brokers. Harness/base images
are unchanged. The fresh unattended Luna CI retry stopped after 33 minutes with
an explicit Codex `server_is_overloaded` stream error, after 33 tool calls and
two compactions. The non-daemon graph finished 236/240 tasks successfully; five
daemon batches ran before the overload. Four non-daemon test packages and two
daemon context fixtures failed. The remaining daemon batch and `endo.test.js`
were not reached; this is neither complete coverage nor a CI pass.

The October 7 overload follow-up adds live inference-local retries to the shared
subscription Responses adapter: five waits of 5, 10, 20, 40 and 60 seconds, then
the sixth refusal is terminal. Constructor `overloadRetryDelaysMs` configures
the sequence (empty disables retries). Each retry keeps the identical serialized
request/session affinity and acknowledges endpoint revocation before waiting.
Only a named `server_is_overloaded` refusal before any output or usage qualifies;
unknown events, partial reasoning/tool/text output, observer failures, malformed
streams, HTTP errors and transport uncertainty are not replayed. Cancellation
and disposal interrupt backoff. Sanitized diagnostics report attempts/delays,
not provider prose or credentials. This is volatile transport retry state, not
another durable turn or a recovered-turn replay mechanism; tool dispatch stays
behind the existing journaled complete-response boundary. OpenRouter reuses the
same abortable delay, without changing its retry policy. Deployment and a new
unattended CI attempt remain to be verified.
The Floot development preset publishes only the common
Shell as `shell` in inventory and exposes structured `runCommand`/`inspectShell`
tools, distinct from JavaScript `exec`. Only Fae inference backends select it;
hosted CLI sessions already own their execution environment. The preset has its
own recorded network policy and private retained admin. Cancellation aborts
inference and waits for native stop; failed cleanup journals uncertainty and
quarantines the incarnation. Deletion aborts before stopping, preserves native
HOME/workspace storage, and keeps the private admin for manual disposal. Missing
private administration fails closed, including on revival of an existing Shell.
Focused publication, cancellation and factory tests pass; the full Floot/UI
regression suite passed 872 tests before the final revival regression addition.
Operator provisioning uses a private development runner and a credential-free
network listener, separate from inference and subscription ownership.
Real two-daemon Shell capability routing and explicit-stop/cold-restoration tests
pass locally. The two-daemon test uses a fixture runner; it does not establish
live remote Podman or VM execution.

| Live acceptance gate | Result |
|---|---|
| Fae through Codex subscription pool | `gpt-5.6-luna` installed Rust in native HOME, built `/workspace/rust-pilot`, passed its unit test and accurately reported exit 7 |
| Fae through OpenRouter | Only `openrouter/free`; uid/gid 1000, HOME `/home/node`, native commands and workspace read/write passed |
| Durable compaction | Three checkpoints at the forced-compaction gate; six total by final inspection; original history and opaque provider context retained |
| Policy replacement | Off prevented DNS/public access; public-only returned HTTP 200; installed Cargo survived both changes |
| Cancellation | Admin stop interrupted an admitted sleep in 3.295 s; Floot cancel in 1.359 s, with a durable cancelled record and idle, non-interrupted environment |
| Planned restart/recall | Explicit stop acknowledged before daemon restart; Cargo tests passed without reinstalling, `RUST_RESTART_OK` recalled, free-route file retained |
| Delete/dispose | Both test sessions deleted, private admins disposed, dedicated test factory/profile retired; no development containers, sockets or 9P mounts remain |

Focused Responses/Floot tests pass 42; runner/network/Shell tests pass 43 with
loopback permissions (the restricted run could not start listener pipes).
Workspace/storage/setup tests pass 21; journal/projection tests pass 27;
Fae provider-owner tests pass 9. Lal/hosted-agent types and changed JavaScript
ESLint pass. These are separate focused runs, not a claim that the whole repo
is green. Every implementation/ops commit received adversarial review.
Private operation receipts and transcript evidence remain at
`/var/lib/endo/development-acceptance-20261002/`; the helper is connect-only,
never a persistent daemon formula. Secrets, renewal owners, host and existing
user workspaces were preserved. Deployment watchers are active after NixOS
activation; no watcher policy change was made.

### Defects found and fixed during acceptance

The first Luna request failed before
tool admission because ChatGPT completed output items in stream events but sent
an empty terminal output list. The Responses adapter now retains the complete
indexed item snapshots, preserves opaque context and rejects unfinished observed
items, duplicate native identities, missing or conflicting completions; it does
not reconstruct arguments from deltas.
The next live request reached `runCommand` and reported the provisioning error
accurately: Unix sockets cannot fit beneath full native allocation identities.
The runner now allocates a short private incarnation socket directory beneath
the operator runtime root, and removes it non-recursively only after unmount
acknowledgement. Failed removal retains its original owner for explicit retry.
Recorded `ENDO_NINEP_*` settings now reach the existing mounter validator and
helper program fields. Neither change moves or deletes durable HOME/workspace.
Generation 193 then passed live Rust installation, Cargo tests, nonzero exit 7,
the OpenRouter auto-free workspace pilot, three forced compaction checkpoints,
and off/public network changes. Cancellation found that parallel listener/slice
teardown can race network-namespace dependencies. Cleanup now acknowledges the
native scope before removing its joined listener; early listener cancellation
remains available before a scope exists. Native errors are made passable before
crossing controller boundaries. The failed test's original owner acknowledged
cleanup on explicit retry; its uncertain command receipt is retained, not replayed.
Generation 194 passed the remaining cancellation, restart/recall and disposal
gates after scope-first ordering was applied to runner-wide shutdown as well.
Actual daemon testing also found that daemon exit does not run manager-owned
environment cancellation hooks. Planned restart must explicitly acknowledge
`admin.stop()` before stopping the daemon; exit alone leaves the active-intent
fence. This is not cleanup proof and is not automatically adopted on restoration.
Revising the daemon-wide shutdown boundary is follow-up lifecycle research
(#1323), not an additional native recovery mechanism in this implementation.
Automatic environment GC remains a design gap: cleanup is explicit on the
private admin facet, not a finalizer or cancellation side effect.

### User-trial follow-up: DNS and inference admission

Later user sessions exposed two failures beyond the initial acceptance.
Vultr's DHCP resolver returned `SERVFAIL` for the Rust download domains.
Tokyo now uses independently tested public resolvers, without adopting DNS from
DHCP/RA; address and route assignment remain unchanged.
Sandbox public-address validation and internet-off policy remain intact.

Fae through the Codex pool also hit the shared endpoint wrapper's implicit
100,000-character `M.string()` guard after successfully building Rust programs.
This was not model context exhaustion: the reading was about 20k of 272k tokens.
The wrapper now matches the existing 8 MiB transport admission envelope;
configured UTF-8 byte quotas still run before credential access or dispatch.
Buffered/streamed regressions through direct endpoints, shares and wrapped pools
pass, including multibyte quota refusal with no extra credential reads or fetches.
The four focused broker/issuer/share/transport suites pass 180 tests; types and
changed-file lint pass, and the docs build reports no errors.

Generation 195 passed a real Luna/Floot turn with 120,662 input characters.
The agent installed stable Rust 1.99 with rustup, built and ran Cargo Hello World,
and returned a successful final answer.
It corrected one ordinary shell failure (`sh` does not support `pipefail`) by
using Bash; this was not a transport or unresolved-outcome failure.
Internet-off denied the Rust URL with curl exit 6; public-only returned HTTP 200.
The dedicated test session, native storage and factory/profile were disposed.
Existing sessions, installations, Secrets and renewal owners were preserved.
Private receipts and logs: `/var/lib/endo/dns-body-acceptance-20261002/`.

### User-trial follow-up: durable stream-failure diagnostics

The original Codex/Fae development session completed two later requests after
the admission repair, then failed before tools on a provider SSE `error` event.
The adapter had retained only the event type, losing its diagnostic fields.
The exact original cause cannot be recovered from those records.
The existing failed-turn journal now receives bounded symbolic error code/type,
schema parameter paths and incomplete-response reasons, with fixed explanations
for common failures, through the same error string as the UI and worker log.
Free provider prose, request identifiers and dumped responses are not retained:
they may echo prompts, credentials or opaque context.
Missing or unsafe fields leave the generic failure intact.
No new journal, storage format, retry mechanism or public API was introduced.

The adapter suite passes 49 tests and journal integration passes 80.
Three real-adapter failures survive fresh agent reconstruction with their
diagnostic text. Each fixture makes one subscription request and revokes its
endpoint once; reconstruction makes no additional request.
Lal types, formatting and changed-file ESLint pass; root docs has zero errors.
Standalone Floot typechecking still reports 21 existing errors outside changed
files; these focused gates are not a whole-repository green claim.
Generation 196 passed deployed offline SSE diagnostics and one real
`gpt-5.6-luna` Floot smoke turn, without tools.
The dedicated session/factory/profile were removed.
Original sessions, installed tools, workspaces, Secrets and renewal owners were
preserved; no failed user task was replayed.
Private receipts and logs: `/var/lib/endo/stream-error-acceptance-20261005/`.

### Repository tests inside the development slice

A dedicated, operator-guided Floot/Fae session using `gpt-5.6-luna` cloned this branch into
`/home/node/ebfb`, not the 9P workspace, and used the image's Node 22/Corepack.
Two shared networking defects blocked Yarn installation before any test could run:

- Yarn 4 does not use the ordinary `HTTP_PROXY`/`HTTPS_PROXY` environment settings.
  The common sandbox environment now also supplies Yarn's own proxy settings,
  derived from the same credential-free managed endpoint.
- The egress object's default lifetime allowance stopped installation at exactly
  1,024 cached packages and then refused later connections.
  There is now no lifetime connection cap by default, and no unbounded admission
  counter when it is omitted.
  Explicit finite allowances remain available to trusted callers.
  Concurrent connections, bytes, deadlines, public-address checks and revocation
  remain bounded; this change does not permit private networking.

Generation 197 preserved the slice's native HOME across explicit stop/restart.
Without manual proxy overrides, the agent verified Yarn's managed proxy setting,
fast-forwarded the clean tracked checkout and completed immutable installation
in about 35 seconds.
It then ran the whole Lal suite: 151 passed, one skipped because `LAL_HOST` was
not set, zero failures.
The broader JavaScript workspace run reached the Shell's ten-minute deadline.
Smaller foreground tasks, complete HOME logs and bounded tool-result summaries
let the agent continue without increasing test timeouts or sandbox privileges:

- Signed Debian download-only resolution and HOME extraction supplied Chromium's
  missing libraries: preact-container passed 171 tests and preact-social 34.
- The locked Electron installer's explicit download, with normal checksum
  verification and no global lifecycle-script enablement, let Familiar pass seven.
- HOME extraction of `procps` supplied `pgrep`; hosted-agent then passed all 826.
- The clean checkout initially failed three agent-tools declaration-freshness
  tests, while the warm local tree passed.
  Running the normal `build:types` prerequisite succeeded and the whole
  agent-tools suite passed 231 tests.
  Turbo's ordinary `build` graph alone does not provide those declarations.

The final non-daemon graph completed with 238 of 240 build/test tasks successful,
236 served from the same-revision Turbo cache; these are task counts, not test counts.
Four assertions fail at the tested revision, in two suites:

- Sandbox's two command-environment extensibility assertions use reflection that
  SES's unsafe hardener deliberately replaces with a false result.
  The same failures were reproduced locally.
- Codex setup's two account-use expectations include `codex` but omit the
  implemented `fae-codex` binding.

All 109 daemon test files were exercised with the normal serial script and
unchanged AVA timeouts.
File batches cover 1–23, 25–60, 61–84 and 85–109 in the sorted manifest.
The large `endo.test.js` file uses three exhaustive, non-overlapping title groups:
case-insensitive `a*`–`f*`, `g*`–`m*`, and their complement.
The completed logs record 1,506 passes, six failures and five skips.
Pass counts in failing batches come from AVA reporter entries, since its failed
summary does not print a pass total.
No-matching-tests attempts and deadline-truncated attempts are excluded.
The six daemon failures need fixture/assertion corrections:

- The OpenCode owner/storage test expects activation to fail without Podman,
  but its narrow error regex excludes `spawn podman ENOENT`.
  This does not justify nested Podman or a host-engine socket.
- Claude owner/storage and OpenCode credential-retention fixtures still supply
  the retired broker `models` configuration.
- The submount fixture uses a named host handle where it needs the host returned
  by `provideHost()`.
- Two archived/native-context fixtures append synthetic execution evidence
  without persisting dispatch intent first.
  The journal correctly refuses them; their restart assertions were not completed.

No test assertions were changed to turn these failures green, and tracked
source files in the test checkout remain unchanged.
This is not a whole-repository green claim, nor coverage of the separate Rust,
XS, test262, lint and type-contract lanes.
Local hosted-agent regression tests pass 825 with one skip; types, changed-file
lint and formatting pass.
Private receipts and logs: `/var/lib/endo/endo-suite-acceptance-20261005/`.
The helpers are one-shot/connect-only, never registered as daemon formulas.
After all 18 attempts settled, the private archive preserved all 58 tool calls
and results, complete test logs, the filename manifest and Turbo summaries.
The exported tool records retain sequence, failure and dispatch metadata;
opaque compaction/context payloads are not included in the export.
The log archive was verified against the live files before cleanup.
The dedicated session and factory/profile bindings were deleted, and the private
environment admin acknowledged disposal before its last binding was removed.
Its roughly 4 GB of native checkout/cache data was removed; helpers were moved
recoverably into the private archive to prevent accidental reuse.
Original sessions, Secrets, renewal owners and workspaces were untouched.
Post-cleanup daemon and gateway health checks pass, with no running Podman slices.

The run also exposed two context/inspection limitations outside the network repair:

- Several large tool/log excerpts filled the conservative compaction headroom.
  The initial policy keeps the newest two user turns verbatim and cannot compact
  a large current/recent turn; it failed with
  `Compaction needs an older completed user turn` on two attempts.
  Smaller tasks with bounded output are the current operational workaround,
  not proof of autonomous long-turn compaction.
- A 117,897-character compaction journal payload could not be read through the
  public Floot `getTurnContent` facet because its result uses the default
  100k-character string guard.
  The durable record was present before cleanup; only its kind/size metadata was
  exported, not its opaque content.
  The inspection guard must be aligned with the content-storage contract in a follow-up.

The agent needed operator guidance for user-owned APT paths, bounded outputs,
test batching and a mistaken AVA matcher argument.
This run establishes that the slice can install prerequisites and execute the
JavaScript suites, not that a single autonomous turn completes the whole task.

### Unattended test-run follow-up

Two fresh Floot/Fae `gpt-5.6-luna` sessions received the same previously tested
recipe on 2026-10-05, with no corrective prompts during either attempt.
The first ended with a provider `server_is_overloaded` error before checkout/tests.
The second corrected its `sh`/`pipefail` mistake, cloned revision `6b853c646`,
retried transient Yarn connection resets, completed immutable installation and
`build:types`, and started the non-daemon JavaScript test graph.
It did not reach whole-lane completion or the daemon batches.

At 22:34:55 JST, a host Endo worker exhausted its V8 heap and aborted.
This is a host-runtime failure, not a test assertion or established compaction failure.
Follow-up reproduced a CapTP answer-retention defect: answers are stored under
the peer's `q-N` question ID, but `CTP_DROP` deleted the reversed `q+N` key.
Downloaded base64 chunks therefore remained reachable after their questions
were collected, despite `gcImports: true` on both transport ends.
The correction preserves export-slot accounting and deletes the original answer key.
Protocol tests cover bootstrap/call pipelining before and after a drop; a forced-GC
test proves streamed copy-record answers become collectible.
The complete CapTP suite passes 40 tests in each of three runtime configurations;
27 private-pipe, worker and public-egress tests also pass.
An identical synthetic private-pipe soak with a 256 MiB heap previously exhausted
memory around 144 MiB transferred; after the fix, 384 MiB completes with 7–8 MiB
live heap after forced collection.
This establishes a matching leak mechanism, not complete attribution of every
allocation in the Tokyo crash.
The isolated upstream fix and regressions are on
[Endo PR #3370](https://github.com/endojs/endo/pull/3370), based on upstream master,
not the hosted-agent branch.
Its 14 package tests pass in all three runtime configurations; two package type
errors are verified unchanged on the base, and GitHub CI stops before tests on
an existing mismatched `configstore` lockfile resolution.
Generation 198 deploys the host-side fix without changing retained owners or images.
The rebuilt listener `ae762fb2f2edb7946d4e41c0d1b02201a9ddd97ba86aef0657bc496dfc01c413`
contains the correction but is not activated; this is explicitly a partial rollout.
The fresh visible Luna session `muvcjeso-28ooeb-0` received the unchanged recipe
once, completed cold clone, immutable install and type build, and reached tests.
Its host worker remained healthy around 130–310 MiB RSS after dependency traffic.
The first non-daemon graph command exceeded its 600-second invocation timeout.
The agent then independently inspected task coverage and installed signed Debian
prerequisites into native HOME, but first-turn compaction failed with
`Compaction needs an older completed user turn` before Electron setup and daemon batches.
All 18 tool calls have results; the failed turn settled normally, and the private
admin acknowledged an idle, non-interrupted stop while preserving the session and HOME.
Its complete tool transcript is retained privately; unattended whole-suite completion
is still unverified.
The user subsequently authorized per-invocation timeout overrides, longer or shorter,
while keeping ten minutes as the development preset's default.
The shared Shell no longer silently clamps the requested timeout to that default.
Positive native-timer-range validation, admission-inclusive deadlines, termination
escalation, cancellation and output ceilings remain unchanged.
Generation 199 passed a live network-off Podman check: a three-second command completed
with a ten-second override over a two-second test default; omission and a 100 ms override
both reported timeout failures.
The normal development Shell still reports its 600,000 ms default.
The test's private admin acknowledged stop and disposal before only its own bindings
were removed; the existing trial workspace and session remain intact.
Private receipts: `/var/lib/endo/shell-timeout-acceptance-20261006/`.

A separate, smaller CapTP bookkeeping leak remains a follow-up: a disposable
probe sent 1,000 bootstrap questions and matching drops, then observed 1,000
numeric `q-N` reference-count entries still retained.
Receive accounting uses the original question ID while drop accounting removes
the reversed ID; this is distinct from the large answer-payload retention fixed here.
Potential interaction with local question-ID collisions still needs protocol research.
Do not expand the answer-release PR or the native-recovery design on that assumption.
In interrupted attempt 2, the test container continued after its controlling
worker died; the operator
verified its ownership and native HOME mounts, then stopped that exact container.
Partial logs and crash diagnostics were archived privately before daemon recovery.
After restart, the transcript retains 12 tool calls and 11 results, with the
turn explicitly `outcome-unknown`; no exit/result was manufactured or task replayed.
Original session IDs remain present, and daemon/gateway health passes.
The interrupted test session and native HOME remain for investigation, with no
running test containers; its environment is inactive but marked interrupted.
Unattended whole-suite acceptance is therefore still unverified.
Private receipts: `/var/lib/endo/endo-autonomous-suite-20261005/` and
`/var/lib/endo/endo-autonomous-suite-2-20261005/`, with the third trial in
`/var/lib/endo/endo-autonomous-suite-3-20261005/`.

### Earlier slice history (superseded by the current status above)

Implementation is authorized; the first slice removes the misleading dynamic
`mount`, `scratch`, `open`, `fork`, and unused `reset` methods from public and native
slice contracts, together with the tracker-only `SandboxMount` capability.
Static mount declarations, process supervision, admission fencing, and owned disposal remain.
Interface enumeration tests pin the smaller surface without old-name aliases.
The second slice adds `makeSandboxSpawner(slice)` over eventual-send process and
byte-stream capabilities, using the existing Shell rather than another executor.
Shell now preserves read/wait/stdin failures and rejects timeout, including delayed
admission; a late process remains observed for queued termination.
Stalled stdin closure cannot hide an admitted process from cancellation.
Tests cover structured argv, separate streams, nonzero exit, a CapTP membrane,
read/stdin failures, delayed admission, and termination refusal.
Durable environment provisioning, independent egress composition, and live
Fae/Floot/two-daemon acceptance remain to be implemented.
No new native recovery mechanism or deployment is included in these slices.
The next implementation adds a Floot development preset, Fae inference through
the existing Codex subscription pool, and durable Fae context compaction.
These are authorized work, not implemented or deployed capabilities.
The first new slice implements the shared capability-backed Responses adapter
in `packages/lal/providers/subscription-responses.js`.
It uses the existing Subscription model-id contract, opens one listener-free
endpoint per request, retains late-acquisition cleanup, and preserves complete
provider output including opaque reasoning on the common assistant message.
Focused tests cover a real broker Subscription, text/tool continuation, failure
and refusal handling, SSE framing, cancellation, and retried cleanup.
The adapter's 25 tests and the nearest OpenRouter/configuration suites pass
72 tests together. Lal ESLint and Lal/hosted-agent type checks pass;
root documentation builds with 0 errors and 180 warnings.
Standalone Fae now accepts a `subscription-responses` recipe containing the
retained subscription, model, and optional reasoning/catalog metadata.
The driver derives pool affinity from the retained agent's full locator identity.
The former token cache is replaced by one local provider owner: HTTP providers
still follow Secret rotation, subscription adapters never read a Secret, and
injected providers remain borrowed.
Cancellation fences late inference and unadmitted tools while retaining completed
tool outcomes and waiting for their tree publication; it does not wait for a
borrowed provider that ignores cancellation.
The adapter's disposal is an acknowledged cancellation hook, not a GC hook.
Focused tests cover the actual driver, opaque tool continuation, late endpoint
acquisition, batch cancellation, stalled inference, and delayed evidence writes.
The 27 focused tests pass; the full Fae suite passes 186 tests with two existing
known failures.
Fae ESLint reports 0 errors and 141 warnings, the nearest Floot turn/transcript
suites pass 35 tests, and root documentation still builds with 0 errors and 180 warnings.
Standalone inbox restoration now uses the existing conversation tree for messages
and admission receipts, with one retained `fae-conversation` branch selection.
The selection also records an active turn before inference or tool effects.
Graceful cancellation drains startup, tool, final-response, and claimed-reply
publications before clearing that fence.
An abruptly interrupted turn or failed publication stays fenced for explicit
admin inspection or retirement; this is not automatic effect recovery.
Restoration reads every retained tree node, including unselected or orphaned
receipts, and rejects failed lookups rather than silently allowing replay.
It rejects missing, cyclic, wrong-root, malformed, and pre-selection state.
The tree remains the conversation authority; the branch selection stores no
duplicate transcript, and no old-name compatibility path is added.
Fresh inbox-incarnation tests preserve encrypted Responses reasoning and tool outputs.
A real isolated daemon test also preserves the branch, receipt, and opaque
context across a cold restart using retained guest formulas.
The full Fae suite passes 200 tests with two existing known failures;
conversation-tree passes 9 tests and the nearby Floot suites pass 35 tests.
Fae and conversation-tree ESLint have no errors; root documentation builds with
0 errors and 180 warnings.
Floot now offers a distinct `Fae · Codex pool` inference choice.
It captures the existing Subscription capability, catalog model and reasoning
option in the private session registry, not an endpoint, Secret or CLI sandbox.
Restoration and child sessions retain that exact inference authority even after
the pool's petname is rebound; the same account/renewal owners serve both choices.
Registry validation rejects malformed recipes before guest acquisition.
Factory tests cover passive creation, failed model/effort discovery, interrupted
creation cleanup, retained opaque context and deletion.
The development preset, live acceptance, and deployment remain pending.
Floot's journal now carries validated per-assistant provider context. Responses
restoration preserves complete output, encrypted reasoning and native call IDs,
and checks dialogue/calls against their canonical records. These annotations do
not replace earlier history. Compaction tails can retain them; incompatible
exporters refuse rather than silently flattening them. The existing journal
remains Floot's only conversation authority.
Pool selection is locally tested; live acceptance is not yet claimed.
Automatic environment GC is a recorded design gap, not implementation scope for
this PR; cleanup remains explicit on the administration facet.
Shared Fae compaction selects completed protocol groups rather than requiring
three user turns or retaining the last two turns regardless of their size.
It can compact between settled tool rounds inside the first user turn.
The latest user directive stays verbatim, exactly once in continuation context.
Recent groups are selected against half the available headroom after system
instructions, tool schemas and that directive; their calls, results and native
opaque context stay together and unchanged.
Standalone checkpoints live in the existing conversation tree; Floot checkpoints
live in its journal, not another transcript store.
Publication checks the captured source head/frontier and provider identity before
selecting a checkpoint; cancellation, ambiguous writes and stale summaries do not
replace newer context.
The common turn engine accepts an owner-selected context head before committing
the next step, allowing compaction between tool rounds as well as between turns.
The Codex catalog projects its optional `context_window` field.
The minimum observed window across eligible pool routes is captured, or unknown
if any route is unknown; fixed HTTP models may capture their catalog window.
Unpinned HTTP models and OpenRouter auto routes retain no fixed capacity claim.
No model size is invented when metadata is absent.
Planning uses last-request occupancy and a conservative wire-byte heuristic
(including tool schemas and opaque context), with 30% headroom.
This can compact early; it is not a tokenizer or a provider-sized token estimate.
The summary request is separately budgeted, tools disabled, using portable
role/call/result/failure data rather than replaying old encrypted reasoning.
When necessary, old tool-output excerpts are shortened with explicit omission
markers, keeping both ends; full durable results are never changed.
An oversized settled group may be summarized as a whole rather than split.
Unknown or unresolved outcomes refuse compaction; oversized instructions,
schemas or non-tool summary input fail explicitly before inference dispatch.
Original history remains available; restart restores the checkpoint without
repeating summarization or tool effects.
Focused tests cover automatic first-turn and repeated compaction, parallel tools,
bounded summary requests, recent opaque context, unknown capacity, invalid or
non-reducing summaries, cancellation, stale publication and ambiguous writes.
Floot's first-turn fixture executes eight effects, compacts twice and reconstructs
without replay; refused checkpoint publication prevents continuation dispatch.
Standalone inbox reconstruction preserves the selected checkpoint, original
effects, admission receipt and cleared occupancy reading.
This October 6 change is deployed on Tokyo generation 200. A fresh network-off
development session through Codex's `gpt-5.6-luna` ran eight commands, each emitting
34,023 characters and appending a distinct marker, in separate tool rounds.
Its first user turn published two automatic checkpoints and finished with eight
successful calls/results; no three-user-message gate or operator compaction was
used. Both summaries used the requested Markdown handoff and carried the exact
paths, command order, completed effects and no-rerun constraint forward.
After explicit idle native stop and a cold daemon restart, context-only recall
named all eight markers, the saved native HOME file and their completed status,
with no tools or additional checkpoint. The hydrated seed evidence was unchanged.
Startup deliberately remints the controller over the retained profile, so the
test recorded an explicit one-time adoption after checking both controller
formulas, the unchanged profile/inventory and exact pre-restart evidence digest.
The admin identity and creation timestamp were first observed after restart;
this is conversation-continuity evidence, not independent native-admin identity
continuity or unplanned-crash recovery proof.
Private evidence was verified before deleting only this disposable session and
disposing its allocation. The original eight sessions, Secrets and workspaces
were preserved. Receipts remain under
`/var/lib/endo/fae-compaction-acceptance-20261006/`; no helper was registered as a
daemon formula. This bounded gate did not verify unattended whole-suite execution;
the later full-lane verification below supersedes that limitation.

The inspected [OpenCode implementation](https://github.com/kumavis/opencode/blob/af032b9fbc293cd19283e16f6a7f8effe296c065/packages/opencode/src/session/compaction.ts)
uses a budgeted recent tail, within-turn splitting and bounded prose tool excerpts
for summarization, then publishes its checkpoint before returning to inference.
Fae adopts those principles, not OpenCode's separate persistence/pruning machinery:
Endo's existing owners still require complete settled protocol groups and retain
the original evidence.
Its summary prompt likewise asks for an anchored Markdown handoff: goal,
constraints/decisions, progress (done, underway, blockers/failures), next steps,
and paths/references, with explicit preservation of still-relevant earlier
summary facts and exact commands, paths and identifiers.
This is model-authored continuation text, not a new durable state schema or
system instruction; section headings are guidance rather than a dispatch gate.

### Unattended JavaScript test-lane verification — 2026-10-06

Fresh session `muvuozxr-fe6xx1-0` used Fae/Codex `gpt-5.6-luna`, high reasoning,
the development preset and public internet on generation 200. One initial task
asked it to execute, not fix, the JavaScript workspace lane at the exact deployed
app revision. No coaching, corrective turn, manual compaction, source/test edit,
signature bypass or privilege escalation was used. It selected explicit
per-invocation timeouts while leaving the runners' own timeouts unchanged.
The run lasted about 57 minutes and settled with **48 tool calls/results and
three automatic checkpoints in its first user turn**.

The agent corrected its `sh`/`pipefail` mistake and transient Yarn proxy resets,
then completed immutable dependency installation and the root declaration build.
It downloaded signed Debian dependencies into native HOME, extracted runtime
libraries and `procps` without root, and used the locked Chromium/Electron recipes.
The 13-minute non-daemon graph completed under its explicit 30-minute Shell
override. Four initially blocked suites passed after these prerequisite repairs:
Preact container (171), Preact social (34), Familiar (7), and Hosted Agent (826).
Host worker memory stayed healthy; the earlier V8 heap failure did not recur.

Independent checks, including adversarial review of the retained artifacts,
establish the following coverage:

| Gate | Verified result |
|---|---|
| Non-daemon graph | All 115 package test tasks and 125 build tasks terminal, no cache hits; test-task identities exactly match the in-scope package scripts |
| Daemon files | Exact sorted manifest of 109 files; 108 non-core files executed once in five batches |
| Core daemon titles | 268 unique source titles, including conditional Node aliases and `testShim`; disjoint a–f, g–m and complement title sets match the reporter exactly |
| Core partitions | 65 passed; 89 passed; 110 passed and 4 failed; every complement exclusion, including `!j*`, present in actual invocation |
| Daemon aggregate | 1,506 passed, 6 failed, 5 configured skips (four Node/Rust cross-supervisor and one network test) |
| Checkout | Exact revision `69d7ef537de40b99e3823998b105a955fb246baf`; tracked source and lockfiles unchanged |

Eleven unique failures remain: two Codex setup assertions, two Sandbox
Podman-policy host-environment/proxy assertions, one OCapn API snapshot, and six
daemon failures. The daemon failures are the archived/native Floot context
restart fixtures, OpenCode backend owner/storage, Claude backend owner/storage,
OpenCode broker secret retention, and `provideSubMount` capability validation.
The retained broker fixtures still pass retired model configuration; the logs
show that refusal explicitly. The OCapn failure is printed three times by its
wrapper but represents one failing title. No failing assertion was suppressed
or patched. Rust, XS, test262, lint and type-contract CI lanes were outside scope.

The agent wrote its report, coverage ledger and per-task status file, and copied
the short report to `/workspace/endo-test-run-report.md`. Its own aggregate count
(1,384 daemon passes) is wrong: the independently checked aggregate is 1,506.
It also mislabels one core failure and the Sandbox proxy assertions. Preserve
that original report as evidence, but use the independent audit above as authority.
After writing the files at tool step 48, the final chat output was the existing
tool-step-limit warning. Thus **unattended test execution is verified; clean
end-to-end assistant completion is not**. The round-cap/final-summary behavior
and report accuracy remain follow-ups, not compaction failures. This run did not
repeat the cold-restart gate; the separate eight-command test above covers it.

Full hydrated tool evidence excludes credentials and opaque reasoning payloads.
The exporter ends with an explicit completion receipt for 48 calls/results.
The private archive contains 379 allowlisted regular log/JSON/report files,
20,212,168 source bytes, compressed to 3,837,996 bytes, SHA-256
`bba30483e1946a3e62e76a947a6d7e5113931b82beae86b92961bd02bf930ebb`.
Each extracted member was independently checked against its recorded hash;
the archive also compared equal to the live files before disposal.
Receipts, the original reports and the independent audit remain under
`/var/lib/endo/endo-autonomous-suite-4-20261006/`. No helper was installed as a
daemon formula. Only the fresh test session and its owned native allocation were
removed after positive settlement, export/archive verification and an acknowledged
idle stop/disposal. The original eight sessions, their uncertainty evidence,
Secrets, renewal owners and workspaces were preserved.

### Nearby operational limits — 2026-10-06 source audit

These are implementation choices, not provider/model limits. Following the
operator's approval, defaults protect against runaway work, not normal high
usage. They do not reserve memory, disk, provider tokens or quota. Prior Yarn
resets are not proven to come from the old connection cap.

| Limit | Current behavior | Source |
|---|---|---|
| Retained transcript per turn | 1,073,741,824 UTF-16 code units across encoded records and 1,048,576 records; each stored content value may use 268,435,456 code units. Exceeding admission refuses a new write. Compaction does not delete original tool evidence. | `FLOOT_MAX_TRANSCRIPT_CHARS`, `FLOOT_MAX_TRANSCRIPT_RECORDS`, `FLOOT_MAX_CONTENT_CHARS` |
| Public network | 1,024 concurrent sockets/resolutions; 1 TiB aggregate upload/download per egress instance; 24-hour absolute tunnel lifetime. Proxy and DNS worker admission use the same concurrent default. There is still no default lifetime connection-count allowance. | `ENDO_PUBLIC_EGRESS_MAX_CONNECTIONS`, `ENDO_PUBLIC_EGRESS_MAX_BYTES`, `ENDO_PUBLIC_EGRESS_TIMEOUT_MS` |
| Development Shell | 24-hour default invocation timeout, overridable per call. Each stream retains 16 MiB, then marks truncation and drains. The native process owner has a separate 1 GiB per-stream runaway-output guard. Keep large logs in native HOME and inspect pieces. | `FLOOT_SHELL_TIMEOUT_MS`, `FLOOT_SHELL_MAX_OUTPUT_BYTES`, `ENDO_ENVIRONMENT_PROCESS_OUTPUT_BYTES` (bigint bytes); low-level spawn also accepts `stdoutByteLimit`/`stderrByteLimit` |
| Inference request | One-hour default for direct OpenRouter HTTP and hosted provider requests, not a whole-turn or token cap. | `FLOOT_PROVIDER_REQUEST_TIMEOUT_MS`, `FAE_PROVIDER_REQUEST_TIMEOUT_MS`, `LAL_REQUEST_TIMEOUT_MS`, `ENDO_PROVIDER_REQUEST_TIMEOUT_MS` |
| Subagents | 1,024 live children per parent; depth 32; 24-hour default reply wait, with up to seven days per ask; 1 MiB task/prompt and 16 MiB reply preview. Closed-ask and known-agent interception sets each retain 65,536 entries. | `FLOOT_MAX_SUBAGENTS`, `FAE_MAX_SUBAGENTS`, `FLOOT_MAX_SUBAGENT_DEPTH`, `FAE_MAX_SUBAGENT_DEPTH`; suffix settings below |

Subagent settings use either `FLOOT_` or `FAE_` followed by
`SUBAGENT_TIMEOUT_SECONDS`, `SUBAGENT_MAX_TIMEOUT_SECONDS`,
`SUBAGENT_MAX_TASK_CHARS`, `SUBAGENT_MAX_ANSWER_CHARS`,
`SUBAGENT_MAX_CLOSED_ASKS`, or `SUBAGENT_MAX_KNOWN_SUBAGENTS`.
The round budget uses `FLOOT_MAX_TOOL_ROUNDS`/`FAE_MAX_TOOL_ROUNDS` (1024).
Malformed settings fail eagerly. Numeric upper bounds are timer/array domain
constraints, not the former small workload ceilings; traffic uses bigint.
Standalone Fae's flat derived pet names still fit Endo's 255-character format:
short names permit more nesting, maximal 63-character names permit two levels.
All owned names are preflighted before creating anything.

Setup forwards only explicit allowlisted settings into retained Endo formula
environments; Fae descendants inherit workload knobs without parent topology.
Broker/environment construction changes require an acknowledged stop and
deliberate retirement/reprovision, rather than silently ignoring settings on
retained owners. Shell recipes already recorded for existing environments are
not rewritten. New transcript limits apply to new writes, not replay or
duplicate acknowledgements: lowering settings cannot invalidate saved evidence.
Admission prevalidates all content fields and event schema/size before the first
storage write; actual storage failures still retain uncertainty.
Daemon mail text and formula-environment values use explicit structural text
bounds, so the former implicit 100,000-character guards do not defeat larger
task/prompt budgets. Names, paths, environment keys and capability guards are
unchanged. A real daemon test covers 1 MiB send/reply/edit payloads and formula
construction values, including latest-payload and formula restoration.
Existing mail revision history is not restored after restart; this is a separate
durability follow-up, not a new guarantee from raising workload limits.

The full Floot and hosted-agent suites pass (832 and 833 tests respectively,
with one hosted-agent skip); Fae passes 211 tests with two known failures, and
LAL passes 157 with one skip. Focused native output/lifecycle tests pass 35.
Changed-source ESLint has no errors, package typechecks and the root documentation
build pass. The listener image and workload defaults are deployed on generation
201. The fresh scoped JavaScript CI run through Floot is in progress.

The coordinated listener cutover retired eight old test sessions under the
operator's cull approval. Six completed supported deletion; the quarantined
fixtures `muvad3xs-9e0c3k-1` and `muvcjeso-28ooeb-0` required explicit retirement,
not recovery. Original private journals, registry snapshots, admin/guest handles
and seven workspace references are archived on the retained profile under
`retired-workload-20261006`. Six Secret entry identities are unchanged; renewal
owners and development HOME were not disposed. No interrupted lifecycle was
rewritten as idle or any old tool outcome marked successful.
The old factory's registered disposal hook settled and its held facet confirmed
closed before the operator appended an empty registry snapshot. Web admission
was fenced; the old daemon cgroup, running Podman containers, conmon processes
and 9P mounts were verified empty before replacements started. Receipts remain
at `/var/lib/endo/workload-guards-20261006/`; helpers are connect-only, not formulas.
The fresh run is session `muw2eab5-k0izgi-1`, with private receipts/logs under
`/var/lib/endo/endo-autonomous-suite-5-20261006/`. It uses the exact app revision
above and `gpt-5.6-luna`. Shell inspection confirms the 24-hour/16 MiB defaults;
clone and initial public-network tool use succeeded. The temporary stopped
image holder was removed after the activated generation protected the listener.

Per-frame bounds, paged reads, model context/output limits, display-only thinking
previews, DNS lookup timeouts and malformed-input/address validation have
different purposes and remain unchanged. Larger operator workload budgets do
not bypass public-address confinement or make unsupported native context valid.
The direct Anthropic SDK's request policy is unchanged; the direct-provider
timeout knobs above select OpenRouter HTTP requests. Listener-owner capacity is
a separate operator resource setting (Tokyo currently explicitly sets 16 hosted
sessions per broker); 1,024 subagents is not a reservation for 1,024 containers
or concurrently admitted provider requests.

The shared credential-free listener worker now accepts a closed network-only
bootstrap with a public-egress endpoint and optional copy-data operator limits,
and publishes `ManagedNetworkV1`
readiness without creating or reporting an inference HTTP endpoint.
It reuses the same rootless isolated runtime, network observations, DNS/proxy
listeners and retained cleanup; no fake provider grant or new sidecar framework.
Nested extra capabilities and missing egress authority are rejected before
native admission.
The worker/runtime suites pass 31 tests, including source/bundle inference
regressions and network-only lifecycle tests; types and ESLint pass.
Live egress and durable environment composition remain pending.
The daemon now mints an `environment` recipe and separate Shell/admin facet
formulas. Graph edges retain exact runner and workspace identities; only the
private formula-backed state directory is read during lookup or restoration.
Command admission publishes active intent before resolving the runner. A cold
active intent fences execution for operator cleanup; it does not replay commands
or manufacture cleanup proof from a fresh runner.
The runner's `provideEnvironment` contract is inert: acquisition belongs only to
the returned controller's `open`. Stop reaches retained controllers outside the
command queue and observes early cleanup rejection immediately; retry retains
the original owner. Policy replacement and disposal fence new commands.
Explicit disposal deletes owned development storage only after stop, never the
workspace. Automatic GC remains deferred.
Nine owner tests and one real daemon cold-restoration test pass. The latter
proves passive inspection and exact dependency capture after petname rebinding.
The Podman runner now composes the same native scopes, Shell spawner, inode-owned
allocation store and managed network-only listener. The portable recipe and
private runner/controller guards live with Shell, not in a backend-specific
session contract. Provisioning returns an inert controller. Acquiring a scope,
projecting the exact workspace Mount over 9P and opening public egress belong to
explicit open. Stop reaches pending acquisitions outside their queue and waits
for original native cleanup before unmounting.
Only the native `home` child is bound writable at `/home/node`; Cargo/Rustup and
build output use it. The workspace is a separate projection. The Podman operator
maps uid/gid 1000 with `keep-id`, preserving host ownership without chowning
shared storage; the attested hosted-policy path is unchanged. No scratch mount,
inference grant, Secret, host path or Podman controller reaches Shell.
The runner's five tests and nearest daemon/native lifecycle suites pass 79 tests.
Types and ESLint pass. Live Podman identity/network and installation persistence
are still unverified; preset integration and Tokyo acceptance remain pending.
No admitted inbox command or inference is replayed to discover its result.
The delegation registry's closed-ask and unsolicited-sender routing remains
process-local; published claimed-reply receipts prevent their replay, but an
interrupted late-reply receipt outside an active turn is not a durable exchange
restoration guarantee.
Automatic resumption of subagent asks and native process-loss recovery remain
outside this slice.
Focused factory, native-factory, ownership, lifecycle, and runtime suites pass
78 tests in each of the four SES configurations; package types and ESLint pass
with warnings, and root documentation builds with 0 errors and 180 warnings.
The full sandbox suite is not green: two unchanged direct Podman-driver
environment-extensibility assertions fail in the unsafe configuration.
No live Podman acceptance is claimed on this macOS development host.
The sandbox-to-Shell adapter adds eight passing tests in each SES configuration.
The Shell suite passes 17 tests and package types/ESLint (3 warnings, 0 errors);
the daemon's host-Shell composition suite passes 7 tests, including real child
termination, and sandbox types/ESLint pass (29 warnings, 0 errors).
The root documentation build still reports 0 errors and 180 warnings.

## Problem and scope

Floot and Fae should be able to use a POSIX execution environment represented by
ordinary Endo capabilities, whether its implementation is Podman, a VM, or a remote machine.
An operator should be able to provision and manage that environment through durable formulas.
Fae should be able to install a Rust toolchain, compile a program, and run its tests there.
Floot should compose these capabilities rather than maintain a parallel environment platform.

The proposed direction is to reuse `@endo/exo-shell`, the sandbox process interfaces,
and existing formula and storage mechanisms, with adapters only where contracts actually differ.
The primary goal remains less duplicated code, less dead code, and clearer ownership and ontology.
This document records the investigation, implementation progress, and remaining sequence,
not approval to build a new lifecycle framework.
It does not add a merge gate to [PR #1248](https://github.com/endojs/endo-but-for-bots/pull/1248).

Automatic recovery after native process loss remains separate research in
[hosted native recovery](hosted-native-recovery-investigation.md) and
[draft PR #1323](https://github.com/endojs/endo-but-for-bots/pull/1323).
Durable environment configuration does not imply that a running process, its streams,
or the outcome of an interrupted command can be recovered.

## Investigation baseline

The following findings describe application revision `43d27e5f3` and host revision `f3dc1a8`.
The investigation used source inspection and existing focused factory/runtime and shell tests.
It did not perform a live formula inventory, a two-daemon execution test, or a new Tokyo deployment.

### The daemon shell already uses exo shell

The daemon's [`shell` formula](../packages/daemon/src/manager.js) directly constructs
`makeShell` from [`@endo/exo-shell`](../packages/exo-shell/README.md), backed by
[`makeHostSpawner`](../packages/host-spawner/src/host-spawner.js).
Its persisted recipe contains a writable physical `mountId` and execution policy.
Reconstruction selects the local host-process engine; it cannot select a sandbox or remote runner.
The formula therefore restores configuration, not a durable command history or confined environment.

No application or Tokyo setup caller provisioning this formula was found in the inspected source.
This is not evidence that no manually created instance exists on Tokyo.
[`@endo/agent-tools`](../packages/agent-tools/src/workspace.js) can project a supplied Shell
into workspace tools, and Agentry can receive one through an explicit grant.
Neither fact means those consumers provision or select its execution environment.

Hosted Claude, Codex, and OpenCode execute their native command tools through the sandbox path.
Fae's [`runCommand` tool maker](../packages/fae/src/tool-makers.js) instead uses local
`child_process.exec`; it is not backed by the daemon Shell formula.
These are distinct execution paths today.

### Podman slices are configuration and operation containers

The [`Podman driver`](../packages/sandbox/src/drivers/podman.js) creates an operation
container for each spawn, starts it attached with the command as its main process,
and removes it through the operation's completion or cancellation cleanup.
A slice is configuration and ownership, with a policy anchor where needed;
it is not necessarily one persistent container in which all commands run through `podman exec`.
Writable tmpfs content is therefore not a place to preserve installed software between operations.

The hosted [`NativeSandboxService`](../packages/sandbox/src/runtime.js) keeps session scopes
in a process-local map.
Claude, Codex, and OpenCode instantiate this shared implementation independently.
The [`native-service owner`](../packages/sandbox/src/owned-native-service.js) retains
controllers and cleanup closures across formula reconstruction in the same native process,
but explicitly does not survive process loss.
Formula records, filesystem ownership markers, and allocated directories may persist;
the live scope map and cleanup closures do not, and native resources may outlive them.
An absent map entry is not proof that an earlier incarnation released its resources.

The current driver deliberately selects a local engine: its bind paths and native
observations belong to that execution host.
Remote compatibility should place the factory on the remote host and pass its capability,
not make local ownership checks operate on an arbitrary remote Podman endpoint.

### Existing interfaces are close but not equivalent

`exo-shell` exposes buffered `exec(command, args, options)` and policy `inspect()`.
Its injected spawner is a local function returning a `ProcessLike` with byte iterables,
`wait()`, and `kill()`; it is not itself an eventual-send protocol.
The [`SandboxProcess`](../packages/sandbox/src/interfaces.js) capability exposes
`stdin()`, `stdout()`, `stderr()`, `wait()`, and `kill()` through Endo writer/reader objects.
An adapter must bridge this actual difference rather than require one implementation's
local JavaScript objects to cross CapTP.

There are also semantic differences.
At the baseline, `exo-shell` truncated output capture, drained the rest, and caught
stream read failures without exposing a separate read-error result.
The adapter implementation now preserves these failures as rejected execution.
The sandbox's [`eager reader`](../packages/sandbox/src/eager-reader.js) can terminate an
operation at its capture bound and propagate read failures.
Termination and descendant cleanup differ between the host spawner and Podman as well.
Matching method names do not establish equivalent limits or error reporting.

### Retired slice methods overstated the implemented behavior

At the investigation baseline, dynamic `mount()` minted a tracker without performing
a new mount, and `scratch()` allocated and tracked storage without dynamically attaching it.
`open()` and `fork()` refused as unimplemented.
`reset()` killed tracked live processes without restoring a filesystem snapshot.
These methods and the tracker-only mount capability are now removed from the
[`factory`](../packages/sandbox/src/factory.js), guards, types, and help.
Tokyo is the only consumer; old names and unsupported option shapes need no compatibility aliases.

## Proposed capability boundaries

| Capability or role | Responsibility | Authority not implied |
|---|---|---|
| Factory or runner | Provision an environment on its execution host from approved configuration | Arbitrary host paths, engine flags, or a Podman socket |
| Environment | Durable logical identity, dependencies, storage binding, and lifecycle state | Credential custody or conversation history |
| Shell | Execute commands in the bound environment under its execution policy | Environment reconfiguration or destruction |
| Process | One command's input, output, completion, and termination | A durable job manager or portable OS PID |
| Administration facet | Stop, reconfigure, retire, and explicitly dispose owned storage | Automatic authority to destroy an adopted remote machine |

These are responsibility boundaries, not a requirement to mint five independent formulas
or invent another runner layer.
Start with existing factory and slice objects, and justify every additional object by
its authority separation or durability needs.
Ordinary local and remote references should use the same eventual-send interfaces.
Provider implementations retain private engine configuration, host paths, and credentials.

The environment should supply or bind filesystem authority so file tools and command
execution see the same workspace.
Use existing mount/tree capabilities and an explicit projection on the execution host;
a remote mount capability is not a local pathname.
Stop, retirement, and workspace deletion must be separate actions.

The operator has clarified that sharing and delegation stay in scope, including budgets,
nested shares, delegated session allowances, and expiry/revocation policies.
Those policies should attenuate the same runner, environment, or inference capabilities,
not require a second transport or environment platform.
Removing the unsupported delegated storage-bound extension did not remove those features.

## Shell and process alignment

Keep one guest-facing Shell contract across host, sandbox, VM, and remote implementations.
Reuse `makeShell` where its semantics are suitable, with a thin local spawner adapter
over an eventual-send process capability.
Keep structured argv execution distinct from explicitly granting a shell interpreter.
Do not add backend-specific flags to the agent tool schema.

The first adapter settles these parts of the buffered contract:

- Execution uses structured argv, an environment-relative working directory, and
  explicit environment variables; no shell interpolation or ambient environment is implied.
- EOF is sent to stdin, without withholding process controls until remote acknowledgement.
- Ordinary nonzero exit is a result; spawn, read, stdin-close, wait, transport, and
  timeout failures reject rather than reporting partial output as successful execution.
- The per-stream Shell bound truncates capture and drains the rest.
  The factory's separate native safety ceiling can terminate execution and reject it.
- The deadline starts before admission; `options.timeoutMs` overrides the policy's
  default invocation timeout, longer or shorter, within the native timer range.
  TERM, KILL, and a bounded wait reach late-admitted handles; a bounded rejection
  does not assert native cleanup or permit unproven resource reuse.
- No remote PID is disclosed or used for cancellation.

The remaining integration must establish these parts before claiming acceptance:

- Command resolution, working-directory interpretation, environment inheritance, and stdin closure.
- Exit status versus spawn, stream, transport, cancellation, and timeout failures.
- Whether an output bound truncates capture or terminates execution, and how partial output is reported.
- Cancellation while spawn is pending, termination grace, descendant cleanup, and completion evidence.
- Reader/writer closure and backpressure across both local adapters and CapTP.

Use the existing process machinery for native ownership and cleanup.
Share only equivalent buffering, timeout, and projection mechanics; do not copy another
timeout/kill loop into each backend or hide a cleanup failure behind a successful result.
PIDs may remain diagnostic information, but must not identify a process across hosts or incarnations.

The same callable interface does not promise the same confinement.
A host Shell can still execute with its OS user's authority.
An allowlisted compiler or interpreter can execute arbitrary code; its command name is
not a security boundary.
Describe the environment's confinement separately, using evidence appropriate to its backend.
Do not expose private host paths through ordinary inspection.

## Durability and restart boundaries

The initial target is durable logical configuration and retained storage, with a replaceable
native incarnation.
Persist exact factory, filesystem, policy, and other authority dependencies according to
daemon formula lifetime patterns rather than re-resolving mutable pet names on restart.
Use inert construction and passive inspection; native activation should be explicit or
deferred until an execution request.

Creation must retain ownership and cleanup responsibility before native side effects,
persist the relevant intent before acquisition, and publish a stable logical identity.
Reconstruction must distinguish owned interrupted creation from unrelated directories
and refuse uncertain native takeover.
Missing cleanup evidence must not permit a fresh incarnation to overlap the old one.
Until process-loss research establishes a stronger boundary, uncertainty may require
operator-assisted cleanup rather than automatic recovery.

An interrupted command must never replay automatically.
Persisting an environment recipe does not establish whether an external command committed
its effects, and absence of a result is not proof that it never ran.
The design must choose the minimum admission/outcome evidence needed to refuse ambiguous
replay and report an unknown outcome honestly.
Floot's conversation/effect journal still owns conversation evidence.
Do not create another general journal simply to duplicate it.

Live process handles, stream continuity, PTYs, exactly-once command effects, and durable
background jobs are not promised by this first design.
If they become requirements, research and estimate them separately.
The root-managed per-session producer proposal in #1323 is not selected here, nor is
NixOS or systemd part of the portable interface.

### Provisioning constraints found during implementation

The next slice must establish the formula recipe before adding native provisioning.
The existing `SessionOwner` is not a drop-in environment owner: its forwarding
protocol is conversation-specific (`send`, `interrupt`, and transcript readers).
Do not encode shell commands as conversation messages to reuse it.
Use a durable environment administration capability and an independently revivable
Shell facet, following the existing kit/facet formula pattern.
This is an authority split, not another delegation transport or job platform.

A stored record of live capabilities alone does not establish passive reconstruction.
The daemon's `marshal` maker provides every retained slot when it is reconstructed;
if a slot is a native factory, merely looking up that record can activate the factory.
Conversely, retaining a powers directory and resolving `lookup('factory')` later
would follow a mutable binding, not the exact original dependency.
The recipe needs exact retained formula dependencies and a private lazy resolver.
The resolver must remain scoped to those recorded dependencies, not grant arbitrary
host lookup or pathname authority to the Shell holder.
The precise provisioning entrypoint and resolver wiring are still unimplemented.

Retain an inert native controller and its cleanup before calling its effectful open.
Persist activation intent before acquisition; keep interrupted intent fenced on
reconstruction and never replay a command to infer its outcome.
Clear the intent only after acknowledged cleanup, not after a caller timeout,
an empty process-local map, or a failed constructor without cleanup evidence.
The minimum record is lifecycle/admission evidence, not another transcript or
an accumulating general-purpose command journal.

Cancellation of shared `factory.make()` has a specific limitation: it exposes no
per-pending-creation cancellation handle.
Environment stop must close admission immediately, retain the creation promise,
and dispose a late handle before acknowledging stopped.
It must not cancel a shared factory and thereby terminate unrelated environments.
Reuse a scoped controller where its existing cleanup authority is suitable;
do not copy a native supervisor into the environment caplet.
Failed or uncertain cleanup keeps the environment fenced, with operator-assisted
cleanup where needed; this does not select process-loss recovery from #1323.

### Formula collection and permanent cleanup

Permanent collection is distinct from cancelling a native incarnation.
Endo's collector currently cancels live controllers before reclaiming formula
records and daemon-owned scratch mounts; the worker Context exposes disposal
hooks for cancellation, not a separate permanent-collection hook.
The sandbox factory observes cancellation and closes its slices, but those
observers alone do not give the collector an acknowledged per-slice cleanup barrier.
Individual slices are not independently durable formulas today.
Do not claim a complete GC integration from the existing shutdown path.

The operator has deferred automatic environment GC beyond this PR.
Keep native and owned-storage cleanup explicit on the administration facet.
The operator must retain that facet until cleanup is acknowledged, then remove its
durable roots; merely dropping a Shell or administration reference is not cleanup.
Ordinary cancellation preserves the recipe and development storage for reconstruction.
Explicit deletion must first stop native work, then dispose only owned storage;
failed or uncertain cleanup keeps the environment fenced and its storage retained.

The remaining design gap is acknowledged permanent cleanup after the last durable
root is removed, including a dormant environment that has no installed live hook.
A future design must keep a retained Shell's environment dependencies alive and
retain the cleanup obligation until native disposal is proved.
It should use existing formula collection and ownership mechanisms rather than
introduce another GC platform.
Active/dormant collection, retained Shells, and failed collection cleanup are
follow-up tests, separate from this PR's explicit disposal and restart acceptance.

These constraints need formula-backed tests for passive lookup, exact dependency
retention after name rebinding, stop during acquisition, failed cleanup, and
graceful restart before environment provisioning is described as complete.
Automatic permanent collection remains explicitly unsupported.

## Network and development storage

Execution needs public egress independently of an LLM subscription.
The existing [`public egress capability`](../packages/hosted-agent/src/public-egress.js)
is distinct from credentialed inference, but hosted provisioning currently composes them
through provider grants and a broker sidecar.
The current slice policy accepts only the hosted-agent profile with that sidecar shape.
A general environment must be able to receive approved public-egress authority without
inventing a fake provider or handing an inference credential to the command runner.
This is a composition change, not merely a profile rename.

The existing public-internet mode is managed HTTP/CONNECT proxy access to public
destinations on ports 80 and 443, with DNS/address checks; it is not arbitrary raw networking.
Preserve that distinction in help and acceptance tests.
Changing policy should fence execution and replace the affected native configuration
while preserving authorized storage, not silently change an in-flight command's authority.

Reuse the pinned [`shared development image`](../packages/hosted-agent/oci/dev/README.md)
without a Claude/Codex/OpenCode CLI overlay for a generic Fae environment.
The base includes common shell and build tools, Python, and C/C++ tooling, but not Rust or Go.
Use native persistent development storage for user-installed toolchains, caches, and build output.
For a Rust pilot, bind `HOME`, `CARGO_HOME`, `RUSTUP_HOME`, and, where appropriate,
`CARGO_TARGET_DIR` to owned storage on the execution host.
The workspace may remain a 9P source projection, but toolchain executables and caches
should not depend on its filesystem semantics or operation-local tmpfs survival.

Keep the image immutable and model processes unprivileged.
User-space installation or an operator-built image is different from granting permission
to modify the image's root filesystem.
Storage retirement needs an explicit policy; stopping an environment should not delete
the workspace or unexpectedly destroy its installed toolchain.

Tokyo startup cleanup currently includes container-prefix and runtime-marker sweeps
in `endo-host/modules/endo-daemon.nix`.
Before deploying persistent managed environments, reconcile these sweeps with explicit
ownership and storage retention; a matching name alone is not adoption or cleanup proof.
This is host integration work, not a requirement to expose host-specific service management
through the portable shell.

## Floot development preset and Fae inference

Agent execution, inference, and POSIX execution are independent choices.
A development session should use Fae's agent loop with the Codex subscription
pool while holding a Shell capability for its own Podman environment.
Selecting that pool does not select the Codex CLI harness.
In Floot this means its existing direct-agent loop, Fae tools, and shared turn
machinery, not replacing that loop with the standalone Fae inbox driver.
Floot keeps its effect journal as conversation owner; standalone Fae keeps its
conversation tree.
Share the provider adapter and equivalent compaction mechanics, not a second
conversation owner inside one session.

The new development preset provisions one environment and puts its public
Shell in the session inventory as `shell`.
Floot retains the administration facet; the model receives neither environment
destruction authority, a Podman socket, nor inference credentials.
Use the existing Shell tool projection with an unambiguous `runCommand` name:
Floot's `exec` already means JavaScript capability evaluation.
File tools and commands must share the same workspace view.
Do not fall back to Fae's host-local command executor when a supplied Shell fails.

Keep the shared development image immutable and give each session owned native
storage for its home, installed tools, caches, and build output.
Every operation container mounts that same storage.
User-space tools therefore survive subsequent commands and graceful restart;
operation-local tmpfs and the 9P source mount are not installation targets.
Stop preserves storage.
Deletion explicitly disposes session-owned storage after acknowledged cleanup,
without deleting shared or adopted workspaces.
An interrupted command is reported as interrupted or unknown, never replayed.
Pin the actual environment recipe and dependencies, rather than reinterpreting
an edited preset catalog when a session is reconstructed.

Derive command network settings from the environment, not the inference backend.
Compose the existing managed public HTTP/HTTPS egress without a fake provider
or credentialed broker listener.
Fence execution before changing the network configuration and preserve storage.
Reconcile Tokyo's native cleanup sweeps with explicit retained ownership before
deployment; this does not add systemd to the portable Shell interface.

### Codex subscription provider adapter

The existing Subscription exposes `openEndpoint` for inference without a listener.
Fae should use a local provider adapter over this eventual-send capability.
Reuse the current pool's account routing, renewal owners, model catalog, capacity
readings, and optional bounded shares; do not create a second credential owner.
Retain the subscription dependency, model, reasoning option, and stable session
identity as the recipe, not a live endpoint or a credential.
Acquire endpoints lazily and revoke them on cancellation or disposal.

Translate dialogue, tools, and tool outcomes into Responses requests, with
non-stored streaming responses as required by the current subscription policy.
Decode text, complete tool calls, terminal errors, usage, and opaque continuation
items; do not flatten backend-specific context into dialogue.
Reject malformed, truncated, incomplete, or unsuccessful streams before exposing
tool execution, and do not blindly repeat uncertain inference.
Use the same adapter in standalone Fae and Floot's direct-agent provider path.
The UI must distinguish Fae using the Codex pool from the hosted Codex CLI agent.
Model and reasoning choices come from the pool's catalog; live Codex acceptance
uses the catalog's Luna model.

### Fae context compaction

The user has lifted the earlier hold on Fae compaction.
Long-running development sessions are not ready until compaction is exercised.
Use the selected or actually serving model's context window and observed usage,
with space reserved for the next reply and tools, rather than a fixed message cap.
If the model's window is unknown, report that limitation instead of pretending
that an arbitrary limit is its context capacity.

Compact completed conversation segments into a continuation checkpoint.
Preserve unresolved tool calls and outcomes verbatim, required call identifiers,
and backend-specific opaque context required for valid continuation.
The provider adapter owns its wire/context rules; the agent owns conversation
selection and durable checkpoint publication.
Share equivalent checkpoint validation and selection machinery with Floot rather
than copying its conversation loop or creating another transcript authority.

Persist a checkpoint's source boundary, summary, retained context, and provider
identity before selecting it for the next inference request.
Select it only when that boundary is on the current conversation branch and its
provider/context identity is compatible with the next request.
Late publication onto a different branch must not replace that branch's context.
Keep the original transcript available and restore the selected checkpoint after
restart without repeating compaction or tool effects merely to infer their status.
Cancelled, failed, or invalid compaction must leave the previous context selected
and expose a clear error.
Compaction itself uses the granted inference capability and its existing budget.

## Dependencies and existing documentation

| Document | Relationship |
|---|---|
| [Daemon agent tools](daemon-agent-tools.md) | Owns the existing Shell and tool projection; sandbox-backed shell Phase 2c remains the relevant unfinished seam |
| [POSIX sandbox](endo-posix-sandbox.md) | Factory, slice, process, driver, and confinement foundations; review unfinished methods against current code |
| [Hosted sandbox unification](hosted-agent-sandbox-unification.md) | Current shared hosted composition to simplify and reuse, not duplicate |
| [Hosted subscriptions](hosted-agent-subscriptions.md) | Separate inference/account authority and retained sharing/delegation policies |
| [Hosted native recovery](hosted-native-recovery-investigation.md) | Independent uncertainty, containment, and crash-recovery research; no producer architecture selected |
| [Source bulk audit](../packages/floot/SOURCE-BULK-AUDIT.md) | Deletion-before-abstraction work and the clarified decision to keep sharing/delegation |
| [Refactor alignment](../packages/floot/REFACTOR-ALIGNMENT.md) | Current implementation and acceptance status for #1248 |

Assign this implementation to M10, with a Shell integration dependency on the M3
agent-tool work.
Size and duration remain unestimated until the contract and minimum durability requirements
are reviewed; no additional critical-path duration is assigned.

## Implementation sequence

1. **Decide the contract and minimum state.** Specify the roles, failure semantics,
   authority descriptors, restart guarantees, and retained evidence before adding interfaces.
   Remove or redefine misleading unsupported slice methods.
2. **Align shell execution.** Build the small sandbox-process/spawner adapter and test
   it against the existing host contract, including failure and cancellation differences.
   Keep native ownership in its current layer.
3. **Provision a durable Podman environment.** Use formula recipes and exact dependencies,
   separate execution/admin facets, independent public egress, and retained development storage.
   Keep per-operation containers initially; a persistent-container alternative needs its own
   cancellation, isolation, and filesystem tests before replacing that model.
4. **Run a Fae Rust pilot and a remote capability test.** Replace the supplied environment's
   local `runCommand` projection with the common Shell tool.
   Install Rust, compile, test, observe a real nonzero exit, and exercise cancellation.
   Restart the daemon, re-lookup the environment, verify toolchain/workspace retention,
   and prove an interrupted command is not replayed.
   Run through a real two-daemon CapTP connection, not just a local `E()` wrapper.
5. **Make Floot consume the same environment authority.** Keep native CLI continuation,
   inference grants, credentials, and transcript ownership separate from POSIX execution.
   Remove the superseded provisioning/execution path after equivalent acceptance passes.
   Add VM or adopted-machine implementations only when needed; a full VM provisioning API
   is not required to establish the portable Shell contract.

The next delivery order is:

1. Record this expanded plan, then implement and test the capability-backed
   Codex provider adapter independently of environment provisioning.
2. Wire the provider recipe into standalone Fae and Floot, preserving context,
   cancellation, model discovery, and existing subscription ownership.
3. Implement and exercise durable Fae compaction, including forced compaction
   followed by tool use and daemon restart.
4. Finish durable environment provisioning, native development storage, and
   independent network policy under the constraints above.
5. Add the development preset and run the combined Fae/Codex/Rust acceptance,
   followed by remote Shell acceptance and Tokyo deployment.

Use the adversarial subagent review loop before every commit.
Update this document after each slice and distinguish unit tests, formula-backed
tests, live acceptance, and deployment rather than treating one as proof of another.

## Acceptance and unresolved decisions

Acceptance must cover create, inspect without activation, tool use, nonzero exit, spawn/read
failure, cancel during acquisition, timeout, output bounds, policy change, graceful restart,
retirement, and explicit storage disposal.
Check credential isolation, remote file/command view consistency, no authority widening,
and retained cleanup after failed acquisition or removal.
Keep the existing cross-backend lifecycle and restoration matrix for Floot consumers.
Existing focused factory/runtime and exo-shell tests passed during investigation;
they do not establish the proposed integration, remote execution, or crash recovery.

Provider acceptance covers a reply, multiple tool calls/results, malformed and
failed streams, cancellation during endpoint acquisition and reading, account
exhaustion, credential isolation, retained opaque context, and graceful restart.
The combined development task installs Rust, compiles and tests a small program,
reuses installed binaries across commands, observes a nonzero exit, cancels a
command, exceeds the compaction threshold, restarts and continues, changes
network policy, and deletes only its owned environment resources.
Compaction tests also cover stale or late publication, wrong-branch selection,
and incompatible provider restoration, leaving the previous valid selection intact.

Before implementation, decide where a durable environment is minted and how its execution
and administration facets are retained, whether process streaming is needed by Fae initially,
and the minimum durable command evidence.
Also decide storage retention and policy replacement rules, reconcile host cleanup, and
test the adapter's failure semantics before claiming a common contract.
Do not turn these unresolved choices into a generic job scheduler, delegation platform,
or automatic native-resource recovery project.

## Prompt

> lets investigate our management of podman slices. i am interested in making durable
> endo formula capabilities for creating and managing podman slices and running commands
> in their context. the idea is then that the floot machinery would build off of this
> and the fae agent could use this to get access to a POSIX environment to eg run rust
> code. ideally the shell capability would not be specific to podman and would have
> the same interface if its a vm or remote machine. consider the design and what it
> would take to get us there

> so in Floot id like to create a new preset that includes a new podman slice whose
> shell can be placed in the inventory. it would need to work in such a way that the
> session can install tools and use them. map out what needs to be done to make that
> work. additionally, id like to use fae against the codex provider pool

> ill just add we need a compaction mechanism on fae

> document the plan, then enact the plan
