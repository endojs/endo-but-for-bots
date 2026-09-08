# `@endo/thixotrope`

A prototype distributed ocap machine with purely orthogonal persistence.

A thixotrope daemon is a simpler cousin of the Endo daemon: it spins up
workers whose guest state is preserved by XS heap snapshots or the
Ironhorse SQLite heap store rather
than by explicit formula-based persistence.
Guests never observe their own suspension, restoration, or the
daemon's restarts — persistence is orthogonal to the guest programming
model, and there is no upgrade story on purpose.

The machine speaks the OCapN p2p wire protocol end to end, and the
daemon is mostly a forwarding and slot-rewriting hub
(`src/hub.js`): workers and remote peers are hub sessions, and
every message between them is structurally transcoded through
persisted c-list tables — the daemon reifies no presences, no
promises, no subscriptions for routed traffic.
Worker exports published under a swissnum become OCapN sturdy refs
answered by the hub's bootstrap from its publications table.

Workers are sleepy.
When a worker is quiescent, the daemon can snapshot and terminate it;
a later message to any of its presences transparently wakes it.
Sleep is embedder policy, never guest-visible: the worker object's
`sleep()`/`wake()`/`isAwake()` are explicit hooks for embedders and
tests — a guest cannot observe (or trigger) any of them.

Workers have no names.
Each is identified by a host-generated unguessable id, so reaching a
worker requires a capability — a publication, a reference relayed
through the hub, or a facade — never a well-known string.
`createWorker({ debugLabel })` accepts an optional label that appears
only in logs and error messages; `daemon.getWorker(workerId)` is the
embedder's admin route to an existing worker.
`daemon.eval(source, endowments?)` is the lambda-shaped shortcut:
evaluation implies a fresh worker, and the result is the only handle
returned (the worker persists like any other and shows up in
`listWorkerIds()`).

## Local supervisor and workspace

Build the Ironhorse worker and bundles as described below, then run:

```sh
yarn workspace @endo/thixotrope thix serve ./private-state
# In another terminal:
yarn workspace @endo/thixotrope thix attach ./private-state
yarn workspace @endo/thixotrope thix status ./private-state
yarn workspace @endo/thixotrope thix stop ./private-state
```

`serve` runs in the foreground and creates a private state directory (mode 0700).
It accepts local OCapN admin sessions on `control.sock` (mode 0600).
Only the supervisor opens the persistence store.
The socket grants full local administration; anyone running as the same OS user
can administer this workspace.
A service manager can restart the foreground process; clients never start it implicitly.

`attach` evaluates one JavaScript line at a time in the same persisted workspace vat.
Use `globalThis.name = value` for bindings shared between evaluations.
Top-level `const` and `let` declarations are scoped to their individual evaluation;
closures containing those variables persist when retained by the workspace.
Ctrl-D or Ctrl-C detaches the terminal, leaving the supervisor running.
Piped input works too, and evaluation failures produce a nonzero exit status.
A lost connection reports an uncertain evaluation outcome and never retries it.

The workspace has `E`, `Far`, `harden`, and a `vats` controller.
For example, enter each of these as one line:

```js
(async () => { globalThis.other = await E(vats).createWorker('counter'); })()
(async () => { globalThis.counter = await E(other).evaluate("(() => { let count = 0n; return Far('Counter', { incr: () => ++count }); })()"); })()
E(counter).incr()
```

Detach, stop and restart the supervisor, then attach and call `E(counter).incr()` again.
Both vats retain their state and the reference between them; calls pass through comms.
A publication keeps the workspace vat reachable without an inventory layer.
The observable inventory is an optional guest convenience, with no special GC role.

The workspace also provides `inventory`, a special object backed by an ordinary Map.
It supports `get`, `has`, `set`, `delete`, `clear`, `keys`, `entries`, and `getSize`.
Keys are strings; values retain their ordinary identity and reachability.
To watch it in another terminal:

