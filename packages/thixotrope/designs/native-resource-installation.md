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

## Installation identity and compatibility

The operator command is `thix install-native state-directory inventory-name resource-directory`.
A state directory selects the daemon's existing single workspace; this change does not introduce
another user naming or pet-name-path model.
The durable factory is synchronous and receives `{E, Far, makeKeeper, adapters}`.
It returns `{registration, lifecycle}`, both remotables.
Only the registration facet is installed in inventory; applications get it through existing grants.
Reinstalling the same identity returns the same registration without replacing later inventory edits.
Every installed lifecycle participates in the workspace's one startup notification.

The directory digest covers its files recursively, including the two entry modules.
The native process verifies that digest before importing `ephemeral.js`.
Dependencies outside the directory use ordinary module resolution and are not covered by this
directory digest; keep those dependencies compatible with the installed durable bundle.
This is a pinned-directory installation, not a copied package or an automatic upgrade protocol.
Keep the directory present and unchanged for future incarnations.
Use a new inventory name and an unchanged new directory for a new installation.

This changes workspace metadata to version 2 and removes the old `http-port` host resource.
Existing version-1 workspaces and durable HTTP closures need an explicit migration; no automatic
migration is included in this early design.
Use a fresh state directory for this implementation.
No Ironhorse heap format or runtime code change is intended.

## Validation and review

The process seam passed precommit subagent review after correcting shutdown ordering and failed
startup cleanup; its tests cover process identity, reference retirement, stalled root acquisition,
and exit-callback errors.
The installation increment checks HTTP from an application guest, native adapter replacement,
daemon restart, multiple installed lifecycles, stable installation identity, and stale close handles.
Review additionally required partial port restoration and retiring native state after an interrupted
close so a withdrawn registration cannot remain served.
Registration returns its durable handle even if immediate binding fails.
Status retries the binding and reports inactive/error, so callers can always cancel desired state.

The final review found no remaining actionable issues.
Validation covered 23 focused functional tests in each of three SES modes, the native Ironhorse
HTTP restart and process-crash tests, package lint/typechecking, the root declaration build,
and package documentation.
Root documentation generation remains blocked by unrelated repository type errors, including
the nested checkouts under `output/` and `tmp/`; package documentation generated with no errors.

### Ironhorse compatibility

Sending the durable bundle in one evaluation request exhausted the current Ironhorse decoder's
per-crank heap while building intermediate string prefixes.
Installation now transfers source in bounded chunks, then evaluates the assembled expression.
The supervisor serializes installations and waits for accepted installations before shutdown.

An outer destructured-parameter wrapper around the bundled strict functions triggered Ironhorse's
`invalid directive` parser error.
Using a simple parameter and property access avoids that parser incompatibility.
The native HTTP integration passes without engine changes or a higher production meter.
