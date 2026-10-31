//! TEMPORARY audit verifier probe (snapshot-image-codec). Delete after the audit.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ironhorse_snapshot::atom::AtomReader;
use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::snapshot_api::FunctionRow;
use ironhorse_vm::{ChunkOffset, Interp, Kind, Payload, Slot, SlotIndex};

struct Counting;
static CUR: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(l) };
        if !p.is_null() {
            let c = CUR.fetch_add(l.size(), Ordering::Relaxed) + l.size();
            PEAK.fetch_max(c, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) };
        CUR.fetch_sub(l.size(), Ordering::Relaxed);
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, n: usize) -> *mut u8 {
        let q = unsafe { System.realloc(p, l, n) };
        if !q.is_null() {
            if n > l.size() {
                let c = CUR.fetch_add(n - l.size(), Ordering::Relaxed) + (n - l.size());
                PEAK.fetch_max(c, Ordering::Relaxed);
            } else {
                CUR.fetch_sub(l.size() - n, Ordering::Relaxed);
            }
        }
        q
    }
}
#[global_allocator]
static A: Counting = Counting;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn machine(src: &str) -> Interp {
    let (b, n) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "fixture: {:?}", o.halt);
    m
}

fn crank(m: &mut Interp, src: &str) -> String {
    let (b, n) = compile(src);
    let code = m.relink_crank(&b, &n).expect("relinks");
    let o = m.run(&code);
    format!(
        "completed={} result={:?} halt={:?}",
        o.completed,
        o.result.chars().take(80).collect::<String>(),
        o.halt
    )
}

fn panic_text(e: Box<dyn std::any::Any + Send>) -> String {
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap_or_default()
}

fn guarded(label: &str, secs: u64, f: impl FnOnce() -> String + Send + 'static) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
            let _ = tx.send(match r {
                Ok(s) => format!("returned: {s}"),
                Err(e) => format!("HOST PANIC: {}", panic_text(e)),
            });
        })
        .unwrap();
    match rx.recv_timeout(Duration::from_secs(secs)) {
        Ok(s) => {
            println!("[{label}] {s}");
            false
        }
        Err(_) => {
            println!("[{label}] HANG: no result after {secs}s");
            true
        }
    }
}

fn find_int(slots: &[Slot], v: i32) -> Vec<usize> {
    slots
        .iter()
        .enumerate()
        .filter(|(_, s)| s.value == Payload::Integer(v))
        .map(|(i, _)| i)
        .collect()
}

fn owner_of(slots: &[Slot], prop: usize) -> usize {
    for (i, s) in slots.iter().enumerate() {
        if s.kind != Kind::Instance {
            continue;
        }
        let mut cur = s.next;
        for _ in 0..16 {
            if cur.is_null() || cur.0 as usize >= slots.len() {
                break;
            }
            if cur.0 as usize == prop {
                return i;
            }
            cur = slots[cur.0 as usize].next;
        }
    }
    panic!("no owner");
}

/// SNI-1: two-object prototype cycle (o -> p -> o) as well as self-cycle.
#[test]
fn v1_proto_cycle() {
    let m = machine("var o = {mark: 778001}; var p = {mark2: 778002}; 1");
    let honest = m.write_snapshot(&sig()).unwrap();
    let base = read_machine(&honest, &sig()).unwrap();
    let oi = owner_of(&base.slots, find_int(&base.slots, 778001)[0]);
    let pi = owner_of(&base.slots, find_int(&base.slots, 778002)[0]);
    let mut hung = false;
    for (label, edits) in [
        ("self", vec![(oi, oi)]),
        ("two-hop", vec![(oi, pi), (pi, oi)]),
    ] {
        let mut image = base.clone();
        for &(a, b) in &edits {
            image.slots[a].value = Payload::Reference(SlotIndex(b as u32));
        }
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[V1 {label}] crafted prototype cycle ACCEPTED by from_snapshot_bytes");
                let c2 = crafted.clone();
                hung |= guarded(&format!("V1 {label} 'zz' in o (metered 10k, host refuses)"), 10, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    r.arm_meter(10_000, Box::new(|_| false));
                    crank(&mut r, "'zz' in o")
                });
                let c3 = crafted.clone();
                hung |= guarded(&format!("V1 {label} o.mark (own hit)"), 10, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    r.arm_meter(10_000, Box::new(|_| false));
                    crank(&mut r, "o.mark")
                });
            }
            Err(e) => println!("[V1 {label}] refused: {e}"),
        }
    }
    if hung {
        println!("exiting with spinning thread(s)");
        std::process::exit(0);
    }
}