```sh
yarn workspace @endo/thixotrope thix inventory ./private-state
```

Then use `attach` to modify it:

```js
inventory.set('counter', counter)
inventory.set('note', 'hello')
inventory.delete('note')
```

The TUI redraws from subscribed snapshots and displays object/capability placeholders;
it receives no references to the inventory's actual capability values.
Press `q` then Enter, Ctrl-D, or Ctrl-C to close the view.
The TUI always disconnects its dedicated socket on close, including EOF and signals.
An abruptly killed TUI also loses its socket, so the supervisor cancels its subscription.

Guest code can call `inventory.subscribe(listener)` where the listener has a
`changed(snapshot)` method.
The subscription immediately sends the current display snapshot and returns an
object with `unsubscribe()`.
Snapshots contain a bigint revision and `[key, displaySummary]` entries.
Unchanged `set` calls, missing-key deletes, and empty clears do not notify.
Slow listeners receive the latest coalesced snapshot rather than an unbounded history.

This exercises three lifetimes: persistent inventory state, persistent guest
subscribers, and ephemeral UI subscribers bridged by the running supervisor.
An attached UI can continue across guest sleep/wake.
Closing it explicitly cancels its guest subscription and drops the bridge's observer
reference, even if a notification is pending.
On supervisor restart, old UI subscriptions are discarded while guest subscriptions remain.
Shutdown bounds its wait for guest cancellation so a stalled guest cannot prevent
worker cleanup and store release; restart discards any remaining UI registrations.
Cancellation makes subscription objects collectible; physical reclamation follows
normal heap GC and snapshot/journal cleanup rather than a special inventory GC rule.
`inventory.subscriptionCounts()` reports the durable and ephemeral registrations for
experiments; it is not a measure of physical heap reclamation.

`status` reports worker state and cumulative process-local counts and milliseconds
for delivery (including its commit cranks), snapshot creation, and engine startup/wake.
These are coarse measurements, not a latency benchmark or isolated fsync timings.
The idle sleep delay is 30 seconds; `stop`, SIGINT, and SIGTERM park workers before exit.
Quarantined workspaces remain inspectable with `status`; this version offers no repair command.

### Persistent applications

Install a JavaScript module exporting `make(powers)` into a fresh guest vat:

```sh
yarn workspace @endo/thixotrope thix install ./private-state counter ./examples/counter.js
yarn workspace @endo/thixotrope thix applications ./private-state
```

Module paths resolve from the CLI process's working directory.
The Yarn workspace command runs inside `packages/thixotrope`.
The module belongs to a JavaScript package with a `package.json`.
The CLI bundles its static module graph locally; application code runs in the guest.
The initial installation profile limits the serialized request to 16 KiB, rejecting
larger bundles before sending them into the workspace crank.
Use the guest-provided `E`, `Far`, and `harden` rather than bundling those libraries.
The guest has its usual `E`, `Far`, and `harden` globals, with no ambient Node powers.
Append `powerName=inventoryKey` arguments to grant selected inventory capabilities to `make`.
This first profile accepts remotable capabilities as grants; copy data and promises are
rejected before forwarding, so a small request cannot hide a large copied grant.
The inventory itself and the worker controller are not implicitly granted.

From `attach`, call `E(E(apps).get('counter')).incr()`.
`apps.list()` reports each installation's SHA-256 bundle digest, grants, and status.
The registry retains the factory's result, including a pending result promise.
Its code and captured powers survive restart without reading the original module again.
The digest identifies the exact bundle bytes, not a publisher or a signature.
Repeating a name with the same bundle and grant mapping reuses its original result;
changing its code or grants requires a different name or explicit `apps.remove(name)`.
Inventory changes after installation do not change previously captured powers.

