//! TEMPORARY audit probe (vm-natives-objects region). Not part of the tree.
//! (1) computrons vs wall time for native built-ins with suspected unmetered
//! super-linear work; (2) host bytes vs side-storage charge per array item /
//! collection entry / FinalizationRegistry cell; (3) AsyncDisposableStack
//! await ordering; (4) key-space consumption by a sort persisting into the
//! next crank.
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

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

fn armed(names: &[ironhorse_vm::SymbolName]) -> Interp {
    let mut m = Interp::new();
    m.link_intrinsics(names);
    m.arm_meter(1u64 << 40, Box::new(|_| true));
    m
}

/// Run `setup` then `work` in two cranks; report computrons and wall time of `work`.
fn meter(name: &str, setup: &str, work: &str) {
    let (b0, n0) = compile(setup);
    let (b1, n1) = compile(work);
    let mut m = armed(&n0);
    let o = m.run(&b0);
    assert!(o.completed, "{name} setup {:?}", o.halt);
    let b1 = m.relink_crank(&b1, &n1).expect("relink");
    let i0 = m.meter_index();
    let t = Instant::now();
    let o = m.run(&b1);
    let dt = t.elapsed();
    let ct = (m.meter_index() - i0) >> 16;
    println!(
        "METER {name}: computrons={ct} wall={:.3}s ns/computron={:.1} completed={} halt={:?}",
        dt.as_secs_f64(),
        dt.as_nanos() as f64 / ct.max(1) as f64,
        o.completed,
        o.halt
    );
}

#[test]
fn a_meter_vs_wall() {
    let base = "var N = 20000; var keep = [];";
    meter("baseline_loop_2M", base, "var x = 0; for (var i = 0; i < 2000000; i++) { x = (x + i) | 0; }");
    meter("array_push_pop_200k", base, "var a = []; for (var i = 0; i < 200000; i++) a.push(i); while (a.length) a.pop();");
    meter("array_shift_10k", "var a = []; for (var i = 0; i < 10000; i++) a.push(i);", "while (a.length) a.shift();");
    meter("array_splice_end_10k", "var a = []; for (var i = 0; i < 10000; i++) a.push(i);", "for (var i = 0; i < 10000; i++) a.splice(a.length - 1, 1);");
    meter("set_union_20k", "var a = new Set(), b = new Set(); for (var i = 0; i < 20000; i++) { a.add(i); b.add(i + 20000); }", "var u = a.union(b);");
    meter("set_difference_20k", "var a = new Set(), b = new Set(); for (var i = 0; i < 20000; i++) { a.add(i); b.add(i); }", "var u = a.difference({ size: 1e9, has: function (v) { return v % 2 === 0; }, keys: function () { return [][Symbol.iterator](); } });");
    meter("weakmap_delete_20k", "var ks = []; for (var i = 0; i < 20000; i++) ks.push({}); var w = new WeakMap(); for (var k of ks) w.set(k, 1);", "for (var k of ks) w.delete(k);");
    meter("map_delete_20k", "var ks = []; for (var i = 0; i < 20000; i++) ks.push({}); var w = new Map(); for (var k of ks) w.set(k, 1);", "for (var k of ks) w.delete(k);");
    meter("fr_unregister_200kx5k", "var fr = new FinalizationRegistry(function () {}); var t = {}, tok = {}; for (var i = 0; i < 200000; i++) fr.register(t, i, tok); var other = {};", "for (var i = 0; i < 5000; i++) fr.unregister(other);");
    meter("ta_sort_default_20k", "var t = new Int32Array(20000); for (var i = 0; i < 20000; i++) t[i] = 20000 - i;", "t.sort();");
    meter("array_sort_default_longstr", "var s = 'x'.repeat(100000); var a = []; for (var i = 0; i < 2000; i++) a.push(s);", "a.sort();");
    meter("array_sort_default_num_30k", "var a = []; for (var i = 0; i < 30000; i++) a.push((i * 7919) % 30011);", "a.sort();");
    meter("groupBy_distinct_20k", "var xs = []; for (var i = 0; i < 20000; i++) xs.push(i);", "var g = Map.groupBy(xs, function (x) { return x; });");
    meter("ab_resize_churn_64x4MB", "var b = new ArrayBuffer(4 << 20, { maxByteLength: 4 << 20 });", "for (var i = 0; i < 64; i++) b.resize((4 << 20) - (i & 1) * 8);");
}

