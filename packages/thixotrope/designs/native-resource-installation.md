# Directory-installed native resources

This replaces the HTTP-specific host service in PR #1280.
The exploratory `codex/thixotrope-boundary-refactor` branch is not the implementation baseline.

An operator installs a trusted directory into the selected daemon's workspace inventory.
The directory provides `durable.js` and `ephemeral.js`, each exporting `make(powers)`.
The durable module is bundled and instantiated inside the existing workspace.
The ephemeral module is imported by a separate Node process, which owns its native APIs and
exposes only its root capability over the existing OCapN pipe protocol.
The primary daemon never imports or executes the resource's ephemeral module.

The durable factory receives a package-scoped adapter launcher and the workspace's E/Far helpers.
It returns a public `registration` capability and a private `lifecycle` capability whose
`started()` method reconciles desired state after daemon restart.
Installation retains the private facet in a workspace registry and places only `registration`
in the requested inventory slot.
Applications receive that reference through ordinary inventory grants.
A single workspace startup dispatcher notifies every installed resource.

The daemon supplies generic process launch, reference routing, retirement, and shutdown.
A native process is an ephemeral hub session with a fresh identity, not a replaying worker.
Process exit permanently breaks that incarnation's references; its inputs are never replayed.
Pipe loss terminates the process so its OS resources are released.
The durable manager creates a successor and reconstructs only declared state.

HTTP's package owns the server, sockets, buffering, deadlines, response handling, and routing.
The workspace manager retains registrations and application handlers in its ordinary heap.
The public facet registers a handler on a port and returns a per-registration status/close facet.
Neither platform objects nor the adapter launcher are returned to applications.

Implementation proceeds through the generic native-process seam, then directory installation
and HTTP migration, with functional tests and a subagent correctness review before each commit.
Checks cover distinct process ownership, retirement without replay, repeated installation,
multiple installed resources, daemon restart, and HTTP registration/recovery.
Directory identity and upgrade behavior must be explicit: an existing installation must not
silently combine an old durable module with newly edited native code.
