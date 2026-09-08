# Offline vat surgery experiment

This example explores SQL-assisted inspection and a deliberately narrow heap repair.
It decodes a canonical Ironhorse snapshot into a disposable SQLite workspace, accepts
integer-slot and same-kind donor-value edits, and writes a new candidate snapshot after graph
validation and eager restore.
It does not edit a resident heap database or install the candidate into a Thixotrope host.

The source container is backend-neutral: existing store tooling can obtain one through
`export_to_container` from a stopped, coherent `HeapStore`.
This CLI takes that exported artifact, not the worker's SQLite database.
The caller supplies the expected host signature/profile; the engine adds its boot-layout version.
An incompatible source is refused rather than migrated.

## Try it

Run from the repository root, using new output paths:

```sh
cargo run -p ironhorse-store-sqlite --example vat_surgery -- demo /tmp/surgery-source.container
cargo run -p ironhorse-store-sqlite --example vat_surgery -- inspect /tmp/surgery-source.container /tmp/surgery-workspace.sqlite ironhorse-worker-v1
sqlite3 /tmp/surgery-workspace.sqlite
```

The demo has two closures, `read` and `add`, sharing an integer captured in a private environment.
The distinctive value is a fixture locator, not a general method for finding source bindings.
In SQLite:

```sql
SELECT slot, kind, integer_value, hex(record)
FROM heap_slots WHERE is_free = 0 AND integer_value = 40414243;

INSERT INTO integer_edits (slot, expected_record, replacement)
SELECT slot, record, 40414250 FROM heap_slots
WHERE is_free = 0 AND integer_value = 40414243;

SELECT slot, hex(expected_record), replacement FROM integer_edits;
.quit
```

Prepare a new candidate:

```sh
cargo run -p ironhorse-store-sqlite --example vat_surgery -- apply /tmp/surgery-source.container /tmp/surgery-workspace.sqlite /tmp/surgery-candidate.container ironhorse-worker-v1
cargo test -p ironhorse-store-sqlite --example vat_surgery
```

The tests invoke both closures, mutate through one, collect garbage, checkpoint into SQLite,
close and reopen it, and verify the closures still share the repaired value.
They also compare the complete decoded images: only the selected scalar payload changes.

## Contract and limits

- `snapshot` binds workspace version 2 to the SHA-256 of the exact source container bytes.
  An empty plan preserves those bytes exactly; noncanonical source encodings are refused.
  Recreate older workspaces with `inspect`; the writer refuses their version.
- `heap_slots` is inspection data, including free slots.
  Editing it has no effect on the candidate; only `integer_edits` and `donor_edits` request mutations.
  `is_free = 0` means allocated, not necessarily reachable or application-owned.
  Slot identifiers are meaningful only within the specified source snapshot.
- Each `integer_edits` row requires the entire expected 20-byte canonical record, an allocated
  slot, and both the Integer kind and Integer payload.
  `integer_edits` replacement values are signed 32-bit integers because that profile edits the
  VM's `i32` Integer arm.
- `donor_edits` copies a payload from another allocated source slot of the same supported kind:
  Boolean, Integer, Number, String, or Reference.
  Both source records must match, all donors are read from the original image, and each target
  may occur only once across both edit tables.
  This supports swaps, exact floating-point bit preservation, and existing chunk/object reuse.
  It preserves target descriptors and list links; internal Instance/Closure pointers are refused.
  It neither allocates new strings/objects nor changes every alias when retargeting one reference.
- `slot_values`, `names`, `functions`, and `saved_frames` provide additional decoded inspection.
  Floating-point values are eight-byte big-endian bit BLOBs rather than SQLite REAL values.
  References/chunks use source-local indices, including the VM's `4294967295` null sentinel.
  `names` maps string-key IDs; symbol keys and non-key uses of slot IDs require separate decoding.
  `saved_frames` lists generator/async frame ownership and resume addresses, not a complete
  continuation or incoming-reference graph.
  None of these inspection tables is an editable source of truth.
- The writer validates SQLite values independently of editable SQL constraints, pins plan reads
  to one read transaction, and validates the complete candidate before creating its output.
  Existing outputs are refused, including empty files.
  An I/O failure can leave a partial new artifact; no output is automatically installed.
- SHA-256 and expected records detect stale inputs; they do not authenticate a patch author.
  This is privileged offline owner tooling and can bypass guest immutability restrictions.
  It does not identify protected runtime slots or prove application invariants.
  Do not interpret successful eager restore as permission to install a candidate.
- A canonical container has no resident-store epoch/seal or host journal cutover record.
  Importing a candidate into a fresh store establishes fresh store history.
  Replacing a managed vat still needs host authority, protocol-obligation checks, and coordinated
  journal/hub publication; those operations are outside this experiment.

## What the first experiment establishes

Captured scalar repair is possible using existing engine codecs and validators, without changing
the authoritative heap schema or teaching SQL the binary encoding.
Shared closure identity survives the tested repair and persistence lifecycle.
The SQL workspace is optional tooling and adds no work to ordinary runtime checkpoints.

Finding the right cell remains manual.
The workspace exposes slot metadata and canonical records, not named environments, properties,
or complete incoming-reference relations.
Next experiments should expose closure/environment links and side-state edges, then assess
function replacement for future calls separately from migration of saved continuations.
The first profile deliberately leaves those semantic problems unresolved.
See [the upgrade experiment matrix](UPGRADE_EXPERIMENTS.md) for the broader test-only recipes,
including anonymous, named, and prototype function replacement.

## Plan a donor edit

For a source with two uniquely named string-key slots, inspect their records and insert a plan:

```sql
SELECT h.slot, n.name, h.kind, hex(h.record)
FROM heap_slots h JOIN names n ON n.property_id = h.property_id
WHERE h.is_free = 0 AND n.name IN ('surgeryRef', 'donorRef');

INSERT INTO donor_edits
SELECT target.slot, target.record, donor.slot, donor.record
FROM heap_slots target JOIN names tn ON tn.property_id = target.property_id
CROSS JOIN heap_slots donor JOIN names dn ON dn.property_id = donor.property_id
WHERE target.is_free = 0 AND donor.is_free = 0
AND tn.name = 'surgeryRef' AND dn.name = 'donorRef';
```

Names are not globally unique across arbitrary heaps: review the actual selected slots.
The tests use controlled fixtures with unique keys and assert that the locator has one result.
Use `functions.owner` to join callable objects to their code metadata, and `saved_frames.function`
to find the generator/async activations that currently reference those functions.
