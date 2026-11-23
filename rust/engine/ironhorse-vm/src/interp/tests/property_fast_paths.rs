//! The property-access fast paths must leave the machine exactly as the
//! general paths do. Each program runs twice, with the fast paths on and
//! with them switched off (`property::fast_path_switch`), and the two
//! machines are compared whole: result, halt, computrons, dispatch count, raw
//! meter index, every live slot record (so the allocation sequence, property
//! order and flags) and the chunk arena's bytes.
use super::*;

/// Everything observable about a finished run, in comparable form.
fn fingerprint(source: &str, off: u8) -> String {
    super::property::fast_path_switch::OFF.with(|cell| cell.set(off));
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&crate::parse_symbols(&symbols));
    let outcome = vm.run(&code);
    super::property::fast_path_switch::OFF.with(|cell| cell.set(0));
    let mut out = format!(
        "completed={} result={:?} halt={:?} computrons={} dispatched={} raw={}\n",
        outcome.completed,
        outcome.result,
        outcome.halt,
        outcome.computrons_this_run,
        outcome.dispatched_this_run,
        vm.meter_index()
    );
    for i in 0..vm.slots.capacity() {
        let index = crate::value::SlotIndex(i);
        if !vm.slots.is_free_index(index) {
            out.push_str(&format!("{i} {:?}\n", vm.slots.get(index)));
        }
    }
    out.push_str(&format!("chunks {:?}\n", vm.chunks.raw_bytes()));
    out
}

/// Run `source` with every fast path in `bits` on and off; the machines
/// must be identical. Returns the result for the caller to pin.
pub(super) fn assert_fast_paths_unobservable(source: &str, bits: u8) -> String {
    let on = fingerprint(source, 0);
    let off = fingerprint(source, bits);
    assert!(
        on == off,
        "fast paths observable for {source}\n--- on\n{}\n--- off\n{}",
        &on[..on.len().min(600)],
        &off[..off.len().min(600)]
    );
    on.lines().next().unwrap().to_string()
}

