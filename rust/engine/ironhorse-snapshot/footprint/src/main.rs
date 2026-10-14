//! The snapshot footprint harness of WASM-BLOCKERS.md B7 and B8: how much
//! memory a whole-heap snapshot and a per-crank checkpoint add to a running
//! machine, natively (resident set size from `/proc/self/status`) and on
//! wasm32 (`memory.size`, which never shrinks), plus how long the snapshot
//! takes.
//!
//! Usage: `ih-snapshot-footprint <mode> <case> [key=value ...]`
//!
//! Modes:
//!   snapshot          run the case, write its container into memory
//!   snapshot-file     run the case, write its container to `path=`
//!   checkpoint        begin a store session, run `crank=`, checkpoint it
//!   fixture           write the case's container bytes to `path=`
//!
//! Cases: `map` (`count=` entries), `strings` (`count=` strings of `units=`
//! UTF-16 units), `array` (`count=` items), `program` (`path=` to a script).
//!
//! Every line of output is `FOOTPRINT key=value ...`.

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, MachineSnapshot};
use ironhorse_snapshot::store::{
    CommitVerifier, HeapStore, MemoryStore, StoreError, StoreManifest,
};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{parse_symbols, Interp};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::time::Instant;

/// Bytes of memory the process holds, in the sense each target can report:
/// linear memory on wasm32 (which never shrinks, so a delta is growth beyond
/// the previous high-water mark), the resident set size natively.
fn memory_bytes() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size::<0>() as u64 * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        proc_status("VmRSS:")
    }
}

/// The process's peak resident set size natively (`VmHWM`); on wasm32 the
/// linear memory size is its own high-water mark.
fn peak_bytes() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        memory_bytes()
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        proc_status("VmHWM:")
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn proc_status(key: &str) -> u64 {
    let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
    status
        .lines()
        .find_map(|line| line.strip_prefix(key))
        .and_then(|rest| rest.trim().strip_suffix("kB"))
        .and_then(|kb| kb.trim().parse::<u64>().ok())
        .map_or(0, |kb| kb * 1024)
}

fn report(line: &[(&str, String)]) {
    let mut out = String::from("FOOTPRINT");
    for (key, value) in line {
        out.push(' ');
        out.push_str(key);
        out.push('=');
        out.push_str(value);
    }
    println!("{out}");
}

fn source_of(case: &str, options: &BTreeMap<String, String>) -> String {
    let count = options
        .get("count")
        .map(|c| c.parse::<u64>().expect("count"))
        .unwrap_or(1000);
    match case {
        "map" => {
            format!("var m = new Map(); for (var i = 0; i < {count}; i++) m.set(i, i); m.size")
        }
        "strings" => {
            let units = options
                .get("units")
                .map(|u| u.parse::<u64>().expect("units"))
                .unwrap_or(1000);
            format!(
                "var a = []; for (var i = 0; i < {count}; i++) a.push('x'.repeat({units})); a.length"
            )
        }
        "array" => format!("var a = []; for (var i = 0; i < {count}; i++) a.push(i); a.length"),
        "program" => {
            std::fs::read_to_string(options.get("program").expect("program=")).expect("program")
        }
        other => panic!("unknown case {other}"),
    }
}