fn live() -> usize {
    LIVE.load(Ordering::Relaxed)
}

fn bytes(name: &str, setup: &str, work: &str, n: f64) {
    let (b0, n0) = compile(setup);
    let (b1, n1) = compile(work);
    let mut m = armed(&n0);
    let o = m.run(&b0);
    assert!(o.completed, "{name} setup {:?}", o.halt);
    let b1 = m.relink_crank(&b1, &n1).expect("relink");
    let h0 = live();
    let s0 = m.side_storage_bytes();
    let c0 = m.chunks().byte_size();
    let o = m.run(&b1);
    assert!(o.completed, "{name} work {:?}", o.halt);
    let h1 = live();
    let s1 = m.side_storage_bytes();
    let c1 = m.chunks().byte_size();
    println!(
        "BYTES {name}: host/unit={:.1} side-charged/unit={:.1} chunk/unit={:.1}",
        (h1 as f64 - h0 as f64) / n,
        (s1 as f64 - s0 as f64) / n,
        (c1 as f64 - c0 as f64) / n
    );
}

#[test]
fn b_bytes_per_unit() {
    let setup = "var keep = [];";
    bytes("array_int_items_262144", setup, "var a = []; for (var i = 0; i < 262144; i++) a.push(i); keep.push(a);", 262144.0);
    bytes("map_int_entries_131072", setup, "var m = new Map(); for (var i = 0; i < 131072; i++) m.set(i, i); keep.push(m);", 131072.0);
    bytes("fr_cells_262144", "var keep = []; var fr = new FinalizationRegistry(function () {}); var t = {};", "for (var i = 0; i < 262144; i++) fr.register(t, i);", 262144.0);
    bytes("uint8array_1MB", setup, "keep.push(new Uint8Array(1 << 20));", 1048576.0);
}

fn read_global(m: &mut Interp, expr: &str) -> String {
    let (b, n) = compile(&format!("throw new Error(JSON.stringify({expr}));"));
    let b = m.relink_crank(&b, &n).expect("relink");
    let o = m.run(&b);
    format!("{:?}", o.halt)
}

#[test]
fn c_async_dispose_awaits() {
    let src = r#"
var R = { log: [], settled: 'pending' };
var s = new AsyncDisposableStack();
s.defer(async function () { R.log.push('a-start'); await null; await null; R.log.push('a-end'); });
s.defer(async function () { R.log.push('b-start'); await null; R.log.push('b-end'); throw new Error('boom'); });
s.disposeAsync().then(function () { R.settled = 'fulfilled'; R.log.push('settled'); }, function (e) { R.settled = 'rejected:' + e.message; R.log.push('settled'); });
R.log.push('sync-after');
"#;
    let (b, n) = compile(src);
    let mut m = armed(&n);
    let o = m.run(&b);
    println!("ASYNC run completed={} halt={:?}", o.completed, o.halt);
    println!("ASYNC R = {}", read_global(&mut m, "R"));
}

#[test]
fn d_sort_keyspace_persists_across_cranks() {
    let (b, n) = compile("var a = []; for (var i = 0; i < 60000; i++) a.push(60000 - i); a.sort(function (x, y) { return x - y; }); var ok = a[0] === 1;");
    let mut m = armed(&n);
    let o = m.run(&b);
    println!("KEYS crank1 completed={} halt={:?}", o.completed, o.halt);
    let (b2, n2) = compile("var o = {}; var made = 0; try { for (var j = 0; j < 8000; j++) { o['fresh' + j] = j; made++; } } catch (e) { throw new Error('crank2 made ' + made + ' then ' + e.name + ': ' + e.message); } throw new Error('crank2 made ' + made);");
    let b2 = m.relink_crank(&b2, &n2).expect("relink");
    let o = m.run(&b2);
    println!("KEYS crank2 halt={:?}", o.halt);
    let (b3, n3) = compile("var p = {}; var made2 = 0; try { for (var j = 0; j < 8000; j++) { p['fresh' + j] = j; made2++; } } catch (e) { throw new Error('control made ' + made2 + ' then ' + e.name); } throw new Error('control made ' + made2);");
    let mut c = armed(&n3);
    let o = c.run(&b3);
    println!("KEYS control (fresh machine) halt={:?}", o.halt);
}
