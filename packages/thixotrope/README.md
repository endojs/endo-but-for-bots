# `@endo/thixotrope`

A prototype distributed ocap machine with orthogonally persistent JavaScript guests.

A thixotrope daemon is a simpler cousin of the Endo daemon: it spins up
workers whose guest state is preserved by XS heap snapshots or the
Ironhorse SQLite heap store rather
than by explicit formula-based persistence.
Guest heap state survives suspension and restoration without application-written serialization.
External resource lifetimes remain explicit: a pending host-operation answer can reject on restart,
and installed resource managers receive a startup notification to recreate their native adapters.
Application upgrades are not yet implemented; candidate mechanisms are described separately.

The machine speaks the OCapN p2p wire protocol end to end, and the
daemon is mostly a forwarding and slot-rewriting hub
(`src/net/hub.js`): workers and remote peers are hub sessions, and
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

The [potential designs](designs/README.md) record the current hypotheses for user-space
upgrade, delivery responsibility, host-directed vat retirement, and crossing persistence regimes.
They distinguish intended behavior from current implementation gaps.

## Source layout and host powers

`src/` groups modules by responsibility:

- `core/`: the daemon, worker peers and transports, session records,
  replay engines, and reachability inspection.
- `control/`: the supervisor composition root, local admin socket, and
  application bundle/install helpers.
- `net/`: the OCapN hub, the in-host pipe network, and the durable and
  Unix netlayers.
- `store/`: durable worker and session stores, validators, and string
  atoms.
- `mail/`: the guest mail protocol, contacts, and address book.
- `tui/`: the terminal views the CLI opens over a control connection.
- `observable-map.js`: the string-keyed observable Map that backs both the
  workspace inventory and the conventional `contacts` address book.
- `native/`: directory installation and disposable native process integration.
- `ironhorse/`: Ironhorse and XS worker engines and their guest
  fixtures.
- `platform/`: capability interfaces, and `platform/node/` for the Node
  implementations of them.

The package-level `resources/` directory holds the native resources the package ships, each a
durable manager and a native adapter: `resources/http/`, installable with `thix install-native`,
and `resources/clock/` and `resources/control/`, which the supervisor provides at every start.

Each module directly under `platform/` names one capability — `timers`,
`random`, `files`, `processes`, `sockets`, and so on — whose methods take
and return plain data, so no host API or host handle type reaches core.
Only `platform/node/` imports Node built-ins, and `platform/node/powers.js`
composes those implementations into the record an entry point passes in. Every
other module receives just the capability objects it names; the root ESLint
configuration enforces both rules.

The `logging` power carries three channels — `log` for a view's own output,
`info` for protocol tracing, and `error` for diagnostics — and a `sub(...path)`
that prefixes each line with a bracketed subsystem path such as
`[thixotrope:daemon:netlayer]`, so a log can be filtered by substring.
Whether tracing is emitted at all is the host's decision, made once in
`platform/node/powers.js`: set `THIXOTROPE_TRACE` to send OCapN's per-frame
`info` channel to stderr. No module in between silently drops a channel.

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
It accepts local OCapN admin sessions on `control.sock` (mode 0600), served by the control
socket, a native resource the supervisor provides daemon-wide: its adapter process listens on the
socket and starts each client's session from a facet of the operator's administration, which stays
host code, so repair works while vats are broken, and a listener that dies is rebuilt.
`thix installations` lists it as `control`; it keeps nothing worth repairing, so one that failed is
provided afresh at the next start, and a start that cannot provide it at all, the registry vat
being quarantined, say, has the host listen on the socket itself and says so in its log, unless
the resource's adapter, rebuilt from the registration its vat kept, is serving the socket already.
It cannot be removed through itself: `thix remove control` is refused.
Only the supervisor opens the persistence store.
The socket grants full local administration; anyone running as the same OS user
can administer every workspace.

A state directory serves many workspaces, each a vat of its own with an inventory and an address
book of its own, and a mailbox provided to it in a vat of its own; `serve` makes one named `default`.
A connection speaks for one workspace at a time, `default` unless it selects another, and every
`thix` command of a workspace's takes `--workspace NAME` (or `--workspace=NAME`) ahead of it to
select one:

```sh
yarn workspace @endo/thixotrope thix workspaces ./private-state
yarn workspace @endo/thixotrope thix create-workspace ./private-state alice
yarn workspace @endo/thixotrope thix --workspace alice attach ./private-state
```

A workspace name is letters, digits, dot, dash and underscore, 64 at most, starting with a letter
or digit.
Its vat is allocated under a key derived from the name, so a start finds it again with no record
to lose; `workspace.json` is the table of names the host serves.
The hub, the peers socket, the registry of installations, the clock and the control socket are the
daemon's, shared by every workspace.
A service manager can restart the foreground process; clients never start it implicitly.