/// SNI-2: string offset moved inside its allocation.
#[test]
fn v2_string_offset() {
    let m = machine("var s = 'ABCDEFGHIJKLMNOP'; var mark = 777002; s.length");
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    let pat: Vec<u8> = "ABCDEFGHIJKLMNOP"
        .encode_utf16()
        .flat_map(|u| u.to_be_bytes())
        .collect();
    let at = match image.chunks.windows(pat.len()).position(|w| w == pat.as_slice()) {
        Some(a) => a,
        None => {
            let pat_le: Vec<u8> = "ABCDEFGHIJKLMNOP"
                .encode_utf16()
                .flat_map(|u| u.to_le_bytes())
                .collect();
            image.chunks.windows(pat_le.len()).position(|w| w == pat_le.as_slice()).expect("bytes")
        }
    };
    let mut changed = 0;
    for s in image.slots.iter_mut() {
        if s.value == Payload::String(ChunkOffset(at as u32)) {
            s.value = Payload::String(ChunkOffset(at as u32 + 4));
            changed += 1;
        }
    }
    println!("[V2] string payload at {at}, rewired {changed} slot(s) to +4");
    let crafted = write_machine_unchecked(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(_) => {
            println!("[V2] crafted container ACCEPTED");
            for src in ["s.length", "(s + '!').length", "s.charCodeAt(0)"] {
                let c = crafted.clone();
                let s = src.to_string();
                guarded(&format!("V2 {src}"), 20, move || {
                    let mut r = from_snapshot_bytes(&c, &sig()).unwrap();
                    crank(&mut r, &s)
                });
            }
        }
        Err(e) => println!("[V2] refused: {e}"),
    }
}

/// SNI-4: kind retag and own-chain cycle; own-keys enumeration with a memory watchdog.
#[test]
fn v3_heap_shape() {
    {
        let m = machine("var n = 777003; n");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let hits = find_int(&image.slots, 777003);
        for &i in &hits {
            image.slots[i].kind = Kind::String;
        }
        println!("[V3a] retagged {} slot(s) Integer->String kind", hits.len());
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[V3a] crafted container ACCEPTED");
                for src in ["typeof n", "n.length", "n + 1"] {
                    let c = crafted.clone();
                    let s = src.to_string();
                    guarded(&format!("V3a {src}"), 20, move || {
                        let mut r = from_snapshot_bytes(&c, &sig()).unwrap();
                        crank(&mut r, &s)
                    });
                }
            }
            Err(e) => println!("[V3a] refused: {e}"),
        }
    }
    let m = machine("var o = {a: 777004, b: 777005}; 1");
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    let pa = find_int(&image.slots, 777004)[0];
    let pb = find_int(&image.slots, 777005)[0];
    let owner = owner_of(&image.slots, pa);
    let head = image.slots[owner].next.0 as usize;
    let tail = if head == pa { pb } else { pa };
    image.slots[tail].next = SlotIndex(head as u32);
    let crafted = write_machine_unchecked(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(_) => {
            println!("[V3b] crafted cyclic own-property chain ACCEPTED");
            let c2 = crafted.clone();
            guarded("V3b o.zz", 10, move || {
                let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                crank(&mut r, "o.zz")
            });
            // Watchdog: exit the process once the heap passes 768 MiB.
            let base = CUR.load(Ordering::Relaxed);
            std::thread::spawn(move || loop {
                let now = CUR.load(Ordering::Relaxed);
                if now > base + (768 << 20) {
                    println!("[V3b watchdog] live heap grew by {} MiB during the enumeration; exiting", (now - base) >> 20);
                    std::process::exit(0);
                }
                std::thread::sleep(Duration::from_millis(5));
            });
            let c3 = crafted.clone();
            let t = Instant::now();
            let hung = guarded("V3b Object.freeze(o) (metered 10k, host refuses)", 20, move || {
                let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                r.arm_meter(10_000, Box::new(|_| false));
                crank(&mut r, "Object.freeze(o); 1")
            });
            println!("[V3b] after {:?}, hung={hung}, heap delta {} MiB", t.elapsed(), (CUR.load(Ordering::Relaxed).saturating_sub(base)) >> 20);
            if hung {
                std::process::exit(0);
            }
        }
        Err(e) => println!("[V3b] refused: {e}"),
    }
}

