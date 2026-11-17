//! TEMPORARY audit probe 2 (vm-memory-gc-meter region). Not part of the tree.
//! Per-unit resident cost of more value kinds, and guest-controlled GC /
//! native work versus the computrons charged for it.
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

fn per_unit(name: &str, setup: &str, work: &str, n: f64) {
    let (b0, n0) = compile(setup);
    let (b1, n1) = compile(work);
    let mut m = Interp::new();
    m.link_intrinsics(&n0);
    let o = m.run(&b0);
    assert!(o.completed, "{name} setup {:?}", o.halt);
    let b1 = m.relink_crank(&b1, &n1).expect("relink");
    let bytes0 = live();
    let slots0 = m.slots().live_count();
    let chunk0 = m.chunks().byte_size();
    let side0 = m.side_storage_bytes();
    let c0 = m.meter_index();
    let o = m.run(&b1);
    assert!(o.completed, "{name} work {:?}", o.halt);
    let c1 = m.meter_index();
    println!(
        "UNIT {name}: heapB/unit={:.1} slots/unit={:.2} chunkB/unit={:.1} chargedSideB/unit={:.1} computrons/unit={:.1}",
        (live() as f64 - bytes0 as f64) / n,
        (m.slots().live_count() as f64 - slots0 as f64) / n,
        (m.chunks().byte_size() as f64 - chunk0 as f64) / n,
        (m.side_storage_bytes() as f64 - side0 as f64) / n,
        ((c1 - c0) >> 16) as f64 / n,
    );
}

#[test]
fn a_more_per_unit_costs() {
    let keep = "var keep = [];";
    let n = 20_000.0;
    let w = |body: &str| format!("var keep; for (var i = 0; i < 20000; i++) keep.push({body}); 0");
    per_unit("baseline_array_push_int", keep, &w("i"), n);
    per_unit("pending_promise", keep, &w("new Promise(function () {})"), n);
    per_unit(
        "then_on_one_pending_promise",
        "var p = new Promise(function () {}); var keep = [];",
        "var p, keep; for (var i = 0; i < 20000; i++) p.then(undefined); 0",
        n,
    );
    per_unit(
        "suspended_async_call",
        "var never = new Promise(function () {}); async function f() { await never; } var keep = [];",
        &w("f()"),
        n,
    );
    per_unit(
        "suspended_generator",
        "function* g() { yield 1; yield 2; } var keep = [];",
        &w("(function () { var it = g(); it.next(); return it; })()"),
        n,
    );
    per_unit(
        "bound_function_no_args",
        "function f() {} var keep = [];",
        &w("f.bind(null)"),
        n,
    );
    per_unit("symbol", keep, &w("Symbol()"), n);
    per_unit("error", keep, &w("new Error('x')"), n);
    per_unit("regexp_literal", keep, &w("/ab+c/g"), n);
    per_unit("date", keep, &w("new Date(0)"), n);
    per_unit("proxy", keep, &w("new Proxy({}, {})"), n);
    per_unit(
        "class_instance_2_public_fields",
        "var P = class { a = 1; b = 2; }; var keep = [];",
        &w("new P()"),
        n,
    );
    per_unit(
        "class_instance_2_private_fields",
        "var Q = class { #a = 1; #b = 2; }; var keep = [];",
        &w("new Q()"),
        n,
    );
    per_unit(
        "object_with_shared_getter",
        "var g = function () { return 1; }; var keep = [];",
        &w("Object.defineProperty({}, 'x', { get: g })"),
        n,
    );
    per_unit(
        "set_of_objects_entry",
        "var s = new Set(); var keep = [];",
        "var s; for (var i = 0; i < 20000; i++) s.add({}); 0",
        n,
    );
    per_unit(
        "weakmap_entry",
        "var wm = new WeakMap(); var keep = [];",
        "var wm, keep; for (var i = 0; i < 20000; i++) { var k = {}; keep.push(k); wm.set(k, i); } 0",
        n,
    );
    per_unit(
        "named_function_decl_in_eval_loop",
        keep,
        &w("(function named_fn_xxxxxxxx() {})"),
        n,
    );
}

