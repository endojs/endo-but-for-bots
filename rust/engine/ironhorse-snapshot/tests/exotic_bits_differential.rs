//! The exotic-membership words (`ironhorse-vm/src/exotic_bits.rs`) let property
//! reads and writes skip the exotic side-table probes for an instance in none
//! of them. Skipping must be unobservable: every program here runs as three
//! cranks on two fresh machines, one with the fast paths on and one with them
//! switched off (`diagnostics::set_exotic_bits_disabled`, debug builds only),
//! with a full collection, a snapshot and restore, or both between cranks, and
//! the two runs must agree on every crank's completion, halt, result,
//! computrons, dispatch count and raw meter index, and on the snapshot bytes
//! after every crank (which carry every slot record and the chunk arena).
//! After every crank and every restore the superset invariant itself is
//! checked: every key of every exotic table has its bit set.
//!
//! The programs cover each exotic table (arrays and `arguments`, index-named
//! keys on ordinary objects, primitive wrappers, the four Temporal tables,
//! disposable stacks, buffers, typed arrays and data views, regexps, Intl
//! locales and collators, functions of every kind, proxies), each as the
//! receiver and as a prototype, plus accessors, frozen and sealed objects,
//! prototype changes, delete and re-add, and slot reuse after collection.
#![cfg(debug_assertions)]

#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::diagnostics::set_exotic_bits_disabled;
use ironhorse_vm::Interp;

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

#[derive(Clone, Copy, Debug)]
enum Between {
    Nothing,
    Collect,
    Restore,
    Both,
}

/// One crank's observable outcome and the machine's snapshot after it.
fn observe(machine: &mut Interp, source: &str, first: bool) -> (String, Vec<u8>) {
    let (bytecode, names) = compile(source);
    let outcome = if first {
        machine.link_intrinsics(&names);
        machine.run(&bytecode)
    } else {
        let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
        machine.run(&bytecode)
    };
    assert!(
        machine.exotic_bits_cover_tables(),
        "a key without its bit after {source}"
    );
    let line = format!(
        "completed={} halt={:?} result={:?} computrons={} dispatched={} raw={}",
        outcome.completed,
        outcome.halt,
        outcome.result,
        outcome.computrons,
        outcome.dispatched,
        machine.meter_index()
    );
    let bytes = if outcome.completed {
        machine.write_snapshot(&sig()).expect("snapshot")
    } else {
        Vec::new()
    };
    (line, bytes)
}

fn run(setup: &str, probe: &str, between: Between, disabled: bool) -> Vec<(String, Vec<u8>)> {
    set_exotic_bits_disabled(disabled);
    let mut machine = Interp::new();
    let mut seen = vec![observe(&mut machine, setup, true)];
    for _ in 0..2 {
        if matches!(between, Between::Collect | Between::Both) {
            machine.collect_garbage().expect("collect");
            assert!(machine.exotic_bits_cover_tables(), "after collection");
        }
        if matches!(between, Between::Restore | Between::Both) && !seen.last().unwrap().1.is_empty()
        {
            machine = from_snapshot_bytes(&seen.last().unwrap().1, &sig()).expect("restore");
            assert!(machine.exotic_bits_cover_tables(), "after restore");
        }
        seen.push(observe(&mut machine, probe, false));
    }
    set_exotic_bits_disabled(false);
    seen
}

fn assert_unobservable(setup: &str, probe: &str, expected: &str) {
    for between in [
        Between::Nothing,
        Between::Collect,
        Between::Restore,
        Between::Both,
    ] {
        let on = run(setup, probe, between, false);
        let off = run(setup, probe, between, true);
        for (crank, (a, b)) in on.iter().zip(&off).enumerate() {
            assert_eq!(a.0, b.0, "{between:?} crank {crank}: {setup} / {probe}");
            assert!(
                a.1 == b.1,
                "{between:?} crank {crank}: snapshot bytes differ: {setup} / {probe}"
            );
        }
        for (line, _) in &on[1..] {
            assert!(
                line.starts_with("completed=true")
                    && line.contains(&format!("result={expected:?}")),
                "{between:?}: {setup} / {probe}: {line}"
            );
        }
    }
}