Failed installations remain inspectable and do not automatically run `make` again.
A crash during host-side worker allocation or acquisition of its evaluator can reject that installation under the
existing at-most-once host-resource policy; remove its record before deliberately retrying.
`apps.remove(name)` releases the registry's reference, including a pending installation;
it does not cancel work or revoke references already held elsewhere.
Unused application vats become eligible for ordinary vat collection.
This initial version provides installation, not live code upgrades.


## Ironhorse demos and CI tests

Each demo runs two guest vats in separate Ironhorse processes, connected only
through the daemon's non-reifying OCapN comms hub.
The Node endpoint wires their initial capabilities and invokes the second vat.
The examples use ordinary `const` and `let` variables.
A Map could provide a useful user inventory of named capabilities, but neither
example needs an inventory or gives one a special GC role.

**Counter:** the first vat owns a counter closure; the second simply forwards
`incr()` and `read()` using `E(counter)`.
There is no application-level promise-listener machinery in this example.
The count is a `bigint` because it models an unbounded natural number.

**Promise listener:** the producer creates a pending promise and retains its
resolver; the listener vat registers a `.then()` callback.
After restart, the producer resolves the promise and the persisted listener runs.
This example contains no counter.

From the repository root, after `corepack yarn install --immutable`:

```sh
cargo build --locked --release -p thixotrope-ironhorse-worker
yarn workspace @endo/thixotrope build:ironhorse-bundles

# Demo 1: cross-vat counter (default state: packages/thixotrope/tmp/ironhorse-counter)
yarn workspace @endo/thixotrope demo:ironhorse:counter init
yarn workspace @endo/thixotrope demo:ironhorse:counter incr
yarn workspace @endo/thixotrope demo:ironhorse:counter check

# Demo 2: persisted listener (default state: packages/thixotrope/tmp/ironhorse-promise)
yarn workspace @endo/thixotrope demo:ironhorse:promise init
yarn workspace @endo/thixotrope demo:ironhorse:promise listen
yarn workspace @endo/thixotrope demo:ironhorse:promise resolve ./tmp/ironhorse-promise hello
yarn workspace @endo/thixotrope demo:ironhorse:promise check

# The same real-worker scenarios exercised by CI
yarn workspace @endo/thixotrope test:ironhorse
```

Both demos accept a state-directory argument after the command and support
`status`; `demo:ironhorse` is an alias for the counter demo.
Each invocation starts the daemon, calls the published guest, then parks the vats
and exits.
Existing heaps keep their original guest code; use fresh directories for these
split examples.
The metadata identifies which demo owns a directory and rejects a mismatch.

CI's `test-thixotrope-ironhorse` job builds the release worker and SES/OCapN
bundles, then runs the original fourteen serial AVA scenarios:

1. A basic cross-vat counter call.
2. A persisted promise listener that settles after restart.
3. Transparent counter wake after explicit sleep.
4. Acknowledged mutations recovered after crash without duplication.
5. A pending reply recovered after failure before delivery.
6. A pending reply recovered after heap commit but before outbound release.
7. Ordered concurrent counter calls.
8. A guest-acquired capability retained across restart.
9. A persisted rejection listener.
10. Two listeners retaining their registration order.
11. Async locals and `finally` across two separate await checkpoints.
12. SES confinement after restore.
13. Metered failure quarantine with a healthy sibling.
14. Corrupt-image refusal and incarnation cleanup.

Nine additional reliability scenarios in `test/ironhorse/reliability.js` cover
four actual daemon SIGKILL boundaries, competing supervisors, runtime identity,
inspection of quarantined workers, custom heap-path refusal, and ownership-helper
loss during worker startup.
The suite is selected by `ava.ironhorse.config.mjs`; it runs the two files serially.
It requires the real binary and bundles: missing artifacts fail the lane instead
of skipping tests.
Each scenario owns an independent directory and tears down its daemon and workers.
Fault injection targets the counter delivery before execution and after its heap commit.
The original daemon crash helper drains queued transport work before stopping workers.
The subprocess suite instead stops the daemon synchronously after journal append,
heap commit, output acceptance, or snapshot metadata publication, then SIGKILLs it.
These tests verify exactly one counter increment after a fresh process restores the store.
They do not simulate hardware power loss or storage devices that ignore fsync.
`THIXOTROPE_IRONHORSE_WORKER` can select a different binary.

