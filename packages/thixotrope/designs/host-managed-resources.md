# Host-managed resources and workspaces that hold references

Status: proposed.
This note gathers the system changes suggested while reviewing #1220 so they are not lost.
None is implemented; each names what exists today, what should change, and what it costs.

## The model

A **workspace** is a user's inventory plus a few things of the user's own: a mailbox and its
contacts, and whatever control surfaces the user has been handed.
It holds **references** to resources; it does not manage them.
Resources, native or host, are **managed by the host**: the host allocates their vats, launches and
retires their processes, delivers their start notices, and indexes them.
A workspace therefore has no code of its own beyond an observable map and an address book, and
nothing in it needs a version bump when the host's bookkeeping changes shape.

When this note was written, the code was close to this for native resources at runtime and far
from it for bookkeeping.
The host already allocated the manager vat, owned the adapter launcher (a host resource described
by the manager's worker id), delivered the start notice and drove removal.
But the **installation registry** that indexed every installation lived in the workspace vat's
heap, so an installation was scoped to one workspace and managed through that workspace; section 1
moved it.

## 1. Move the installation registry out of the user's workspace (Done.)

What the registry in the workspace implied:

- An installation is scoped to one workspace.
  The same native directory installed from two workspaces is two manager vats and two adapter
  processes, which for HTTP is two attempts to bind the same port.
- The host cannot manage installations without that vat.
  `installations`, `remove` and start-phase retries all evaluate in the workspace, so a quarantined
  workspace leaves every installed vat running and unremovable.
- The retention root for every installed vat is the workspace; retiring the workspace makes them
  all collectible.
- The registry's shape is frozen into heap closures, which is why every change to it is a
  `WORKSPACE_VERSION` bump with migrate-or-fresh.
- The one real benefit of being in a vat: the factory-result promise is guest-to-guest, so an
  application whose `make` is still pending across a host restart settles afterwards instead of
  being aborted as a host answer.

Proposal: one **registry vat per daemon**, owned by the host, holding the same registry closure.
The host installs native resources and applications through it; the install phases keep their
guest-to-guest factory promise; a workspace receives a reference to the installed value as a
grant into its inventory, exactly as applications receive grants today.
The host keeps a small durable index of its own (name, kind, digest, allocation key, worker id,
status) beside the vat, so `installations` and `remove` work when the registry vat is quarantined
and so retention of installed vats does not hang off any user's workspace.
Native resources become one per daemon; a workspace gets the facet, or a per-workspace sub-facet
the manager hands out when a resource must be partitioned between users.

Cost: a workspace version bump; `install.js` addressed at the registry vat rather than the
workspace; the supervisor's `provide` of the clock and mailbox moves with it.

Done: the registry vat is the host's, allocated under a fixed key and published under a name only
the host knows; `installations.json` is the host's index, written by the registry vat through the
`installation-index` resource and read by the host when the vat cannot answer; a workspace exposes
an access object that resolves grants and takes and gives back installed values; the supervisor
provides the clock and the mailbox through the registry.
A quarantined registry vat leaves the host serving from the index, listing and removing
installations and making none.
A native resource is still installed per name from one workspace; what section 2 shares between
workspaces is the daemon's clock, through the registry's daemon-wide namespace, which any other
shared resource can use the same way.

## 2. Many workspaces, one by default (Done.)

Today a state directory has exactly one workspace: `workspace.json` records one worker id and the
publication `workspace-<id>`, the administration facet is bound to it, and the clock, mailbox and
address book are provided into it.
A daemon that hosts many users needs many.

Proposal: a workspace table keyed by name, each entry with its own vat, publication, inventory,
address book, and provided mailbox, allocated under an **allocation key** rather than the
`workspace` debug label (the label is identity in one place today, `supervisor.js` first start).
The control connection selects a workspace by name and `thix` takes `--workspace NAME`;
`serve` creates one named `default` unless told otherwise.
The hub, the peers socket, the alarm ledger and the registry vat of section 1 stay shared.

Cost: `workspace.json` becomes a table; the admin facet becomes per workspace; the TUI and the CLI
gain a selector.

Done: `workspace.json` is the table, each workspace allocated under a key derived from its name, so
the label is identity nowhere; a connection selects a workspace (`selectWorkspace`), `thix` takes
`--workspace NAME`, and `createWorkspace`/`workspaces` make and list them.
The registry keys installations by workspace and name; the clock is the daemon's, held by the
registry and handed to every workspace, and the mailbox is provided to each.
The default's name is fixed; the table is a cache of the names served, so a row naming a vat that
is gone is dropped, the installations of that vat removed with it, and the name served afresh.

## 3. The control socket stays host code

The operator's control socket is a fresh OCapN session per connection whose first object is the
administration facet.
It is the operator's full authority over the workspace and the daemon, and it is host code, so it
works when vats are broken: a quarantined workspace, an exhausted manager or a bad bundle are the
cases `thix attach` and `thix status` exist for.
Modelling the socket as a native resource would route repair through the thing being repaired, so
it stays in the host.
The adapter half of the kit could still own the listening socket if one listener implementation is
wanted, with the admin facet served by the host.

Two smaller changes follow:

- The README and the root design describe inventory views as receiving "descriptions, never the
  values", which reads as confinement.
  It is a representation choice for a text view whose session ends with the connection; the
  operator already holds everything.
  Reword both.
- `evaluate` returns a rendered string, so an operator cannot hold a value from one command to the
  next except through the inventory.
  The session is already OCapN; the admin facet could return references and render client-side.

## 4. Resources bound to workers, not described

A resource description is the static constructor argument of a host resource: any passable value,
memoised and persisted as `(name, JSON(description))` so the host can make the same instance again
after a restart.
It cannot be removed outright, because a host object is not orthogonally persistent and something
must say how to rebuild it, and because a per-vat facet is the capability discipline: the clock
facet a vat holds is the authority over that vat's alarms and no other's.

It can be reduced to one shape.
Every per-instance description in the code today carries a worker id: `{ workerId }` for the
clock facet and the worker facade, `{ workerId, alarmId }` for an alarm's settlement promise, and
`{ bundleDigest, workerId }` for the adapter launcher, whose other field is the installation's
and will be in the host index of section 1.
The two singletons, the worker controller and mail introductions, carry none.

Proposal: a resource is **bound to a worker**, `makeResource(name, workerId, key?)`, where `key`
is a small discriminator a resource may add (the alarm id) and a daemon-wide singleton is bound to
the endpoint itself.
Then the maker signature is typed per resource name, `retireResource` takes checked arguments,
retiring a worker retires every resource bound to it generically rather than through the
`onRetireWorker` hook each service registers today, and the launcher's description shrinks to the
worker id with its module and identity looked up in the host index.
The export record persists `(name, workerId, key)` instead of an opaque value; the launcher's
read-side fallback for the field renamed this session retires with the old shape.

## 4a. `debugLabel`

When this note was written the label was a free-form string used for logging, process names,
`status`, the TUI and the reachability report, with one use as identity: the supervisor recovered
an interrupted first start by finding the worker labelled `workspace`.
After sections 1 and 2 nothing identifies a worker by its label: installations and workspaces are
allocated under allocation keys, and the host index records each worker's kind and name.
(The identity use is gone with section 2; the label is still an input to `createWorker`.)
The label is then derived (`kind:name`) for display and need not be an input at all; it should not
be upgraded into something more, because the index record is the something more.

## 5. Smaller items

- `alarmStatus` flattens bigint counts to `Number` for the JSON the CLI prints; `status` uses
  strings for its counts. One convention for counts over the control socket.
- Node replay doubles load the guest prelude as host modules, so environment options those
  packages read (`ENDO_RANK_STRINGS`, `DEBUG`) must be the same across runs that share a journal.
  Either pin them in the doubles or document the constraint where the doubles are configured.
- The manager kit's `describe` receives no spec for a closed registration; the HTTP facet could
  carry a `closedAt` or similar if views want it.
- `installNative` returns the installation record; `thix install` prints it. A `thix install`
  retry that hits "name has a different installation" should say what differed.

## 6. Reuse of building blocks

A survey of what the package writes more than once, and of what other Endo packages already
provide.
Each entry names the copies; the fix is the one piece they should share.

### Written more than once inside the package

- **Bounded error text.**
  `String(reason).slice(0, 512)` appears in `mailbox.js`, `mail-contact.js`, `registry.js`,
  `manager-kit.js` and `adapter-kit.js`.
  Four of the five are shipped into vats by source, so the helper belongs in the guest prelude
  beside `makeSerialQueue`.
- **Remotable checks that must not throw.**
  `passStyleOf` throws on a non-passable value, so `mail-address-book.js`, `workspace-access.js` and
  `native/manager.js` each wrap it in a try/catch `isRemotable`; `@endo/pass-style`'s own
  `isRemotable` throws the same way and is not a drop-in.
  One prelude helper.
- **Bytes to hex.**
  `hub.js`, `durable-netlayer.js` and `random-id.js` each spell `byte.toString(16).padStart(2,
  '0')`; `@endo/hex` exports `encodeHex` and is already in the Ironhorse bundle's graph.
- **Versioned records on disk.**
  The alarm ledger (version 2), workspace metadata (version 8), the runtime manifest (format 2) and
  worker metadata each check a version and compose their own "newer than this build" and
  "migrate or use a fresh directory" messages.
  One `versionedRecord` over `SyncStringAtom`, with the three outcomes (current, newer, older)
  and one message shape.
- **Length-prefixed framing.**
  `unix-netlayer.js` and `local-control.js` each read and write four-byte length frames over a
  socket with their own size cap and error path; `pipe-network.js` frames worker pipes.
  One framing function for sockets, and further, the control connection could be a transient hub
  session over the Unix netlayer rather than a separate OCapN peer per socket, which also gives
  section 3 its references.
- **Keeping one incarnation.**
  `adapter-keeper.js` (in a vat) and `durable-worker-transport.js` (in the host) both hold one
  incarnation, probe it, retire it when dead, rebuild it and serialise the operations around it.
  The shapes match but the authority and the state do not (the transport also owns journal cuts
  and images), and the keeper is sixty lines; leave them separate and say so.
- **Views.**
  The inventory view subscribes through a host-side bridge (`inventory-view-lifetime.js`) and
  renders live; the mail view polls on a keystroke, although the mailbox already exposes
  `subscribeInbox` and `subscribeOutbox` and nothing on the host uses them.
  Generalise the bridge to `watch(map)` for the inventory, the inbox, the outbox and the contacts,
  and every view is live through one lifetime.
- **Test fixtures.**
  Twenty-three test files construct a daemon by hand, eleven a memory store, fourteen a control
  client, thirty-four a temporary directory, and four an adapter double.
  The Ironhorse lane already has `_fixture.js`; the Node suite wants the same: `withDaemon`,
  `withSupervisor`, `fakeAdapter`, `fakeIntroductions`.

### Already provided by another Endo package

- **Serial queue.**
  `makeSerialQueue` duplicates `@endo/daemon`'s `makeSerialJobs`, itself built on `@endo/stream`'s
  `makeQueue`.
  Both daemons need it and the guest prelude ships it, so it belongs in one small package (under
  `@endo/promise-kit` or `@endo/stream`) that both import.
- **Change notification.**
  `@endo/pubsub` exports `makeLatestTopic` and `makeChangeTopic`: one outstanding notification per
  subscriber, the newest value coalesced, which is exactly the observable map's subscription
  policy.
  The map is shipped into vats and may import only the prelude, so it cannot import the package
  today; if the latest topic were in the prelude, the map would be the topic plus a key index.
- **Platform ports.**
  `@endo/platform` already defines filesystem port types (`fs/lite`) with a Node implementation,
  and process helpers.
  Thixotrope's `platform/files.js` and `platform/processes.js` are a second set of ports for the
  same concerns; converge on one, in whichever package keeps the stricter plain-data discipline.
- **State locations.**
  `@endo/where` gives the conventional state, ephemeral-state and socket locations per platform;
  `thix` requires an explicit state directory on every command and could default to them.
- **Mail.**
  `@endo/daemon` has a mailbox, a pet store and invitations as host-side objects; Thixotrope's are
  guest exos in a vat, so code cannot be shared across that boundary.
  The invitation text format and the `help()` conventions can be, in a package both depend on;
  low priority.

### Order

1. The prelude helpers (error text, remotable check) and `@endo/hex`: small, mechanical.
2. The view bridge generalised to `watch(map)`; the mail view goes live.
3. The versioned-record helper, when the registry move of section 1 touches those files anyway.
4. The serial queue moved to a shared package, with `@endo/daemon` switched to it.
5. Framing and the control connection as a transient hub session, together with section 3.
6. Test fixtures, as tests are touched.

## 7. Host parts that a vat would simplify

The host has no orthogonally persistent state of its own.
Every durable thing it holds is a file with its own version, atomic write and
recovery rule.
Two of those files exist only because the host owns a control flow that can die
halfway through: the alarm ledger and the installation phases.
A vat's continuation is itself durable, and a host answer broken by a restart
carries one known message (`PENDING_ANSWER_ABORTED_MESSAGE`, which the clock
vat already retries on), so moving the control flow into a vat makes the file
unnecessary.

### 7.1 Alarms: the deadline set moves into the clock vat (superseded by 8.1)

Today the host keeps `alarms.json`: pending deadlines and outcomes, at most
1,024 rows, rewritten whole, written before the matching promise settles.
It exists so that the `alarm {workerId, alarmId}` promise resource can be
re-seated and settled after a host restart.
Around it sit the release protocol in `guest-clock.js` (a row is reclaimed once
the vat has recorded a local settlement, with a retry loop), `retireWorker` and
the supervisor's `onRetireWorker` route, and the `alarm-settlement.md` argument
for write-before-settle.

Proposed: the clock vat owns its deadlines, as it already owns the promises its
callers hold.
The host provides one stateless timer resource whose `at(deadline)` returns a
promise that settles at or after the deadline and does not survive a restart.
At restart it breaks with the restart message, like every pending host answer,
and the clock vat re-arms every outstanding deadline when it sees that message.
An idle vat does not notice a restart, so the host sends each clock vat a start
notice through the mechanism the native managers use, and finds which vats to
notify from the endpoint's export records for `alarms {workerId}`; no new
ledger is needed.

Settlement stays exactly-once, now at the vat: the local promise settles when
the vat journals the host's settlement message.
If the host fires and dies before the vat journals it, the re-arm finds the
deadline already passed and fires at once.

Removed: the `durable-alarms.js` ledger (406 lines, replaced by a timer
resource of a few dozen), `alarms.json` and its version 2 format, the row cap,
the release and retry protocol in the clock vat, `retireWorker` and
`onRetireWorker` (section 4 removes the route for its own reason), the
per-alarm promise resource, and `alarm-settlement.md`.
Cost: every vat holding a clock wakes once per host start to re-arm, inside
the existing start-notice bound, and the cap on pending alarms becomes a
per-vat matter of heap, which is where a quota belongs.

### 7.2 Installation: the driver moves into the registry vat (Done.)

Before this change `install.js` was a host phase runner (`prepare`, `attach`,
`start`, `finish`, `fail`, `lookup`, `remove`) against the registry in the
workspace vat.
Because the host could die between phases, each phase was recorded, a retry
was explicit, the supervisor serialised installations and drained them within
a bound at shutdown, and a removal interrupted between retiring the vat and
forgetting the name was repaired by a fixup before the next `prepare`.

Proposed: with the registry vat of section 1, run the driver there as one
async function per installation.
It asks the worker controller for a vat under the allocation key (idempotent),
has the bundle staged, calls the factory and records the outcome.
The function's continuation survives sleep and restart; a host answer broken by
restart is retried under the same allocation key.
The phases collapse into the function's own progress, the `fail` and `lookup`
fixups and the shutdown drain disappear, and the serial queue becomes the
vat's own `makeSerialQueue` from the prelude.

Prerequisite: bundle bytes must not pass through the registry vat's heap or
journal.
Ironhorse journals every inbound message, and the 1 KiB decoder limit already
forces source to be chunked.
The host stages the bundle under its digest, through a staging resource or a
worker-controller method that takes a digest, and the installed vat receives it
from the host; the registry vat handles the digest only.
Grants are presences the registry vat forwards.

Removed: the phase driving in `install.js`, the phase states in
`installations.js`, the drain bound and the removal fixup.
Kept: allocation keys and the registry record (name, kind, digest, grants,
allocation key, outcome).

Done: `makeRegistry` runs the driver in the registry vat and makes a host call
again when a restart broke its answer; the host's `installer` resource, granted
to the registry vat alone, allocates under the key, stages a bundle by digest
from the store, makes a native manager and retires a vat, each idempotently.
The index names a bundle until its vat holds the code, and the host records a
request in the index before handing it to the registry, so a start in between
keeps the bundles; a later start's sweep frees them.
Collection no longer waits for an installation: an allocation takes a turn
with collection, and the host keeps a vat it has handed out until the
registry's next call about it, after which the registry's own reference roots
it.

### 7.3 What stays in the host, and why

Hub tables, peer session frames, the endpoint's export records, the runtime
manifest and the store lease are the mechanism beneath vats.
A vat exists only through them, so nothing can hold them in a vat.
`workspace.json` shrinks to its version gate: the worker id is already found by
label when the file is absent, and the publication name is derived from it.
The gate must be read before any vat is restored, so it stays a file, and
section 2 gives it the list of workspaces.

Section 7.1 depends on nothing else and can go first; 7.2 follows section 1.

## 8. Alarms and the control socket as native resources

Section 7.1 keeps a stateless timer resource in the host.
One step further, alarms become a native resource shipped with the package,
and so does the operator's control socket.
The host then provides exactly what a vat cannot have: vats (the worker
controller), processes (the adapter launcher), publication (the hub) and the
peer transport.
Everything else is a vat or a native resource the host installed.

### 8.1 Alarms (Done.)

The clock is a native resource the package ships, `resources/clock`, and the
supervisor installs it at every start under `clock`, as it did the guest
clock.
`durable.js` makes a manager labelled `Alarm`.
A spec is `{ at, sink }` or `{ after, sink }`, where `sink` is one exo of the
manager with `fire(key, now)`; `same` compares the sink and, when the wanted
spec has one, the deadline; `replaces` is never.
The facet has `at(deadline)` and `after(delay)`, each settling at or after the
deadline with the host time; `arm({ at } | { after })`, which also returns a
canceller for that one alarm; and `status()`, a count of pending alarms, since
a holder that could enumerate alarms could cancel every other holder's.
Each alarm is a fresh key with a promise kit in the manager's heap; `fire`
settles it once, idempotently per key, and closes the registration; a fire
that outruns the registration's own answer is kept until the answer arrives.
The deadlines live in the manager's heap, durable for free, and the manager is
the clock vat.

`ephemeral.js` binds a key by arming a timer against its own clock, re-arming
within the single-timer limit until the deadline is near, and reports
`fire(key, now)` on expiry; `unbind` clears it.
A registration made with `after` is resolved there to `{ at, sink }`, which
the manager adopts (8.3 item 4), so a restart restores the deadline and never
the delay counted again.
`restore` re-arms the desired set, so after a daemon restart, or the process's
own exit (8.3 item 1), every pending deadline is armed again and one that
passed meanwhile fires at once.

`now()` is gone: the manager never needs the time, the adapter owns the
timers and its own clock, and a program that only needs a delay never learns
what time it is.
The durable factory is shipped by source like every other built-in, so a start
bundles nothing; it is whole, and a test evaluates it with only the prelude
in scope.

Removed: the host alarm ledger (`durable-alarms.js`, `alarms.json`), its
row cap, the release and retry protocol of the guest clock
(`guest-clock.js`), the `alarm` and `alarms` host resources, the daemon's
`onRetireWorker` and `beforeStartNotices` hooks, the supervisor's `alarmNow`
test power, and `alarm-settlement.md`; section 7.1 is superseded.
`alarmStatus` asks the clock for its count and reports `{ pending }`.
Workspace metadata is version 9.

### 8.2 The control socket

`resources/control/durable.js` is `make({ makeManager, admin })`: it registers
one key with `{ path, admin }` and its facet reports status.
`admin` is a grant made at install: the administration facet, held in a vat
over the worker controller, the registry and the workspace, as section 3
already allows ("control surfaces can be held by the workspace").

`resources/control/ephemeral.js` binds by listening on the Unix socket at
`path`.
Each connection is an OCapN session over that socket whose bootstrap object is
`E(admin).connect()`, a per-connection facet the adapter closes on disconnect,
so inventory-view subscriptions end with the connection.
If the adapter dies, its transient session is swept and those presences become
unreachable, which is the rule the view bridge already relies on.
The adapter uses the package's own unix netlayer and framing, which section 6
lists as duplicated in `local-control.js`; that file goes.
The cost is one more hop (client, adapter, hub, target), acceptable on a local
socket.

`peers.sock` stays in the host.
It is the hub's own durable transport, correct because frames are committed
before output is released; an adapter relaying frames over a transient session
would run the hub's transport over a hub session.

### 8.3 What the kit needs first

1. Rebuild on exit, between starts. (Done.)
   A manager with anything desired rebuilt its adapter at daemon start,
   through the start notice, and otherwise only when the next operation that
   needed the adapter found the keeper's probe failing.
   The launcher observed the process exit but told the manager nothing, so
   between starts a dead adapter stayed dead until something called the
   manager: a closed port for HTTP, every reminder silenced for alarms, the
   operator locked out for the control socket.
   Now the launcher reports an incarnation's own exit (not one it was told
   to end, nor its owner's retirement, nor shutdown) to the owner through
   the same held object the start notice reaches, as `exited()` on the
   lifecycle facet, and the manager kit rebuilds on it while anything is
   desired, exactly as it does on `started()`.
   The backoff lives in the host, which owns the timers a vat lacks: the
   first exit after a life of ten seconds or more is reported at once, and
   consecutive quicker exits double the delay from one second up to thirty.
   No per-resource flag is needed, since an empty desired set has nothing to
   restore.
2. Built-in resources the host installs. (Clock done; control socket with 8.2.)
   The supervisor installs `resources/clock` under `clock` at every start
   through the same `provide` rule as the mailbox, and will install
   `resources/control` the same way; a missing or broken control resource is
   reinstalled at start, since it is the operator's only way in.
   The registry of section 1 and the per-workspace grant of section 2 follow
   when those land.
3. Bundle the ephemeral module at install, as the durable one already is.
   (Done.)
   `installNative` bundled `durable.js` with `makeBundle` and evaluated the
   bundle into the manager vat, so that half was detached from the directory
   from the first moment.
   `ephemeral.js` was not: the launcher's description carried the module URL
   and the directory's identity, and the adapter process re-digested the
   directory and imported the module from disk at every launch, which is why
   the directory had to stay present and unchanged, and why an edit refused
   to start.
   Now `ephemeral.js` is bundled at install too, in the mapper's `cjs`
   functor form, which turns Node builtins (`node:http`, `node:timers`) into
   exits the process resolves with its own `require` while the resource's
   own modules and the adapter kit it imports are frozen in the bundle, as
   `makeManager` is already frozen in the manager's heap.
   The bundle is stored in the state directory under its digest
   (`bundles/<sha256>.cjs`), the content-addressed store that section 7.2
   wants for application bundles as well: manually persisted, immutable,
   verified by digest in the process that loads it, and freed at the next
   daemon start once no launcher record names it.
   The launcher's description names the bundle digest and the owning vat
   instead of a module URL and a directory, and the digest check at launch
   replaced `describeNativeResource` there, which now only locates the two
   entries; a launcher recorded before this refuses to launch and says the
   resource is to be installed again.
   The installation's identity is the pair of bundle digests, so the
   directory's real path dropped out of it; an edited directory no longer
   matters, and a new version is a new installation under a new name or
   after a removal, exactly as for an application.
   A default import of a Node builtin has no binding in the bundle, since
   the mapper's exit cells are the host namespace's own names; builtins are
   imported by name or as a namespace.
   What becomes of the old manager's registrations across a new version is
   out of scope here.

4. Let a registration resolve at bind time. (Done.)
   The kit recorded the spec the manager sent, and `restore` sent it back
   unchanged.
   Some registrations are resolved at bind time: a relative delay becomes an
   absolute deadline, and a port of zero becomes the port the listener got.
   `makeAdapter` now takes an optional `resolve(binding, spec)`; a bind
   answers the resolved spec, or `undefined` when a registration is as sent,
   and `restore` reports each resolved registration with its resolved spec.
   The manager kit adopts a resolved spec as the desired one, if the entry
   is still the desired registration under its key, so `same`, `describe`
   and the next restore all see the resolved form.
   HTTP has no `resolve` and is unchanged.

### 8.4 The host afterwards

The hub and the store; the endpoint with the worker controller, the worker
facade, the adapter launcher and publication; the peer netlayer; the startup
sequence.
The supervisor becomes the main of `thix serve`: take the lease, check
versions, start the daemon, install the built-ins if missing.
Alarm status is `describe` over the manager's registrations, and the
operator's administration facet is an exo in a vat.

Order: the monitor (8.3.1) first, then alarms (8.1, in place of 7.1), then
the control socket once section 1 and the administration facet move are done.

## 9. Collection hooks for native resources

A requirement recorded during the work above, not yet designed in detail.

Some native resources hold something in the adapter, or on disk, whose lifetime should follow a
durable object in the manager.
The example: a native resource that creates data stores backed by files on disk.
A guest holds a durable handle to a store; when nothing holds that handle any more and the vat's
collector drops it, the files behind it should go too.
The manager must therefore learn that its durable object was collected, and tell the adapter,
which deletes the files.
This generalises to any native resource whose registrations stand for something the adapter or the
operating system keeps: files, directories, sockets, subprocesses, caches.

What exists today:

- The kit's registration model already carries the right verb: a registration closed through its
  handle reaches the adapter as `unbind(key)`, and `unbind` is where the adapter releases what it
  acquired.
  Collection is one more reason to close a registration.
- The hub and the host endpoint already account for exports: a reference a vat or the host no
  longer holds is reported (`slotCollected` and the `gc-exports` operation in
  `worker-session-records.js`), so an object exported from the manager vat to a consumer vat is
  dropped from the manager's export table once every holder has let go.
- A `FinalizationRegistry` in the manager vat, registered with the durable object and the
  registration's key, would fire once the object is unreachable from the heap, including through
  the export table, and could close the registration.

What has to be settled:

- Determinism under replay.
  A vat is the image plus a replay of its journal; a finalizer that fires at a point the collector
  chose is not in the journal, so a replayed vat could fire it elsewhere, or not at all, and
  diverge.
  The engine must deliver collection as a journaled event: the collector's verdict recorded as an
  inbound message before the vat acts on it, or finalization confined to a checkpoint boundary
  where the recorded image is the authority.
  Neither the Ironhorse engine nor the vat peers mention `FinalizationRegistry` today, so a vat
  under Ironhorse has no finalizer of its own to fire; XS has the intrinsic but a deterministic
  profile would keep it from the guest for the same reason.
  The engine-delivered event is therefore the likely shape: the engine reports what it collected
  at a checkpoint, the host journals that report as a delivery, and the vat acts on it in a crank
  like any other.
- Where the hook lives.
  Preferred: in the kit, so authors write nothing new.
  `register(key, spec, { heldBy: object })` lets the manager kit register `object` with a
  finalization registry under `key` and close the registration when it is collected; the adapter
  sees an ordinary `unbind`.
  The alternative is a host-driven hook: the hub knows when an export is dropped and could tell the
  manager, as it tells it of a start or an exit, through the lifecycle facet.
- Exactly-once and ordering.
  A collection that races a close, or a rebuild that restores a registration whose holder was
  collected in between, must not resurrect a deleted store or delete one still held: the
  registration's own generation (the handle's) decides, as it does for `close`.
- Durable state outliving its holder on purpose.
  Some stores should survive the handle (a named store a user expects to find again): collection
  must be opt-in per registration, never the default for every native resource.

## Order of the larger changes

1. Section 1, since sections 2 and 3 are simpler once installations are the host's.
2. Section 2.
3. Section 4 (worker-bound resources, which removes `onRetireWorker`), 4a, and the documentation
   rewording in section 3.
4. Section 5 as they come up.
5. Section 8, after its kit prerequisites (8.3), with 7.2 alongside section 1.
