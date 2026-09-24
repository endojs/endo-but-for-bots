# Directory-installed native resources

This describes native-resource installation in PR #1220, which incorporates the work from #1280.
The exploratory `codex/thixotrope-boundary-refactor` branch is not the implementation baseline.

An operator installs a trusted directory into the selected daemon's workspace inventory.
The directory provides `durable.js` and `ephemeral.js`, each exporting `make(powers)`.
Each installation bundles and instantiates its durable module in a dedicated persistent manager vat.
The existing workspace retains installation bookkeeping and the public inventory reference.
The ephemeral module is imported by a separate Node process, which owns its native APIs and
exposes only its root capability over the existing OCapN pipe protocol.
The primary daemon never imports or executes the resource's ephemeral module.

The durable factory receives a package-scoped adapter launcher and its vat's E/Far helpers.
It returns a public `registration` capability and a private `lifecycle` capability whose
`started()` method reconciles desired state after daemon restart.
Installation publishes the private lifecycle facet for the manager's own startup notification and
places only `registration` in the requested workspace inventory slot.
Applications receive that reference through ordinary inventory grants.
Each manager has its own startup notification, so recovery does not depend on workspace execution.

The daemon supplies generic process launch, reference routing, retirement, and shutdown.
A native process is an ephemeral hub session with a fresh identity, not a replaying worker.
Process exit permanently breaks that incarnation's references; its inputs are never replayed.
Pipe loss terminates the process so its OS resources are released.
The durable manager creates a successor on its next adapter-using operation or daemon startup,
and reconstructs only declared state.
It does not autonomously restart an adapter immediately after process exit.

HTTP's package owns the server, sockets, buffering, deadlines, response handling, and routing.
The manager vat retains registrations and application handlers in its ordinary heap.
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
Each installed lifecycle receives its own daemon startup notification.

The directory digest covers its files recursively, including the two entry modules.
The native process verifies that digest before importing `ephemeral.js`.
Dependencies outside the directory use ordinary module resolution and are not covered by this
directory digest; keep those dependencies compatible with the installed durable bundle.
This is a pinned-directory installation, not a copied package or an automatic upgrade protocol.
Keep the directory present and unchanged for future incarnations.
Use a new inventory name and an unchanged new directory for a new installation.

Native installation introduced workspace metadata version 2 and removed the old `http-port` resource.
The [alarm acknowledgement protocol](alarm-settlement.md) introduced workspace version 3;
dedicated native manager vats now require version 4.
Older workspaces and durable closures need explicit migration; no automatic migration is included.
Use a fresh state directory for this implementation.
The native installation itself does not change Ironhorse heap format; execution-limit changes are
documented separately in [Ironhorse limits](ironhorse-limits.md).


## Dedicated manager vat implementation plan

Use one durable manager vat per installation, containing all registrations for that resource.
The workspace remains the inventory and installation coordinator.
The native child process remains ephemeral and continues to invoke application handlers directly.
This separates the manager's execution budget, heap, and failure lifetime from the workspace.
It adds a heap and startup/snapshot costs, without routing ordinary HTTP requests through the workspace.

The workspace registry reserves a name and code digest with a random allocation key before allocation.
The host records that key in the new worker's initial metadata, making allocation retryable without
using diagnostic labels as identity.
The registry retains the worker facade before evaluating resource code, providing an ordinary
reference for vat collection.
Collection waits for an active installation to finish so it cannot remove an unbound allocation.

Initialization evaluates the durable module once in the manager and retains its kit or failure there.
Then the host publishes the lifecycle facet and installs that manager's startup notice.
Finally, the workspace inserts registration into inventory, checking for intervening inventory edits.
Completed retries preserve later inventory edits; failed managers retain their identity and error.
An interrupted installation resumes on an explicit same-identity install retry, using the pinned
source directory; startup does not silently complete an unfinished install.
These records coordinate installation, not reconstruction of the manager's ordinary heap state.

Workspace metadata advances to version 4 because existing registry closures and installed managers
cannot be relocated automatically.
Older workspaces require migration or fresh state.
Validation covers separate manager globals, same-name reuse, allocation and initialization interruption,
manager failure with a usable workspace, independent startup notices, HTTP recovery, and collection.
Run functional checks and an adversarial subagent review before committing the implementation.

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

The native-installation increment passed its precommit review.
Validation covered 23 focused functional tests in each of three SES modes, the native Ironhorse
HTTP restart and process-crash tests, package lint/typechecking, the root declaration build,
and package documentation.
Root documentation generation remains blocked by unrelated repository type errors, including
the nested checkouts under `output/` and `tmp/`; package documentation generated with no errors.

The dedicated-manager increment passed its precommit adversarial review after narrowing factory
results to the two declared facets; implementation helpers remain local to the manager.
Recovery tests interrupt allocation, attachment, initialization, startup-notice registration, and
inventory publication, then restart and retry without duplicating the manager or factory execution.
Additional checks cover collection during installation, independent globals and startup, inventory
edits, and a failed factory.
Native Ironhorse checks confirm that exhausting one manager's meter leaves the workspace and a
sibling manager usable across restart, alongside HTTP restart, process-crash, and limit-increase tests.
Package lint and typechecking pass for this increment.
Root declaration generation encounters stale generated-declaration conflicts.
Current package API documentation also encounters six unrelated type errors in `platform` and
`endo-fs-asset-server`; root documentation encounters the wider repository errors noted above.

### Ironhorse compatibility

Sending the durable bundle in one evaluation request exhausted the current Ironhorse decoder's
heap ceiling during decoding while building intermediate string prefixes.
Installation now transfers source in bounded chunks, then evaluates the assembled expression.
The supervisor serializes installations and waits for accepted installations before shutdown.

An outer destructured-parameter wrapper around the bundled strict functions triggered Ironhorse's
`invalid directive` parser error.
Upstream commit `242b339b8`, now included through the `llm` rebase, fixes that parser issue (#1313).
The existing simple-parameter wrapper remains valid.
Chunked source transfer still addresses the separate decoder allocation cost.
Configurable execution and heap defaults are documented in [Ironhorse limits](ironhorse-limits.md).
