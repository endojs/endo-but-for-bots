//! TEMPORARY verifier probe (vm-memory-gc-meter). Deleted after use.
#![allow(unsafe_code)]
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;
use ironhorse_vm::Interp;

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 { let p = unsafe { System.alloc(l) }; if !p.is_null() { LIVE.fetch_add(l.size(), Ordering::Relaxed); } p }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 { let p = unsafe { System.alloc_zeroed(l) }; if !p.is_null() { LIVE.fetch_add(l.size(), Ordering::Relaxed); } p }
    unsafe fn realloc(&self, ptr: *mut u8, l: Layout, n: usize) -> *mut u8 { let p = unsafe { System.realloc(ptr, l, n) }; if !p.is_null() { LIVE.fetch_sub(l.size(), Ordering::Relaxed); LIVE.fetch_add(n, Ordering::Relaxed); } p }
    unsafe fn dealloc(&self, ptr: *mut u8, l: Layout) { unsafe { System.dealloc(ptr, l) }; LIVE.fetch_sub(l.size(), Ordering::Relaxed); }
}
#[global_allocator]
static GLOBAL: Counting = Counting;
fn live() -> usize { LIVE.load(Ordering::Relaxed) }
fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}
fn mib(b: usize) -> f64 { b as f64 / 1048576.0 }

fn gc_after(name: &str, src: &str) {
    let (b, names) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&names);
    let c0 = m.meter_index();
    let o = m.run(&b);
    assert!(o.completed, "{name} {:?}", o.halt);
    let comp = (m.meter_index() - c0) >> 16;
    let t = Instant::now();
    let gc = m.collect_garbage().unwrap();
    println!("MEM2 {name}: build_computrons={comp} gc={:?} reclaimed={} live={}", t.elapsed(), gc.slots_reclaimed, gc.slots_live);
}

#[test]
fn mem2_gc_quadratic() {
    for n in [4000u32, 8000, 16000] {
        gc_after(&format!("own_getter_live_n{n}"), &format!("var keep = []; for (var i = 0; i < {n}; i++) keep.push({{ get x() {{ return 1; }} }}); 0"));
    }
    for n in [10000u32, 20000] {
        gc_after(&format!("shared_getter_live_n{n}"), &format!("var g = function () {{ return 1; }}; var keep = []; for (var i = 0; i < {n}; i++) keep.push(Object.defineProperty({{}}, 'x', {{ get: g }})); 0"));
    }
    for n in [2000u32, 4000, 8000] {
        gc_after(&format!("private2_live_n{n}"), &format!("var keep = []; class C {{ #a = 1; #b = 2; }} for (var i = 0; i < {n}; i++) keep.push(new C()); 0"));
    }
    for n in [8000u32, 16000] {
        gc_after(&format!("weakmap_chain_n{n}"), &format!("var wm = new WeakMap(); var k = {{}}; var head = k; for (var i = 0; i < {n}; i++) {{ var nx = {{}}; wm.set(k, nx); k = nx; }} k = null; nx = null; 0"));
    }
    for dead in [false, true] {
        let extra = if dead { "(function () { var o = {}; o[Symbol('d')] = 1; })();" } else { "" };
        gc_after(&format!("weakmap_chain4k_pad200k_deadsym={dead}"), &format!("{extra} var pad = []; for (var j = 0; j < 200000; j++) pad.push(j & 1 ? {{}} : 1); var wm = new WeakMap(); var k = {{}}; var head = k; for (var i = 0; i < 4000; i++) {{ var nx = {{}}; wm.set(k, nx); k = nx; }} k = null; nx = null; 0"));
    }
    gc_after("plain_objects_live_100k", "var keep = []; for (var i = 0; i < 100000; i++) keep.push({}); 0");
}

fn small_profile(name: &str, src: &str) {
    let (b, names) = compile(src);
    let base = live();
    let mut m = Interp::new();
    m.set_slot_ceiling(262_144).unwrap();
    m.set_chunk_ceiling(4 * 1024 * 1024).unwrap();
    m.link_intrinsics(&names);
    let o = m.run(&b);
    let out = if o.completed { o.result.chars().take(20).collect::<String>() } else { format!("{:?}", o.halt) };
    println!("MEM3 {name}: outcome={out} host_heap={:.1}MiB live_slots={} chunk={}B side_charged={}B", mib(live() - base), m.slots().live_count(), m.chunks().byte_size(), m.side_storage_bytes());
}

#[test]
fn mem3_uncharged_retention() {
    small_profile("bind_400x20k", "function f() {} var a = []; for (var i = 0; i < 20000; i++) a.push(i); var bs = []; for (var j = 0; j < 400; j++) bs.push(f.bind(null, ...a)); bs.length");
    small_profile("defer_4M", "var s = new DisposableStack(); var f = function () {}; for (var i = 0; i < 4000000; i++) s.defer(f); i");
    small_profile("finreg_register_3M", "var r = new FinalizationRegistry(function () {}); var t = {}; for (var i = 0; i < 3000000; i++) r.register(t, 1); i");
    small_profile("then_until_ceiling", "var p = new Promise(function () {}); for (;;) p.then(undefined);");
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
    let out = if o.completed { o.result.chars().take(20).collect::<String>() } else { format!("{:?}", o.halt) };
    println!("WORK {name}: wall={dt:?} computrons={comp} result={out}");
}