/// Programs that write existing own properties in every shape the overwrite
/// fast path must take or refuse, with the expected result.
const OVERWRITES: &[(&str, &str)] = &[
    ("var o = { a: 1 }; for (var i = 0; i < 5; i++) o.a = o.a + i; o.a", "11"),
    ("(function () { var o = { a: 1, b: 2 }; o.b = 'x'; o.a = o; return o.b + (o.a === o); })()", "xtrue"),
    // Sealed: writable but non-configurable, which the write keeps.
    ("var o = Object.seal({ a: 1 }); o.a = 2; var d = Object.getOwnPropertyDescriptor(o, 'a'); [o.a, d.writable, d.configurable, d.enumerable].join()", "2,true,false,true"),
    // Frozen and non-writable: refused, silently and then strictly.
    ("var o = Object.freeze({ a: 1 }); o.a = 2; o.a", "1"),
    ("'use strict'; var o = Object.freeze({ a: 1 }); try { o.a = 2; 'no' } catch (e) { e.constructor.name + o.a }", "TypeError1"),
    ("var o = {}; Object.defineProperty(o, 'a', { value: 1, writable: false, configurable: true }); o.a = 2; o.a", "1"),
    // Non-enumerable writable keeps its enumerability.
    ("var o = {}; Object.defineProperty(o, 'a', { value: 1, writable: true }); o.a = 5; [o.a, Object.keys(o).length, Object.getOwnPropertyDescriptor(o, 'a').enumerable].join()", "5,0,false"),
    // Own accessors: the setter runs, a getter-only one refuses.
    ("var log = []; var o = { set a(v) { log.push(v); }, get a() { return 9; } }; o.a = 3; o.a = 4; log.join() + ':' + o.a", "3,4:9"),
    ("'use strict'; var o = { get a() { return 1; } }; try { o.a = 2; 'no' } catch (e) { e.constructor.name }", "TypeError"),
    // Redefining an accessor as data, then writing it.
    ("var o = { get a() { return 1; } }; Object.defineProperty(o, 'a', { value: 2, writable: true }); o.a = 3; o.a", "3"),
    // An inherited setter or read-only property is not an own property.
    ("var p = { set a(v) { this.b = v; } }; var o = Object.create(p); o.a = 7; [o.b, o.hasOwnProperty('a')].join()", "7,false"),
    ("var p = Object.freeze({ a: 1 }); var o = Object.create(p); o.a = 2; [o.a, o.hasOwnProperty('a')].join()", "1,false"),
    // A different receiver: Reflect.set and a super write.
    ("var o = { a: 1 }; var r = { a: 5 }; Reflect.set(o, 'a', 9, r); [o.a, r.a].join()", "1,9"),
    ("class A { m() { super.x = 4; return this.x; } } var a = new A(); a.x = 1; a.m()", "4"),
    // Proxies: as the object, as the receiver and as a prototype.
    ("var log = []; var p = new Proxy({ a: 1 }, { set(t, k, v, r) { log.push(k); t[k] = v; return true; } }); p.a = 2; p.a = 3; log.join() + p.a", "a,a3"),
    ("var t = { a: 1 }; var p = new Proxy(t, {}); p.a = 4; t.a", "4"),
    ("var log = []; var p = new Proxy({}, { set(t, k, v, r) { log.push(k); return Reflect.set(t, k, v, r); } }); var o = Object.create(p); o.own = 1; o.own = 2; log.join() + o.own", "own2"),
    // Arrays, arguments and typed arrays with named properties and length.
    ("var a = [1, 2]; a.x = 1; a.x = 2; a.length = 1; [a.x, a.length].join()", "2,1"),
    ("(function () { arguments.x = 1; arguments.x = 2; arguments.length = 7; return arguments.x + arguments.length; })(1)", "9"),
    ("var t = new Int8Array(2); t.x = 1; t.x = 2; t[0] = 300; [t.x, t[0]].join()", "2,44"),
    // Functions' synthesized and real properties.
    ("function f() {} f.x = 1; f.x = 2; f.name = 'g'; f.length = 9; [f.x, f.name, f.length].join()", "2,f,0"),
    ("function f() {} f.prototype = 5; f.prototype", "5"),
    // Globals and a frozen global property.
    ("var g = 1; g = 2; globalThis.g = 3; this.g = g + 1; g", "4"),
    ("Object.defineProperty(globalThis, 'k', { value: 1, writable: false }); k = 2; globalThis.k = 3; k", "1"),
    // A String wrapper's own named property; its length and indices refuse.
    ("var s = new String('ab'); s.x = 1; s.x = 2; s.length = 9; s[0] = 'z'; [s.x, s.length, s[0]].join()", "2,2,a"),
    // Delete then re-add, and overwrite after re-add.
    ("var o = { a: 1, b: 2 }; delete o.a; o.a = 3; o.a = 4; Object.keys(o).join() + o.a", "b,a4"),
    // Primitive receivers.
    ("'use strict'; try { 'x'.length = 2; 'no' } catch (e) { e.constructor.name }", "TypeError"),
    ("var n = 5; n.x = 1; n.x", "undefined"),
];

#[test]
fn own_overwrites_match_the_general_path() {
    for (source, expected) in OVERWRITES {
        let line = assert_fast_paths_unobservable(source, super::property::FAST_OWN_OVERWRITE);
        assert!(
            line.starts_with("completed=true") && line.contains(&format!("result={expected:?}")),
            "{source}: {line}"
        );
    }
}

/// The single-lookup `GET_PROPERTY` walk has no switch (it replaces the old
/// walk), so pin its answers in every shape the walk distinguishes.
#[test]
fn in_place_reads_answer_every_shape() {
    let cases: &[(&str, &str)] = &[
        ("var o = { a: 1 }; o.a", "1"),
        ("class A { m() { return 1; } } class B extends A {} class C extends B {} new C().m()", "1"),
        ("var p = { get a() { return this.v; } }; var o = Object.create(p); o.v = 3; o.a", "3"),
        ("var p = { set a(v) {} }; var o = Object.create(p); String(o.a)", "undefined"),
        ("var o = { get a() { return 2; } }; o.a", "2"),
        ("var o = Object.create(null); String(o.a)", "undefined"),
        ("function f(a, b) {} [f.length, f.name, typeof f.prototype].join()", "2,f,object"),
        ("function f() {} var o = Object.create(f); [o.length, o.name].join()", "0,f"),
        ("function f() {} delete f.name; f.name", ""),
        ("var o = Object.create([1, 2, 3]); [o.length, o[1]].join()", "3,2"),
        ("var o = Object.create(new String('xy')); [o.length, o[1]].join()", "2,y"),
        ("var o = Object.create(new Int8Array([5, 6])); try { o.length; } catch (e) { String(o[1]) + e.constructor.name }", "6TypeError"),
        ("var o = { 3: 'x' }; var c = Object.create(o); c[3] + c['3']", "xx"),
        ("var o = Object.create(new Proxy({}, { get(t, k) { return 'trap:' + String(k); } })); o.zz", "trap:zz"),
        ("var o = {}; Object.defineProperty(o, 'a', { get: undefined, set(v) {} }); String(o.a)", "undefined"),
        ("var s = 'abc'; [s.length, s[1], s.charAt(2)].join()", "3,b,c"),
    ];
    for (source, expected) in cases {
        let line = assert_fast_paths_unobservable(source, 0xff);
        assert!(
            line.starts_with("completed=true") && line.contains(&format!("result={expected:?}")),
            "{source}: {line}"
        );
    }
}