`attach` evaluates one JavaScript line at a time in the same persisted workspace vat.
Use `globalThis.name = value` for bindings shared between evaluations.
Top-level `const` and `let` declarations are scoped to their individual evaluation;
closures containing those variables persist when retained by the workspace.
Ctrl-D or Ctrl-C detaches the terminal, leaving the supervisor running.
Piped input works too, and evaluation failures produce a nonzero exit status.
A lost connection reports an uncertain evaluation outcome and never retries it.

The workspace has the guest prelude (`E`, `Far`, `harden`, `makeExo`, `M`, and the rest) and a
`vats` controller.
For example, enter each of these as one line and wait for its result before entering the next.
`E` accepts both capabilities and promises for capabilities, so the stored results can be used directly.

<!-- prettier-ignore -->
```js
globalThis.other = E(vats).createWorker('counter');
globalThis.source = "(() => { let count = 0n; return Far('Counter', { incr: () => ++count }); })()";
globalThis.counter = E(other).evaluate(source);
E(counter).incr();
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
inventory.set('counter', counter);
inventory.set('note', 'hello');
inventory.delete('note');
```

The TUI redraws from subscribed snapshots and displays object/capability placeholders: a text
view renders descriptions, which is a choice of representation for a session that ends with the
connection, not a confinement, since the operator holds everything the socket reaches.
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
worker cleanup and store release; restart discards any remaining UI subscriptions.
Cancellation makes subscription objects collectible; physical reclamation follows
normal heap GC and snapshot/journal cleanup rather than a special inventory GC rule.
`inventory.subscriptionCounts()` reports the durable and ephemeral subscriptions for
experiments; it is not a measure of physical heap reclamation.

`status` reports worker state and cumulative process-local counts and milliseconds
for delivery (including its commit cranks), snapshot creation, and engine startup/wake.
These are coarse measurements, not a latency benchmark or isolated fsync timings.
The idle sleep delay is 30 seconds; `stop`, SIGINT, and SIGTERM put workers to sleep before exit.
A quarantined application or native manager vat is cleared by `thix remove` of its installation
and reinstalled; a quarantined workspace vat remains inspectable with `status`, and this version
offers no command to repair it.
Nothing roots a quarantined workspace vat, so `thix collect` sweeps it, and the next start serves
the name with a fresh vat, provided like any other; the installations of the vat that is gone go
with it, since their values were in its inventory.
A row of `workspace.json` naming a vat that is gone is taken to mean the workspace is gone; the
table is the host's, not to be edited by hand.

### Persistent applications

Install a JavaScript module exporting `make(powers)` into a fresh guest vat:

```sh
yarn workspace @endo/thixotrope thix install ./private-state counter ./examples/counter.js
yarn workspace @endo/thixotrope thix installations ./private-state
```

Module paths resolve from the CLI process's working directory.
The Yarn workspace command runs inside `packages/thixotrope`.
The module belongs to a JavaScript package with a `package.json`.
The CLI bundles its static module graph locally; application code runs in the guest.
The bundle is staged into the application's vat in bounded messages, so there is no request-size
cap; grants are checked in the workspace before any vat exists.
Use the guest prelude rather than bundling those libraries: every vat has `E`, `Far`, `harden`,
`makeExo`, `defineExoClass`, `defineExoClassKit`, `M`, `matches`, `mustMatch`, `passStyleOf`,
`Fail`, `q`, `makeError`, `makePromiseKit`, `makeSerialQueue`, `describeError`, and `isRemotable` as
globals, with no ambient Node powers.
Bundled code reads the ones it wants off `globalThis` in one destructure, typed as `GuestGlobals`
from `@endo/thixotrope/guest.js`; `mustMatch`, being an assertion, needs a binding of its own
annotated as `GuestGlobals['mustMatch']`.
Append `powerName=inventoryKey` arguments to grant selected inventory capabilities to `make`.
This first profile accepts remotable capabilities as grants; copy data and promises are
rejected before forwarding, so a small request cannot hide a large copied grant.
The inventory itself and the worker controller are not implicitly granted.

The application's root takes the name in the inventory: from `attach`, call
`E(inventory.get('counter')).incr()`.
`thix installations` reports each installation of either kind with its workspace, SHA-256 code
digest, grants, and status.
An installation belongs to the workspace that asked for it, so the same name in two workspaces is
two installations, and `thix remove` takes the selected workspace's installation under the name
first, then the daemon's; the clock has no workspace and is the daemon's.
One registry, in a vat of the daemon's own, records applications and native resources alike: a
name, a code digest, a grant mapping, the vat allocated for it, and its outcome.
The registry retains the factory's result, including a pending result promise, which is guest to
guest so a factory still pending when the host restarts settles afterwards.
Its code and captured powers survive restart without reading the original module again.
The digest identifies the exact bundle bytes, not a publisher or a signature.
Repeating a name with the same bundle and grant mapping reuses its original result;
changing its code or grants requires a different name or removing the installation first.
Inventory changes after installation do not change previously captured powers.

