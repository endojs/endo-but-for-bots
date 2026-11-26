//! The engine's store acceptance suite (`ironhorse_snapshot::store_suite`)
//! against the product `DoStore` over the Durable Object's SQLite: every
//! fresh store is a new store id in the object's one database, opened and
//! emptied, as the native rusqlite suite does with several stores in one
//! file.

use std::cell::Cell;

use ironhorse_snapshot::store_sections::{section_hash, SmallSection};
use ironhorse_snapshot::store_suite;
use ironhorse_store_do::{SqlExecutor, Value, SECTION_CHUNK_BYTES};

use crate::host::HostSql;
use crate::session::{open_clean, open_store, Store};

thread_local! {
    // Above any id the other commands use, so a suite run never empties a
    // store a measurement seeded.
    static NEXT_FRESH: Cell<u32> = const { Cell::new(1_000) };
}

fn fresh() -> Store {
    let id = NEXT_FRESH.with(|next| {
        let id = next.get();
        next.set(id + 1);
        id
    });
    open_clean(id).expect("a fresh store opens")
}

fn exec(sql: &str, params: &[Value]) {
    HostSql.exec(sql, params).expect("the edit applies");
}

fn blob(bytes: &[u8]) -> Value {
    Value::Blob(bytes.to_vec())
}

/// Rewrite one row of store `id` at rest, in the layout `DoStore` keeps:
/// what the suite's consistent-edit part asks of a backend.
fn edit_row(id: u32, kind: &str, index: u32, new: &[u8]) {
    let update = |table: &str, column: &str| {
        exec(
            &format!("UPDATE {table} SET bytes = ?1 WHERE store = ?2 AND {column} = ?3"),
            &[blob(new), id.into(), index.into()],
        )
    };
    match kind {
        "slot page" => update("ih_slot_pages", "page"),
        "chunk extent" => update("ih_chunk_exts", "ext"),
        "free segment" => update("ih_free_segs", "seg"),
        "small section" => {
            // Full chunks, then one shorter final chunk, with the payload's
            // digest on chunk 0.
            exec(
                "DELETE FROM ih_sections WHERE store = ?1 AND id = ?2",
                &[id.into(), index.into()],
            );
            let hash = section_hash(SmallSection::ALL[index as usize], new);
            for n in 0..=new.len() / SECTION_CHUNK_BYTES {
                let start = n * SECTION_CHUNK_BYTES;
                let chunk = &new[start..new.len().min(start + SECTION_CHUNK_BYTES)];
                let digest: &[u8] = if n == 0 { &hash } else { &[] };
                exec(
                    "INSERT INTO ih_sections (store, id, chunk, bytes, hash) VALUES (?1, ?2, ?3, ?4, ?5)",
                    &[id.into(), index.into(), (n as u32).into(), blob(chunk), blob(digest)],
                );
            }
        }
        "manifest" => exec(
            "UPDATE ih_meta SET value = ?1 WHERE store = ?2 AND key = 'manifest'",
            &[blob(new), id.into()],
        ),
        other => panic!("no {other} rows in DoStore"),
    }
}

/// Run one part of the suite; a failed assertion unwinds to the caller.
pub fn run(name: &str) -> Result<(), String> {
    match name {
        "sparse" => store_suite::sparse_section_acceptance(fresh),
        "metamorphic" => store_suite::metamorphic_suite(fresh),
        "boundary" => store_suite::boundary_collection_twins(fresh),
        "lazy" => store_suite::lazy_working_set_bound(fresh),
        "checkpoint" => store_suite::checkpoint_acceptance(&mut fresh()),
        "resume" => store_suite::resume_equals_uninterrupted(&mut fresh()),
        // Reopen: the handle consumed, then a new one on the same id,
        // through the stamp check.
        "commit" => {
            store_suite::commit_contract(fresh(), |store| {
                open_store(store.id()).expect("the store reopens")
            });
        }
        // Each row edited at rest between the old handle and a new one.
        "edits" => {
            store_suite::consistent_edits_resume(fresh(), |store, kind, index, _old, new| {
                let id = store.id();
                edit_row(id, kind, index, new);
                open_store(id).expect("the store reopens")
            });
        }
        other => return Err(format!("unknown suite part: {other}")),
    }
    Ok(())
}
