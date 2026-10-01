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

Today the code is close to this for native resources at runtime and far from it for bookkeeping.
The host already allocates the manager vat, owns the adapter launcher (a host resource described by
the manager's worker id), delivers the start notice and drives removal.
But the **installation registry** that indexes every installation lives in the workspace vat's
heap, so an installation is scoped to one workspace and managed through that workspace.

## 1. Move the installation registry out of the user's workspace

What the registry in the workspace implies today:

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

## 2. Many workspaces, one by default

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
`{ moduleUrl, resourceIdentity, workerId }` for the adapter launcher, whose other two fields are
the installation's and will be in the host index of section 1.
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

Today the label is a free-form string used for logging, process names, `status`, the TUI and the
reachability report, with one use as identity: the supervisor recovers an interrupted first start
by finding the worker labelled `workspace`.
After sections 1 and 2 nothing identifies a worker by its label: installations and workspaces are
allocated under allocation keys, and the host index records each worker's kind and name.
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
  `String(reason).slice(0, 512)` appears in `mailbox.js`, `mail-contact.js`, `installations.js`,
  `manager-kit.js` and `adapter-kit.js`.
  Four of the five are shipped into vats by source, so the helper belongs in the guest prelude
  beside `makeSerialQueue`.
- **Remotable checks that must not throw.**
  `passStyleOf` throws on a non-passable value, so `mail-address-book.js`, `installations.js` and
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

### 7.1 Alarms: the deadline set moves into the clock vat

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

### 7.2 Installation: the driver moves into the registry vat

Today `install.js` is a host phase runner (`prepare`, `attach`, `start`,
`finish`, `fail`, `lookup`, `remove`) against the registry in the workspace
vat.
Because the host can die between phases, each phase is recorded, a retry is
explicit, the supervisor serialises installations and drains them within a
bound at shutdown, and a removal interrupted between retiring the vat and
forgetting the name is repaired by a fixup before the next `prepare`.

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

### 8.1 Alarms

`resources/alarms/durable.js` makes a manager labelled `Alarms`.
A spec is `{ deadline, sink }`, where `sink` is one exo of the manager with
`fire(key, at)`; `same` compares the deadline and the sink, `replaces` is
always false.
The facet's `when(deadline)` registers a fresh key, keeps a promise kit in the
manager's heap and returns its promise; `fire` settles it (idempotently, per
key) and closes the handle; `arm` returns a canceller that closes the handle
and rejects the promise.
The deadlines live in the manager's heap, durable for free, and the manager is
the clock vat: `guest-clock.js` folds into it.

`resources/alarms/ephemeral.js` binds a key by arming a timer (chained beyond
the 2^31-1 ms limit of a single timer), calls `E(sink).fire(key, now)` on
expiry and clears it on unbind.
`restore` re-arms the desired set, so after a daemon restart every pending
deadline is armed again and one that passed during downtime fires at once.
A fire the manager did not journal before the host died is simply fired again
by the rebuilt adapter, and the key's idempotence makes it exactly-once.

Registrations clean themselves up at their deadline, so a retired workspace's
alarms cost at most one timer each; no retirement route is needed.
`now()` needs the adapter: the manager holds the adapter's presence through
the keeper, so the kit should let `makeAdapter` take methods beyond the four
of the protocol (`methods: { now }`), since a vat cannot read time itself.

Removed: everything section 7.1 removes, plus the host timer resource and the
separate clock vat.
The platform `timers` power stays in the host for its own bounds only (idle,
drains, start notices).

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

1. A restart monitor.
   Today an adapter that dies between daemon starts is rebuilt by the next
   operation that needs it.
   For HTTP that already means a closed port until something calls the manager;
   for alarms it would silence every reminder, and for the control socket it
   would lock the operator out, since no operation could reach the manager.
   The launcher already observes exit (`onExit` in `adapters.js`); it should
   report it to the keeper, which rebuilds with backoff.
   This is a kit change that HTTP benefits from as well, and it gates the rest.
2. Built-in resources the host installs.
   On first start the host installs `resources/alarms` and `resources/control`
   under reserved names in the registry of section 1, and grants each
   workspace the alarm facet (section 2).
   A missing or broken control resource is reinstalled at start, since it is
   the operator's only way in.
3. Adapter methods beyond the protocol, for `now()` (8.1).
4. A code-upgrade path.
   A native resource's identity pins the directory's digest, so a package
   upgrade that changes `durable.js` cannot start under the old manager, and
   the deadlines in that manager's heap would be stranded.
   HTTP tolerates a reinstall; alarms do not.
   Either the identity pins only `durable.js` and `ephemeral.js` may change
   under a stable protocol, with `durable.js` kept minimal, or the lifecycle
   gains `export()` and `import()` of desired registrations across a
   reinstall, a small generic migration.
   This is the general problem of upgrading a durable vat's code, met here
   first.

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

## Order of the larger changes

1. Section 1, since sections 2 and 3 are simpler once installations are the host's.
2. Section 2.
3. Section 4 (worker-bound resources, which removes `onRetireWorker`), 4a, and the documentation
   rewording in section 3.
4. Section 5 as they come up.
5. Section 8, after its kit prerequisites (8.3), with 7.2 alongside section 1.