`makeIronhorseEngine({ workerBinary, bootPaths, storePath, crankBudget,
requestTimeoutMs })` implements the existing WorkerEngine interface. The
bootstrap uses the real SES shim and compartments. Native `async` functions,
ordinary promises, closures, and retained capabilities persist in SQLite without guest-side
serialization. Suspended async activations use the new `ASYN` snapshot atom
and store schema 24; their saved frames and promise references are validated
on restoration.

Every completed crank commits an incremental SQLite checkpoint before a reply
leaves the process. Snapshot references identify immutable, content-addressed
SQLite files. A running incarnation uses a private writable copy. Sleep folds
the WAL, saves and syncs an image, then pairs its reference with the transport's
journal cut and outbound sequence base. Recovery copies **that exact image**
and replays the journal suffix; it never adopts an abandoned incarnation's
newer database. Hub input watermarks and a durable outbox commit together before forwarding.
Destination journals record stable outbox sequence numbers with each frame, so
resending a frame after a daemon crash cannot duplicate a guest delivery. This MVP pays
for a whole database copy on sleep/wake, while ordinary cranks write dirty
state incrementally. Daemon journal/metadata writes are also synced.

The guest crank budget defaults to 10 million computrons; trusted peer
initialization has a separate one-billion-computron allowance, and the process
watchdog defaults to 60 seconds. A deterministic VM halt, including budget
exhaustion, preserves the last image and journal for inspection, records a
failure in worker metadata, and retires the logical comms session so pending
calls reject. Other vats continue to run. Failed vats do not replay the same
poison input after a restart; inspection does not retry that input.

This remains an experimental, local, single-supervisor MVP.
A kernel-backed directory lease refuses concurrent supervisors.
Workers hold shared incarnation leases until they exit; a replacement supervisor
must acquire the exclusive incarnation lease before reclaiming abandoned copies.
Lock files stay in place: never unlink them to force an unlock.
Use a matching engine build and bootstrap for stored images; upgrade migration
of live guest code is outside this demo. Async generators and `Array.fromAsync` suspensions remain
refused by the engine's persistence gate. The bootstrap omits the unfinished
optional Iterator-helper profile and uses SES's minimal override-taming profile.
This keeps the array iterator as a frozen native data property, as required by
Ironhorse's current typed-array copy path. The loopback netlayer is a testing transport;
a fixed public listener, service installation, and remote authentication UX are
not part of this CLI.


### Compatibility and recovery

`runtime.json` records the worker executable hash, ordered bootstrap hashes,
crank budget, and host delivery protocol.
The worker's SQLite signature includes the resulting profile digest.
The supervisor validates this manifest under its lease before restoring heaps or
cleaning abandoned incarnations, and executes private checked copies throughout
its lifetime so edits to the original paths cannot change a later wake.
This release also advances the engine boot-layout signature to 21.

Use `demo:ironhorse:counter status PATH` (or the promise variant) for administrative
worker metadata without sending messages to guest capabilities.
`demo:ironhorse:counter inspect PATH` reads the manifest and metadata without
starting a daemon, acquiring worker capabilities, repairing files, or requiring a
matching binary; it remains available for incompatible or quarantined stores.
`inspectIronhorseStore(PATH)` exposes that read-only operation to embedders.
An inspection of a running store is not a transactional backup.

Recovery is deliberately explicit:

- After process death, reopen with the same runtime and budget; leases release
  when their owning processes exit, and the new supervisor recovers image plus journal.
- On an identity mismatch, restore the matching executable and bootstrap bytes.
  Do not edit the manifest to bypass the check.