An installation is one durable function in the registry vat, so one interrupted by a crash
resumes by itself at the next start, reusing the vat it allocated and never running `make` twice;
until then it stays listed as pending.
The host keeps an index of its own beside the vat, `installations.json`, which `installations` and
`remove` read when the registry vat cannot answer.
A failed installation, whether its factory or a step before it failed, stays inspectable and is
not retried; remove it and install again.
That includes one whose name the user took while it was being installed: the name is the user's,
and the installation fails rather than waiting for the name.
`thix remove ./private-state NAME` removes an installation of either kind, completed, failed, or
pending: its vat is retired, so references already held elsewhere break, and the name is free.
This initial version provides installation, not live code upgrades.

## Persistent applications serving HTTP

Install the native resource into the selected workspace's inventory, then grant its facet to an
application:

```sh
thix install-native ./private-state web ./resources/http
thix install ./private-state site ./examples/http-counter.js http=web
# In `thix attach ./private-state`:
# await E(inventory.get('site')).start(8080)
curl -X POST http://127.0.0.1:8080/incr
curl http://127.0.0.1:8080/read
```

A trusted native-resource directory supplies `durable.js` and `ephemeral.js`.
Each installation runs its durable module in a dedicated manager vat with its own heap and limits.
Its `make({ adapters, makeKeeper, makeManager })` returns `{ facet, lifecycle }`, the record also
carrying whatever the installation was granted or provided, such as the control socket's `admin`;
`makeManager` writes the manager's bookkeeping once, so the module supplies only what identifies a
registration and how to describe its status.
The ephemeral module runs in a separate Node process with native platform APIs; its `make()`
builds the adapter with `makeAdapter` from `@endo/thixotrope/native-adapter.js`, supplying the
identity rules, the two verbs that acquire and release the resource, and optionally `resolve`,
what a registration became once bound (a delay becoming a deadline, say), which the manager adopts.
The two halves speak one protocol, so `resources/http` is HTTP and little else on each side.
The registry vat retains the installation and the workspace inventory holds the public facet.
Each manager receives its own daemon startup notification, independently of workspace execution,
and an exit notice when its adapter process ends on its own, after a backoff that grows with
consecutive quick exits; it rebuilds the adapter on either while anything is registered.
The primary daemon only locates the two entry modules and bundles them, launches and connects
the native process from the stored ephemeral bundle, and manages its lifetime.
It contains no HTTP listener implementation or HTTP-specific installation commands.

Installation stores only the public facet in the requested inventory slot, through
the same registry as an application.
An interrupted installation resumes by itself at the next start.
The resumption reuses the manager vat; it does not rerun a completed durable factory attempt.
The HTTP facet provides `register(port, handler, policy?)`; the returned handle provides
`status()` and `close()`.
An unavailable port still returns a handle; `status()` retries binding and reports an error
while inactive, and `close()` withdraws the desired registration.
The application implements `handle({method, path, body})`, returning `{status, body}`.
Its counter and the manager's desired registrations survive in their respective durable heaps.
Sockets, request buffers, deadlines, and response handling live entirely in the native adapter.
A closed registration cannot close a later registration that reuses its port.

The initial HTTP profile uses ports 1024–65535 on IPv4 loopback, text bodies up to 64 KiB,
16 concurrent requests, and a five-second deadline.
Daemon restart creates a fresh adapter and reconstructs desired listeners, never pending requests.
After an adapter exits on its own while the daemon stays alive, the host reports the exit to its
manager after a backoff that grows with consecutive quick exits, and a manager with anything
registered rebuilds it then; one with nothing registered rebuilds on the next registration.
Already accepted calls into durable application vats may still complete.
A failed port bind does not prevent other registrations from being restored.

Native installation bundles both modules and is identified by the pair of bundle digests.
The ephemeral bundle is stored in the state directory under its digest, and every adapter process
verifies that digest over the bytes it loads.
The directory is not consulted again: editing or removing it after installation changes nothing
for a running or restarted installation, and changed source is a different installation, so
install its new version explicitly, under another name or after `thix remove`.
A name stays taken by its installation, completed, failed, or interrupted, until
`thix remove ./private-state NAME` removes it: the manager vat is retired, the processes it
launched are closed and its ports released, its startup notice is withdrawn, and the name is free.
Capabilities granted from the removed installation break; applications holding one need a new
grant.
A corrected directory therefore installs under the same name after `remove`, and never by
overwriting.
A module's dependencies are frozen in its bundle at installation.
In the ephemeral module only Node builtins are resolved by the process, imported by name or as a
namespace (`import * as http from 'node:http'`); a default import of a builtin has no binding in
the bundle.
A state directory serves a table of workspaces; `install-native` installs into the one the
connection selected, `default` unless `--workspace NAME` names another.
See [native resource installation](designs/native-resource-installation.md) for the module contract.

## Durable alarms and reminders

Every workspace holds the daemon's clock under `clock`, a native resource the supervisor provides
at every start, installed when missing, and hands to each workspace; grant it to an application like
any inventory entry:

```sh
thix install ./private-state reminders ./examples/reminder.js clock=clock
thix alarms ./private-state
thix attach ./private-state
```

In the attached workspace, enter each line separately to schedule a reminder a minute out:

<!-- prettier-ignore -->
```js
E(inventory.get('reminders')).arm(60000n, 'check the oven');
E(inventory.get('reminders')).status();
```

Applications receive `at(deadline)`, `after(delay)` and `arm({ at } | { after })`.
The first two settle at or after the deadline with the host time; the last also returns a
canceller for that one alarm, `E(canceller).cancel()`.
There is no `now()`: a program that only needs a delay never learns what time it is.
The clock is a native resource, `resources/clock`: its durable module runs in a manager vat of its
own and holds every pending deadline in its heap, and its ephemeral module is a process that arms
one OS timer per alarm against its own clock and reports each firing to the manager.
A delay is resolved to a deadline in that process when the alarm is armed, and the manager adopts
the resolved registration, so a restart restores the deadline rather than counting the delay again.
A restart, or the process ending on its own, rebuilds the process and re-arms every pending alarm;
one whose deadline passed meanwhile fires at once, and a firing the manager had not recorded is
reported again and settles once.
`thix installations` lists the clock; removing it retires its vat, its alarms and its process, and
the next start provides a fresh one.
A capability granted from a removed clock is a dead reference like any other; an application that
held it is reinstalled to receive the new one.
A name the user holds is theirs: the supervisor logs that it could not provide the installation and
serves without it, and a provided installation whose factory failed stays listed as failed until it
is removed and the next start provides it again.
The reminder example attaches its listener in another guest vat; both survive restart.
`alarms` asks the clock in the workspace for the number of `pending` alarms, so it fails while the
workspace vat is quarantined or the clock is not installed.

Deadlines are nonnegative signed 64-bit bigint Unix milliseconds; a delay is a bigint of
milliseconds up to 2^53.
The process checks wall-clock time before reporting, so this is not a precise timer.
A backward clock adjustment delays firing; a forward adjustment is noticed at the next timer check.
Recurring scheduling, per-application quotas, and notification UI remain future work.

Workspace metadata version 14 is required.
It includes dedicated native manager vats (version 4), the mail address book that introduces
contacts through the `mail-introductions` resource with observable inbox and outbox maps
(version 5), adapter launchers described by the manager vat that owns them, so that removing or
collecting a manager closes its processes (version 6), one installation registry for applications
and native resources whose values live in the inventory (version 7), the clock and mailbox provided
as installations in vats of their own (version 8), native adapters launched from bundles stored
under their digest together with the clock as a native resource with no host ledger (version 9),
the registry in a vat of the daemon's own with the host's index beside it (version 10), a
table of workspaces, each allocated under a key derived from its name, with installations
belonging to a workspace or to the daemon (version 11), and host resources bound to a worker and
a key, the adapter launcher's key being its bundle digest (version 12), and an export record
naming its resource's binding (version 13), and an installation whose name is taken while it runs
failing (version 14).
Older workspaces require migration or a fresh state directory because persisted registry and clock
closures cannot be updated by loading new source; startup rejects them before restoring workers.

## Local introductions and capability mail

Each supervisor also listens on `peers.sock`, a private Unix socket.
This initial transport connects supervisors owned by the same OS user on one machine.
It checks the destination directory's ownership and permissions before sending a resumption token.
It is not a transport for connections between machines or mutually untrusted OS users.
Logical messages are split into Unix fragments of at most one MiB and reassembled before durable acceptance.
Incomplete messages are discarded on socket loss and retried by the delivery layer.
This fragment limit does not bound total message or outbox memory.

Run two supervisors with different private state directories, then use these commands
(shown as `thix`; from the repository root use `node packages/thixotrope/bin/thix.js`):

```sh
thix invite ./alice bob
# Copy the JSON invitation into Bob's command, quoted as one argument:
thix accept ./bob alice '<invitation JSON>'
thix contacts ./alice
thix contacts ./bob
thix send ./alice bob 'Try this counter' counter
thix mail ./bob
```

The last argument to `send` selects one capability from Alice's inventory.
For example, install the counter example; its root is in Alice's inventory under `counter`.
Each message carries exactly one capability.
Bob's mailbox view supports `r` to refresh, `take <id> <inventory-key>`,
`discard <id>`, and `q` to disconnect.
`inbox`, `outbox`, and `contacts` provide the same descriptions as JSON for scripts.
`take` copies a message's capability into the inventory; `discard` releases only the mailbox's reference.
The view renders descriptions rather than the capabilities and creates no guest subscriptions.
Message text and contact labels are remote-controlled, so every command that prints them
escapes terminal control characters, including the C1 controls and Unicode line separators
that JSON quoting leaves raw.

