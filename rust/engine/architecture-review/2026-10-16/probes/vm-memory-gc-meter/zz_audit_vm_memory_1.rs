//! TEMPORARY audit probe (vm-memory-gc-meter region). Not part of the tree.
//! Measures resident heap per unit with a counting global allocator, GC
//! scaling, WeakMap delete scaling, and computron-vs-wall-time ratios.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use ironhorse_vm::Interp;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            LIVE.fetch_add(layout.size(), Ordering::Relaxed);
        }
        p
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            LIVE.fetch_add(new_size, Ordering::Relaxed);
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static GLOBAL: Counting = Counting;

fn live() -> usize {
    LIVE.load(Ordering::Relaxed)
}

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

struct Snap {
    bytes: usize,
    cap: u32,
    live_slots: u32,
    chunk: usize,
    side: u64,
    slot_resident: usize,
}

fn snap(m: &Interp) -> Snap {
    Snap {
        bytes: live(),
        cap: m.slots().capacity(),
        live_slots: m.slots().live_count(),
        chunk: m.chunks().byte_size(),
        side: m.side_storage_bytes(),
        slot_resident: m.slots().resident_byte_size(),
    }
}

/// Run `setup` (baseline) then `work` on one machine; report per-unit deltas.
fn per_unit(name: &str, setup: &str, work: &str, n: f64) {
    let (b0, n0) = compile(setup);
    let (b1, n1) = compile(work);
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    let o = m.run(&b0);
    assert!(o.completed, "{name} setup {:?}", o.halt);
    let b1 = m.relink_crank(&b1, &n1).expect("relink");
    let before = snap(&m);
    let t = Instant::now();
    let o = m.run(&b1);
    let dt = t.elapsed();
    assert!(o.completed, "{name} work {:?}", o.halt);
    let after = snap(&m);
    let t = Instant::now();
    let gc = m.collect_garbage().unwrap();
    let gct = t.elapsed();
    let post = snap(&m);
    println!(
        "UNIT {name}: n={n} heapB/unit={:.1} slots/unit={:.2} (cap {}->{}, live {}->{}) chunkB/unit={:.1} sideB/unit={:.1} slotResidentB/unit={:.1} run={:?} | gc={:?} reclaimed={} heap_after_gc_B/unit={:.1}",
        (after.bytes as f64 - before.bytes as f64) / n,
        (after.live_slots as f64 - before.live_slots as f64) / n,
        before.cap,
        after.cap,
        before.live_slots,
        after.live_slots,
        (after.chunk as f64 - before.chunk as f64) / n,
        (after.side as f64 - before.side as f64) / n,
        (after.slot_resident as f64 - before.slot_resident as f64) / n,
        dt,
        gct,
        gc.slots_reclaimed,
        (post.bytes as f64 - before.bytes as f64) / n,
    );
}