/// Programs that CREATE properties through `[[Set]]` and definitions, in the
/// shapes the creation shortcuts must leave alone: index-named keys routed
/// to the index store (spelled as numbers, strings and computed names),
/// receivers that differ from the object, inherited setters, Proxy, typed
/// array, String and function prototypes, non-extensible targets.
const CREATIONS: &[(&str, &str)] = &[
    ("function P(x) { this.x = x; this.y = x + 1; } var p = new P(1); Object.keys(p).join() + p.y", "x,y2"),
    ("var o = {}; o['7'] = 1; o[8] = 2; o.z = 3; var k = '9'; o[k] = 4; Object.keys(o).join()", "7,8,9,z"),
    ("var o = { '3': 'a' }; o['3'] = 'b'; o[3] = 'c'; Object.defineProperty(o, '4', { value: 'd', enumerable: true }); Object.keys(o).join() + o[3] + o[4]", "3,4cd"),
    ("var o = {}; Object.defineProperty(o, '5', { get() { return 'g'; } }); o['5'] = 1; o[5]", "g"),
    ("var a = []; a['2'] = 'x'; a.q = 1; [a.length, a[2], a.q].join()", "3,x,1"),
    ("var o = Object.preventExtensions({}); o.n = 1; String(o.n)", "undefined"),
    ("'use strict'; var o = Object.preventExtensions({}); try { o.n = 1; 'no' } catch (e) { e.constructor.name }", "TypeError"),
    ("var p = { set n(v) { this.m = v * 2; } }; var o = Object.create(p); o.n = 4; [o.m, o.hasOwnProperty('n')].join()", "8,false"),
    ("var o = {}; var r = {}; Reflect.set(o, 'n', 5, r); [String(o.n), r.n].join()", "undefined,5"),
    ("var r = Object.preventExtensions({}); [Reflect.set({}, 'n', 5, r), String(r.n)].join()", "false,undefined"),
    ("var t = {}; var p = new Proxy(t, {}); var o = Object.create(p); o.n = 6; [o.n, String(t.n)].join()", "6,undefined"),
    ("var o = Object.create(new Int8Array(2)); o[0] = 7; o.n = 8; [o[0], o.n, o.hasOwnProperty(0)].join()", "7,8,true"),
    ("var s = Object.create(new String('ab')); s[0] = 'z'; s[5] = 'y'; s.n = 1; [s[0], s[5], s.n].join()", "a,y,1"),
    ("function f() {} var o = Object.create(f); o.name = 'x'; o.length = 3; o.prototype = 1; [o.name, o.length, o.prototype, o.hasOwnProperty('prototype')].join()", "f,0,1,true"),
    ("for (var i = 0; i < 3; i++) globalThis['v' + i] = i; v0 + v1 + v2", "3"),
    ("class A { constructor() { this.a = 1; } } class B extends A { constructor() { super(); this.b = this.a + 1; } } var b = new B(); Object.keys(b).join() + b.b", "a,b2"),
    ("var o = {}; o.k = 1; delete o.k; o.k = 2; o.k", "2"),
];

#[test]
fn creations_match_the_general_path() {
    for (source, expected) in CREATIONS {
        let line = assert_fast_paths_unobservable(
            source,
            super::property::FAST_OWN_OVERWRITE | super::property::FAST_SET_ABSENT,
        );
        assert!(
            line.starts_with("completed=true") && line.contains(&format!("result={expected:?}")),
            "{source}: {line}"
        );
    }
}
