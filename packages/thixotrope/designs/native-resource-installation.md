# Directory-installed native resources

The [root design](../../../designs/thixotrope.md#native-resources) states the model: a native
resource is a directory with `durable.js` and `ephemeral.js`, whose manager runs in a dedicated vat
and whose adapter runs in a Node process that is expected to die.
This note records the installation contract behind it: what identifies an installation, how the
host drives it to completion or removal across interruption, and what the Ironhorse engine
required of the source transfer.

An operator installs a trusted directory into the selected daemon's workspace inventory with
`thix install-native STATE NAME DIRECTORY`.
Each installation bundles its durable module and evaluates it once in a dedicated manager vat;
the workspace retains the installation record and the public inventory reference.
The ephemeral module is imported by a separate Node process, which owns its native APIs and
exposes only its root over the existing OCapN pipe protocol; the primary daemon never imports or
executes it.

The durable factory is synchronous and receives `{adapters, makeKeeper, makeManager}`, with the
guest prelude in scope as globals.
It returns `{facet, lifecycle}`, both remotables; `src/native/contract.js` states the contract as
types.
Installation publishes the lifecycle facet privately for the manager's own notices and places
only the facet in the requested inventory slot, where applications receive it through ordinary
grants.
Each manager has its own start notice, so recovery does not depend on workspace execution, and
hears of its adapter's own exit through the same facet, after a host-side backoff, so a listener
comes back between starts without waiting for the next operation that needs it.

The daemon supplies generic process launch, reference routing, retirement and shutdown.
A native process is a transient hub session with a fresh identity, not a replaying worker: process
exit permanently breaks that incarnation's references, its inputs are never replayed, and pipe
loss terminates the process so its OS resources are released.
The manager creates a successor on its next adapter-using operation or at daemon startup, and
reconstructs only declared state; it does not restart an adapter autonomously after exit.

## Installation identity and compatibility

A state directory selects the daemon's existing single workspace.
An installation's identity is its inventory name together with a digest over the directory's real
path, a digest of its contents and a digest of the bundled durable module.
The contents digest covers every file under the directory, each hashed with its relative path and
length, in sorted order; the bundle is hashed on its own.
An edit to any file is therefore a different installation, and so is the same contents at another
path: the directory must stay present and unchanged for every later incarnation, since the native
process is started from it and re-describes it before importing the ephemeral module, refusing to
start a durable module's successor from edited native code.
Dependencies outside the directory resolve the ordinary way and are not part of the digest.
Reinstalling the same identity returns the same installation record without replacing later
inventory edits.
A directory containing `node_modules` is refused, so a directory holds source rather than vendored
packages; links are refused, so the digest covers only bytes that live inside the directory.

## The manager vat

One durable manager vat per installation holds every registration for that resource, separating
the manager's execution budget, heap and failure lifetime from the workspace and from other
managers; the workspace remains the inventory and installation coordinator.
The native child process stays ephemeral and invokes application handlers directly, so ordinary
requests never route through the workspace.

The workspace registry, shared with application installation, reserves a name, kind, code digest
and grant mapping under a random allocation key before any vat exists.
The host records that key in the new worker's initial metadata, so allocation is idempotent
without using diagnostic labels as identity, and the registry retains the worker facade before
resource code runs, giving vat collection an ordinary reference to respect.
Collection waits for an active installation to finish, so it cannot remove an unbound allocation.

Initialization stages the durable bundle into the manager in bounded chunks and evaluates it once
there, together with the manager kit and the keeper, retaining the kit or the failure in the
manager's own heap so a retry never runs the factory twice.
The host then publishes the lifecycle facet and installs the manager's start notice.
Finally the workspace puts the facet into the inventory, checking for intervening inventory
edits: a completed retry preserves later edits, and a failed manager retains its identity and
error until removed.
An interrupted installation resumes on an explicit same-identity install; startup does not
silently complete an unfinished one.

Removal is the host's to drive, in the opposite order.
The manager vat is retired first, which closes the native processes it launched (each launcher is
described by the manager that owns it), withdraws its start notice and drops the host rows keyed
by it; only then does the registry forget the name, taking the facet out of the inventory if the
inventory still holds it.
A removal interrupted between the two steps leaves an entry naming a retired vat, which the next
removal or installation under that name finishes; the reverse order could leave a manager that no
name reaches but whose start notice still roots it.
A failed or interrupted installation is removed the same way, so a corrected directory installs
under the same name rather than over an installation the registry still holds.

Workspace metadata carries a version the supervisor bumps whenever a guest closure it ships
changes shape, since registry closures and installed managers cannot be relocated automatically;
older workspaces require migration or fresh state.

## Ironhorse compatibility

Sending the durable bundle in one evaluation request exhausted the Ironhorse decoder's heap
ceiling while it built intermediate string prefixes.
Installation therefore transfers source in bounded chunks and evaluates the assembled expression;
the workspace's mail bootstrap goes the same way, on a staging slot of its own.
The supervisor serializes installations and waits, within a bound, for accepted installations
before shutdown.
The staged source is wrapped in a simple-parameter function, the shape Ironhorse's parser accepts
around bundled strict functions.
Configurable execution and heap defaults are in [Ironhorse limits](ironhorse-limits.md).