#[test]
fn a_sizes_and_boot() {
    use std::mem::size_of;
    println!(
        "SIZE Slot={} Payload={} Kind={} SlotIndex={} ChunkOffset={} Interp={} SlotArena={} ChunkArena={} Meter={} RunOutcome={} Halt={}",
        size_of::<ironhorse_vm::Slot>(),
        size_of::<ironhorse_vm::Payload>(),
        size_of::<ironhorse_vm::Kind>(),
        size_of::<ironhorse_vm::SlotIndex>(),
        size_of::<ironhorse_vm::ChunkOffset>(),
        size_of::<Interp>(),
        size_of::<ironhorse_vm::SlotArena>(),
        size_of::<ironhorse_vm::ChunkArena>(),
        size_of::<ironhorse_vm::Meter>(),
        size_of::<ironhorse_vm::RunOutcome>(),
        size_of::<ironhorse_vm::Halt>(),
    );
    // Composite sizes of std containers holding the side-table entries we can name.
    println!(
        "SIZE (u32,Slot)={} (SlotIndex,Slot)={} ((SlotIndex,SlotIndex),Slot)={} Option<Box<[u8]>>={}",
        size_of::<(u32, ironhorse_vm::Slot)>(),
        size_of::<(ironhorse_vm::SlotIndex, ironhorse_vm::Slot)>(),
        size_of::<((ironhorse_vm::SlotIndex, ironhorse_vm::SlotIndex), ironhorse_vm::Slot)>(),
        size_of::<Option<Box<[u8]>>>(),
    );
    let b0 = live();
    let t = Instant::now();
    let mut m = Interp::new();
    let t_new = t.elapsed();
    let b1 = live();
    let (b, n) = compile("var x = 1; x");
    let t = Instant::now();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    let t_run = t.elapsed();
    assert!(o.completed);
    let s = snap(&m);
    println!(
        "BOOT Interp::new heap={}B in {:?}; after link+tiny run heap={}B in {:?}; slots cap={} live={} chunk={}B side={}B slot_resident={}B",
        b1 - b0,
        t_new,
        s.bytes - b0,
        t_run,
        s.cap,
        s.live_slots,
        s.chunk,
        s.side,
        s.slot_resident
    );
    let t = Instant::now();
    let gc = m.collect_garbage().unwrap();
    println!("BOOT gc {:?} in {:?}; heap after {}B", gc, t.elapsed(), live() - b0);
    drop(m);
    println!("BOOT after drop residual={}B", live() as isize - b0 as isize);
}

#[test]
fn b_per_unit_costs() {
    let setup = "var keep = []; var o = 0; var i = 0; var m = 0; var C = 0; var s = '';";
    // Array of small ints: isolates the per-item array cost.
    per_unit(
        "array_1M_small_ints",
        "var a = [];",
        "var a; for (var i = 0; i < 1000000; i++) a.push(i & 1023); 0",
        1_000_000.0,
    );
    per_unit(
        "array_100k_small_ints",
        "var a = [];",
        "var a; for (var i = 0; i < 100000; i++) a.push(i & 1023); 0",
        100_000.0,
    );
    // Linked list of empty-ish objects (one property: the link) — no array.
    per_unit(
        "linked_100k_objects_1prop",
        "var head = null;",
        "var head; for (var i = 0; i < 100000; i++) head = { n: head }; 0",
        100_000.0,
    );
    per_unit(
        "array_of_100k_empty_objects",
        setup,
        "var keep; for (var i = 0; i < 100000; i++) keep.push({}); 0",
        100_000.0,
    );
    per_unit(
        "array_of_100k_objects_4props",
        setup,
        "var keep; for (var i = 0; i < 100000; i++) keep.push({a: i, b: i, c: i, d: i}); 0",
        100_000.0,
    );
    per_unit(
        "array_of_100k_short_strings",
        setup,
        "var keep; for (var i = 0; i < 100000; i++) keep.push('s' + i); 0",
        100_000.0,
    );
    per_unit(
        "array_of_20k_arrow_closures_over_let",
        setup,
        "var keep; for (let i = 0; i < 20000; i++) keep.push(() => i); 0",
        20_000.0,
    );
    per_unit(
        "array_of_10k_iife_closures",
        setup,
        "var keep; for (var i = 0; i < 10000; i++) keep.push((function (x) { return function () { return x; }; })(i)); 0",
        10_000.0,
    );
    per_unit(
        "map_100k_int_entries",
        "var m = new Map();",
        "var m; for (var i = 0; i < 100000; i++) m.set(i, i); 0",
        100_000.0,
    );
    per_unit(
        "map_100k_string_keys",
        "var m = new Map();",
        "var m; for (var i = 0; i < 100000; i++) m.set('k' + i, i); 0",
        100_000.0,
    );
    per_unit(
        "array_of_10k_class_instances_2_private_fields",
        "var keep = [];",
        "var keep; class C { #a = 1; #b = 2; getA() { return this.#a; } } for (var i = 0; i < 10000; i++) keep.push(new C()); 0",
        10_000.0,
    );
    per_unit(
        "array_of_10k_objects_with_getter",
        setup,
        "var keep; for (var i = 0; i < 10000; i++) keep.push({ get x() { return 1; } }); 0",
        10_000.0,
    );
}

