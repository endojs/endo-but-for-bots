# Offline vat surgery experiment

This example explores SQL-assisted inspection and a deliberately narrow heap repair.
It decodes a canonical Ironhorse snapshot into a disposable SQLite workspace, accepts
integer-slot edits, and writes a new candidate snapshot after graph validation and eager restore.
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

- `snapshot` binds workspace version 1 to the SHA-256 of the exact source container bytes.
  An empty plan preserves those bytes exactly; noncanonical source encodings are refused.
- `heap_slots` is inspection data, including free slots.
  Editing it has no effect on the candidate; only `integer_edits` requests mutations.
  `is_free = 0` means allocated, not necessarily reachable or application-owned.
  Slot identifiers are meaningful only within the specified source snapshot.
- Each edit requires the entire expected 20-byte canonical record, an allocated slot, and both
  the Integer kind and Integer payload.
  Replacement values are signed 32-bit integers because this profile edits the VM's `i32`
  Integer arm; JavaScript Number, BigInt, references, and code are not supported edits.
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