Contact names are local labels, not claims of authenticated human identity.
Possession of an invitation permits one reciprocal exchange of inbox capabilities.
Once the exchange completes, the publication is withdrawn: the same correspondent may repeat
`accept` through the reference it already holds, but nobody can fetch the invitation again,
and a different correspondent is refused.
`revoke-invite ./alice '<invitation JSON>'` closes an unredeemed invitation and withdraws its publication.
It prints `false` when nothing remained to revoke, and it never disturbs an established contact
or capabilities previously sent.
Treat invitations as secrets and share them only with the intended recipient.

A pet name can be reused after a failed `accept`.
The contact keeps its name with status `failed` and the error;
`invite` or `accept` with the same name retries on that contact, and the last error stays
visible in `contacts` until an attempt succeeds.
A contact whose invitation was revoked before redemption is `cancelled` and can be invited again the same way.
`accept` validates the invitation before it records any session intent, so an invalid invitation reserves no name.

Invitations embed the inviter's `peers.sock` path as an absolute path, because `thix` resolves
the state directory argument against the current working directory when it starts serving.
Unix socket paths are limited by `sun_path`, 103 bytes here, so a deeply nested state directory
cannot serve peers; choose a short absolute path.

The mailbox is an installation the supervisor provides to every workspace at every start, in a
vat of its own, under `mailbox`; the address book is created over it on first use, and it and every contact look the
mailbox up at each use, so a mailbox provided afresh after a removal is the one they speak to, with
the removed mailbox's messages gone.
The workspace inventory holds the `contacts` map and the `mail` address book, so an application
can be granted mail the same way as any other inventory entry.
The address book reaches the host authority an introduction needs — publishing, withdrawing and
fetching invitations — through one `mail-introductions` resource, so a guest that holds the address
book can invite and accept without holding the daemon.
Granting `mail` therefore also grants the authority to make this node dial the peer named in any
invitation it accepts and to keep a durable session with that peer.
The inbox and outbox are observable maps of immutable message records that retain the sending or
receiving contact object; labels resolve against the contacts map when a list is read, so renaming
a contact relabels its messages and a contact removed from the map shows as `<unnamed>`.
The workspace holds the mailbox's owner capability; remote contacts receive only their own submission facet.
Accept while the destination is online and wait for contact status `ready` before sending.
Once established, calls use durable sessions: a send while the recipient is offline can remain
`sending` until reconnect, including after both supervisors restart.
The guest issues one invocation per send; the node owns delivery retries after admission.
This does not yet provide a separate application admission API or user-space retry proxy.
An interrupted introduction command can have an uncertain outcome; inspect `contacts` before retrying.

`@endo/daemon` has the same three ideas under other names: a mailbox, a pet store, and invitations.
There, the daemon owns the mailbox, a message names several capabilities by pet name and stores
them by formula identifier, and the pet store resolves names when the message is sent.
Here, the mailbox lives in a guest vat, records retain the contact object and resolve labels
only when read, and each message carries exactly one capability.

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
Each invocation starts the daemon, calls the published guest, then puts the vats to sleep
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
`ava.ironhorse.config.mjs` selects the complete native lane and runs its files serially.
In addition to those scenarios, it covers configurable limits, remote delivery, reachability,
supervisor lifecycle, capability mail, HTTP, and alarms, including separate HTTP and alarm crash suites.
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

`makeIronhorseEngine(powers, { workerBinary, bootPaths, storePath, crankBudget,
bootstrapBudget, slotCeiling, chunkCeiling, requestTimeoutMs })` implements the existing WorkerEngine interface. The
bootstrap uses the real SES shim and compartments. Native `async` functions,
ordinary promises, closures, and retained capabilities persist in SQLite without guest-side
serialization.
Suspended async activations use the `ASYN` snapshot atom; their saved frames and promise references
are validated on restoration.
The engine owns snapshot-format and store-schema versions; see
[`versions.rs`](../../rust/engine/ironhorse-snapshot/src/versions.rs) for their compatibility roles.

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

Configure the daemon-wide defaults when starting `thix serve`:

```sh
THIXOTROPE_CRANK_BUDGET=20000000 \
THIXOTROPE_BOOTSTRAP_BUDGET=1500000000 \
THIXOTROPE_SLOT_CEILING=2000000 \
THIXOTROPE_CHUNK_CEILING=536870912 \
THIXOTROPE_REQUEST_TIMEOUT_MS=90000 \
thix serve ./private-state
```

`thix status ./private-state` reports the effective settings under `ironhorse`.
Per-vat overrides are not implemented yet.

| Setting | Unit | Default | Supported range |
| --- | --- | --- | --- |
| `THIXOTROPE_CRANK_BUDGET` | computrons per guest crank | 10,000,000 | 1 to 2^64−1 |
| `THIXOTROPE_BOOTSTRAP_BUDGET` | computrons per bootstrap script or peer initialization | 1,000,000,000 | 1 to 2^64−1 |
| `THIXOTROPE_SLOT_CEILING` | slot records | 1,000,000 | 1 to 2^32−1 |
| `THIXOTROPE_CHUNK_CEILING` | chunk address-space bytes | 268,435,456 | 1 to 2^32−1 |
| `THIXOTROPE_REQUEST_TIMEOUT_MS` | milliseconds per worker request | 60,000 | 1 to 2^31−1 |