fn gc_time(name: &str, src: &str, n: usize) {
    let (b, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let t = Instant::now();
    let o = m.run(&b);
    let run = t.elapsed();
    assert!(o.completed, "{name} {:?}", o.halt);
    let live_slots = m.slots().live_count();
    let t = Instant::now();
    let gc = m.collect_garbage().unwrap();
    let dt = t.elapsed();
    println!(
        "GC {name} n={n}: run={run:?} live_slots={live_slots} gc={dt:?} reclaimed={} live_after={}",
        gc.slots_reclaimed, gc.slots_live
    );
}

#[test]
fn c_gc_scaling() {
    for n in [1000usize, 2000, 4000, 8000] {
        gc_time(
            "live_plain_objects",
            &format!("var keep = []; for (var i = 0; i < {n}; i++) keep.push({{a: i}}); 0"),
            n,
        );
    }
    for n in [1000usize, 2000, 4000, 8000] {
        gc_time(
            "live_private_fields",
            &format!(
                "var keep = []; class C {{ #a = 1; #b = 2; getA() {{ return this.#a; }} }} \
                 for (var i = 0; i < {n}; i++) keep.push(new C()); 0"
            ),
            n,
        );
    }
    for n in [1000usize, 2000, 4000, 8000] {
        gc_time(
            "dead_private_fields",
            &format!(
                "var keep = []; class C {{ #a = 1; #b = 2; getA() {{ return this.#a; }} }} \
                 for (var i = 0; i < {n}; i++) keep.push(new C()); keep = null; 0"
            ),
            n,
        );
    }
    for n in [1000usize, 2000, 4000, 8000] {
        gc_time(
            "live_getter_objects",
            &format!(
                "var keep = []; for (var i = 0; i < {n}; i++) keep.push({{ get x() {{ return 1; }} }}); 0"
            ),
            n,
        );
    }
    for n in [1000usize, 2000, 4000, 8000] {
        gc_time(
            "dead_getter_objects",
            &format!(
                "var keep = []; for (var i = 0; i < {n}; i++) keep.push({{ get x() {{ return 1; }} }}); keep = null; 0"
            ),
            n,
        );
    }
    for n in [1000usize, 2000, 4000, 8000] {
        gc_time(
            "weakmap_chain",
            &format!(
                "var wm = new WeakMap(); var head = {{}}; var k = head; \
                 for (var i = 0; i < {n}; i++) {{ var nx = {{}}; wm.set(k, nx); k = nx; }} k = null; nx = null; 0"
            ),
            n,
        );
    }
}

fn run_time(name: &str, src: &str) -> (std::time::Duration, u64, String) {
    let (b, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let before = m.meter_index();
    let t = Instant::now();
    let o = m.run(&b);
    let dt = t.elapsed();
    let comp = (m.meter_index() - before) >> 16;
    let outcome = if o.completed {
        o.result.chars().take(40).collect()
    } else {
        format!("{:?}", o.halt)
    };
    println!(
        "METER {name}: wall={dt:?} computrons={comp} ns_per_computron={:.2} result={outcome}",
        dt.as_nanos() as f64 / comp.max(1) as f64
    );
    (dt, comp, outcome)
}

#[test]
fn d_weakmap_delete_scaling() {
    for n in [10_000usize, 20_000, 40_000] {
        run_time(
            &format!("weakmap_delete_front_n{n}"),
            &format!(
                "var wm = new WeakMap(); var ks = []; for (var i = 0; i < {n}; i++) {{ var o = {{}}; ks.push(o); wm.set(o, i); }} \
                 for (var i = 0; i < {n}; i++) wm.delete(ks[i]); 0"
            ),
        );
    }
    for n in [10_000usize, 20_000, 40_000] {
        run_time(
            &format!("map_delete_front_n{n}"),
            &format!(
                "var wm = new Map(); var ks = []; for (var i = 0; i < {n}; i++) {{ var o = {{}}; ks.push(o); wm.set(o, i); }} \
                 for (var i = 0; i < {n}; i++) wm.delete(ks[i]); 0"
            ),
        );
    }
}

#[test]
fn f_chunk_fragmentation() {
    use ironhorse_vm::ChunkArena;
    // Blocks larger than one 64 KiB extent are "crossing" blocks: never moved.
    let mut c = ChunkArena::new();
    let blk = vec![1u8; 100 * 1024];
    let offs: Vec<_> = (0..8).map(|_| c.alloc(&blk)).collect();
    // keep 0, 3, 4, 7; kill the adjacent pairs (1,2) and (5,6)
    let live = [offs[0], offs[3], offs[4], offs[7]];
    let before = c.byte_size();
    let remap = c.compact_local(&live);
    println!(
        "FRAG before={} after={} moved={} can_alloc_150K_in_hole={} (a 150 KiB request fits only if adjacent dead blocks coalesced)",
        before,
        c.byte_size(),
        remap.len(),
        {
            let ceiling = c.byte_size();
            let mut probe = ChunkArena::new();
            let _ = &mut probe;
            c.set_ceiling(ceiling).unwrap();
            c.can_allocate(150 * 1024)
        }
    );
    println!(
        "FRAG can_alloc_90K_in_hole={}",
        c.can_allocate(90 * 1024)
    );
    // Same experiment with small blocks inside one extent: dead quarter rule.
    let mut d = ChunkArena::new();
    let small = vec![2u8; 1000];
    let offs: Vec<_> = (0..60).map(|_| d.alloc(&small)).collect();
    // kill 1 of every 5 (20% dead, below the 25% threshold)
    let live: Vec<_> = offs
        .iter()
        .enumerate()
        .filter(|(i, _)| i % 5 != 0)
        .map(|(_, o)| *o)
        .collect();
    let before = d.byte_size();
    let remap = d.compact_local(&live);
    println!(
        "FRAG small_20pct_dead before={} after={} moved={}",
        before,
        d.byte_size(),
        remap.len()
    );
}

#[test]
fn g_memory_not_returned_after_gc() {
    // Churn: allocate 400k objects that die, then collect. Does the
    // process heap drop?
    let (b, n) = compile("var x = 0; for (var i = 0; i < 400000; i++) x = {a: i}; x = 0; 0");
    let base = live();
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let after_boot = live();
    let o = m.run(&b);
    assert!(o.completed, "{:?}", o.halt);
    let after_run = live();
    let gc = m.collect_garbage().unwrap();
    let after_gc = live();
    println!(
        "RETAIN boot={}B after_run={}B after_gc={}B reclaimed_slots={} live_slots={} cap={} slot_resident={}B",
        after_boot - base,
        after_run - base,
        after_gc - base,
        gc.slots_reclaimed,
        gc.slots_live,
        m.slots().capacity(),
        m.slots().resident_byte_size()
    );
    // Strings: build 100 MB of garbage strings then collect.
    let (b, n) = compile(
        "var s = ''; var t = 'y'.repeat(1000); for (var i = 0; i < 50000; i++) s = t + i; s = 0; 0",
    );
    let base = live();
    let mut m = Interp::new();
    m.link_intrinsics(&n);
    let o = m.run(&b);
    assert!(o.completed, "{:?}", o.halt);
    let after_run = live();
    let chunk_before = m.chunks().byte_size();
    let gc = m.collect_garbage().unwrap();
    let after_gc = live();
    println!(
        "RETAIN strings after_run={}B after_gc={}B chunk_len {}->{} ({:?})",
        after_run - base,
        after_gc - base,
        chunk_before,
        m.chunks().byte_size(),
        gc
    );
}

#[test]
fn i_gc_getters_large() {
    for n in [16000usize, 32000] {
        gc_time(
            "live_getter_objects",
            &format!(
                "var keep = []; for (var i = 0; i < {n}; i++) keep.push({{ get x() {{ return 1; }} }}); 0"
            ),
            n,
        );
    }
    for n in [16000usize, 32000] {
        gc_time(
            "weakmap_chain",
            &format!(
                "var wm = new WeakMap(); var head = {{}}; var k = head; \
                 for (var i = 0; i < {n}; i++) {{ var nx = {{}}; wm.set(k, nx); k = nx; }} k = null; nx = null; 0"
            ),
            n,
        );
    }
}

#[test]
fn h_bound_args_uncharged() {
    for k in [25usize, 50, 100] {
        let src = format!(
            "function f() {{}} var a = []; for (var i = 0; i < 100000; i++) a.push(i); var bs = []; \
             for (var j = 0; j < {k}; j++) bs.push(f.bind(null, ...a)); bs.length"
        );
        let (b, n) = compile(&src);
        let base = live();
        let mut m = Interp::new();
        m.link_intrinsics(&n);
        let t = Instant::now();
        let o = m.run(&b);
        let dt = t.elapsed();
        assert!(o.completed, "{:?}", o.halt);
        println!(
            "BIND k={k} wall={dt:?} computrons={} heap={}B slots_live={} chunk={}B side_charged={}B",
            m.meter_index() >> 16,
            live() - base,
            m.slots().live_count(),
            m.chunks().byte_size(),
            m.side_storage_bytes()
        );
    }
}

#[test]
fn e_meter_proportionality() {
    run_time(
        "baseline_int_loop_1e6",
        "var x = 0; for (var i = 0; i < 1000000; i++) x = (x + i) | 0; x",
    );
    run_time(
        "baseline_obj_alloc_2e5",
        "var x = 0; for (var i = 0; i < 200000; i++) x = {a: i}; 0",
    );
    run_time(
        "repeat_long_string_x10000",
        "var s = 'abcdefghij'.repeat(1000); var r = s.repeat(10000); r.length",
    );
    run_time(
        "repeat_1char_1e8",
        "var r = 'x'.repeat(100000000); r.length",
    );
    run_time(
        "padEnd_1e8",
        "var r = 'x'.padEnd(100000000); r.length",
    );
    run_time(
        "uint8array_1e8_fill",
        "var u = new Uint8Array(100000000); u.fill(7); u[5]",
    );
    run_time(
        "uint8array_alloc_2e8",
        "var u = new Uint8Array(200000000); u.length",
    );
    run_time(
        "arraybuffer_slice_1e8",
        "var u = new ArrayBuffer(100000000); var v = u.slice(0); v.byteLength",
    );
    run_time(
        "typedarray_sort_1e7",
        "var u = new Float64Array(10000000); for (var i = 0; i < 10; i++) u[i] = 10 - i; u.sort(); u[0]",
    );
    run_time(
        "typedarray_join_1e6",
        "var u = new Uint8Array(1000000); u.join('').length",
    );
    run_time(
        "sparse_join_1e7",
        "var a = []; a.length = 10000000; a.join().length",
    );
    run_time(
        "sparse_join_2e32m1_long_sep",
        "var a = []; a.length = 4294967295; a.join('').length",
    );
    run_time(
        "json_stringify_33M_string",
        "var s = 'x'; for (var k = 0; k < 25; k++) s += s; JSON.stringify(s).length",
    );
    run_time(
        "json_stringify_33M_quotes",
        "var s = '\"'; for (var k = 0; k < 24; k++) s += s; JSON.stringify(s).length",
    );
    run_time(
        "doubling_concat_25",
        "var s = 'x'; for (var k = 0; k < 25; k++) s += s; s.length",
    );
    run_time(
        "indexOf_worst_1e6_by_1e3",
        "var h = 'a'.repeat(1000000); var n = 'a'.repeat(1000) + 'b'; h.indexOf(n)",
    );
    run_time(
        "includes_worst_1e6_by_1e3",
        "var h = 'a'.repeat(1000000); var n = 'a'.repeat(1000) + 'b'; h.includes(n)",
    );
    run_time(
        "split_worst_1e6_by_1e3",
        "var h = 'a'.repeat(1000000); var n = 'a'.repeat(1000) + 'b'; h.split(n).length",
    );
    run_time(
        "replaceAll_1e6",
        "var h = 'a'.repeat(1000000); h.replaceAll('a', 'bb').length",
    );
    run_time(
        "bigint_mul_200k_bits",
        "var a = 3n ** 120000n; var b = a * a; b > 0n",
    );
    run_time(
        "bigint_tostring_100k_digits",
        "var a = 7n ** 120000n; a.toString().length",
    );
    run_time(
        "bigint_parse_100k_digits",
        "var s = '7'.repeat(100000); BigInt(s) > 0n",
    );
    run_time(
        "number_tostring_radix",
        "var x = 0; for (var i = 0; i < 100000; i++) x += (i * 1.1).toString(3).length; x",
    );
    run_time(
        "array_sort_1e5",
        "var a = []; for (var i = 0; i < 100000; i++) a.push((i * 7919) % 100003); a.sort(function (x, y) { return x - y; }); a[0]",
    );
    run_time(
        "array_sort_default_1e5",
        "var a = []; for (var i = 0; i < 100000; i++) a.push((i * 7919) % 100003); a.sort(); a[0]",
    );
    run_time(
        "normalize_1e6",
        "var s = '\\u0041\\u030A'.repeat(500000); s.normalize('NFC').length",
    );
    run_time(
        "toUpperCase_1e7",
        "var s = 'a'.repeat(10000000); s.toUpperCase().length",
    );
    run_time(
        "regexp_backtrack_26",
        "/(a+)+b/.test('a'.repeat(26))",
    );
    run_time(
        "localeCompare_1e6",
        "var a = 'a'.repeat(1000000); var b = 'a'.repeat(999999) + 'b'; a.localeCompare(b)",
    );
    run_time(
        "string_compare_1e7",
        "var a = 'a'.repeat(10000000); var b = 'a'.repeat(9999999) + 'b'; var n = 0; for (var i = 0; i < 20; i++) if (a < b) n++; n",
    );
    run_time(
        "string_eq_1e7_x20",
        "var a = 'a'.repeat(10000000); var b = 'a'.repeat(9999999) + 'b'; var n = 0; for (var i = 0; i < 20; i++) if (a === b) n++; n",
    );
    run_time(
        "charAt_loop_1e6_on_1e6",
        "var a = 'ab'.repeat(500000); var n = 0; for (var i = 0; i < 1000000; i++) n += a.charCodeAt(i); n",
    );
    run_time(
        "new_Array_2e32m1",
        "var a = new Array(4294967295); a.length",
    );
    run_time(
        "array_fill_sparse_1e6",
        "var a = new Array(1000000); a.fill(0); a.length",
    );
    run_time(
        "array_includes_sparse_1e7",
        "var a = []; a.length = 10000000; a.includes(1)",
    );
    run_time(
        "array_indexOf_sparse_2e32",
        "var a = []; a.length = 4294967295; a[4294967294] = 1; a.indexOf(1)",
    );
    run_time(
        "array_lastIndexOf_sparse_2e32",
        "var a = []; a.length = 4294967295; a[0] = 1; a.lastIndexOf(1)",
    );
    run_time(
        "array_reverse_sparse_1e7",
        "var a = []; a.length = 10000000; a[0] = 1; a.reverse(); a.length",
    );
    run_time(
        "object_keys_1e5",
        "var o = {}; for (var i = 0; i < 100000; i++) o['k' + i] = i; Object.keys(o).length",
    );
    run_time(
        "for_in_1e5",
        "var o = {}; for (var i = 0; i < 100000; i++) o['k' + i] = i; var n = 0; for (var k in o) n++; n",
    );
    run_time(
        "string_concat_loop_16000",
        "var s = ''; for (var i = 0; i < 16000; i++) s += 'x'; s.length",
    );
}
