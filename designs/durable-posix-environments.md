# Durable POSIX environments and shell capabilities

| | |
|---|---|
| **Created** | 2026-10-01 |
| **Updated** | 2026-10-05 |
| **Author** | kumavis (prompted) |
| **Status** | Initial implementation complete; Tokyo acceptance passed |

## Implementation status

2026-10-02: initial implementation passed Tokyo acceptance on generation 194,
app `854a4c5aae573b669692fd132bcd30cbb0cc3926`, host
`1f2a4bdc027089096a6cea27d549903e527c2b6b`.
Generation 195 added the DNS and request-body follow-up below.
Generation 196 added safe stream-failure diagnostics on 2026-10-05.
Tokyo now runs generation 197, app `5079916db715d368bb6bc4e1d9b6b6ac5a4d96ad`,
host `f7021d6a1cf8686eea412cdd2ae3fbe9458d6efc`, with the dependency-install
networking repairs described below.
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
The underlying allocation cause is not yet known.
The test container continued after its controlling worker died; the operator
verified its ownership and native HOME mounts, then stopped that exact container.
Partial logs and crash diagnostics were archived privately before daemon recovery.
After restart, the transcript retains 12 tool calls and 11 results, with the
turn explicitly `outcome-unknown`; no exit/result was manufactured or task replayed.
Original session IDs remain present, and daemon/gateway health passes.
The interrupted test session and native HOME remain for investigation, with no
running test containers; its environment is inactive but marked interrupted.
Unattended whole-suite acceptance is therefore still unverified.
Private receipts: `/var/lib/endo/endo-autonomous-suite-20261005/` and
`/var/lib/endo/endo-autonomous-suite-2-20261005/`.

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
Shared Fae compaction now selects only older completed turns and retains the last
two user turns, their complete tool groups and backend-specific context verbatim.
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
An oversized recent tail or one large unfinished turn fails explicitly instead
of dropping evidence.
Original history remains available; restart restores the checkpoint without
repeating summarization or tool effects.
Focused tests cover forced compaction/continuation and factory reconstruction,
unknown capacity, malformed summaries, recent opaque context, cancelled/stale
publication and ambiguous checkpoint writes.
Live pool/compaction acceptance is not yet claimed.
The shared credential-free listener worker now accepts a closed network-only
bootstrap with only a public-egress endpoint, and publishes `ManagedNetworkV1`
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
- The deadline starts before admission and can only narrow the policy deadline.
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
