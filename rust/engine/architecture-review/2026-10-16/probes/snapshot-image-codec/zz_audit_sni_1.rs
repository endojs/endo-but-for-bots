//! TEMPORARY audit probe (SNI region). Delete after the audit.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use ironhorse_snapshot::image::{read_machine, write_machine_unchecked};
use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
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

/// Run `f` on a fresh thread with a deadline; report its outcome or a hang.
fn guarded(label: &str, secs: u64, f: impl FnOnce() -> String + Send + 'static) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::Builder::new()
        .stack_size(64 << 20)
        .spawn(move || {
            let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f));
            let _ = tx.send(match r {
                Ok(s) => format!("returned: {s}"),
                Err(e) => format!(
                    "HOST PANIC: {}",
                    e.downcast_ref::<String>()
                        .cloned()
                        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default()
                ),
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

#[test]
fn sni_probe() {
    println!(
        "size_of Slot={} Payload={} SlotIndex={}",
        std::mem::size_of::<Slot>(),
        std::mem::size_of::<Payload>(),
        std::mem::size_of::<SlotIndex>()
    );

    // ---- P1: peak allocation during an eager container restore ----
    for (label, src) in [
        (
            "objects",
            "var a = []; for (var i = 0; i < 100000; i++) { a.push({x: i, y: i + 1}); } a.length",
        ),
        (
            "strings",
            "var a = []; for (var i = 0; i < 20000; i++) { a.push('s' + i + 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'); } a.length",
        ),
    ] {
        let m = machine(src);
        let before = CUR.load(Ordering::Relaxed);
        let bytes = m.write_snapshot(&sig()).unwrap();
        let c = bytes.len();
        let slots = m.slots().capacity();
        let chunk = m.chunks().byte_size();
        drop(m);
        let base = CUR.load(Ordering::Relaxed);
        PEAK.store(base, Ordering::Relaxed);
        let t = Instant::now();
        let image = ironhorse_snapshot::image::read_validated_machine(&bytes, &sig()).unwrap();
        let read_peak = PEAK.load(Ordering::Relaxed) - base;
        let after_read = CUR.load(Ordering::Relaxed) - base;
        PEAK.store(CUR.load(Ordering::Relaxed), Ordering::Relaxed);
        let base2 = CUR.load(Ordering::Relaxed);
        let restored = ironhorse_snapshot::machine::image_to_interp(image).unwrap();
        let interp_peak = PEAK.load(Ordering::Relaxed) - base2 + after_read;
        let resident = CUR.load(Ordering::Relaxed) - base;
        println!(
            "[P1 {label}] container={c} B, slots={slots} (wire {} B), chunk={chunk} B; \
             read_validated_machine peak +{read_peak} B ({:.2}x container), image held {after_read} B; \
             image_to_interp peak (incl. image) +{interp_peak} B ({:.2}x); restored machine {resident} B; \
             total {:?}; pre-snapshot live {before}",
            slots as usize * 20,
            read_peak as f64 / c as f64,
            interp_peak as f64 / c as f64,
            t.elapsed()
        );
        drop(restored);
    }

    // ---- P2: O(n^2) duplicate-tag scan before any gate ----
    for n in [8_000usize, 16_000, 32_000, 64_000] {
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
            "[P2] atoms={n} bytes={} refused={:?} in {:?}",
            buf.len(),
            r.err().map(|e| e.to_string()),
            t.elapsed()
        );
    }

    // ---- P3: dead/advisory fields accepted (KEYS content, CREA slot count) ----
    {
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
                    "[P3] crafted KEYS+CREA ACCEPTED; honest={} crafted={} rewrite={} rewrite==honest:{} rewrite==crafted:{}",
                    honest.len(),
                    crafted.len(),
                    again.len(),
                    again == honest,
                    again == crafted
                );
            }
            Err(e) => println!("[P3] refused: {e}"),
        }
    }

    // ---- P4: string slot offset moved inside its own allocation ----
    {
        let m = machine("var s = 'ABCDEFGHIJKLMNOP'; var mark = 777002; s.length");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let pat: Vec<u8> = "ABCDEFGHIJKLMNOP"
            .encode_utf16()
            .flat_map(|u| u.to_be_bytes())
            .collect();
        let at = image
            .chunks
            .windows(pat.len())
            .position(|w| w == pat.as_slice())
            .expect("string bytes in BLOC");
        let mut changed = 0;
        for s in image.slots.iter_mut() {
            if s.value == Payload::String(ChunkOffset(at as u32)) {
                s.value = Payload::String(ChunkOffset(at as u32 + 4));
                changed += 1;
            }
        }
        println!("[P4] string payload at {at}, rewired {changed} slot(s) to +4");
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P4] crafted container ACCEPTED by from_snapshot_bytes");
                let c2 = crafted.clone();
                guarded("P4 s.length", 20, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    crank(&mut r, "s.length")
                });
                let c3 = crafted.clone();
                guarded("P4 s + '!'", 20, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    crank(&mut r, "(s + '!').length")
                });
            }
            Err(e) => println!("[P4] refused: {e}"),
        }
    }

    // ---- P5: kind/payload mismatch in a heap record ----
    {
        let m = machine("var n = 777003; n");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let hits = find_int(&image.slots, 777003);
        for &i in &hits {
            image.slots[i].kind = Kind::String;
        }
        println!("[P5] retagged {} slot(s) Integer->String kind", hits.len());
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P5] crafted container ACCEPTED");
                let c2 = crafted.clone();
                guarded("P5 n.length", 20, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    crank(&mut r, "n.length")
                });
                let c3 = crafted.clone();
                guarded("P5 typeof n", 20, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    crank(&mut r, "typeof n")
                });
            }
            Err(e) => println!("[P5] refused: {e}"),
        }
    }

    // ---- P6: own-property chain cycle on a non-global object ----
    {
        let m = machine("var o = {a: 777004, b: 777005}; 1");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let pa = find_int(&image.slots, 777004)[0];
        let pb = find_int(&image.slots, 777005)[0];
        let owner = owner_of(&image.slots, pa);
        // Whichever of a/b is the tail, point its next back at the head.
        let head = image.slots[owner].next.0 as usize;
        let tail = if head == pa { pb } else { pa };
        println!(
            "[P6] owner={owner} head={head} tail={tail} tail.next={:?}",
            image.slots[tail].next
        );
        image.slots[tail].next = SlotIndex(head as u32);
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P6] crafted cyclic own-property chain ACCEPTED");
                let c2 = crafted.clone();
                guarded("P6 o.zz (lookup)", 10, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    crank(&mut r, "o.zz")
                });
            }
            Err(e) => println!("[P6] refused: {e}"),
        }
    }

    // ---- P7: prototype cycle (instance is its own prototype) ----
    let mut hung = false;
    {
        let m = machine("var o = {mark: 777001}; 1");
        let honest = m.write_snapshot(&sig()).unwrap();
        let mut image = read_machine(&honest, &sig()).unwrap();
        let p = find_int(&image.slots, 777001)[0];
        let owner = owner_of(&image.slots, p);
        println!("[P7] owner={owner} proto={:?}", image.slots[owner].value);
        image.slots[owner].value = Payload::Reference(SlotIndex(owner as u32));
        let crafted = write_machine_unchecked(&image);
        match from_snapshot_bytes(&crafted, &sig()) {
            Ok(_) => {
                println!("[P7] crafted self-prototype ACCEPTED");
                let c2 = crafted.clone();
                hung |= guarded("P7 'zz' in o", 15, move || {
                    let mut r = from_snapshot_bytes(&c2, &sig()).unwrap();
                    r.arm_meter(10_000, Box::new(|_| false));
                    crank(&mut r, "'zz' in o")
                });
                let c3 = crafted.clone();
                hung |= guarded("P7 o.zz (metered)", 15, move || {
                    let mut r = from_snapshot_bytes(&c3, &sig()).unwrap();
                    r.arm_meter(10_000, Box::new(|_| false));
                    crank(&mut r, "o.zz")
                });
            }
            Err(e) => println!("[P7] refused: {e}"),
        }
    }
    if hung {
        println!("exiting with spinning thread(s)");
        std::process::exit(0);
    }
}
