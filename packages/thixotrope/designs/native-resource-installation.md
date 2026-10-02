# Directory-installed native resources

The [root design](../../../designs/thixotrope.md#native-resources) states the model: a native
resource is a directory with `durable.js` and `ephemeral.js`, whose manager runs in a dedicated vat
and whose adapter runs in a Node process that is expected to die.
This note records the installation contract behind it: what identifies an installation, how the
host drives it to completion or removal across interruption, and what the Ironhorse engine
required of the source transfer.

An operator installs a trusted directory into the selected workspace's inventory with
`thix install-native STATE NAME DIRECTORY`.
Each installation bundles its durable module and evaluates it once in a dedicated manager vat;
the registry vat retains the installation record, the host its index entry, and the workspace the
public inventory reference.
The ephemeral module is bundled at installation as well, in the compartment mapper's CommonJS
form, and stored in the state directory under its digest; a separate Node process loads the
stored bundle, owns its native APIs and exposes only its root over the existing OCapN pipe
protocol.
The primary daemon never imports or executes it.

The durable factory is synchronous and receives `{adapters, makeKeeper, makeManager}` together with
whatever the installation was granted or provided, with the guest prelude in scope as globals.
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
The manager creates a successor on its next adapter-using operation, at daemon startup, or when the
host reports the adapter's own exit, and reconstructs only declared state; nothing pending is
replayed into it.

## Installation identity and compatibility

A state directory serves many workspaces, and an installation belongs to the one that asked for it:
the registry keys it by workspace and name, so one directory installed from two workspaces is two
installations, each with a manager vat of its own.
An installation's identity is its workspace and inventory name together with a digest over the pair
of bundle digests, the durable module's and the ephemeral module's.
Each bundle freezes what its module imports, so a dependency's change is a change of the bundle;
the directory's path is not part of the identity, and the same modules at another path are the
same installation.
The ephemeral bundle is stored under its digest in the state directory's `bundles/`, written once
and never rewritten, and the launcher, bound to the manager vat, has that digest as its key, so
the host knows, from the launcher's record alone, which bundle it launches together with the manager
vat that owns it.
Every adapter process reads the stored file, verifies the digest over its bytes and refuses to
start on a mismatch, so a damaged or substituted file does not run; a launcher recorded before
bundling names no bundle and refuses to launch, saying the resource is to be installed again.
The directory is consulted only at installation: an edit or a removal afterwards changes nothing
for a running or restarted installation, and edited source is a different installation, installed
explicitly under another name or after a removal.
Bundles that no launcher record names are freed at the next daemon start, once the endpoint's
records are settled, which releases a removed installation's bundle and one left by an
installation interrupted before its manager held the launcher.
Reinstalling the same identity returns the same installation record without replacing later
inventory edits.
The two entries must be files rather than links, so what is bundled is what is there; nothing else
in the directory is inspected, and packages vendored beside the entries are the bundler's to
resolve.

## The manager vat

One durable manager vat per installation holds every registration for that resource, separating
the manager's execution budget, heap and failure lifetime from the workspace and from other
managers; the registry vat coordinates the installation and the workspace holds the facet in its
inventory.
The native child process stays ephemeral and invokes application handlers directly, so ordinary
requests never route through the workspace.

The registry, in a vat of the daemon's own and shared with application installation, reserves a
name, kind, code digest and grant mapping under a random allocation key before any vat exists.
The host records that key in the new worker's initial metadata, so allocation is idempotent
without using diagnostic labels as identity, and the registry retains the worker facade before
resource code runs, giving vat collection an ordinary reference to respect.
An allocation takes a turn with collection, and the host keeps a vat it has handed out from
collection until the registry's next call about it: the facade is still on its way when the turn
ends, and until the registry holds it nothing else roots the vat.

The host's installer, a resource granted to the registry vat alone, stages the durable bundle
from the store into the manager in bounded chunks and evaluates it once there, together with the
manager kit and the keeper, retaining the kit or the failure in the manager's own heap so a retry
never runs the factory twice; the bundle stays in the store until a later start's sweep finds
nothing naming it, the index having stopped naming it once the manager held it.
The host then publishes the lifecycle facet and installs the manager's start notice.
Finally the registry puts the facet into the inventory through the workspace's access object; a
name taken meanwhile fails the installation, and a failed installation retains its vat, its
identity and its error until removed.
The installation is one durable function in the registry vat, so an interrupted one resumes by
itself at the next start: a host answer broken by the restart is made again under the same
allocation key, and every host step is idempotent.
The host keeps an index of its own beside the vat, written by the registry at each step, which
names the bundles not yet staged for the sweep and answers listing and removal while the registry
vat cannot.
The host records a request there before handing it to the registry, since the registry journals
the request before the host hears of it, and a start in between would otherwise sweep the bundles
from under the resuming driver.
A quarantined registry vat leaves the host serving from the index: installations are listed and
removed, and none is made, until the state directory is replaced.

Removal is the registry's to drive, in the opposite order.
The manager vat is retired first, which closes the native processes it launched (each launcher is
bound to the manager that owns it), withdraws its start notice and drops the host rows keyed
by it; only then does the registry forget the name, taking the facet out of the inventory if the
inventory still holds it, and the host its index entry.
A removal interrupted between the steps resumes where it stopped; the reverse order could leave a
manager that no name reaches but whose start notice still roots it.
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
The registry vat serializes installations; the supervisor does not wait for one at shutdown, since
the driver resumes it at the next start.
The staged source is wrapped in a simple-parameter function, the shape Ironhorse's parser accepts
around bundled strict functions.
Configurable execution and heap defaults are in [Ironhorse limits](ironhorse-limits.md).
