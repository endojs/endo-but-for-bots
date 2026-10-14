//! The memory probe: runs one program from standard input and reports how
//! much memory the engine reached doing it, against the slot and chunk
//! ceilings. Built natively and for `wasm32-wasip1` by `../memory.py`, which
//! runs it under Wasmtime for `rust/engine/WASM-MEMORY.md`.
//!
//! ```text
//! ih-memory-probe run [options] < program.js
//! ih-memory-probe snapshot [options] < program.js   # run, then write a whole-heap snapshot
//! ih-memory-probe checkpoint [options] < program.js # one crank, then checkpoint_to_store
//! ih-memory-probe restore <snapshot file>           # resume a snapshot, then run `1 + 1`
//!
//! options: --slot-ceiling <n> --chunk-ceiling <bytes> --save <snapshot file>
//! ```
//!
//! Each command prints one line of `key=value` fields. `linear` is the host's
//! view: wasm linear memory in bytes (`memory.size` times 64 KiB), which never
//! shrinks, so it is the peak so far; natively it is the process's peak
//! resident set (`VmHWM`). `heap_peak` is the engine's view: the most bytes the
//! global allocator had live at once, counted by this binary's allocator. Both
//! are read after each phase (`run_`, `snapshot_`, `checkpoint_`), and the
//! allocator peak is reset at the start of each phase, so `snapshot_heap_peak`
//! is the peak while the snapshot was written.
//!
//! The checkpoint phase mirrors the Thixotrope worker: `begin_store_session` on
//! a fresh machine, the program as the first crank (linking its intrinsics),
//! then `checkpoint_to_store`. Its store keeps the manifest and the section
//! hashes and discards every row, as a host-side store (Durable Object SQLite)
//! takes rows out of linear memory; an in-memory store's own copy would count.

use std::alloc::{GlobalAlloc, Layout, System};
use std::io::Read;
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

use ironhorse_snapshot::machine::{begin_store_session, checkpoint_to_store, MachineSnapshot};
use ironhorse_snapshot::store::{CommitVerifier, HeapStore, StoreError, StoreManifest};
use ironhorse_snapshot::store_sections::{updated_leaves, SectionLeaves, SMALL_SECTION_COUNT};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{Interp, RunOutcome};

/// Forwards to [`System`], counting live bytes and their peak.
struct CountingAllocator;

static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn grew(bytes: usize) {
    let live = LIVE.fetch_add(bytes, Relaxed) + bytes;
    PEAK.fetch_max(live, Relaxed);
}

// SAFETY: every method forwards its arguments to `System` unchanged, so each
// upholds the `GlobalAlloc` contract exactly as `System` does. Counting only
// touches atomics, which never allocate or unwind.
unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = System.alloc_zeroed(layout);
        if !p.is_null() {
            grew(layout.size());
        }
        p
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = System.realloc(ptr, layout, new_size);
        if !p.is_null() {
            // The old block is live until the copy completes.
            grew(new_size);
            LIVE.fetch_sub(layout.size(), Relaxed);
        }
        p
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.fetch_sub(layout.size(), Relaxed);
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