- Older stores without a manifest are refused rather than assigned an unverified
  identity; retain their original checkout/runtime, or initialize a fresh directory.
- For a quarantined guest, inspect and preserve its image, journal, and metadata.
  A fresh demo can be initialized in a separate directory while keeping that evidence.
  This change does not clear quarantine, replay poison inputs, or migrate live code.

The engine now materializes modeled intrinsic surfaces before preventing
extensions and refuses late intrinsic installation onto non-extensible objects.
There is no bootstrap priming workaround for `Symbol.unscopables`.

## Example

```js
// The daemon runs under Hardened JavaScript: lock down first.
import '@endo/init';

import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeFsStore, makeThixotropeDaemon, makeXsEngine } from '@endo/thixotrope';

const daemon = await makeThixotropeDaemon({
  store: makeFsStore('/var/lib/thixotrope'),
  engine: makeXsEngine({
    workerBinary: 'target/release/thixotrope-xs-worker',
    bootPath: 'dist-xs/boot.js',
    bundlePath: 'dist-xs/worker-peer.js',
    casPath: '/var/lib/thixotrope/cas',
  }),
  codec: syrupCodec,
  makeNetlayer: ({ handlers, logger }) => makeTcpNetLayer({ handlers, logger }),
});

const worker = await daemon.createWorker({ debugLabel: 'counter' });
const counter = await worker.evaluate(`
  (() => {
    let count = 0;
    return Far('Counter', { incr: () => (count += 1) });
  })()
`);
const secret = daemon.publish(counter);
// Any OCapN peer can now mint a sturdy ref from (daemon.location, secret)
// and call the counter — across worker sleeps and daemon restarts.
console.log(await E(counter).incr()); // 1, via the in-process endpoint

await daemon.shutdown(); // parks every worker; the store resumes it all
```

A restarted daemon must serve the same address its peers hold: pin the
netlayer's port (`makeTcpNetLayer({ ..., specifiedPort })`, or the
equivalent for your netlayer) rather than letting a successor process
pick a fresh ephemeral port.

## Worker sessions

Each worker runs a full (reduced-profile) OCapN peer —
`src/worker-peer.js`, a persistent `Compartment` behind an OCapN
client whose evaluate facet is fetched from the worker's own locator
under the well-known swissnum `shell`.
The daemon's side of the session is a durable worker transport
(`src/durable-worker-transport.js`), the durability envelope of the
worker's hub session: no wire handshake, no client — the OCapN hub
owns routing, and attaching the transport is the *same* operation for
a fresh worker, a wake from snapshot, and a daemon restart.

Durability is snapshot-keyed frame retention:

- daemon→worker frames are journaled before they reach the duct, and
  retained until a snapshot commits (not until acknowledged);
- wake = restore the snapshot and replay the journal suffix; every
  worker frame — live or replay-regenerated — carries a
  session-lifetime sequence number (a base persisted with each
  snapshot plus its index), and the hub's inbound watermark, which
  commits atomically with the frame's effects, drops the duplicates
  determinism regenerates: exactly once, never lost, never twice;
- sleep = drain, snapshot, record `{ ref, cut }`, truncate the
  subsumed journal prefix, terminate. The OCapN session — and every
  live remote reference through it — stays live; the next inbound
  frame wakes the worker.

A crash without sleep restarts from the last snapshot plus the full
journal suffix; clean shutdown is an optimization, not a correctness
requirement.

## The hub, and how daemon restarts work

Thixotrope owns the hub, its persistence transactions, delivery queues, and session lifecycle.
OCapN supplies protocol codecs, descriptor helpers, and signature operations.
The hub (`src/hub.js`) holds only per-session c-lists (position ↔
reference row), answer routes, and publications — plain JSON tables,
written through to the store before any frame that names them exists.
Every message is decoded with the ordinary wire codecs against a
table-backed reference kit, routed by its target's origin, and
re-encoded toward the destination with its c-lists; subscriptions,
resolutions, pipelined answers, and gc hints are all just messages
whose slots get rewritten.
Promises are not special anywhere: an `op:listen` forwards like any
delivery, and a settlement frame toward a sleeping worker wakes it
through its transport.