Supply positive decimal integers; zero does not mean unlimited.
The engine API also accepts bigint budgets; numeric inputs must fit unsigned 32 bits.
Status reports computron budgets as decimal strings to preserve precision.
Heap ceilings are arena limits, not per-crank allowances or total process memory limits.

Limits may change on restart while preserving the workspace, with one exception:
the slot and chunk ceilings may only increase, because a restored heap that already exceeds a
lower ceiling could never allocate again.
A ceiling decrease is refused before workers start, never clamped; repeat raised ceilings on
subsequent starts so an omitted setting does not revert to a lower default.
The crank budget, bootstrap budget, and watchdog timeout may change in either direction.
Lower a budget after a clean shutdown: crash recovery replays journaled cranks under the current
budget, and a crank recorded under a higher one can exceed it and quarantine that vat.
Raising limits does not automatically retry an already failed vat.
Older runtime manifests require migration or a fresh directory, and a `runtime.json` written by a
newer version is reported as such rather than as corrupt; this policy applies to version-2
manifests.
See [the limits design](designs/ironhorse-limits.md) for compatibility details.

This remains an experimental, local, single-supervisor MVP.
A kernel-backed directory lease refuses concurrent supervisors.
Workers hold shared incarnation leases until they exit; a replacement supervisor
must acquire the exclusive incarnation lease before reclaiming abandoned copies.
Lock files stay in place: never unlink them to force an unlock.
Use a matching engine build and bootstrap for stored images; upgrade migration
of live guest code is outside this demo. Async generators and `Array.fromAsync` suspensions remain
refused by the engine's persistence gate. The bootstrap carries the full
`Iterator` surface — the five lazy helpers are implemented, so it no longer
omits them — and uses SES's minimal override-taming profile.
This keeps the array iterator as a frozen native data property, as required by
Ironhorse's current typed-array copy path.
The standalone demos use a loopback testing netlayer; the `thix` supervisor provides the workspace
and installation commands described above.

### Compatibility and recovery

`runtime.json` records the worker executable hash, ordered bootstrap hashes,
host delivery protocol, and the current execution limits.
The worker's SQLite signature includes the code identity digest, excluding mutable limits.
The supervisor validates this manifest under its lease before restoring heaps or
cleaning abandoned incarnations, and executes private checked copies throughout
its lifetime so edits to the original paths cannot change a later wake.
The engine also validates its own boot-layout signature when restoring a stored image.

Use `demo:ironhorse:counter status PATH` (or the promise variant) for administrative
worker metadata without sending messages to guest capabilities.
`demo:ironhorse:counter inspect PATH` reads the manifest and metadata without
starting a daemon, acquiring worker capabilities, repairing files, or requiring a
matching binary; it remains available for incompatible or quarantined stores.
`inspectIronhorseStore(PATH)` exposes that read-only operation to embedders.
An inspection of a running store is not a transactional backup.

Recovery is deliberately explicit:

- After process death, reopen with the same runtime and equal or higher execution limits; leases release
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

Host factories take their platform powers explicitly as their first argument.
The Node composition entry creates filesystem, socket, subprocess, timer, entropy, and diagnostic
capabilities; the core never imports that entry or acquires platform authority by default.
Each installed native-resource manager keeps its durable state in its own vat heap.

```js
// The daemon runs under Hardened JavaScript: lock down first.
import '@endo/init';

import { E } from '@endo/eventual-send';
import { makeTcpNetLayer } from '@endo/ocapn/netlayer/tcp-testing';
import { syrupCodec } from '@endo/ocapn/syrup';
import {
  makeFsStore,
  makeThixotropeDaemon,
  makeXsEngine,
} from '@endo/thixotrope';
import { makeNodePowers } from '@endo/thixotrope/node-powers.js';

const powers = makeNodePowers();

const daemon = await makeThixotropeDaemon(powers, {
  store: makeFsStore(powers, '/var/lib/thixotrope'),
  engine: makeXsEngine(powers, {
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
    let count = 0n;
    return Far('Counter', { incr: () => ++count });
  })()
`);
const secret = daemon.publish(counter);
// Any OCapN peer can now mint a sturdy ref from (daemon.location, secret)
// and call the counter — across worker sleeps and daemon restarts.
console.log(await E(counter).incr()); // 1n, via the in-process endpoint