/// SNI-3: METR index near u64::MAX.
#[test]
fn v4_meter() {
    let m = machine("var t = 1; t");
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    println!(
        "[V4] honest METR index={} interval={} count={}",
        image.meter.index, image.meter.interval, image.meter.count
    );
    image.meter.index = u64::MAX - 3;
    let crafted = write_machine_unchecked(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(_) => {
            println!("[V4] METR index=u64::MAX-3 ACCEPTED");
            guarded("V4 t + 1", 10, move || {
                let mut r = from_snapshot_bytes(&crafted, &sig()).unwrap();
                crank(&mut r, "t + 1")
            });
        }
        Err(e) => println!("[V4] refused: {e}"),
    }
}

/// SNI-5: duplicate scan cost (release timing).
#[test]
fn v5_atoms() {
    for n in [8_000usize, 16_000, 32_000, 64_000, 128_000] {
        let mut buf = Vec::with_capacity(8 + 8 * n);
        buf.extend_from_slice(&((8 + 8 * n) as u32).to_be_bytes());
        buf.extend_from_slice(b"XS_M");
        for i in 0..n as u32 {
            buf.extend_from_slice(&8u32.to_be_bytes());
            buf.extend_from_slice(&(i | 0x8000_0000).to_be_bytes());
        }
        let t = Instant::now();
        let r = read_machine(&buf, &sig());
        println!(
            "[V5] atoms={n} bytes={} refused={:?} in {:?}",
            buf.len(),
            r.err().map(|e| e.to_string()),
            t.elapsed()
        );
    }
}

/// SNI-6: FUNC gate per-row body walk (release timing).
#[test]
fn v6_func_gate() {
    let (b, n) = compile("function f() { return 1; } f()");
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    assert!(m.run(&b).completed);
    let honest = m.write_snapshot(&sig()).unwrap();
    let base = read_machine(&honest, &sig()).unwrap();
    let op = (0u8..=255)
        .find(|&b| ironhorse_vm::instruction_len(&[b], 0) == Some(1))
        .expect("a one-byte opcode");
    let len = 1usize << 20;
    for rows in [1usize, 100, 400, 1600] {
        let mut image = base.clone();
        let seg = image.function_state.segments.len() as u32;
        image.function_state.segments.push(vec![op; len]);
        let first = image.slots.len() as u32;
        for i in 0..rows as u32 {
            image.slots.push(Slot::undefined());
            image.function_state.functions.push(FunctionRow {
                owner: first + i,
                segment: Some(seg),
                body_start: Some(0),
                body_len: len as u64,
                closures: u32::MAX,
                name: String::new(),
                arity: 0,
                name_chunk: u32::MAX,
                is_generator: false,
                home: u32::MAX,
                class_derived: None,
            });
        }
        image.slot_live = image.slots.len() as u32 - image.slot_free.len() as u32;
        let crafted = write_machine_unchecked(&image);
        let t = Instant::now();
        let r = read_machine(&crafted, &sig());
        println!(
            "[V6] body={len} B rows={rows} container={} B: read_machine {:?} -> {:?}",
            crafted.len(),
            t.elapsed(),
            r.as_ref().err().map(|e| e.to_string())
        );
    }
}