/// The host's view of memory: wasm linear memory, or the native peak RSS.
fn linear() -> u64 {
    #[cfg(target_arch = "wasm32")]
    {
        core::arch::wasm32::memory_size::<0>() as u64 * 65536
    }
    #[cfg(not(target_arch = "wasm32"))]
    {
        let status = std::fs::read_to_string("/proc/self/status").unwrap_or_default();
        status
            .lines()
            .find_map(|line| line.strip_prefix("VmHWM:"))
            .and_then(|kb| kb.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            .map_or(0, |kb| kb * 1024)
    }
}

/// Start a phase: the allocator peak restarts from what is live now.
fn phase() {
    PEAK.store(LIVE.load(Relaxed), Relaxed);
}

/// The fields every phase reports, under `prefix`.
fn readings(prefix: &str, out: &mut Vec<String>) {
    out.push(format!("{prefix}linear={}", linear()));
    out.push(format!("{prefix}heap_peak={}", PEAK.load(Relaxed)));
    out.push(format!("{prefix}heap_live={}", LIVE.load(Relaxed)));
}

/// A [`HeapStore`] that keeps only what checkpoint succession reads (the
/// manifest and the small-section hashes) and counts the bytes of every row
/// it is handed, then drops them.
#[derive(Default)]
struct DiscardStore {
    manifest: Option<StoreManifest>,
    leaves: Option<SectionLeaves>,
    rows_bytes: usize,
}

fn discarded() -> StoreError {
    StoreError::Io("the memory probe's store discards rows".into())
}

impl HeapStore for DiscardStore {
    fn manifest(&self) -> Result<StoreManifest, StoreError> {
        self.manifest.clone().ok_or(StoreError::Empty)
    }
    fn read_small_state(&self) -> Result<Vec<u8>, StoreError> {
        Err(discarded())
    }
    fn small_section_hashes(&self) -> Result<[[u8; 32]; SMALL_SECTION_COUNT], StoreError> {
        Ok(*self.leaves.as_ref().ok_or(StoreError::Empty)?.hashes())
    }
    fn read_slot_page(&self, _page: u32) -> Result<Vec<u8>, StoreError> {
        Err(discarded())
    }
    fn read_chunk_extent(&self, _ext: u32) -> Result<Vec<u8>, StoreError> {
        Err(discarded())
    }
    fn inventory(&self) -> Result<(Vec<usize>, Vec<usize>), StoreError> {
        Err(discarded())
    }
    fn read_free_seg(&self, _seg: u32) -> Result<Vec<u8>, StoreError> {
        Err(discarded())
    }
    fn page_edges(&self) -> Result<Vec<Vec<u32>>, StoreError> {
        Err(discarded())
    }
    fn commit_verified(&mut self, verify: &mut CommitVerifier<'_>) -> Result<(), StoreError> {
        let batch = verify(self.manifest.as_ref())?.batch();
        self.leaves = Some(updated_leaves(self.leaves.as_ref(), batch)?);
        let rows = |rows: &[(u32, Vec<u8>)]| rows.iter().map(|(_, b)| b.len()).sum::<usize>();
        self.rows_bytes = batch.small.len()
            + batch
                .small_updates
                .iter()
                .flatten()
                .map(|u| u.bytes.len())
                .sum::<usize>()
            + rows(&batch.slot_pages)
            + rows(&batch.chunk_extents)
            + rows(&batch.free_segs);
        self.manifest = Some(batch.manifest.clone());
        Ok(())
    }
}

struct Options {
    command: String,
    slot_ceiling: Option<u32>,
    chunk_ceiling: Option<usize>,
    save: Option<String>,
    path: Option<String>,
}

fn options() -> Options {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut options = Options {
        command: args.first().cloned().unwrap_or_default(),
        slot_ceiling: None,
        chunk_ceiling: None,
        save: None,
        path: None,
    };
    let mut rest = args.iter().skip(1);
    while let Some(arg) = rest.next() {
        let mut value = || rest.next().cloned().expect("an option needs a value");
        match arg.as_str() {
            "--slot-ceiling" => options.slot_ceiling = Some(value().parse().expect("slots")),
            "--chunk-ceiling" => options.chunk_ceiling = Some(value().parse().expect("bytes")),
            "--save" => options.save = Some(value()),
            path => options.path = Some(path.to_string()),
        }
    }
    options
}

fn signature() -> Signature {
    Signature::new("ih-memory-probe")
}

fn compile(source: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("the program compiles");
    (code, ironhorse_vm::parse_symbols(&symbols))
}

fn configure(machine: &mut Interp, options: &Options) {
    if let Some(slots) = options.slot_ceiling {
        machine.set_slot_ceiling(slots);
    }
    if let Some(bytes) = options.chunk_ceiling {
        machine.set_chunk_ceiling(bytes);
    }
    machine.set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
}

fn outcome_fields(machine: &Interp, outcome: &RunOutcome, out: &mut Vec<String>) {
    out.push(format!("halt={:?}", outcome.halt));
    out.push(format!("result={:?}", outcome.result));
    out.push(format!("meter={}", machine.meter_index()));
    out.push(format!("chunk_bytes={}", machine.chunks().byte_size()));
    out.push(format!("chunk_ceiling={}", machine.chunks().ceiling()));
    out.push(format!("slots={}", machine.slots().capacity()));
    out.push(format!("slot_ceiling={}", machine.slots().ceiling()));
}

fn run_program(options: &Options) {
    let mut source = String::new();
    std::io::stdin()
        .read_to_string(&mut source)
        .expect("read the program from standard input");
    let mut out = vec![format!("command={}", options.command)];
    readings("start_", &mut out);
    let signature = signature();
    if options.command == "checkpoint" {
        let mut store = DiscardStore::default();
        let mut session = begin_store_session(Interp::new(), &signature, &mut store)
            .map_err(|(_, error)| error)
            .expect("begin a store session");
        let (code, names) = compile(&source);
        let machine = session.machine_mut();
        configure(machine, &options);
        machine.link_intrinsics(&names);
        phase();
        let outcome = machine.run(&code);
        readings("run_", &mut out);
        outcome_fields(machine, &outcome, &mut out);
        if outcome.completed {
            phase();
            let epoch = checkpoint_to_store(&mut session, &signature, &mut store)
                .expect("checkpoint the crank");
            readings("checkpoint_", &mut out);
            out.push(format!("checkpoint_epoch={epoch}"));
            out.push(format!("checkpoint_rows_bytes={}", store.rows_bytes));
        }
    } else {
        let (code, names) = compile(&source);
        let mut machine = Interp::new();
        configure(&mut machine, &options);
        machine.link_intrinsics(&names);
        phase();
        let outcome = machine.run(&code);
        readings("run_", &mut out);
        outcome_fields(&machine, &outcome, &mut out);
        if options.command == "snapshot" && outcome.completed {
            phase();
            let bytes = machine
                .write_snapshot(&signature)
                .expect("write the snapshot");
            readings("snapshot_", &mut out);
            out.push(format!("snapshot_bytes={}", bytes.len()));
            if let Some(path) = &options.save {
                // In pieces: one write of a snapshot of hundreds of megabytes
                // fails in Wasmtime's WASI with ENOMEM.
                use std::io::Write;
                let mut file = std::fs::File::create(path).expect("create the snapshot file");
                for piece in bytes.chunks(1 << 20) {
                    file.write_all(piece).expect("save the snapshot");
                }
            }
        }
    }
    println!("{}", out.join(" "));
}

/// Read a whole file in 1 MiB pieces: one read of a snapshot of hundreds of
/// megabytes fails in Wasmtime's WASI with ENOMEM, as one write does.
fn read_in_pieces(path: &str) -> Vec<u8> {
    let mut file = std::fs::File::open(path).expect("open the snapshot");
    let length = file.metadata().expect("the snapshot's length").len();
    let mut bytes = vec![0; usize::try_from(length).expect("a snapshot that fits in memory")];
    for piece in bytes.chunks_mut(1 << 20) {
        file.read_exact(piece).expect("read the snapshot");
    }
    bytes
}

/// Resume a saved snapshot in this fresh process and run one crank, as a
/// recycled instance does: what that costs in time and memory.
fn restore(options: &Options) {
    let path = options.path.as_deref().expect("restore <snapshot file>");
    let mut out = vec!["command=restore".to_string()];
    readings("start_", &mut out);
    let started = std::time::Instant::now();
    let bytes = read_in_pieces(path);
    let read = started.elapsed();
    phase();
    let mut machine =
        ironhorse_snapshot::from_snapshot_bytes(&bytes, &signature()).expect("resume the snapshot");
    drop(bytes);
    let resumed = started.elapsed();
    readings("restore_", &mut out);
    let (code, names) = compile("1 + 1");
    let code = machine.relink_crank(&code, &names).expect("relink a crank");
    let outcome = machine.run(&code);
    let first = started.elapsed();
    out.push(format!("halt={:?}", outcome.halt));
    out.push(format!("result={:?}", outcome.result));
    out.push(format!("slots={}", machine.slots().capacity()));
    out.push(format!("chunk_bytes={}", machine.chunks().byte_size()));
    out.push(format!("read_us={}", read.as_micros()));
    out.push(format!("resume_us={}", (resumed - read).as_micros()));
    out.push(format!("first_crank_us={}", (first - resumed).as_micros()));
    readings("crank_", &mut out);
    println!("{}", out.join(" "));
}

fn main() {
    let options = options();
    match options.command.as_str() {
        "run" | "snapshot" | "checkpoint" => run_program(&options),
        "restore" => restore(&options),
        _ => {
            eprintln!(
                "usage: ih-memory-probe run|snapshot|checkpoint [--slot-ceiling n] \
                 [--chunk-ceiling bytes] [--save file] < program.js | restore <file>"
            );
            std::process::exit(2);
        }
    }
}
