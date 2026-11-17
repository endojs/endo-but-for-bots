//! TEMPORARY audit probe (ontology/types). Delete after use.
use ironhorse_vm::Interp;

fn compile(src: &str) -> (Vec<u8>, Vec<ironhorse_vm::SymbolName>) {
    let (b, s) = ironhorse_compile::compile_atoms(src).expect("compiles");
    (b, ironhorse_vm::parse_symbols(&s))
}

const MINT: &str = "var n = 0; var err = 'none'; \
    try { for (var i = 0; i < 40000; i++) { var o = {}; o[Symbol('s')] = i; n = i + 1; } } \
    catch (e) { err = e.name + ':' + e.message; } \
    'minted=' + n + ' err=' + err";

#[test]
fn symbol_key_ids_are_not_recycled_by_gc() {
    let (b1, n1) = compile(MINT);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    println!("crank1: completed={} result={}", o1.completed, o1.result);
    let before = m.slots().free_list().len();
    let stats = m.collect_garbage().unwrap();
    let after = m.slots().free_list().len();
    println!("gc: {:?} free_list {} -> {}", stats, before, after);
    let (b2, n2) = compile(MINT);
    let b2 = m.relink_crank(&b2, &n2).expect("relink");
    let o2 = m.run(&b2);
    println!("crank2 (after GC): completed={} result={}", o2.completed, o2.result);
    m.collect_garbage().unwrap();
    let (b3, n3) = compile("var k = 'fresh' + 1; var o = {}; var r = 'ok'; try { o[k] = 1; } catch (e) { r = e.name + ':' + e.message; } r");
    let b3 = m.relink_crank(&b3, &n3).expect("relink");
    let o3 = m.run(&b3);
    println!("crank3 (fresh string key after GC): completed={} result={}", o3.completed, o3.result);
}

#[test]
fn copied_out_values_carry_no_key_id_into_rows() {
    let src = "var S = Symbol('k'); var src = {}; src[S] = 'symval'; src.plain = 'p'; \
        Object.defineProperty(src, 'hidden', { value: 'h', enumerable: false, writable: false }); \
        var arr = []; var m = new Map(); var st = new Set(); \
        arr.push(src[S]); arr.push(src.plain); arr.push(src.hidden); \
        Object.values(src).forEach(function (v) { arr.push(v); }); \
        Object.entries(src).forEach(function (e) { arr.push(e[1]); m.set(e[0], e[1]); }); \
        var cp = Object.assign({}, src); arr.push(cp[S]); \
        var sp = { ...src }; arr.push(sp[S]); m.set(S, sp[S]); st.add(sp[S]); \
        var ds = Object.getOwnPropertyDescriptors(src); arr.push(ds[S].value); arr.push(ds.hidden.value); \
        var { [S]: dv } = src; arr.push(dv); \
        for (var k in src) arr.push(src[k]); \
        arr.push(Reflect.get(src, S)); \
        arr.push(Object.getOwnPropertyDescriptor(src, S).value); \
        var mapped = [1].map(function () { return src[S]; }); arr.push(mapped[0]); \
        var fe = Object.fromEntries([[S, src[S]]]); arr.push(fe[S]); \
        var ar2 = []; Object.defineProperty(ar2, 0, Object.getOwnPropertyDescriptor(src, S)); arr.push(ar2[0]); \
        var g = Object.groupBy([src[S]], function () { return 'x'; }); arr.push(g.x[0]); \
        arr.push(...[src[S], src.hidden]); arr = arr.concat([src[S]]); \
        var w = arr.with(0, src.hidden); var ts = arr.toSorted(); var fl = [[src[S]]].flat(); \
        var ws = new WeakMap(); ws.set(src, src[S]); \
        var ar3 = Array.from(Object.getOwnPropertySymbols(src), function (s) { return src[s]; }); \
        globalThis.keep = [arr, m, st, w, ts, fl, ar2, ar3, ws, src]; arr.length";
    let (b1, n1) = compile(src);
    let mut m = Interp::new();
    m.link_intrinsics(&n1);
    let o1 = m.run(&b1);
    println!("completed={} result={} halt={:?}", o1.completed, o1.result, o1.halt);
    let mut stray = Vec::new();
    for (owner, _len, items) in m.arrays_snapshot() {
        for (i, s) in items {
            if s.id != 0 {
                stray.push(format!("array owner {owner} item {i}: id={} flag={:#x} kind={:?}", s.id, s.flag, s.kind));
            }
        }
    }
    for (owner, _len, items) in m.index_props_snapshot() {
        for (i, s) in items {
            if s.id != 0 {
                stray.push(format!("index_props owner {owner} item {i}: id={} flag={:#x}", s.id, s.flag));
            }
        }
    }
    for (owner, kind, _tl, entries) in m.collections_snapshot() {
        for (k, v) in entries {
            for (label, s) in [("key", k), ("value", v)] {
                if s.id != 0 || s.flag != 0 {
                    stray.push(format!("collection owner {owner} kind {kind} {label}: id={} flag={:#x} kind={:?}", s.id, s.flag, s.kind));
                }
            }
        }
    }
    for (i, s) in m.stack_slots().iter().enumerate() {
        if s.id != 0 {
            stray.push(format!("stack {i}: id={} flag={:#x}", s.id, s.flag));
        }
    }
    println!("stray-key-id rows: {}", stray.len());
    for s in &stray {
        println!("  {s}");
    }
}