#[test]
fn mem4_mem5_work_vs_charge() {
    for n in [1_000_000u32, 4_000_000, 16_000_000] {
        timed(&format!("u8_fill_n{n}"), &format!("var u = new Uint8Array({n}); u.fill(7); u[1]"));
        timed(&format!("u8_alloc_only_n{n}"), &format!("var u = new Uint8Array({n}); u[1]"));
    }
    timed("u8_reverse_4M", "var u = new Uint8Array(4000000); u[0] = 1; u.reverse(); u[3999999]");
    for n in [5_000u32, 10_000, 20_000] {
        timed(&format!("f64_sort_reversed_n{n}"), &format!("var u = new Float64Array({n}); for (var i = 0; i < {n}; i++) u[i] = {n} - i; u.sort(); u[0]"));
        timed(&format!("f64_fillloop_only_n{n}"), &format!("var u = new Float64Array({n}); for (var i = 0; i < {n}; i++) u[i] = {n} - i; u[0]"));
    }
    for c in ["WeakMap", "Map"] {
        for n in [10_000u32, 40_000] {
            timed(&format!("{c}_delete_front_n{n}"), &format!("var wm = new {c}(); var ks = []; for (var i = 0; i < {n}; i++) {{ var o = {{}}; ks.push(o); wm.set(o, i); }} for (var i = 0; i < {n}; i++) wm.delete(ks[i]); 0"));
        }
    }
    timed("finreg_unregister_1M_x2000", "var r = new FinalizationRegistry(function () {}); var t = {}; var tok = {}; var i; for (i = 0; i < 1000000; i++) r.register(t, 1); for (i = 0; i < 2000; i++) r.unregister(tok); i");
    timed("finreg_base_1M_x2000", "var r = new FinalizationRegistry(function () {}); var t = {}; var tok = {}; var i; for (i = 0; i < 1000000; i++) r.register(t, 1); for (i = 0; i < 2000; i++) tok.x = i; i");
}

#[test]
fn mem7_not_returned() {
    for (name, src) in [
        ("obj_churn_400k", "var x; for (var i = 0; i < 400000; i++) x = {a: i}; x = 0; 0"),
        ("closure_churn_150k", "var last; for (var i = 0; i < 150000; i++) last = function () { return i; }; last = 0; 0"),
        ("promise_churn_100k", "var last; for (var i = 0; i < 100000; i++) last = new Promise(function () {}); last = 0; 0"),
        ("string_churn_50k_x1k", "var s = ''; var t = 'y'.repeat(1000); for (var i = 0; i < 50000; i++) s = t + i; s = 0; 0"),
    ] {
        let (b, names) = compile(src);
        let base = live();
        let mut m = Interp::new();
        m.link_intrinsics(&names);
        let boot = live() - base;
        assert!(m.run(&b).completed, "{name}");
        let run = live() - base;
        let chunk_before = m.chunks().byte_size();
        let gc = m.collect_garbage().unwrap();
        let after = live() - base;
        println!("MEM7 {name}: boot={:.1}MiB after_run={:.1}MiB after_gc={:.1}MiB reclaimed={} live_slots={} cap={} chunk_len {}->{}", mib(boot), mib(run), mib(after), gc.slots_reclaimed, gc.slots_live, m.slots().capacity(), chunk_before, m.chunks().byte_size());
    }
}

#[test]
fn mem8_fragmentation() {
    use ironhorse_vm::ChunkArena;
    let mut c = ChunkArena::new();
    let blk = vec![1u8; 100 * 1024];
    let offs: Vec<_> = (0..8).map(|_| c.alloc(&blk)).collect();
    let live = [offs[0], offs[3], offs[4], offs[7]];
    let before = c.byte_size();
    let remap = c.compact_local(&live);
    let after = c.byte_size();
    c.set_ceiling(after).unwrap();
    println!("MEM8 crossing: before={before} after={after} moved={} fit150K={} fit90K={}", remap.len(), c.can_allocate(150 * 1024), c.can_allocate(90 * 1024));
    let mut d = ChunkArena::new();
    let small = vec![2u8; 1000];
    let offs: Vec<_> = (0..60).map(|_| d.alloc(&small)).collect();
    let live: Vec<_> = offs.iter().enumerate().filter(|(i, _)| i % 5 != 0).map(|(_, o)| *o).collect();
    let before = d.byte_size();
    let remap = d.compact_local(&live);
    println!("MEM8 small20pct: before={before} after={} moved={}", d.byte_size(), remap.len());
}
