# Durable POSIX environments and shell capabilities

| | |
|---|---|
| **Created** | 2026-10-01 |
| **Updated** | 2026-10-01 |
| **Author** | kumavis (prompted) |
| **Status** | In Progress |

## Implementation status

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
Focused factory, native-factory, ownership, lifecycle, and runtime suites pass
78 tests in each of the four SES configurations; package types and ESLint pass
with warnings, and root documentation builds with 0 errors and 180 warnings.
The full sandbox suite is not green: two unchanged direct Podman-driver
environment-extensibility assertions fail in the unsafe configuration.
No live Podman acceptance is claimed on this macOS development host.
The adapter adds eight passing tests in each SES configuration.
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

These constraints need formula-backed tests for passive lookup, exact dependency
retention after name rebinding, stop during acquisition, failed cleanup, and
graceful restart before environment provisioning is described as complete.

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

## Acceptance and unresolved decisions

Acceptance must cover create, inspect without activation, tool use, nonzero exit, spawn/read
failure, cancel during acquisition, timeout, output bounds, policy change, graceful restart,
retirement, and explicit storage disposal.
Check credential isolation, remote file/command view consistency, no authority widening,
and retained cleanup after failed acquisition or removal.
Keep the existing cross-backend lifecycle and restoration matrix for Floot consumers.
Existing focused factory/runtime and exo-shell tests passed during investigation;
they do not establish the proposed integration, remote execution, or crash recovery.

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
