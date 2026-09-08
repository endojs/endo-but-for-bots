//! Offline experiment: SQL inspection and guarded heap-value repairs.
//! See ../VAT_SURGERY.md. This does not install a vat or edit a live store.

use std::collections::BTreeSet;
use std::error::Error;
use std::fs::{self, OpenOptions};
use std::io::{Error as IoError, ErrorKind, Write};
use std::path::Path;

use ironhorse_snapshot::sha256::hex_sha256;
use ironhorse_snapshot::{
    encode_slot, from_snapshot_bytes, read_validated_machine, write_machine, MachineImage,
    Signature,
};
use ironhorse_vm::{Kind, Payload};
use rusqlite::{params, Connection, OpenFlags};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn refuse(message: impl Into<String>) -> Box<dyn Error> {
    IoError::new(ErrorKind::InvalidData, message.into()).into()
}

fn record(slot: &ironhorse_vm::Slot) -> Vec<u8> {
    let mut bytes = Vec::new();
    encode_slot(slot, &mut bytes);
    bytes
}

fn validated_source(bytes: &[u8], signature: &Signature) -> Result<MachineImage> {
    // Both graph validation and eager adoption: the latter also validates
    // side-state restoration. Never reuse this proof after mutation.
    let image = read_validated_machine(bytes, signature)
        .map_err(|e| refuse(format!("snapshot validation: {e:?}")))?
        .into_image();
    from_snapshot_bytes(bytes, signature).map_err(|e| refuse(format!("eager restore: {e:?}")))?;
    // Restrict the experiment to the current canonical encoding, so an
    // empty patch cannot accidentally perform a format migration.
    if write_machine(&image) != bytes {
        return Err(refuse("source is not a current canonical snapshot"));
    }
    Ok(image)
}

fn inspect(bytes: &[u8], signature: &Signature) -> Result<Connection> {
    let image = validated_source(bytes, signature)?;
    let free: BTreeSet<u32> = image.slot_free.iter().copied().collect();
    let mut db = Connection::open_in_memory()?;
    let tx = db.transaction()?;
    tx.execute_batch(
        "CREATE TABLE snapshot (
           singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
           workspace_version INTEGER NOT NULL CHECK(workspace_version = 2),
           source_sha256 TEXT NOT NULL
         ) STRICT;
         CREATE TABLE heap_slots (
           slot INTEGER PRIMARY KEY,
           is_free INTEGER NOT NULL,
           kind TEXT NOT NULL,
           flags INTEGER NOT NULL,
           property_id INTEGER NOT NULL,
           next_slot INTEGER NOT NULL,
           integer_value INTEGER,
           record BLOB NOT NULL
         ) STRICT;
         CREATE TABLE integer_edits (
           slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 4294967295),
           expected_record BLOB NOT NULL CHECK(length(expected_record) = 20),
           replacement INTEGER NOT NULL CHECK(replacement BETWEEN -2147483648 AND 2147483647)
         ) STRICT;
         CREATE TABLE donor_edits (
           slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 0 AND 4294967295),
           expected_record BLOB NOT NULL CHECK(length(expected_record) = 20),
           donor INTEGER NOT NULL CHECK(donor BETWEEN 0 AND 4294967295),
           expected_donor_record BLOB NOT NULL CHECK(length(expected_donor_record) = 20)
         ) STRICT;
         CREATE TABLE slot_values (
           slot INTEGER PRIMARY KEY, boolean_value INTEGER, number_bits BLOB,
           reference_slot INTEGER, chunk_offset INTEGER
         ) STRICT;
         CREATE TABLE names (property_id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
         CREATE TABLE functions (
           owner INTEGER PRIMARY KEY, name TEXT NOT NULL, segment INTEGER,
           body_start INTEGER, body_len INTEGER NOT NULL, closures INTEGER NOT NULL,
           arity INTEGER NOT NULL, is_generator INTEGER NOT NULL
         ) STRICT;
         CREATE TABLE saved_frames (
           family TEXT NOT NULL, owner INTEGER NOT NULL, function INTEGER NOT NULL,
           resume_pc INTEGER NOT NULL, locals_count INTEGER NOT NULL,
           PRIMARY KEY(family, owner)
         ) STRICT;",
    )?;
    tx.execute(
        "INSERT INTO snapshot VALUES (1, 2, ?1)",
        [hex_sha256(bytes)],
    )?;
    {
        let mut insert =
            tx.prepare("INSERT INTO heap_slots VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")?;
        for (index, slot) in image.slots.iter().enumerate() {
            let index = u32::try_from(index)?;
            let integer = match slot.value {
                Payload::Integer(value) if slot.kind == Kind::Integer => Some(value),
                _ => None,
            };
            insert.execute(params![
                index,
                free.contains(&index),
                format!("{:?}", slot.kind),
                slot.flag,
                slot.id,
                slot.next.0,
                integer,
                record(slot)
            ])?;
            let (mut boolean, mut number, mut reference, mut chunk) = (None, None, None, None);
            match slot.value {
                Payload::Boolean(v) => boolean = Some(v),
                Payload::Number(v) => number = Some(v.to_bits().to_be_bytes().to_vec()),
                Payload::Reference(v) => reference = Some(v.0),
                Payload::String(v) | Payload::BigInt(v) => chunk = Some(v.0),
                _ => {}
            }
            tx.execute(
                "INSERT INTO slot_values VALUES (?1, ?2, ?3, ?4, ?5)",
                params![index, boolean, number, reference, chunk],
            )?;
        }
    }
    for (index, name) in image.names.iter().enumerate() {
        tx.execute(
            "INSERT INTO names VALUES (?1, ?2)",
            params![u32::try_from(index + 1)?, name],
        )?;
    }
    for f in &image.function_state.functions {
        tx.execute(
            "INSERT INTO functions VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                f.owner,
                f.name,
                f.segment,
                f.body_start,
                f.body_len,
                f.closures,
                f.arity,
                f.is_generator
            ],
        )?;
    }
    for g in &image.generators {
        if let Some(frame) = &g.frame {
            tx.execute(
                "INSERT INTO saved_frames VALUES ('generator', ?1, ?2, ?3, ?4)",
                params![
                    g.owner,
                    frame.cur_func,
                    frame.resume_pc,
                    u32::try_from(frame.locals.len())?
                ],
            )?;
        }
    }
    for a in &image.promise_cluster.async_instances {
        tx.execute(
            "INSERT INTO saved_frames VALUES ('async', ?1, ?2, ?3, ?4)",
            params![
                a.owner,
                a.frame.cur_func,
                a.frame.resume_pc,
                u32::try_from(a.frame.locals.len())?
            ],
        )?;
    }
    tx.commit()?;
    Ok(db)
}