Exactly one session reifies values: the **endpoint**, an in-process
OCapN client hosting the daemon's genuine objects — system resources
and the worker controller — and the embedder's admin route.
Its session records shrink to resource descriptions (re-instantiated
by name at recorded positions) and at-most-once answer obligations —
the one kind of pending obligation that genuinely dies with the
process, since worker-owed answers now survive restarts by heap
replay.

A daemon restart is: reload hub tables, reattach worker transports
(asleep), restore the endpoint session, and let remote peers resume by
rebinding their ducts.
Nothing is re-seated because nothing was reified.
A promise minted in worker A and held in worker B settles after a
daemon restart with both workers starting asleep — the subscription is
nothing but rows and a wire subscription in A's heap.
Retired workers leave dead-reference tombstones in the tables, so
holders' calls break loudly instead of jamming.

## Engines

`makeXsEngine` is the engine: each incarnation is a `thixotrope-xs-worker`
process (rust/thixotrope-xs-worker, a minimal runner on the `xsnap` crate)
evaluating the worker peer bundle inside an XS machine, with real heap
snapshots streamed into a content-addressed store.
Binary OCapN frames ride the binary's ASCII NDJSON duct base64-encoded
(`src/worker-peer-xs.js` is the bundle entry; `dist-xs/worker-peer.js`
the artifact).
Build it with:

```sh
git submodule update --init c/moddable
yarn workspace @endo/thixotrope build:xs-bundles
cargo build --release -p thixotrope-xs-worker
```

The XS tests (`test/worker-peer-xs.test.js`,
`test/durable-worker-session-xs.test.js`, and
`test/worker-session-restart-xs.test.js` — snapshot restore under a
live session, sleepy workers with crash recovery, and a full daemon
restart with cross-worker links and settlements) skip themselves when
those artifacts are absent — build them so the engine you actually
ship is the engine you test.
XS workers boot under XS's native Hardened JavaScript: the runner
installs the engine's own `harden` and `lockdown` globals and the
boot script calls `lockdown()`, so guests evaluate against frozen
shared intrinsics inside a native `Compartment`.

The engine seam stays open for future JS engines with other heap
snapshot mechanisms: any object satisfying the `WorkerEngine` type in
`src/worker-engine.js` (`canSnapshot`, `start`, optional
`releaseSnapshot`) plugs in.
Two internal replay engines (`src/peer-replay-engine.js`) implement
the same contract deterministically without an XS build; they are test
doubles for the daemon's persistence logic, deliberately not part of
the public API.
These test doubles disable Node import finalization because GC-generated
protocol frames are not journal inputs and cannot be replayed deterministically.
Production worker peers retain their normal import collection behavior.

## Workers creating workers

Grant a worker the built-in `worker-controller` resource and its guest
can create and endow other workers, with capabilities passed from its
own heap and the daemon as the relay:

```js
const controller = daemon.makeResource('worker-controller');
await parent.evaluate(
  `
  Far('Parent', {
    setup: async () => {
      const child = await E(controller).createWorker('child');
      const shared = Far('Shared', { secret: () => 'from-parent' });
      return E(child).evaluate(childSource, harden({ shared }));
    },
  })
  `,
  { controller },
);
```

Cross-worker links are durable at the session-record layer: the
child's session records the parent-origin endowment as a link to the
parent session's slot, re-seated on daemon restart without waking
either worker.

## Durable sessions with remote peers

OCapN has no session-resumption message, so thixotrope prototypes it
beneath the protocol, at the netlayer: `makeDurableNetLayer` wraps a
transport netlayer (e.g. TCP) with resumable logical connections.
Each logical connection carries an unguessable resume token; every
OCapN frame rides in a sequence-numbered envelope; both sides retain
unacknowledged frames; and when the socket dies, the originator
reconnects with a `resume` preamble and each side replays what the
other has not seen.
The OCapN layer above is never told the socket dropped, so the
session — and every live remote reference in it — survives
transparently:

```js
const daemon = await makeThixotropeDaemon({
  // ...
  makeNetlayer: ({ handlers, logger, resumption }) =>
    makeDurableNetLayer({
      handlers,
      logger,
      resumption,
      makeBaseNetlayer: powers => makeTcpNetLayer(powers),
    }),
});
```

Wrap both peers.

On the daemon side the sessions are also durable across **daemon
restarts**: unacknowledged outbound frames persist per resume token,
the session's state proper is its hub rows, and a resumed session
reports the hub's committed receive watermark — the peer retransmits
exactly what the hub has not absorbed, and the hub drops the overlap
(exactly once).
A successor process pins the same port; the peer's netlayer reconnects
and resumes; the daemon rebinds the duct to the same hub session — no
handshake, no re-seating, no worker wakes.
Live remote references then keep working as if nothing happened —
including calls issued while the daemon was down, which buffer in the
peer's netlayer and complete against the successor.

Known limits of the prototype: retransmit buffers are unbounded until
acked; parked sessions are kept indefinitely (no session GC); and
daemon-side imports re-mint lazily (identity across the restart is
per-session only).

## Retirement and vat GC

Retirement is a capability, not a host operation: `retire()` on the
embedder's worker object (and on the guest-visible `worker-facade`
resource) permanently deletes the worker — its session aborts so live
presences reject, publications rooted in it drop, its store is
deleted, and its snapshot is released.

Unreferenced workers die by collection instead:
`daemon.collectVats({ keep })` marks workers reachable from
publications (plus awake workers and the `keep` list of ids) along
durable cross-worker links and worker facades, retires the rest, and
returns the swept ids.
`daemon.unpublish(secret)` removes a locator root so a published vat
can become garbage.

### Explaining retention

`thix reachability ./private-state` reports the live administrative view without
waking guest vats; `thix collect ./private-state` retires currently collectible vats.
The JSON report contains each worker's diagnostic label, awake state, direct roots,
one path from a root, and the cross-session references used by collection.
Publication roots never reveal their secrets.
External session identifiers appear as SHA256 fingerprints so bearer resumption tokens
are not exposed.
Both commands use the same graph through `daemon.inspectReachability({ keep })`.
The embedder's `keep` option can explicitly retain known worker ids for a collection.

Roots include publications, awake workers, explicit keeps, and remote sessions
holding references into a vat.
A remote root reports whether its connection is currently attached and whether its
session is durable: a disconnected resumable session still retains its references.
References propagate from rooted workers, including the built-in host worker-facade
capability's target even when that vat has not exported an application object yet.
Pending answer routes and active promise listeners also carry retention edges.
Deposited gifts and withdrawal waiters remain roots until the hub releases them;
their secret identifiers are omitted from the report.
Outstanding host calls are temporary `host-operation` roots, tracked until settlement.
The endpoint's cached imports and evaluator shells do not independently root workers.
Collection rechecks reachability between retirements because incoming messages can
change the graph while an earlier retirement is finishing.

This is a conservative vat-level view of protocol references, not an explanation of
every JavaScript object or variable in a heap.
Dropping an inventory entry or application record releases that ordinary reference;
protocol references can remain until guest GC reports their release.
The diagnostic will show those remaining edges rather than promise immediate deletion.
The collector does not force guest GC, close durable peer sessions, or stop awake vats.
Use normal idle sleep (30 seconds in the supervisor) and inspect again.
Retiring one vat may wake another through protocol cleanup, requiring a later pass.
Registered host resources that internally retain workers need an explicit `keep`;
only the built-in worker-facade's target is automatically represented.