await daemon.shutdown(); // puts every worker to sleep; the store resumes it all
```

A restarted daemon must serve the same address its peers hold: pin the
netlayer's port (`makeTcpNetLayer({ ..., specifiedPort })`, or the
equivalent for your netlayer) rather than letting a successor process
pick a fresh ephemeral port.

## Worker sessions

Each worker runs a full (reduced-profile) OCapN peer —
`src/core/worker-peer.js`, a persistent `Compartment` behind an OCapN
client whose evaluate facet is fetched from the worker's own locator
under the well-known swissnum `shell`.
The daemon's side of the session is a durable worker transport
(`src/core/durable-worker-transport.js`), the durability envelope of the
worker's hub session: no wire handshake, no client — the OCapN hub
owns routing, and attaching the transport is the _same_ operation for
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

### Durable, transient, and view sessions

Three kinds of session reach the hub, and they differ in what survives.

The [root design](../../designs/thixotrope.md#vocabulary) keeps the glossary; the terms below are
the ones this section relies on.

A **durable session** is what a worker or a remote peer holds.
Its c-list rows, answer routes, and delivery obligations are persisted, so the session
outlives its socket, its worker process, and the daemon itself.

A **transient client** is a disposable host-side OCapN session, opened by
`daemon.openTransientClient()` and implemented in `src/net/transient-hub-client.js`.
The supervisor does not use one: its administrative calls go through the endpoint's own
durable session to the workspace vats and the registry vat.
The mechanism remains for embedders that want a request whose answers and imports die with
the request; calls it delivers are durable once accepted, but its own pending answers and
imported references end with the client.
Session keys are never reused, including across restarts, so a reference from a dead
transient client can never designate anything again.
Daemon shutdown drains client creation and closes the outstanding clients before
releasing the store.

A native adapter also has a transient session, attached directly to its process pipes.
For HTTP, one session belongs to the adapter incarnation; requests do not create sessions.
The adapter calls application handlers through this session, without a host-side HTTP observer.

A **view connection** is a control-socket session held by a terminal view in `src/tui/`.
It exists so the supervisor has something to release: closing the terminal, losing the
socket, or restarting the supervisor cancels that view's ephemeral subscriptions and
nothing else.
Durable guest listeners registered through it are unaffected.

## The hub, and how daemon restarts work

Thixotrope owns the hub, its persistence transactions, delivery queues, and session lifecycle.
OCapN supplies protocol codecs, descriptor helpers, and signature operations.
The hub (`src/net/hub.js`) holds only per-session c-lists (position ↔
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

The durable host **endpoint** is an in-process OCapN client hosting system resources,
the worker controller, and the embedder's admin route.
Disposable host clients and native adapters have separate reifying endpoints; routed traffic
between other sessions is handled by the hub without reifying its values.
Its session records shrink to resource bindings (a name, a worker and
a key, re-instantiated at recorded positions) and at-most-once answer obligations —
the one kind of pending obligation that genuinely dies with the
process, since worker-owed answers now survive restarts by heap
replay.

A daemon restart is: reload hub tables, reattach worker transports
(asleep), restore the endpoint session, and let remote peers resume by
rebinding their ducts.
Routed guest references remain hub rows; host resources are re-created from their recorded bindings.
Native adapters are replaced through their durable managers.
A promise minted in worker A and held in worker B settles after a
daemon restart with both workers starting asleep — the subscription is
nothing but rows and a wire subscription in A's heap.
Retired workers leave dead-reference tombstones in the tables, so
holders' calls break loudly instead of jamming.

## Engines

`makeIronhorseEngine` is the supervisor's default engine, backed by SQLite heaps.
Its build commands and configuration are described in [Ironhorse demos and CI tests](#ironhorse-demos-and-ci-tests).

`makeXsEngine` is an alternative heap-snapshot engine: each incarnation is a `thixotrope-xs-worker`
process (rust/thixotrope-xs-worker, a minimal runner on the `xsnap` crate)
evaluating the worker peer bundle inside an XS machine, with real heap
snapshots streamed into a content-addressed store.
Binary OCapN frames ride the binary's ASCII NDJSON duct base64-encoded
(`src/core/worker-peer-xs.js` is the bundle entry; `dist-xs/worker-peer.js`
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
`src/core/worker-engine.js` (`canSnapshot`, `start`, optional
`releaseSnapshot`) plugs in.
Two internal replay engines (`src/core/peer-replay-engine.js`) implement
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
const parent = await daemon.createWorker({ debugLabel: 'parent' });
const parentRoot = await parent.evaluate(
  `
  Far('Parent', {
    setup: async () => {
      const child = await E(controller).createWorker('child');
      const shared = Far('Shared', { secret: () => 'from-parent' });
      const source = "Far('Child', { read: () => E(shared).secret() })";
      return E(child).evaluate(source, { shared });
    },
  })
  `,
  { controller },
);
const child = await E(parentRoot).setup();
console.log(await E(child).read()); // 'from-parent'
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
reconnects with an idempotent version 2 `hello` and each side retransmits what the
other has not durably accepted.
The OCapN layer above is never told the socket dropped, so the
session — and every live remote reference in it — survives
transparently:

```js
const daemon = await makeThixotropeDaemon(powers, {
  // ...
  makeNetlayer: ({ handlers, logger, resumption }) =>
    makeDurableNetLayer(powers, {
      handlers,
      logger,
      resumption,
      makeBaseNetlayer: powers => makeTcpNetLayer(powers),
    }),
});
```

Wrap both peers.
Version 2 records incoming payloads before acknowledging acceptance, and retains outgoing messages
until the receiving hop accepts responsibility.
Invocation acceptance does not settle its result promise; later settlements use the same delivery
machinery and survive disconnects.
See the [layered delivery contract](designs/message-delivery.md).

With the daemon's `resumption` power, both originator and acceptor sessions recover across restart.
Their atomic session records contain inboxes, outboxes, watermarks, and pending handshake state.
The daemon rebinds the transport to the existing hub session and drains accepted inbox work, even
before the peer reconnects.
A successor must retain the same reachable network identity and state directory.

Peers advertise `restart` or `process` acceptance durability.
Clients without session resumption supply only the latter; their process exit can discard state.
Version 1 receipt-only peers and stored sessions require explicit migration or retirement and are
not silently treated as version 2 durable sessions.
Resume tokens are bearer capabilities: use a confidential, authenticated base transport in production.
The TCP testing transport in the example is suitable only for controlled tests.

Known limits of the prototype: retransmit buffers are unbounded until
acked; dormant sessions are kept indefinitely (no session GC); and
daemon-side imports re-mint lazily (identity across the restart is
per-session only).

## Retirement and vat GC

Retirement is a capability, not a host operation: `retire()` on the
embedder's worker object (and on the guest-visible `worker-facade`
resource) permanently deletes the worker — its session aborts so live
presences reject, publications rooted in it drop, its store is
deleted, its snapshot is released, the native adapter processes it
launched are closed, and host state keyed by it is dropped.

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
// `powers` are the platform powers the daemon itself receives.
const makeTimerResource = () =>
  Far('Timer', {
    now: () => powers.timers.now(),
    delay: ms =>
      new Promise(resolve =>
        powers.timers.setTimer(() => resolve(powers.timers.now()), ms),
      ),
  });
const daemon = await makeThixotropeDaemon(powers, {
  // ...
  resources: { timer: makeTimerResource },
});
const worker = await daemon.createWorker({ debugLabel: 'clock' });
const timer = daemon.makeResource('timer');
const clock = await worker.evaluate(
  `Far('Clock', { read: () => E(timer).now() })`,
  { timer },
);
```

