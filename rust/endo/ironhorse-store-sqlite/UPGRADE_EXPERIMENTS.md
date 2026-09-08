# Upgrade experiments, in increasing complexity

These are local synthetic JavaScript heaps, not an installed Thixotrope/SES/OCapN vat.
Run `cargo test -p ironhorse-store-sqlite --example vat_surgery` from the repository root.
The recipes live in `examples/vat_surgery/upgrades.rs`.
Only integer and same-kind donor-value edits are CLI operations; the remaining recipes directly
edit typed images in tests so their assumptions remain explicit and fixture-specific.

## Observed results

| Experiment | Outcome and current difficulty | What would address the remaining work |
| --- | --- | --- |
| Captured integer repair | Easy once the cell is known; shared closures survive execution, GC, SQLite checkpoint and reopen. | Decoded environment and binding paths to locate a cell without a distinctive fixture value. |
| Boolean, Number, longer String | Same-kind donor payload copy works; Number retains negative-zero bits, String reuses a longer existing chunk without moving bytes. | A typed allocator for genuinely new variable-sized values; exact JS value encodings rather than SQL REAL coercion. |
| Reference retargeting | One edge can point to an existing donor object; other aliases still designate the old object after GC/reopen. | Field-level incoming-reference and capability-impact queries; an explicit choice between edge replacement and object-wide replacement. |
| Property rename | Changing a property ID to an already-interned key preserves object identity and aliases. | Owner/property views, collision checks and name interning for general structural edits. |
| Array growth and Map value repair | Sparse array growth and an existing Map value change work without changing any heap-slot record; values are in side-state sections. | Decoded collection rows and mutation-specific validators; heap-slot SQL alone misses these values. |
| Named function body | A donor compiled and linked in the same realm can replace the body while retaining function owner, aliases, bound-wrapper target, and Map-key identity. | Reusable same-realm linking and compatibility checks; compact/remap code-segment IDs when the last old segment user disappears. |
| Truly anonymous function body | An unnamed function created inside an array retains its empty name and identity; array holder, alias, and bound wrapper call the new code after GC/reopen. | Function owner IDs and reference paths, not function names, as selection keys. |
| Prototype method body | Existing instances and saved/bound methods call the new implementation. Preserving the original home object makes donor `super` calls resolve through the original prototype chain. | Explicit method/home-object and constructor contracts; copying all donor metadata would change behavior. |
| Already registered promise callback | The pending reaction calls the replaced function and returns the new result after GC/checkpoint/reopen; a later checkpoint also preserves the result. A second GC is limited by the baseline defect below. | Reaction-role inspection to report affected pending work; fix the independent restore/GC defect before relying on repeated cycles. |
| Closure environment rebind | One metadata pointer switches an existing function and all its aliases to another fixture's captured state. | Capture-layout descriptions and binding maps; pointer validity does not prove the intended variable correspondence. |
| Body replacement with reordered captures | Candidate validates and survives GC/reopen, but returns **102**, whereas a name-aware mapping of replacement `b * 100 + a` over old `a=1,b=2` would return **201**. | Checked capture layouts and explicit old-to-new binding maps. Equal capture counts are insufficient. |
| Suspended generator | An unchanged old absolute resume PC is refused after moving to another body. A fixture-specific mapping to the donor yield successor is accepted; the old local `10` under new `+100` code returns **110**, not the donor's **1000**. | Pinned code versions plus symbolic suspension points, frame-layout descriptions and explicit continuation migration. |
| Suspended async function | The test-only future-call guard detects its saved activation and refuses body replacement, as it does for generators. | A policy covering both activation families; promises/reactions and saved jumps must participate in compatibility analysis. |

Successful state and function recipes check actual JavaScript behavior before and after explicit
GC, SQLite checkpoint, full close and reopen.
The continuation test checkpoints while suspended and then tests completion.
Negative and semantically surprising results are observations, not permissions to bypass validation.

## Independent restore/GC regression found by the probes

`unedited_reaction_heap_repeated_gc_regression` records a known failure and is ignored in the
default run rather than asserting that a panic is correct behavior.
Run it explicitly with:

```sh
cargo test -p ironhorse-store-sqlite --example vat_surgery unedited_reaction_heap_repeated_gc_regression -- --ignored
```

The unedited pending-promise fixture survives the first GC, checkpoint and reopen, then a second
GC panics in `ChunkArena::compact` with `chunk payload out of range (corrupt heap)`.
An independent probe reproduced the same pattern with container-only snapshot/restore, so SQLite,
replacement code, and promise settlement are not prerequisites.
The likely cause is stale boot-function name-chunk offsets after restoring a compacted chunk arena;
that diagnosis still needs offset-level confirmation.
The default reaction-upgrade test exercises the first GC and both checkpoints, omitting only the
known-broken second GC.
This finding limits the lifecycle evidence and needs a VM fix, not a relational schema change.

## Function identity is already separable from body selection

`FunctionRow.owner` supplies a useful identity-preserving editing point today.
The body recipe changes only `segment`, `body_start`, and `body_len`.
It retains the old closure environment, name, arity, home object, constructor metadata and links.
That is why old aliases, bound functions, and prototype lookup reach the replacement.
The fixtures use compatible call shapes; this does not establish arbitrary argument, constructor,
class-private, or closure compatibility.

The donor in the named-function test is compiled in a later crank and linked into the same realm.
This avoids guessing how foreign bytecode name IDs should map into the old image.
After replacement, an unreferenced old segment causes the existing dense-segment validator to
refuse the image; compacting the segment vector and remapping function segment IDs resolves it.
No bytecode in-place patching or fixed-length requirement is needed for these future calls.

`saved_frames` reveals a different contract: frames identify a current function and an absolute PC.
They do not independently select an immutable code version.
Changing a function's body therefore also changes the code against which its saved frames validate.
The test-only guard scans generator and async activations before applying a future-call recipe.
It is a limited refusal check, not a general compatibility checker.

## What to change in the schema, and what SQL cannot fix

The existing encoding is sufficient for the successful experiments.
The first useful addition is a decoded query model: object properties, environment bindings,
function owners, code versions, complete reference roles, and continuation frames.
These can remain disposable views/workspace tables over the canonical image, avoiding a second
authoritative heap representation.

For reliable implementation upgrades, add semantic metadata before treating arbitrary code edits
as supported: capture-layout identities, compilation/name-linking context, call/constructor shape,
and continuation-layout/version identities.
Give saved frames their own pinned code version if old work should finish under old code while
future invocations use a new implementation.
Allowing two code versions to coexist is representational work; deciding which old state maps to
which new binding is an application policy that relational normalization does not determine.

Selective physical normalization of function/code and continuation rows could make inspection,
validation, and edits more direct and reduce whole-section rewrites.
Today these rows travel inside `small_state`; a full typed decode/re-encode makes the experiments
possible but is not an incremental editing algorithm.
Any authoritative row split needs versioned migration and integrity coverage.
We have not benchmarked it and do not yet have evidence to justify normalizing the entire heap.

Finally, this work prepares candidate images only.
Application invariants, SES restrictions, host export identities, journal position, hub obligations,
and publication are separate checks that neither eager restore nor a SQLite transaction proves.