CI verifies that removing a publication collects its unrooted cross-vat component,
deletes the worker stores and SQLite snapshot images, and remains collected after restart.
It also verifies facade-only retention, live-peer retention through disconnect,
and release of a pending host call's root when its answer settles.

## System resources

Host capabilities reach guests as durable exports.
Register makers on the daemon and pass instances as evaluate
endowments:

```js
import { makeTimerResource } from '@endo/thixotrope';

const daemon = await makeThixotropeDaemon({
  // ...
  resources: { timer: makeTimerResource },
});
const worker = await daemon.createWorker({ debugLabel: 'clock' });
const timer = daemon.makeResource('timer');
const clock = await worker.evaluate(
  `Far('Clock', { read: () => E(timer).now() })`,
  ['timer'],
  [timer],
);
```

When a resource is exported into a worker session, its
`(name, description)` is recorded against the export slot; on daemon
restart the export is re-instantiated at the same slot, so presences
inside the worker's snapshot keep working.
Resource results reach the worker as OCapN frames, which the daemon
journals before delivery, so nondeterministic resources (clocks) do
not break deterministic replay, and a pending `timer.delay` wakes a
sleeping worker with no inbound traffic.

Answers the daemon itself owes (host-resource computations) are
at-most-once: a resolver obligation pending across a restart rejects
rather than hanging or re-executing.
Relayed promises are not daemon obligations at all — their
subscriptions are hub rows and wire state in the endpoints, and
settle normally across restarts.

## API

`makeThixotropeDaemon({ store, engine, codec, makeNetlayer, resources?, idleSleepMs?, verbose? })`
resolves to a daemon (`idleSleepMs` parks any worker that has seen no
deliveries for that long; workers run to quiescence per delivery and
have no timer queue, so frame silence is exact dormancy):

- `createWorker({ debugLabel? })` — makes a fresh worker under a
  generated unguessable id and resolves to its worker object.
- `getWorker(workerId)` — the worker object of an existing worker;
  throws for unknown ids (the embedder's admin route).
- `listWorkerIds()` — sorted ids of the live workers (admin/debug).
- `makeResource(name, description?)` — instantiates a registered
  resource maker; interned by `(name, description)`.
- `publish(value, secret?)` — durably registers a capability the
  endpoint holds under a swissnum and returns the swissnum.
- `unpublish(secret)` — removes a publication.
- `lookup(secret)` — the embedder's in-process route to a publication.
- `collectVats({ keep? })` — vat-level mark-and-sweep over the hub's
  reference tables; resolves to the swept ids.
- `location` and `makeSturdyRefDetails(secret)` — what a peer needs to
  mint a sturdy ref.
- `shutdown()` — snapshots and parks every worker, then closes the
  endpoint and the netlayer.
- `crash()` — abandons live state the way a power failure would (for
  tests and supervisors; the store is left recoverable).

Each worker object has:

- `workerId` and `debugLabel` (data properties).
- `evaluate(source, endowments?)` — evaluates a hardened JavaScript
  expression in the worker's persistent compartment, with the
  properties of the endowments record bound as named values.
  The record is hardened implicitly.
- `sleep()`, `wake()`, `isAwake()` — embedder policy hooks; see above.
- `retire()` — permanently deletes the worker; see _Retirement and
  vat GC_.

## Caveats

This is a prototype.
See the design document for the full list of open issues, notably:
answers owed by host resources are at-most-once (they reject after a
restart; worker-owed answers and promises survive in the heap
snapshots), and the remaining loud hub limits — a listen on the
sender's own export breaks (the wire format cannot hand a session its
own resolver back), and pipelining onto an undeposited gift breaks
rather than queueing.
Third-party gifts otherwise work in both hub roles, sturdyrefs pass
through as opaque values, pending answers transfer across sessions,
and idle sleep is available via `idleSleepMs`.

## Design

See
[designs/ocapn-orthogonal-persistence.md](../../designs/ocapn-orthogonal-persistence.md).
