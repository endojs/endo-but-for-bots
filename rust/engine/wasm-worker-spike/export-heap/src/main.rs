//! `ih-export-heap <heap.sqlite> <out.container>`: open a Thixotrope worker's
//! SQLite heap store and write its canonical container bytes, the form
//! `import_from_container` seeds another store from. Prints the manifest's
//! geometry and the host half of its signature (the runtime profile string the
//! importer must present) as one JSON line.

use ironhorse_snapshot::store::{export_to_container, HeapStore};
use ironhorse_store_sqlite::SqliteHeapStore;

/// A store that cannot be exported (an older schema the current store does
/// not migrate, a missing epoch) is reported, not panicked on.
fn fail(message: &str) -> ! {
    eprintln!("ih-export-heap: {message}");
    std::process::exit(1)
}

fn main() {
    let mut args = std::env::args().skip(1);
    let (Some(path), Some(out)) = (args.next(), args.next()) else {
        eprintln!("usage: ih-export-heap <heap.sqlite> <out.container>");
        std::process::exit(2);
    };
    let store =
        SqliteHeapStore::open(&path).unwrap_or_else(|error| fail(&format!("open: {error:?}")));
    let manifest = store
        .manifest()
        .unwrap_or_else(|error| fail(&format!("manifest: {error:?}")));
    let bytes =
        export_to_container(&store).unwrap_or_else(|error| fail(&format!("export: {error:?}")));
    std::fs::write(&out, &bytes).unwrap_or_else(|error| fail(&format!("write {out}: {error}")));
    // The signature encodes as `IHB1` + 32 boot bytes + the host string
    // (`Signature` has no accessor for the host half).
    let encoded = manifest.signature.encode();
    let host = if encoded.starts_with(b"IHB1") && encoded.len() >= 36 {
        String::from_utf8_lossy(&encoded[36..]).into_owned()
    } else {
        String::from_utf8_lossy(&encoded).into_owned()
    };
    // The host string is the runtime profile's ASCII; JSON's escapes for it.
    let host: String = host
        .chars()
        .map(|c| match c {
            '\\' => "\\\\".to_string(),
            '"' => "\\\"".to_string(),
            c if (c as u32) < 0x20 => format!("\\u{:04x}", c as u32),
            c => c.to_string(),
        })
        .collect();
    println!(
        "{{\"container_bytes\":{},\"epoch\":{},\"cranks\":{},\"slot_count\":{},\"slot_live\":{},\"chunk_len\":{},\"free_len\":{},\"profile\":\"{}\"}}",
        bytes.len(),
        manifest.epoch,
        manifest.cranks,
        manifest.slot_count,
        manifest.slot_live,
        manifest.chunk_len,
        manifest.free_len,
        host
    );
    store.close().expect("the store closes");
}