A resource is bound to a worker, a key, both or neither:
`daemon.makeResource(name, { workerId, key })`.
One bound to neither is a daemon-wide singleton; one bound to a worker
is the authority over that worker's affairs and no other's (its facade,
the launcher of its native processes), and is retired with the worker,
whether the worker is retired or, being ephemeral, discarded at a start;
a guest still holding one meets a tombstone after the next restart. The
key tells instances bound to one worker apart (the launcher's bundle
digest).
When a resource is exported into a worker session, its name and binding
are recorded against the export slot; on daemon restart the export is
re-instantiated at the same slot, so presences inside the worker's
snapshot keep working.
`daemon.retireResource(name, binding)` ends one: the instance is
forgotten and its recorded exports are nulled, so a restart seats
tombstones there instead of re-running the maker, and a guest's release
of an export drops that export's record.
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

`makeThixotropeDaemon(powers, { store, engine, codec, makeNetlayer, resources?, idleSleepMs?, verbose? })`
resolves to a daemon (`idleSleepMs` puts to sleep any worker that has seen no
deliveries for that long; workers run to quiescence per delivery and
have no timer queue, so frame silence is exact dormancy):

- `createWorker({ debugLabel?, ephemeral?, allocationKey? })` — makes a
  fresh worker under a generated unguessable id, or finds the one made
  under the allocation key, and resolves to its worker object; an
  ephemeral worker is discarded at the next start.
- `getWorker(workerId)` — the worker object of an existing worker;
  throws for unknown ids (the embedder's admin route).
- `listWorkerIds()` — sorted ids of the live workers (admin/debug).
- `makeResource(name, binding?)` — instantiates a registered
  resource maker; interned by `(name, binding)`.
- `retireResource(name, binding?)` — forgets one, so a restart seats
  tombstones where its exports were.
- `publish(value, secret?)` — durably registers a capability the
  endpoint holds under a swissnum and returns the swissnum.
- `unpublish(secret)` — removes a publication.
- `lookup(secret)` — the embedder's in-process route to a publication.
- `collectVats({ keep? })` — vat-level mark-and-sweep over the hub's
  reference tables; resolves to the swept ids.
- `location` and `makeSturdyRefDetails(secret)` — what a peer needs to
  mint a sturdy ref.
- `shutdown()` — snapshots and puts every worker to sleep, then closes the
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

See the [main design](../../designs/thixotrope.md) for the current architecture and boundaries.
The [package designs](designs/README.md) cover potential mechanisms and experiments.
