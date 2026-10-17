//! TEMPORARY audit probe (vm-property-model region, run 2). Not part of the tree.
//! Measures host bytes per property for named chains, the derived
//! PropertyIndex, the ordinary index store, and arrays.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering};

struct Counting;
static LIVE: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

fn bump(n: usize) {
    let live = LIVE.fetch_add(n, Ordering::Relaxed) + n;
    PEAK.fetch_max(live, Ordering::Relaxed);
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc(layout) };
        if !p.is_null() {
            bump(layout.size());
        }
        p
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        let p = unsafe { System.alloc_zeroed(layout) };
        if !p.is_null() {
            bump(layout.size());
        }
        p
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let p = unsafe { System.realloc(ptr, layout, new_size) };
        if !p.is_null() {
            LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
            bump(new_size);
        }
        p
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size(), Ordering::Relaxed);
    }
}

#[global_allocator]
static A: Counting = Counting;

fn peak_of(source: &str) -> (usize, bool, String) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    let start = LIVE.load(Ordering::Relaxed);
    PEAK.store(start, Ordering::Relaxed);
    let out = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);
    let peak = PEAK.load(Ordering::Relaxed) - start;
    (peak, out.completed, format!("{:?}", out.halt))
}

#[test]
fn property_bytes() {
    const N: usize = 20_000;
    let build = format!("var o = {{}}; for (var i = 0; i < {N}; i++) o['k' + i] = i;");
    let cases = [
        ("strings_only", format!("for (var i = 0; i < {N}; i++) {{ var s = 'k' + i; }}")),
        ("named_one_object", build.clone()),
        ("named_one_object+miss", format!("{build} var miss = o.zzNotThere;")),
        (
            "named_two_objects",
            format!("{build} var p = {{}}; for (var i = 0; i < {N}; i++) p['k' + i] = i;"),
        ),
        (
            "named_two_objects+miss",
            format!("{build} var p = {{}}; for (var i = 0; i < {N}; i++) p['k' + i] = i; var m1 = o.zzNotThere; var m2 = p.zzNotThere;"),
        ),
        (
            "small_objects_8_props",
            format!("var keep = []; for (var j = 0; j < {N} / 8; j++) {{ var q = {{}}; q.a = 1; q.b = 2; q.c = 3; q.d = 4; q.e = 5; q.f = 6; q.g = 7; q.h = 8; keep.push(q); }}"),
        ),
        (
            "small_objects_8_props_proto_miss",
            format!("var keep = []; for (var j = 0; j < {N} / 8; j++) {{ var q = {{}}; q.a = 1; q.b = 2; q.c = 3; q.d = 4; q.e = 5; q.f = 6; q.g = 7; q.h = 8; keep.push(q); }} for (var j = 0; j < {N} / 8; j++) keep[j].zzNotThere;"),
        ),
        ("index_store", format!("var o = {{}}; for (var i = 0; i < {N}; i++) o[i] = i;")),
        ("array_push", format!("var a = []; for (var i = 0; i < {N}; i++) a.push(i);")),
        ("loop_only", format!("for (var i = 0; i < {N}; i++) {{}}")),
        (
            "small_objects_8_accessors",
            format!("var keep = []; for (var j = 0; j < {N} / 8; j++) {{ var q = {{ get a() {{ return 1; }}, get b() {{ return 1; }}, get c() {{ return 1; }}, get d() {{ return 1; }}, get e() {{ return 1; }}, get f() {{ return 1; }}, get g() {{ return 1; }}, get h() {{ return 1; }} }}; keep.push(q); }}"),
        ),
    ];
    let mut results = Vec::new();
    let only = std::env::var("ONLY").ok();
    for (name, source) in &cases {
        if let Some(o) = &only { if !o.split(',').any(|x| x == *name) { results.push((name.to_string(), 0)); continue; } }
        let t = std::time::Instant::now();
        let (peak, completed, halt) = peak_of(source);
        println!("{name:24} peak={peak:>12} completed={completed} halt={halt} t={:?}", t.elapsed());
        results.push((name.to_string(), peak));
    }
    let get = |n: &str| results.iter().find(|(k, _)| k == n).unwrap().1 as f64;
    let per = |a: &str, b: &str| (get(a) - get(b)) / N as f64;
    println!("first object incl. key table, bytes/prop: {:.1}", per("named_one_object", "strings_only"));
    println!("second object (slot chain only), bytes/prop: {:.1}", per("named_two_objects", "named_one_object"));
    println!("PropertyIndex for one object, bytes/prop: {:.1}", per("named_one_object+miss", "named_one_object"));
    println!("PropertyIndex for two objects, bytes/prop: {:.1}", per("named_two_objects+miss", "named_two_objects") / 2.0);
    println!("small objects (8 props, no index), bytes/prop: {:.1}", per("small_objects_8_props", "loop_only"));
    println!("ordinary index store, bytes/prop: {:.1}", per("index_store", "loop_only"));
    println!("array element (push), bytes/elem: {:.1}", per("array_push", "loop_only"));
    println!("small objects (8 getters), bytes/prop: {:.1}", per("small_objects_8_accessors", "loop_only"));
}
