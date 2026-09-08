# Vat replacement as an upgrade fallback

Status: exploratory design, not an implemented API or a selected default upgrade mechanism.
This is a possible fallback for the [user-space upgrade hypothesis](README.md#user-space-upgrade-and-migration).
Here “migration” means replacing an application's vat within one Thixotrope host, not moving it
between machines or changing the Ironhorse heap format.

## Intended capability

An owner prepares a new vat using whatever application-specific recovery and migration code is needed.
At a controlled boundary, the host substitutes that vat for an old vat while preserving existing
references held by other vats and remote peers.
This can repair behavior without requiring every object to have been built around an upgrade facade.
It should not require remote holders to fetch new capabilities from an inventory or registry.

For example, a caller already holds the old vat's counter at export position 7.
The migration binds that old export identity to a replacement counter initialized with recovered state.
The caller's next send reaches the replacement without changing the caller's reference.
Merely changing a publication or application registry entry would not achieve this.

This does not automatically recover arbitrary old state.
Ordinary JavaScript cannot inspect every closed-over variable or suspended activation.
A broken or quarantined vat may be unable to execute state-extraction code at all.
The experiment must establish what state is recoverable through existing capabilities and what would
require additional debugging, inspection, or snapshot tools.
The ability to replace an export is not itself a guarantee that important private heap state can be saved.

## Identity and routing choices

The durable identity seen by holders must be separated conceptually from the worker incarnation
that currently implements it.
A replacement is not retirement followed by reuse of a retired identifier.
Retirement remains terminal; replacement needs its own authorized transition.

There are two candidate implementations:

- Initialize the new guest's session tables so that old export and import positions retain their
  meanings, then replace the worker behind the existing logical session.
- Keep old hub-facing identities and translate them to positions in the replacement's fresh session.
  This avoids requiring equal numeric export positions but adds translation and alias bookkeeping.

Both require a coherent treatment of session state, not just an object map.
The current hub identifies rows using origin session, epoch, position, backing kind, and flavor.
It also records answers owed, listeners, reference counts, queued frames, and delivery sequences.
The old guest's session contains the corresponding imports, exports, answer state, and local values.
Those two sides must agree after replacement.
A worker's raw identifier must not be changed as a shortcut around these obligations.

A first experiment should compare these approaches using the existing single hub session per worker.
Do not assume a new general-purpose routing indirection is required before that comparison.

## Replacement manifest

The owner supplies an explicit plan tied to a frozen source generation and prepared destination.
The host produces the authoritative inventory of protocol obligations from trusted runtime and hub state.
The application supplies replacements and migration policy; it cannot declare obligations absent.
Potential manifest entries include:

- Every externally addressable old export: preserve with a specified replacement or explicitly retire.
  Include bootstrap and runtime-owned exports, which require separate host rules.
- Exported promises and answer-backed promises, with a policy for their result and existing listeners.
- Resolver objects and callbacks that carry protocol obligations even though they look like object exports.
- Imports needed by the replacement and the authority by which it receives them.
- Pending incoming calls, outgoing calls, queued settlements, pipelined calls, and gift handoffs.
- Publications, host worker facades, and other bindings that designate the old vat.
- External resources whose ownership or recovery must be handled outside the heap replacement.

Omitting a slot must not silently route it to some other value or leave a promise pending forever.
The inventory must cover dormant remote holders and retained answer routes, not only active sockets
or named application objects.
Local heap garbage collection may lag the hub's view, so uncertainty requires conservative accounting.

## Host validation

The host should enforce mechanical invariants before committing a replacement:

| Check | Required property |
| --- | --- |
| Authority | The requester has explicit administrative replacement authority over the source and control of the destination. Holding an ordinary exported object is insufficient. |
| Freshness | Source generation, journal cut, hub revision, and prepared destination digest still match the validated plan. |
| Destination isolation | The destination has no uncontrolled holders or traffic that could interfere with adopting the old identity. A first version can require a private staging vat. |
| Coverage | Each required export and protocol obligation has one supported disposition. Unsupported pending state prevents cutover unless an explicit breakage mode is selected. |
| Slot validity | Replacement positions exist in trusted guest session tables and designate admissible values with compatible protocol roles. A guest-provided string is not proof. |
| Identity | Preserve existing alias relationships. Do not silently collapse distinct old identities into one new identity; any supported merge needs an explicit policy. |
| Authority transfer | Replacement imports and new endowments are accounted for and authorized. Migration cannot name arbitrary host capabilities or other vats' private slots. |
| Protocol consistency | Import/export tables, reference counts, answer positions, listener routes, and allocation counters agree. Replaying a GC frame or settlement cannot corrupt replacement state. |
| Delivery continuity | Accepted input, unsent output, attempted deliveries, and duplicate-suppression watermarks have a defined owner across the cut. Fresh counters must not suppress new output or duplicate old effects. |
| Incarnation fencing | The old worker cannot publish output or write accepted state after cutover. Late callbacks are checked against the active generation. |
| Durable recovery | A committed destination checkpoint and recoverable switch record exist before the replacement becomes visible. Restart selects exactly one active incarnation. |
| Runtime compatibility | Both heap images obey the existing runtime/profile validation. Application replacement does not bypass incompatible engine-state checks. |

Object/promise distinctions are necessary but insufficient: a protocol resolver cannot be replaced by
an arbitrary object merely because both occupy object slots.
Optional interface guards or user-supplied checks can catch mistakes, but matching method names does
not establish semantic compatibility.
The host cannot prove that the replacement preserves invariants, privacy, intended authority policy,
or application meaning.
That remains the responsibility of the owner and migration code.

## Cutover and failure model

A candidate protocol is:

1. Prepare a private replacement vat, its migration code, and an initial export mapping.
2. Fence ordinary delivery to the source at a completed execution-step boundary.
   Sleeping alone is insufficient because the next message normally wakes the worker.
   Record the accepted-input cut and the disposition of traffic arriving during migration.
3. Capture the authoritative obligation inventory and finish migration against that fenced state.
   If privileged extraction runs in the old vat, distinguish it from ordinary application ingress.
   Migration code that uses external capabilities can produce real effects; preparation is not
   automatically a side-effect-free preview.
4. Validate the final manifest and checkpoint the prepared destination.
   Refuse a stale manifest rather than validate one state and switch a different state.
5. Durably commit the identity-to-incarnation switch and the coordinated protocol/table changes.
   Hub metadata and worker files currently have separate persistence operations; an explicit
   recoverable transaction is needed, not two independent best-effort writes.
6. Admit queued or new work according to the selected cutover policy and reclaim the old incarnation
   only after recovery no longer needs it.

Before commit, a failed preparation can leave the old vat available for resumption, subject to any
external effects migration code already performed.
After the replacement accepts new work, rolling back to the old heap would discard that work.
Recovery must therefore resume the committed replacement; later reversal is another migration, not
an automatic fallback to an old image.
A saved old heap also retains old secrets and data until the owner discards it.

The existing remote acknowledgement gap remains relevant.
Replacement must not claim to preserve incoming work for which the current transport has already
acknowledged receipt without retaining either the payload or committed handler effects.
The replacement contract must name the durability boundary it actually covers.

## Pending promises and emergency breakage

A durable promise listener is a primary feature, so silently losing listeners is unacceptable.
Pending obligations need either a supported transfer or an explicit terminal result.
Moving a pending promise's export slot alone does not move its resolver, saved continuation, or
registered callback behavior.
An outgoing call may have executed remotely even if the old vat has not received the result.
Replacing the vat must not turn that uncertainty into permission to invoke it again.

Two possible modes remain under discussion:

- Preservation mode refuses replacement when it cannot carry every required obligation.
- Emergency mode permits explicitly reported rejection of selected pending obligations, with
  preservation of the rest and rejection routed through existing promise/listener machinery.

Neither mode can undo external effects.
A host report should distinguish references that keep working, exports that become terminal,
promises that reject, resources requiring intervention, and state it cannot account for.
The owner's policy for allowing emergency breakage has not yet been selected.

## Alternative: SQL-assisted surgery on an existing heap snapshot

This alternative edits a stopped vat's existing heap instead of reconstructing its application
state in a fresh vat.
It could preserve the original object identities, captured environments, and session tables while
repairing selected state or behavior.
It also offers a potential path to inspect state that ordinary JavaScript cannot access.
This is privileged owner tooling, outside guest authority and ordinary SES object-mutation rules.
It is not implemented by the current worker or an ordinary SQLite migration facility.

### What SQLite actually contains

The [SQLite backend](../../../rust/endo/ironhorse-store-sqlite/src/lib.rs) stores an encoded VM image:

| Table | Contents relevant to upgrade |
| --- | --- |
| `slot_pages` | BLOBs containing fixed-width heap slot records, not named application objects. |
| `chunk_exts` | BLOB extents of the chunk arena, including variable-sized payloads. |
| `small_state` | Encoded sections for names and keys, collections, function metadata and code segments, private elements, generators, promises, and suspended async activations. |
| `meta` | Encoded manifest with geometry, versions, expected runtime signature, epoch, content root, and commit seal. |
| `leaf_hashes`, `page_edges`, `free_segs` | Integrity, reachability, and allocation metadata that must agree with the edited state. |
| `edge_pairs` | Derived page-level adjacency index, rebuilt from `page_edges` at open. |
| `side_tables` | A declared table in the schema; it is not currently a relational function/property interface. The tested heap had no rows here. |

The [slot codec](../../../rust/engine/ironhorse-snapshot/src/slot_codec.rs) uses 20-byte big-endian
records with kind, flags, property id, next-slot index, and tagged payload.
Property ids must agree with the name/symbol tables; references and chunk offsets must remain valid.
A SQL statement cannot presently name an application property or closure binding without decoding
this representation and locating the relevant record.
Slot addresses should be treated as identifiers within a specific snapshot, not permanent migration
keys independent of snapshot identity and allocation history.

Function code is not stored as a SQL row containing JavaScript source.
The VM's `FunctionStateSnapshot` has bytecode segments and function rows that identify an owner,
segment, body range, closure environment, and related metadata.
Saved async/generator frames also carry locals, an id map, the environment, function identity,
jump state, and a resume program counter.
See [the VM row definitions](../../../rust/engine/ironhorse-vm/src/interp.rs) and
[small-state encoding](../../../rust/engine/ironhorse-snapshot/src/store.rs).

### Local probes and their limits

An isolated experiment created a heap using the existing Rust worker and a closure that captures
integer `40414243` and returns it.
The worker checkpointed and closed the store before any SQL inspection or edits.
Copies of that heap were edited through Python's SQLite interface and resumed through the worker's
normal eager restore path.
The experiment used a minimal trusted boot script, not a full Thixotrope/SES/OCapN vat.
No user heap was edited.

| Probe | Observed result |
| --- | --- |
| Resume an unchanged copy | Returned `40414243`. |
| Decode slot pages to locate the captured integer | Found one matching integer-payload slot; the original row hash also matched the engine's documented hash formula. |
| SQL `UPDATE slot_pages` replacing that integer with `40414250`, without changing row length | SQLite integrity check passed; worker restore refused: `store slot page fails its leaf hash`. |
| Update the edited page's leaf hash as well | SQLite integrity check passed; worker restore refused with `BaselineMismatch` when the recomputed content root differed. |
| Delete all `edge_pairs` rows on a separate copy | Restore succeeded with the original value; open rebuilt all nine derived edges. This is index repair, not an application upgrade. |

The probe also confirmed that inspection connections must be closed before the worker takes its
exclusive SQLite lock.
These checks demonstrate representation access and existing integrity gates.
They do not demonstrate a successful code upgrade, safe resealing, preservation of SES invariants,
or migration of a live Thixotrope session.
The integer was deliberately distinctive; byte-pattern search is not a general binding locator.

### What would make SQL a useful upgrade interface

The useful design is likely a decoded inspection/editing layer over SQLite, using engine-maintained
codecs and validators rather than application authors manipulating BLOB offsets.
Possible interfaces are virtual tables or typed patch operations that expose object properties,
closure environments, functions, and incoming references.
SQL could select and join those views, while an engine-aware writer applies a validated patch.
No such views or SQL functions exist yet.

A staged writer must update all affected representations: slot and chunk geometry, allocation data,
property ids, side-state sections, reachability summaries, row hashes, the content root, and commit
lineage.
Recomputing a hash only establishes byte consistency; it does not prove that the edited program is
well formed or correct.
The hashes and seals are integrity/succession mechanisms, not authentication of the owner's intent.
The editor needs explicit host authority and a separate migration audit record.

There are existing building blocks to investigate: `store_to_image`, `write_machine`,
`read_validated_machine`, `image_to_batch`, and `import_from_container` in the snapshot crate.
A modified image must cross validation again; a previously validated image is not a reusable proof
after mutation.
A candidate tool could decode an offline copy, apply typed edits, re-encode and validate it, then
write a new store through supported checkpoint/container APIs.
This is an engineering proposal, not a tested SQL upgrade path.
Container import starts a fresh store epoch and crank history, so it cannot silently replace the
host's existing journal/checkpoint bookkeeping.
Store-schema migration functions migrate engine formats, not application code or state.

### State repair versus code replacement

A scalar binding repair that preserves all references is a useful first case.
Changing a reference is harder: aliases, incoming edges, GC metadata, and capability authority matter.
Changing property structure also requires respecting descriptors, prototypes, symbols, and internal
brands unless the owner intentionally authorizes a documented change to them.
Offline editing can bypass frozen-object restrictions; preserving or breaking those restrictions
must be an explicit migration decision, not an accidental consequence of byte writes.

Code replacement requires compilation and linking against the target image's function/environment
layout and key tables.
One bytecode segment can serve multiple closures, so editing it may change more than one object.
Replacing a function's metadata can preserve its object identity, but only if callability metadata,
closure layout, bound functions, constructor links, and related state stay coherent.
A listener registered against that function may observe the new behavior, which must be tested.

A suspended frame is the hardest case: equal bytecode length or an in-range resume offset does not
make a new body compatible with its saved locals, jump stack, and continuation point.
A first code-patch profile should refuse affected active/suspended frames, preserve their old code
alongside new code for future calls, or require an explicit continuation migration.
The choice is part of the upgrade contract; SQL itself does not resolve it.

### Additional host validation and publication requirements

The host must stop or fence the source at a valid execution boundary and produce a closed,
self-contained staging copy.
Do not edit a database still open in a worker, an immutable committed sleep image in place, or an
abandoned live incarnation that the host would never select for recovery.
The SQLite writer holds an exclusive lock and caches integrity metadata; runtime edits are not a
supported synchronization mechanism.

The host should bind a patch to the source snapshot digest, runtime profile, journal cut, and hub
revision, and show a typed before/after diff and affected identities/continuations.
Reject stale plans and require the same authority and protocol checks as whole-vat replacement.
Run full image validation and eager restore on the edited artifact, not only SQLite integrity checks
or the metadata checks sufficient for a lazy restore.
Then test execution, collection, checkpoint, and restore on a disposable validation copy.
Those tests can detect failures but cannot prove application-level correctness.

Thixotrope identifies sleep images by a file digest; an edited file under its old reference is
rejected before worker restore.
A valid patched heap needs a new immutable image reference and a coordinated host commit that makes
it authoritative at the correct journal boundary.
Replaying the old suffix into an arbitrarily edited older snapshot could repeat effects or apply
messages to the wrong state.
Preserving guest session tables does not eliminate the need to coordinate hub tables, delivery
watermarks, output already accepted elsewhere, and the replacement generation.
Patching a snapshot does not bypass runtime compatibility or repair the remote acknowledgement gap.

This makes SQL-assisted snapshot surgery a plausible second escape hatch: it can target otherwise
inaccessible state while preserving more existing identities than reconstruction in a new vat.
Its cost is dependence on VM representation and stronger validation/tooling requirements.
The next useful experiment is a successful engine-validated scalar repair with identity preserved,
followed by a future-call-only function replacement and an explicit refusal for an incompatible
suspended frame.
Do not treat the observed hash refusals as proof that such tooling is impossible, or a successful
scalar patch as evidence that arbitrary heap upgrades are safe.

## SQLite table-design suggestions for easier upgrade

These are proposals informed by the exploration above, not changes to the current schema.
The objective is to expose useful structure without making application authors design a relational
schema for every persistent object.
The VM should supply the mapping from an orthogonal heap to inspectable entities.

### Start with decoded views and a patch workspace

Keep the current page/blob store authoritative initially.
Expose version-aware, read-only virtual tables or decoded staging tables over a particular snapshot.
Use an explicit patch workspace to record requested changes; an engine-aware compiler validates and
applies them to a new snapshot.
This provides SQL queries and joins without maintaining two independently mutable copies of the heap.
A plain writable mirror of `slot_pages` plus normalized object tables would create an ambiguous
source of truth and an additional corruption mode.

Candidate logical relations are:

| Relation | Useful fields and upgrade purpose |
| --- | --- |
| `snapshot_catalog` | Snapshot identity, parent, format/schema versions, runtime profile, source digest, and provenance. Bind every inspection and patch to an exact image. |
| `heap_slots` | Snapshot, slot identity, allocation generation if available, kind, flags, property id, next link, and typed payload. Eliminate application-authored byte offsets. |
| `properties` | Owning object, string/symbol key identity, descriptor flags, value reference or scalar, getter, and setter. Support a query for a particular object's state and preserve descriptor semantics. |
| `bindings` | Environment identity, binding identity/name when known, value, and mutability/initialization state. Make captured state inspectable without pretending every compiler binding has a recoverable source name. |
| `functions` | Function object identity, code version, environment identity, home object, call/construct metadata, and related bound-function links. Separate identity from implementation. |
| `code_versions` | Code identity, bytecode, engine/compiler format, parameter/local/environment layout, and optional source/debug metadata. Make shared code and the scope of replacement explicit. |
| `continuations` | Activation identity, function/code version, resume point, saved-frame layout, locals/arguments, and promise links. Find every suspended activation affected by a proposed code edit. |
| `promises` and `reactions` | Promise identity and settlement state, reaction order, callback references, resolver/capability links, and async/combinator roles. Permit explicit accounting for durable listeners. |
| `reference_edges` | Source entity and field/role, target identity, strong/weak classification where meaningful, and whether the edge is derived. Support incoming-reference and impact queries. |
| `patches` and `patch_edits` | Source identity, expected old values, typed edits, authorizing host operation, and status. Make the requested transformation inspectable and reject stale targets. |
| `validation_results` | Patch identity, candidate digest, validator/runtime version, checks performed, outcomes, and declared losses. Associate approval with exactly the candidate checked. |

These are logical interfaces first, not a proposal to create all of these physical tables.
Some may be views over others or nested records decoded on demand.
An incoming-reference query must include VM side-state edges, not just object properties.
The current page-level `edge_pairs` index is useful for page reachability, but cannot explain which
property, closure, or promise reaction keeps a particular object alive.

### Separate stable identities from replaceable representations

Function identity and code-version identity should be separate.
Many functions can share a code version, while a particular function can select a new version for
future calls without automatically reinterpreting an existing saved frame.
A continuation should explicitly identify the code version and frame layout it was created against.
This makes retaining old code for suspended work representable, though migrating that work remains
a semantic problem.
A source location or equal-length bytecode body is not a continuation compatibility proof.

Likewise, object identity should not depend on a human-assigned inventory name.
Within the initial snapshot views, a slot number plus source snapshot identity is sufficient to
address an edit precisely.
If identities are later intended to span allocation reuse or compaction, an explicit allocation
identity/generation or a relocation map is needed; naked slot numbers must not acquire that promise
accidentally.
Host-visible export identities remain distinct from internal heap identities.

Names, source maps, environment layouts, and binding descriptions would greatly improve emergency
repair, but collecting them may require compiler/VM changes and has storage and privacy costs.
Treat missing debug metadata as missing, not as permission to infer a binding's meaning from a
coincidentally matching integer or string.
These inspection capabilities belong to authorized host tooling, not to ordinary guests.

### Give typed values and invariants explicit representations

Scalar values and references should be distinguishable without interpreting arbitrary payload bytes.
Preserve JavaScript values exactly: floating-point storage must preserve relevant bit patterns,
including negative zero, and arbitrary-size integers must not be coerced through SQLite `REAL` or a
bounded SQL integer column.
Use canonical tagged encodings where SQLite's native types do not match the VM domain.
String keys, symbol identities, object references, and raw chunk locations need distinct types.

Foreign keys, uniqueness constraints, and check constraints can catch missing targets and malformed
rows in a materialized patch workspace.
They do not establish code validity, correct GC edges, or application semantics.
Graph and runtime validation must still check cross-table roles, allocation accounting, continuation
compatibility, internal brands, and bootstrap/runtime invariants.
A patch should state the expected old value and source generation so an SQL update cannot silently
edit a different object after the baseline changes.

### Make edits transactional and derivations explicit

The patch API should accept a group of logical edits, validate the candidate graph, derive integrity
and GC metadata, and publish a new immutable snapshot as one operation.
Do not require users to update leaf hashes, reachability summaries, and commit seals by hand.
Changes to those derived structures should normally be produced by the engine-aware writer.
If a physical index is rebuildable, identify its authoritative source and rebuild/verify rules,
as the current `edge_pairs` table already does.

The patch workspace should distinguish preparation, validation, and host cutover.
A SQL transaction on one heap database does not atomically update the hub and worker journal.
The host migration record must bind the candidate image to its logical vat, source generation,
journal cut, and protocol inventory, and coordinate installation separately.
A diagnostic `vat_exports`/`session_obligations` view could join trusted guest information with that
host inventory, but it must not imply the hub's data resides in the guest heap database or grant the
guest authority to edit it.

Prefer a new snapshot with recorded provenance over editing the old snapshot in place.
A patch log records intent and recovery decisions; it is not by itself a proof that an upgrade is
correct or that rollback remains safe after new work is accepted.

### Normalize physical storage only where evidence supports it

The current store intentionally makes page/chunk commit I/O proportional to dirty rows.
Eagerly maintaining a complete relational mirror could add writes and index work to every guest
mutation, or require a full heap decode at each checkpoint.
First measure on-demand decoding and a disposable patch database built once per upgrade.

If measurements justify normalizing selected runtime state, function/code versions and continuations
are useful candidates because explicit links help validate upgrades and shared-code effects.
Any move from `small_state` BLOB sections to authoritative rows needs a versioned format migration,
updated integrity coverage, and an unambiguous reader/writer contract.
Do not retain two authoritative encodings during a transition without a checked consistency rule.
Physical normalization alone does not provide stable source-level names or make arbitrary code edits
safe.

A useful progression is read-only inspection, typed scalar/reference edits, function replacement for
future calls, and only then explicit continuation migration.
For each step, test no-edit round trips, stale-plan refusal, affected-reference reporting, GC,
checkpoint/reopen, and crash recovery.
Compare upgrade effort, snapshot size, normal checkpoint cost, and migration cost before choosing a
permanent schema expansion.

## Existing mechanisms and missing work

The [hub](../src/hub.js) already has table-backed identities and retirement tombstones.
The [worker transport](../src/durable-worker-transport.js) already serializes delivery and sleep and
records replay boundaries.
The daemon's endpoint uses OCapN `restoreExport` when restoring describable host resources.
That endpoint mechanism is not a guest migration API: it trusts the embedder to supply an equivalent
value and leaves an already occupied export position unchanged.
It does not validate a replacement manifest or reconcile a live guest's session state.
The [guest peer](../src/worker-peer.js) currently exposes evaluation, not trusted export-table
inspection and installation controls.

Missing pieces include authoritative guest/session inspection, source fencing, private staging,
validated table installation or route translation, a recoverable cutover transaction, and explicit
pending-obligation policy.
No such replacement API is implemented by this design note.

## Experiments that would test the fallback

Start with two vats: a caller holds multiple references to a counter vat, with one reference also
published and another retained without a user-visible name.
Prepare new counter code and migrated state, then replace the old vat without changing the caller.
Verify existing references, new exports, publication lookup, alias identity, reference release,
sleep/wake, and daemon restart.
A restricted object-only experiment can validate the mechanism but does not establish success for
the durable-listener upgrade hypothesis.

Then add a listener registered before replacement, a pending incoming call, an outgoing call whose
reply is delayed, and a suspended async activation containing the bug being repaired.
Force crashes around checkpoint preparation and switch commit; inject stale plans, missing slots,
wrong protocol roles, duplicate mappings, late old-worker output, and duplicate transport frames.
Test any supported emergency rejection mode separately from preservation.
Finally attempt state recovery from a broken vat whose important data is held in private closures.
Record the preparation burden and cases where no viable migration can be constructed.