/// `(setup, probe, expected)`: the setup crank leaves everything in the
/// global `g`; the probe runs twice, after the boundary, and must answer
/// `expected` both times (so it must not change what it reads).
const CASES: &[(&str, &str, &str)] = &[
    // Ordinary objects: own, inherited, absent, accessors, integrity.
    (
        "var g = { a: 1, b: 2 }; g.p = Object.create(g); g.p.c = 3;",
        "var g; g.a = g.a + 0; [g.a, g.b, g.p.a, g.p.c, String(g.p.zz), 'a' in g.p].join()",
        "1,2,1,3,undefined,true",
    ),
    (
        "var g = { v: 4, get a() { return this.v; }, set a(x) { this.v = x; } }; g.c = Object.create(g);",
        "var g; g.c.a = 4; [g.a, g.c.a, g.c.hasOwnProperty('v')].join()",
        "4,4,true",
    ),
    (
        "var g = { f: Object.freeze({ a: 1 }), s: Object.seal({ b: 2 }), n: Object.preventExtensions({ c: 3 }) };",
        "var g; g.f.a = 9; g.s.b = 2; g.n.d = 1; [g.f.a, g.s.b, String(g.n.d), Object.isFrozen(g.f)].join()",
        "1,2,undefined,true",
    ),
    (
        "var g = { o: { a: 1, b: 2 } }; delete g.o.a; g.o.a = 5;",
        "var g; g.o.b = g.o.b; delete g.o.c; [Object.keys(g.o).join(''), g.o.a].join()",
        "ba,5",
    ),
    // Prototype changes onto and off exotic objects.
    (
        "var g = { o: { x: 1 } }; Object.setPrototypeOf(g.o, [7, 8]); g.q = { y: 2 }; g.q.__proto__ = function h(a, b) {};",
        "var g; [g.o.length, g.o[1], g.o.x, g.q.length, g.q.name, g.q.y].join()",
        "2,8,1,2,h,2",
    ),
    (
        "var g = { o: Object.create(new Proxy({}, { get(t, k) { return typeof k === 'string' ? 'trap:' + k : undefined; } })) }; g.o.own = 1;",
        "var g; [g.o.own, g.o.zz].join()",
        "1,trap:zz",
    ),
    (
        "var g = { log: [] }; g.p = new Proxy({}, { set(t, k, v, r) { g.log.push(k); return Reflect.set(t, k, v, r); } }); g.o = Object.create(g.p);",
        "var g; g.o.w = 1; g.log.length = 0; g.o.w = 2; [g.log.join(), g.o.w].join()",
        ",2",
    ),
    // Arrays and arguments as receivers.
    (
        "var g = { a: [1, 2, 3] }; g.a.x = 'n'; g.args = (function () { return arguments; })(4, 5);",
        "var g; g.a.length = 3; [g.a.length, g.a[2], g.a.x, g.args.length, g.args[1]].join()",
        "3,3,n,2,5",
    ),
    // Index-named keys on ordinary objects and on their prototypes.
    (
        "var g = { o: { 0: 'a', 5: 'b' } }; g.c = Object.create(g.o); g.o[7] = 'c';",
        "var g; [g.o[0], g.o['5'], g.c[7], String(g.c[1]), Object.keys(g.o).join('')].join()",
        "a,b,c,undefined,057",
    ),
    // Primitive wrappers.
    (
        "var g = { s: new String('hey'), n: new Number(3), b: Object(true) }; g.s.x = 1; g.c = Object.create(g.s);",
        "var g; [g.s.length, g.s[1], g.s.x, g.n.valueOf(), g.b.valueOf(), g.c.length, g.c[2]].join()",
        "3,e,1,3,true,3,y",
    ),
    // Buffers, typed arrays and data views, as receivers and prototypes.
    (
        "var g = { b: new ArrayBuffer(8) }; g.t = new Int16Array(g.b); g.v = new DataView(g.b); g.t.x = 1; g.p = Object.create(g.t); g.t[1] = 300;",
        "var g; g.v.setInt8(0, 7); [g.b.byteLength, g.t.length, g.t[1], g.t.x, g.v.getInt8(0), g.p[1], g.p.x].join()",
        "8,4,300,1,7,300,1",
    ),
    // Regexps.
    (
        "var g = { r: /a(b)/gi }; g.r.lastIndex = 1; g.r.extra = 2; g.c = Object.create(g.r);",
        "var g; [g.r.source, g.r.flags, g.r.global, g.r.lastIndex, g.r.extra, g.c.extra].join()",
        "a(b),gi,true,1,2,2",
    ),
    // Functions of every kind and their synthesized properties.
    (
        "var g = { f: function named(a, b) {}, k: class K { m() { return 1; } }, a: (x) => x, gen: function* () {}, as: async function () {} }; g.b = g.f.bind(null, 1); delete g.f.name; g.f.x = 1;",
        "var g; [g.f.name, g.f.length, g.f.x, g.k.name, typeof g.k.prototype.m, g.a.length, g.b.name, g.b.length, typeof g.gen.prototype, g.as.name, Math.max.length].join()",
        ",2,1,K,function,1,bound named,1,object,as,2",
    ),
    (
        "var g = { f: function P() { this.v = 1; } }; g.f.prototype.m = function () { return this.v; }; g.o = new g.f(); g.c = Object.create(g.f);",
        "var g; g.o.v = 1; [g.o.m(), g.c.name, g.c.length, typeof g.c.prototype].join()",
        "1,P,0,object",
    ),
    // Proxies, including a revoked one.
    (
        "var g = { t: { a: 1 } }; g.p = new Proxy(g.t, {}); g.r = Proxy.revocable({}, {}); g.r.revoke();",
        "var g; g.p.a = 2; var e = ''; try { g.r.proxy.a; } catch (x) { e = x.constructor.name; } [g.t.a, g.p.a, e].join()",
        "2,2,TypeError",
    ),
    // Intl locales and collators.
    (
        "var g = { l: new Intl.Locale('en-Latn-US'), c: new Intl.Collator('en') };",
        "var g; [g.l.language, g.l.script, g.l.region, typeof g.c.compare, g.c.compare('a', 'b')].join()",
        "en,Latn,US,function,-1",
    ),
    // Disposable stacks.
    (
        "var g = { d: new DisposableStack() }; g.d.x = 1;",
        "var g; [g.d.disposed, g.d.x].join()",
        "false,1",
    ),
    // The four Temporal tables.
    (
        "var g = { e: [] }; try { g.i = Temporal.Instant.fromEpochMilliseconds(1000); } catch (x) { g.e.push('i' + x); } try { g.d = Temporal.Duration.from({ days: 2 }); } catch (x) { g.e.push('d' + x); } try { g.p = Temporal.PlainDate.from('2020-02-03'); } catch (x) { g.e.push('p' + x); } try { g.z = new Temporal.ZonedDateTime(0n, 'UTC'); } catch (x) { g.e.push('z' + x); } g.d.x = 1;",
        "var g; [g.e.join(';'), g.i.epochMilliseconds, g.d.days, g.d.x, g.p.month, g.z.year].join()",
        ",1000,2,1,2,1970",
    ),
    // Slot reuse: exotic objects die and the collector frees their slots,
    // then ordinary objects (and new exotics) are allocated over them.
    (
        "var g = {}; (function () { var junk = []; for (var i = 0; i < 200; i++) junk.push([i], function () {}, new Proxy({}, {}), new Int8Array(1)); })();",
        "var g; var made = []; for (var i = 0; i < 200; i++) made.push({ k: i }, [i]); var s = 0; for (var j = 0; j < made.length; j += 2) { made[j].k = made[j].k + 1; s += made[j].k + made[j + 1].length; } String(s)",
        "20300",
    ),
    // Construction through a Proxy `newTarget` whose `prototype` getter runs
    // guest code (reading and writing properties) between allocation and
    // registration, and exotic subclasses.
    (
        "var g = { n: 0, made: [], e: [] }; var nt = new Proxy(function () {}, { get(t, k) { if (k === 'prototype') { g.n = g.n + 1; g.made.length; } return Reflect.get(t, k); } }); \
         [Array, RegExp, Int8Array, ArrayBuffer, Map, Date, Boolean, String, Promise.bind(null, function () {})].forEach(function (C) { try { g.made.push(Reflect.construct(C, C === Int8Array || C === ArrayBuffer ? [2] : [], nt)); } catch (x) { g.e.push(C.name + x); } }); \
         try { g.made.push(Reflect.construct(DataView, [new ArrayBuffer(2)], nt)); } catch (x) { g.e.push('DataView' + x); } \
         try { class A extends Array {} class T extends Int8Array {} class R extends RegExp {} g.sub = [new A(), new T(2), new R('x')]; g.sub[0].push(1); } catch (x) { g.e.push('sub' + x); }",
        "var g; [g.e.join(';'), g.n, g.made.length, g.made[0].length, g.made[2][1], String(g.made[2][5]), String(g.made[3].byteLength), g.sub[0].length, g.sub[1].length, g.sub[2].source].join()",
        ",10,10,0,0,undefined,undefined,1,2,x",
    ),
    // The roster's property workloads, shortened.
    (
        "var g = {};",
        "var g; var r = []; \
         r.push((function () { var o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }; for (var i = 0; i < 300; i++) { o.f = o.a + o.e; o.a = o.f - o.e + 1; } return o.a; })()); \
         r.push((function () { function P(x) { this.x = x; } P.prototype.inc = function (d) { this.x = this.x + d; return this; }; var p = new P(0); for (var i = 0; i < 300; i++) { p.inc(2); } return p.x; })()); \
         r.push((function () { class A { constructor() { this.v = 1; } get1() { return this.v; } } class B extends A {} class C extends B {} var c = new C(); var t = 0; for (var i = 0; i < 300; i++) { t += c.get1(); } return t; })()); \
         r.push((function () { function P(x, y) { this.x = x; this.y = y; this.z = x + y; } var t = 0; for (var i = 0; i < 100; i++) { var p = new P(i, 1); t += p.z; } return t; })()); \
         r.join()",
        "301,600,300,5050",
    ),
    // Ordinary objects that are then used as prototypes, and an object whose
    // prototype is replaced between reads.
    (
        "var g = { o: { m() { return 'o'; } } }; g.c = Object.create(g.o);",
        "var g; var r = g.c.m(); Object.setPrototypeOf(g.c, { m() { return 'n'; } }); r += g.c.m(); Object.setPrototypeOf(g.c, g.o); r",
        "on",
    ),
];

#[test]
fn exotic_bits_are_unobservable() {
    for (setup, probe, expected) in CASES {
        assert_unobservable(setup, probe, expected);
    }
}