fn apply(bytes: &[u8], signature: &Signature, db: &Connection) -> Result<Vec<u8>> {
    // Pin all plan reads to one SQLite read transaction. Workspace rows are
    // untrusted input: validate again even if its original CHECKs were removed.
    let tx = db.unchecked_transaction()?;
    let mut metadata =
        tx.prepare("SELECT singleton, workspace_version, source_sha256 FROM snapshot")?;
    let mut rows = metadata.query([])?;
    let row = rows
        .next()?
        .ok_or_else(|| refuse("missing snapshot identity"))?;
    let singleton: i64 = row.get(0)?;
    let version: i64 = row.get(1)?;
    let digest: String = row.get(2)?;
    if singleton != 1 || version != 2 || digest != hex_sha256(bytes) || rows.next()?.is_some() {
        return Err(refuse("workspace version or source digest mismatch"));
    }
    let mut image = validated_source(bytes, signature)?;
    // Donors always refer to the source, never to an earlier edit's result.
    let original_slots = image.slots.clone();
    let free: BTreeSet<u32> = image.slot_free.iter().copied().collect();
    let mut seen = BTreeSet::new();
    let mut edits =
        tx.prepare("SELECT slot, expected_record, replacement FROM integer_edits ORDER BY slot")?;
    let mut rows = edits.query([])?;
    while let Some(row) = rows.next()? {
        let index: u32 = row.get(0)?;
        let expected: Vec<u8> = row.get(1)?;
        // This is deliberately the VM's i32 Integer arm, not JS Number or BigInt.
        let replacement: i32 = row.get(2)?;
        if !seen.insert(index) || free.contains(&index) {
            return Err(refuse(format!("duplicate or free slot {index}")));
        }
        let slot = image
            .slots
            .get_mut(index as usize)
            .ok_or_else(|| refuse(format!("slot {index} out of range")))?;
        if record(slot) != expected {
            return Err(refuse(format!("slot {index} expected record mismatch")));
        }
        if slot.kind != Kind::Integer || !matches!(slot.value, Payload::Integer(_)) {
            return Err(refuse(format!("slot {index} is not an Integer")));
        }
        // Preserve kind, descriptors, identity and all graph links.
        slot.value = Payload::Integer(replacement);
    }
    let mut edits = tx.prepare(
        "SELECT slot, expected_record, donor, expected_donor_record FROM donor_edits ORDER BY slot",
    )?;
    let mut rows = edits.query([])?;
    while let Some(row) = rows.next()? {
        let index: u32 = row.get(0)?;
        let expected: Vec<u8> = row.get(1)?;
        let donor: u32 = row.get(2)?;
        let expected_donor: Vec<u8> = row.get(3)?;
        if !seen.insert(index) || free.contains(&index) || free.contains(&donor) {
            return Err(refuse("duplicate target or free donor/target slot"));
        }
        let target = original_slots
            .get(index as usize)
            .ok_or_else(|| refuse("target out of range"))?;
        let donor = original_slots
            .get(donor as usize)
            .ok_or_else(|| refuse("donor out of range"))?;
        if record(target) != expected || record(donor) != expected_donor {
            return Err(refuse("donor edit expected record mismatch"));
        }
        let ordinary_value = |slot: &ironhorse_vm::Slot| {
            matches!(
                (slot.kind, slot.value),
                (Kind::Boolean, Payload::Boolean(_))
                    | (Kind::Integer, Payload::Integer(_))
                    | (Kind::Number, Payload::Number(_))
                    | (Kind::String, Payload::String(_))
                    | (Kind::Reference, Payload::Reference(_))
            )
        };
        if target.kind != donor.kind || !ordinary_value(target) || !ordinary_value(donor) {
            return Err(refuse("donor edit requires matching supported value kinds"));
        }
        image.slots[index as usize].value = donor.value;
    }
    let candidate = write_machine(&image);
    validated_source(&candidate, signature)?;
    Ok(candidate)
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
    // A failed write can leave a partial *new* candidate; it is never installed.
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn demo_source() -> Result<Vec<u8>> {
    use ironhorse_snapshot::MachineSnapshot;
    use ironhorse_vm::{parse_symbols, Interp};

    let (code, names) = ironhorse_compile::compile_atoms(
        "var read, add; (function () { let value = 40414243; read = function () { return value; }; add = function () { value = value + 1; return value; }; })(); read()",
    ).map_err(|e| refuse(format!("compile demo: {e:?}")))?;
    let mut machine = Interp::new();
    machine.link_intrinsics(&parse_symbols(&names));
    let outcome = machine.run(&code);
    if !outcome.completed || outcome.result != "40414243" {
        return Err(refuse(format!(
            "demo did not return expected value: {outcome:?}"
        )));
    }
    machine
        .write_snapshot(&Signature::new("ironhorse-worker-v1"))
        .map_err(|e| refuse(format!("snapshot demo: {e:?}")))
}

fn run(args: &[String]) -> Result<()> {
    match args {
        [command, output] if command == "demo" => {
            write_new(Path::new(output), &demo_source()?)?;
        }
        [command, source, workspace, host_signature] if command == "inspect" => {
            let bytes = fs::read(source)?;
            let db = inspect(&bytes, &Signature::new(host_signature))?;
            // Reserve a new path before VACUUM INTO (which otherwise accepts
            // existing empty files). Existing inputs/outputs are never replaced.
            let reservation = OpenOptions::new().write(true).create_new(true).open(workspace)?;
            db.execute("VACUUM INTO ?1", [workspace])?;
            reservation.sync_all()?;
            eprintln!("workspace created; source SHA-256 {}", hex_sha256(&bytes));
        }
        [command, source, workspace, output, host_signature] if command == "apply" => {
            let bytes = fs::read(source)?;
            let db = Connection::open_with_flags(workspace, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let candidate = apply(&bytes, &Signature::new(host_signature), &db)?;
            write_new(Path::new(output), &candidate)?;
            eprintln!("candidate SHA-256 {}; not installed", hex_sha256(&candidate));
        }
        _ => return Err(refuse(
            "usage: vat_surgery demo NEW.container\n       vat_surgery inspect SOURCE.container WORKSPACE.sqlite HOST_SIGNATURE\n       vat_surgery apply SOURCE.container WORKSPACE.sqlite NEW.container HOST_SIGNATURE",
        )),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run(&std::env::args().skip(1).collect::<Vec<_>>()) {
        eprintln!("vat surgery: {error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
#[path = "vat_surgery/tests.rs"]
mod tests;

#[cfg(test)]
#[path = "vat_surgery/upgrades.rs"]
mod upgrades;