fn run(machine: &mut Interp, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("fixture compiles");
    machine.link_intrinsics(&parse_symbols(&symbols));
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

fn crank(machine: &mut Interp, source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("crank compiles");
    let code = machine
        .relink_crank(&code, &parse_symbols(&symbols))
        .expect("crank relinks");
    let outcome = machine.run(&code);
    assert!(outcome.completed, "{:?}", outcome.halt);
    outcome.result
}

/// A store that samples memory when the checkpoint hands it the batch: the
/// point where every encoded row of the checkpoint is in memory at once,
/// before the store has copied anything.
struct ProbeStore {
    inner: MemoryStore,
    at_commit: Cell<u64>,
}

impl HeapStore for ProbeStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.inner.manifest()
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        self.inner.read_small_state()
    }
    fn read_slot_page(&self, page: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_slot_page(page)
    }
    fn read_chunk_extent(&self, ext: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_chunk_extent(ext)
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        self.inner.inventory()
    }
    fn read_free_seg(&self, seg: u32) -> Result<Vec<u8>, StoreError> {
        self.inner.read_free_seg(seg)
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        self.inner.page_edges()
    }
    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        self.at_commit.set(memory_bytes());
        self.inner.commit_verified(verify)
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("snapshot");
    let case = args.get(2).map(String::as_str).unwrap_or("map");
    let options: BTreeMap<String, String> = args[3.min(args.len())..]
        .iter()
        .filter_map(|arg| arg.split_once('='))
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    let signature = Signature::new("ironhorse-footprint-v1");
    let source = source_of(case, &options);
    let mut machine = Interp::new();
    if let Some(ceiling) = options.get("chunk_ceiling") {
        machine.set_chunk_ceiling(ceiling.parse().expect("chunk_ceiling"));
    }
    if let Some(ceiling) = options.get("slot_ceiling") {
        machine.set_slot_ceiling(ceiling.parse().expect("slot_ceiling"));
    }
    let run_start = Instant::now();
    let result = run(&mut machine, &source);
    let run_seconds = run_start.elapsed().as_secs_f64();
    let after_run = memory_bytes();
    let peak_after_run = peak_bytes();
    report(&[
        ("stage", "run".into()),
        ("case", case.into()),
        ("result", result),
        ("seconds", format!("{run_seconds:.3}")),
        ("memory", after_run.to_string()),
        ("peak", peak_after_run.to_string()),
    ]);
    match mode {
        "snapshot" | "fixture" => {
            let start = Instant::now();
            let bytes = machine.write_snapshot(&signature).expect("snapshot");
            let seconds = start.elapsed().as_secs_f64();
            report(&[
                ("stage", "snapshot".into()),
                ("bytes", bytes.len().to_string()),
                ("seconds", format!("{seconds:.3}")),
                ("memory", memory_bytes().to_string()),
                ("peak", peak_bytes().to_string()),
            ]);
            if mode == "fixture" {
                std::fs::write(options.get("path").expect("path="), &bytes).expect("write fixture");
            }
        }
        "snapshot-file" => {
            let path = options.get("path").expect("path=");
            let file = std::fs::File::create(path).expect("create");
            let start = Instant::now();
            let hash = machine
                .write_snapshot_to_file(&signature, file)
                .expect("snapshot to file");
            let seconds = start.elapsed().as_secs_f64();
            report(&[
                ("stage", "snapshot-file".into()),
                (
                    "bytes",
                    std::fs::metadata(path).expect("metadata").len().to_string(),
                ),
                ("sha256", hash),
                ("seconds", format!("{seconds:.3}")),
                ("memory", memory_bytes().to_string()),
                ("peak", peak_bytes().to_string()),
            ]);
        }
        "checkpoint" => {
            let mut store = ProbeStore {
                inner: MemoryStore::new(),
                at_commit: Cell::new(0),
            };
            let mut session = begin_store_session(machine, &signature, &mut store)
                .map_err(|(_, error)| error)
                .expect("begin session");
            let after_begin = memory_bytes();
            let crank_source = options
                .get("crank")
                .cloned()
                .unwrap_or_else(|| "0".to_string());
            let crank_result = crank(session.machine_mut(), &crank_source);
            let before = memory_bytes();
            let start = Instant::now();
            checkpoint_to_store(&mut session, &signature, &mut store).expect("checkpoint");
            let seconds = start.elapsed().as_secs_f64();
            let stats = store.inner.last_commit_stats();
            report(&[
                ("stage", "checkpoint".into()),
                ("crank_result", crank_result),
                ("after_begin", after_begin.to_string()),
                ("before", before.to_string()),
                ("at_commit", store.at_commit.get().to_string()),
                ("after", memory_bytes().to_string()),
                ("peak", peak_bytes().to_string()),
                ("seconds", format!("{seconds:.3}")),
                ("slot_pages_written", stats.slot_pages_written.to_string()),
                (
                    "chunk_extents_written",
                    stats.chunk_extents_written.to_string(),
                ),
            ]);
        }
        other => panic!("unknown mode {other}"),
    }
}