fn timed(name: &str, src: &str) {
    let (b, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let c0 = m.meter_index();
    let t = Instant::now();
    let o = m.run(&b);
    let dt = t.elapsed();
    let comp = (m.meter_index() - c0) >> 16;
    let outcome = if o.completed {
        o.result.chars().take(30).collect::<String>()
    } else {
        format!("{:?}", o.halt)
    };
    println!(
        "WORK {name}: wall={dt:?} computrons={comp} ns/computron={:.1} result={outcome}",
        dt.as_nanos() as f64 / comp.max(1) as f64
    );
}

#[test]
fn b_native_work_vs_charge() {
    for n in [5_000u32, 10_000, 20_000] {
        timed(
            &format!("f64array_sort_default_reversed_n{n}"),
            &format!("var u = new Float64Array({n}); for (var i = 0; i < {n}; i++) u[i] = {n} - i; u.sort(); u[0]"),
        );
    }
    for n in [1_000_000u32, 4_000_000, 16_000_000] {
        timed(
            &format!("u8array_fill_n{n}"),
            &format!("var u = new Uint8Array({n}); u.fill(7); u[1]"),
        );
    }
    for n in [1_000_000u32, 4_000_000] {
        timed(
            &format!("u8array_reverse_n{n}"),
            &format!("var u = new Uint8Array({n}); u[0] = 1; u.reverse(); u[{n} - 1]"),
        );
    }
    for n in [1_000_000u32, 4_000_000] {
        timed(
            &format!("u8array_alloc_only_n{n}"),
            &format!("var u = new Uint8Array({n}); u[1]"),
        );
    }
}

fn gc_after(name: &str, src: &str) {
    let (b, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let c0 = m.meter_index();
    let t = Instant::now();
    let o = m.run(&b);
    let run = t.elapsed();
    assert!(o.completed, "{name} {:?}", o.halt);
    let comp = (m.meter_index() - c0) >> 16;
    let cap = m.slots().capacity();
    let t = Instant::now();
    let gc = m.collect_garbage().unwrap();
    let gct = t.elapsed();
    println!(
        "GC {name}: run={run:?} computrons={comp} cap={cap} gc={gct:?} reclaimed={} live={}",
        gc.slots_reclaimed, gc.slots_live
    );
}

#[test]
fn c_gc_guest_controlled() {
    for n in [5_000u32, 10_000, 20_000] {
        gc_after(
            &format!("shared_getter_objects_live_n{n}"),
            &format!(
                "var g = function () {{ return 1; }}; var keep = []; \
                 for (var i = 0; i < {n}; i++) keep.push(Object.defineProperty({{}}, 'x', {{ get: g }})); 0"
            ),
        );
    }
    // Ephemeron rounds times O(capacity) symbol-key scans: a dead symbol-keyed
    // property leaves an unmarked descriptor wanted in every round.
    for (n, dead_symbol) in [(4_000u32, false), (4_000, true), (8_000, false), (8_000, true)] {
        let extra = if dead_symbol {
            "(function () { var o = {}; o[Symbol('d')] = 1; })();"
        } else {
            ""
        };
        gc_after(
            &format!("weakmap_chain_n{n}_plus_200k_live_dead_symbol={dead_symbol}"),
            &format!(
                "{extra} var pad = []; for (var j = 0; j < 200000; j++) pad.push(j & 1 ? {{}} : 1); \
                 var wm = new WeakMap(); var head = {{}}; var k = head; \
                 for (var i = 0; i < {n}; i++) {{ var nx = {{}}; wm.set(k, nx); k = nx; }} k = null; nx = null; 0"
            ),
        );
    }
    // Sweep cost is O(capacity) even when nothing is live: churn then collect twice.
    let (b, names) = compile("var x; for (var i = 0; i < 400000; i++) x = {a: i}; x = 0; 0");
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    assert!(m.run(&b).completed);
    let t = Instant::now();
    let g1 = m.collect_garbage().unwrap();
    let d1 = t.elapsed();
    let t = Instant::now();
    let g2 = m.collect_garbage().unwrap();
    let d2 = t.elapsed();
    println!(
        "GC capacity_bound: cap={} first={d1:?} (reclaimed {}) second={d2:?} (reclaimed {}, live {})",
        m.slots().capacity(),
        g1.slots_reclaimed,
        g2.slots_reclaimed,
        g2.slots_live
    );
}

/// Host memory under the WASM-MEMORY.md "128 MB Cloudflare isolate" profile
/// (262,144 slots, 4 MiB of chunks), which that document says keeps every
/// phase within 69 MiB.
fn under_small_profile(name: &str, src: &str) {
    let (b, names) = compile(src);
    let base = live();
    let mut m = Interp::new();
    m.set_slot_ceiling(262_144).unwrap();
    m.set_chunk_ceiling(4 * 1024 * 1024).unwrap();
    m.link_intrinsics(&names);
    let o = m.run(&b);
    let outcome = if o.completed {
        o.result.chars().take(30).collect::<String>()
    } else {
        format!("{:?}", o.halt)
    };
    println!(
        "PROFILE {name}: outcome={outcome} host_heap={:.1}MiB live_slots={} chunk={}B side_charged={}B",
        (live() - base) as f64 / 1048576.0,
        m.slots().live_count(),
        m.chunks().byte_size(),
        m.side_storage_bytes()
    );
}

#[test]
fn d_small_profile_uncharged_growth() {
    under_small_profile(
        "suspended_async_until_ceiling",
        "var never = new Promise(function () {}); async function f() { await never; } \
         var i = 0; for (;;) { f(); i++; }",
    );
    under_small_profile(
        "then_until_ceiling",
        "var p = new Promise(function () {}); for (;;) p.then(undefined);",
    );
    under_small_profile(
        "disposable_defer_4M",
        "var s = new DisposableStack(); var f = function () {}; \
         for (var i = 0; i < 4000000; i++) s.defer(f); i",
    );
    under_small_profile(
        "bind_args_400x20k",
        "function f() {} var a = []; for (var i = 0; i < 20000; i++) a.push(i); var bs = []; \
         for (var j = 0; j < 400; j++) bs.push(f.bind(null, ...a)); bs.length",
    );
}

#[test]
fn e_side_tables_not_shrunk_after_gc() {
    for (name, src) in [
        (
            "closure_churn_150k",
            "var last; for (var i = 0; i < 150000; i++) last = function () { return i; }; last = 0; 0",
        ),
        (
            "promise_churn_100k",
            "var last; for (var i = 0; i < 100000; i++) last = new Promise(function () {}); last = 0; 0",
        ),
    ] {
        let (b, names) = compile(src);
        let base = live();
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        let boot = live() - base;
        let o = m.run(&b);
        assert!(o.completed, "{name} {:?}", o.halt);
        let after_run = live() - base;
        let gc = m.collect_garbage().unwrap();
        let after_gc = live() - base;
        println!(
            "SHRINK {name}: boot={:.1}MiB after_run={:.1}MiB after_gc={:.1}MiB reclaimed={} live_slots={} slot_resident={:.1}MiB",
            boot as f64 / 1048576.0,
            after_run as f64 / 1048576.0,
            after_gc as f64 / 1048576.0,
            gc.slots_reclaimed,
            gc.slots_live,
            m.slots().resident_byte_size() as f64 / 1048576.0
        );
    }
}

#[test]
fn f_drop_residual_is_not_per_machine() {
    let (b, n) = compile("var x = {a: 1}; [1, 2, 3].map(function (v) { return v + 1; }); new Map([[1, 2]]); 'ok'");
    let mut residuals = Vec::new();
    let base = live();
    for round in 0..50 {
        let mut m = Interp::new();
        m.link_intrinsics(&n);
        assert!(m.run(&b).completed);
        drop(m);
        if round == 0 || round == 9 || round == 49 {
            residuals.push((round + 1, live() as isize - base as isize));
        }
    }
    println!("DROP residual after N machines (bytes): {residuals:?}");
}