/// SNI-7: read-path peak allocation.
#[test]
fn v7_memory() {
    let m = machine("var a = []; for (var i = 0; i < 100000; i++) { a.push({x: i, y: i + 1}); } a.length");
    let bytes = m.write_snapshot(&sig()).unwrap();
    let c = bytes.len();
    drop(m);
    let base = CUR.load(Ordering::Relaxed);
    PEAK.store(base, Ordering::Relaxed);
    let image = ironhorse_snapshot::image::read_validated_machine(&bytes, &sig()).unwrap();
    let read_peak = PEAK.load(Ordering::Relaxed) - base;
    let held = CUR.load(Ordering::Relaxed) - base;
    PEAK.store(CUR.load(Ordering::Relaxed), Ordering::Relaxed);
    let b2 = CUR.load(Ordering::Relaxed);
    let restored = ironhorse_snapshot::machine::image_to_interp(image).unwrap();
    let interp_peak = PEAK.load(Ordering::Relaxed) - b2 + held;
    let resident = CUR.load(Ordering::Relaxed) - base;
    println!(
        "[V7] container={c} B; read_validated_machine peak +{read_peak} B ({:.2}x); image held {held} B; \
         image_to_interp peak incl image +{interp_peak} B ({:.2}x); restored machine {resident} B; \
         overall peak incl input {:.2}x",
        read_peak as f64 / c as f64,
        interp_peak as f64 / c as f64,
        (c + read_peak.max(interp_peak)) as f64 / c as f64
    );
    drop(restored);
}

/// SNI-8 and SNI-9.
#[test]
fn v8_free_and_canonical() {
    let m = machine("var t = 1; t");
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    image.keys = vec!["junk".into(), "x".repeat(1000)];
    image.creation.initial_slot_count = image.creation.initial_slot_count.wrapping_add(12345);
    let crafted = write_machine_unchecked(&image);
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(r) => {
            let again = r.write_snapshot(&sig()).unwrap();
            println!(
                "[V9a] crafted KEYS+CREA ACCEPTED; honest={} crafted={} rewrite==honest:{} rewrite==crafted:{}",
                honest.len(), crafted.len(), again == honest, again == crafted
            );
        }
        Err(e) => println!("[V9a] refused: {e}"),
    }

    let m = machine("var o = {a: 1}; var t = 2; t");
    let honest = m.write_snapshot(&sig()).unwrap();
    let mut image = read_machine(&honest, &sig()).unwrap();
    image.version.format_version = 15;
    image.function_state.native_names = None;
    let mut crafted = write_machine_unchecked(&image);
    let (heap_at, fmt) = {
        let r = AtomReader::parse(&crafted).unwrap();
        let v = r.find(ironhorse_snapshot::VERS).unwrap();
        let fmt = u32::from_be_bytes(v.payload[4..8].try_into().unwrap());
        let heap = r.find(ironhorse_snapshot::HEAP).unwrap();
        (heap.payload.as_ptr() as usize - crafted.as_ptr() as usize, fmt)
    };
    let slot_count = u32::from_be_bytes(crafted[heap_at..heap_at + 4].try_into().unwrap()) as usize;
    let free = u32::from_be_bytes(crafted[heap_at + 4..heap_at + 8].try_into().unwrap()) as usize;
    let records = heap_at + 12 + 4 * free;
    for i in 0..slot_count {
        crafted[records + i * 20 + 9] = 0xA5;
    }
    match from_snapshot_bytes(&crafted, &sig()) {
        Ok(r) => {
            let again = r.write_snapshot(&sig()).unwrap();
            println!(
                "[V9b] VERS={fmt}; restamp with {slot_count} dirty reserved bytes ACCEPTED; rewrite==crafted:{} rewrite==honest:{}",
                again == crafted, again == honest
            );
        }
        Err(e) => println!("[V9b] refused: {e}"),
    }

    let mut m = machine("var a = []; for (var i = 0; i < 50000; i++) { a.push({x: i}); } a.length");
    let before = m.write_snapshot(&sig()).unwrap().len();
    let (b, n) = compile("a = 0; 1");
    let code = m.relink_crank(&b, &n).unwrap();
    assert!(m.run(&code).completed);
    let stats = m.collect_garbage().expect("gc");
    let after = m.write_snapshot(&sig()).unwrap();
    let image = read_machine(&after, &sig()).unwrap();
    println!(
        "[V8] before drop={before} B; after GC={} B; slots={} free={} live={} (free records+list = {} B); reclaimed={}",
        after.len(),
        image.slots.len(),
        image.slot_free.len(),
        image.slot_live,
        image.slot_free.len() * 24,
        stats.slots_reclaimed
    );
}
