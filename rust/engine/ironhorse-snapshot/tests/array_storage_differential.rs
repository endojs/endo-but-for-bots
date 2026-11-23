//! The array item store's representation is not observable.
//!
//! `ArrayItems` holds an array's (or an ordinary object's index-property)
//! items densely while they are dense enough and in an ordered map
//! otherwise. This test runs every program twice on the same thread: once
//! with the hybrid store, once with the diagnostics switch that keeps every
//! store in the map (the representation before the dense form existed). The
//! two runs must agree on everything a program, the meter, the heap ledger
//! or a snapshot can see: each crank's completion, halt, result, computrons,
//! dispatch count and raw meter index; the meter-host check sequence and an
//! abort at a chosen check; every slot record, the chunk bytes and the
//! side-storage charge; and the snapshot bytes, including across a
//! collection and a snapshot-and-restore in the middle of a run.
//!
//! The corpus is adversarial for the representation: holes, indices near
//! `2^32`, `length` shrink and growth, deletes that thin a dense array into
//! a sparse one and fills that make it dense again, descriptor attributes and
//! accessors on indices, frozen and sealed arrays, index properties on the
//! prototypes, the reordering natives, mutation during iteration, `arguments`
//! objects, ordinary objects' index stores, and a heap ceiling that halts in
//! the middle of a growing array.

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::diagnostics::force_sparse_array_items;
use ironhorse_vm::{parse_symbols, Interp, Slot, SymbolName};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

fn compile(source: &str) -> (Vec<u8>, Vec<SymbolName>) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("compiles");
    (bytecode, parse_symbols(&symbols))
}

/// The guest compiler `Compartment.prototype.evaluate` needs, as
/// `persist_gates.rs` builds it.
struct TestCompiler;

impl ironhorse_vm::SourceCompiler for TestCompiler {
    fn compile_source(
        &self,
        source: &str,
        strict: bool,
        raw_budget: u64,
        charge: &mut dyn FnMut(u64) -> bool,
    ) -> Result<ironhorse_vm::CompiledSource, ironhorse_vm::SourceCompileError> {
        match ironhorse_compile::compile_atoms_budgeted_firewalled(
            source,
            ironhorse_compile::Goal::Eval,
            strict,
            raw_budget,
            charge,
        ) {
            Ok(compiled) => Ok(ironhorse_vm::CompiledSource {
                bytecode: compiled.bytecode,
                symbols: compiled.symbols,
                parse_meter_raw: compiled.parse_meter_raw,
                parse_computrons: compiled.parse_computrons,
            }),
            Err(ironhorse_compile::CompileError::MeterAbort) => {
                Err(ironhorse_vm::SourceCompileError::MeterAbort)
            }
            Err(ironhorse_compile::CompileError::Invariant(detail)) => {
                Err(ironhorse_vm::SourceCompileError::Invariant(detail))
            }
            Err(ironhorse_compile::CompileError::Parse(error)) => {
                Err(ironhorse_vm::SourceCompileError::Syntax(error.message))
            }
        }
    }
}

fn with_compiler(mut machine: Interp) -> Interp {
    machine.set_source_compiler(Rc::new(TestCompiler));
    machine
}

#[derive(Clone, Copy)]
enum Step {
    /// Run one crank of guest source.
    Crank(&'static str),
    /// Run the full collector.
    Collect,
    /// Write a snapshot, restore it, and carry on with the restored machine.
    Restore,
    /// Lower the chunk ceiling to this many bytes above the current heap.
    Ceiling(usize),
}

/// What one side saw after one step.
#[derive(Debug, PartialEq)]
struct Seen {
    outcome: Option<(bool, String, String, u64, u64, u64)>,
    checks: Vec<u64>,
    slots: Vec<Slot>,
    chunks: Vec<u8>,
    side_reserved: u64,
    snapshot: Result<Vec<u8>, String>,
}

struct Side {
    machine: Interp,
    sparse: bool,
    /// Also switch the other round-2 accelerators off: dispatch fusion and
    /// (debug builds) the exotic-membership fast paths.
    all_off: bool,
    linked: bool,
    checks: Rc<RefCell<Vec<u64>>>,
    abort_at: Option<usize>,
    dense_seen: (usize, usize),
}

fn meter_host(
    checks: Rc<RefCell<Vec<u64>>>,
    abort_at: Option<usize>,
) -> Box<dyn FnMut(u64) -> bool> {
    Box::new(move |index| {
        let mut checks = checks.borrow_mut();
        checks.push(index);
        abort_at.is_none_or(|limit| checks.len() < limit)
    })
}

impl Side {
    fn new(sparse: bool, all_off: bool, interval: Option<u64>, abort_at: Option<usize>) -> Side {
        force_sparse_array_items(sparse);
        let mut machine = with_compiler(Interp::new());
        machine.set_dispatch_fusion(!all_off);
        let checks = Rc::new(RefCell::new(Vec::new()));
        if let Some(interval) = interval {
            machine.arm_meter(interval, meter_host(checks.clone(), abort_at));
        }
        force_sparse_array_items(false);
        Side {
            machine,
            sparse,
            all_off,
            linked: false,
            checks,
            abort_at,
            dense_seen: (0, 0),
        }
    }

    fn step(&mut self, step: Step) -> Seen {
        force_sparse_array_items(self.sparse);
        #[cfg(debug_assertions)]
        ironhorse_vm::diagnostics::set_exotic_bits_disabled(self.all_off);
        let outcome = match step {
            Step::Crank(source) => {
                let (bytecode, names) = compile(source);
                let bytecode = if self.linked {
                    self.machine
                        .relink_crank(&bytecode, &names)
                        .expect("relink")
                } else {
                    self.machine.link_intrinsics(&names);
                    self.linked = true;
                    bytecode
                };
                let o = self.machine.run(&bytecode);
                Some((
                    o.completed,
                    format!("{:?}", o.halt),
                    o.result,
                    o.computrons,
                    o.dispatched,
                    o.meter_raw,
                ))
            }
            Step::Collect => {
                // A machine a halt left non-quiescent refuses; both must.
                let refused = self.machine.collect_garbage().err();
                let reason = format!("{refused:?}");
                Some((refused.is_some(), reason, String::new(), 0, 0, 0))
            }
            Step::Restore => {
                let bytes = self.machine.write_snapshot(&sig());
                if let Ok(bytes) = &bytes {
                    let mut restored =
                        with_compiler(from_snapshot_bytes(bytes, &sig()).expect("restore"));
                    restored.set_dispatch_fusion(!self.all_off);
                    if self.machine.meter_is_armed() {
                        restored
                            .reattach_meter_host(meter_host(self.checks.clone(), self.abort_at));
                    }
                    self.machine = restored;
                }
                let reason = format!("{:?}", bytes.as_ref().err());
                Some((bytes.is_err(), reason, String::new(), 0, 0, 0))
            }
            Step::Ceiling(above) => {
                let ceiling = self.machine.chunks().byte_size() + above;
                self.machine.set_chunk_ceiling(ceiling).expect("ceiling");
                None
            }
        };
        let counts = self.machine.dense_item_store_counts();
        self.dense_seen.0 += counts.0;
        self.dense_seen.1 += counts.1;
        let seen = Seen {
            outcome,
            checks: self.checks.borrow().clone(),
            slots: self.machine.slots().records_iter().collect(),
            chunks: self.machine.chunks().raw_bytes().to_vec(),
            side_reserved: self.machine.chunks().side_reserved(),
            snapshot: self
                .machine
                .write_snapshot(&sig())
                .map_err(|error| format!("{error:?}")),
        };
        force_sparse_array_items(false);
        #[cfg(debug_assertions)]
        ironhorse_vm::diagnostics::set_exotic_bits_disabled(false);
        seen
    }
}

/// Run `steps` on a hybrid machine and on a map-only machine and require
/// that they agree after every step. Returns the hybrid side's count of
/// dense `arrays` and `index_props` rows summed over the steps.
fn differential(
    name: &str,
    steps: &[Step],
    interval: Option<u64>,
    abort_at: Option<usize>,
) -> (usize, usize) {
    differential_with(name, steps, interval, abort_at, false)
}

/// [`differential`], where `all_off` also switches the map-only side's
/// other round-2 accelerators off, so every accelerator on is compared with
/// every one off.
fn differential_with(
    name: &str,
    steps: &[Step],
    interval: Option<u64>,
    abort_at: Option<usize>,
    all_off: bool,
) -> (usize, usize) {
    let mut hybrid = Side::new(false, false, interval, abort_at);
    let mut sparse = Side::new(true, all_off, interval, abort_at);
    for (n, &step) in steps.iter().enumerate() {
        let a = hybrid.step(step);
        let b = sparse.step(step);
        if let (Some((flag, halt, ..)), None) = (&a.outcome, abort_at) {
            match step {
                Step::Crank(source) if !source.contains("/*may-halt*/") => {
                    assert!(flag, "{name} step {n} halted: {halt}");
                }
                Step::Collect | Step::Restore => assert!(!flag, "{name} step {n}: {halt}"),
                _ => {}
            }
        }
        assert!(
            a.outcome == b.outcome,
            "{name} step {n}: outcome {:?} vs {:?}",
            a.outcome,
            b.outcome
        );
        assert_eq!(a.checks, b.checks, "{name} step {n}: meter checks");
        assert!(a.slots == b.slots, "{name} step {n}: slot records differ");
        assert!(a.chunks == b.chunks, "{name} step {n}: chunk bytes differ");
        assert_eq!(
            a.side_reserved, b.side_reserved,
            "{name} step {n}: side charge"
        );
        assert!(
            a.snapshot == b.snapshot,
            "{name} step {n}: snapshot bytes differ"
        );
    }
    assert_eq!(
        sparse.dense_seen,
        (0, 0),
        "{name}: the switch left a dense store"
    );
    hybrid.dense_seen
}

use Step::{Ceiling, Collect, Crank, Restore};

const HOLES_AND_FAR: &[Step] = &[
    Crank("var a = [1, 2, 3]; a[10] = 4; a[7] = undefined; var t = a.length + ':' + a.join(); t"),
    Crank("var a; var t; a[4294967294] = 5; t = a.length + ':' + (4294967294 in a) + ':' + a[4294967294]; t"),
    Restore,
    Crank("var a; var t; delete a[4294967294]; a.length = 12; a[11] = 6; t = a.join() + '|' + Object.keys(a).join(); t"),
    Crank("var b = []; b[4294967293] = 1; b[0] = 0; b[1] = 1; var t = Object.keys(b).join() + ':' + b.length; t"),
    Collect,
    Crank("var b; var t; b.length = 2; for (var i = 2; i < 50; i++) b[i] = i; t = b.length + ':' + b[49] + ':' + b.indexOf(30); t"),
];

const LENGTH_CHANGES: &[Step] = &[
    Crank("var b = []; for (var i = 0; i < 300; i++) b.push(i * 2); b.length = 150; b.length = 400; b[399] = 'end'; var t = b.length + ':' + b[149] + ':' + b[150] + ':' + b.lastIndexOf('end'); t"),
    Crank("var b; var t; b.length = 10; b.length = 0; b[5] = 5; t = b.length + ':' + b.join('-'); t"),
    Restore,
    Crank("var b; var t; while (b.length < 2000) b.push(b.length); while (b.length > 3) b.pop(); t = b.join(); t"),
    Crank("var c = new Array(100); c[99] = 1; for (var i = 98; i >= 0; i--) c[i] = i; var t = c.reduce(function (x, y) { return x + y; }, 0); t"),
];

const THIN_AND_REFILL: &[Step] = &[
    Crank("var d = []; for (var i = 0; i < 500; i++) d[i] = i; for (var i = 0; i < 500; i += 2) delete d[i]; var t = Object.keys(d).length + ':' + d.length; t"),
    Crank("var d; var t; for (var i = 0; i < 400; i += 3) delete d[i]; t = Object.keys(d).slice(0, 5).join(); t"),
    Collect,
    Crank("var d; var t; for (var i = 0; i < 2000; i++) d[i] = -i; t = d[0] + ':' + d[1999] + ':' + Object.keys(d).length; t"),
    Restore,
    Crank("var d; var t; d[100000] = 1; delete d[100000]; for (var i = 0; i < 3000; i++) d[i] = i; for (var j = 0; j < 20; j++) { d[50000 + j] = j; delete d[50000 + j]; d[j] = j; } t = d.length + ':' + Object.keys(d).length; t"),
    Crank("var e = []; for (var i = 0; i < 1000; i++) e[i * 7] = i; for (var i = 0; i < 7000; i++) e[i] = i; var t = e.length + ':' + e[6999]; t"),
];

const ATTRIBUTES: &[Step] = &[
    Crank("var f = [0, 1, 2, 3, 4, 5]; Object.defineProperty(f, '3', {writable: false}); Object.defineProperty(f, '4', {enumerable: false}); Object.defineProperty(f, '1', {configurable: false}); f[3] = 9; var t = f.join() + '|' + Object.keys(f).join() + '|' + delete f[1]; t"),
    Crank("var f; var t; Object.defineProperty(f, '5', {get: function () { return 'g'; }, configurable: true}); Object.defineProperty(f, '8', {set: function (v) { this[0] = v; }}); f[8] = 'set'; t = f[5] + ':' + f[0] + ':' + f.length + ':' + JSON.stringify(Object.getOwnPropertyDescriptor(f, '3')); t"),
    Restore,
    Crank("var f; var t; f.length = 2; t = f.length + ':' + f.join(); t"),
    Crank("var g = [1, 2, 3]; Object.freeze(g); g[0] = 9; g.push; var r = ''; try { g.push(4); } catch (e) { r = e.name; } var t = g.join() + ':' + r + ':' + Object.isFrozen(g); t"),
    Crank("var h = [1, 2, 3, 4]; Object.seal(h); h[0] = 7; h.length = 1; var t = h.length + ':' + h.join() + ':' + delete h[0]; t"),
    Crank("var k = [3, 1, 2]; Object.preventExtensions(k); k[5] = 1; k.sort(); var t = k.join() + ':' + k.length; t"),
];

const PROTOTYPE_INDICES: &[Step] = &[
    Crank("Array.prototype[3] = 'p'; Object.prototype[1] = 'q'; var m = [0, , 2, , 4]; var t = m[1] + m[3] + ':' + m.indexOf('p') + ':' + m.join() + ':' + m.includes('q'); t"),
    Crank("var m; var t; var seen = []; m.forEach(function (v, i) { seen.push(i + '=' + v); }); t = seen.join(); t"),
    Restore,
    Crank("var m; var t; delete Array.prototype[3]; delete Object.prototype[1]; t = m[1] + ':' + m[3] + ':' + m.join(); t"),
    Crank("Object.defineProperty(Array.prototype, '2', {get: function () { return 'getter'; }, configurable: true}); var n = [0, 1]; n.length = 4; var t = n[2] + ':' + n.join() + ':' + n.slice(1).join(); delete Array.prototype[2]; t"),
];

const REORDERING: &[Step] = &[
    Crank("var s = []; for (var i = 0; i < 200; i++) s.push((i * 37) % 101); s.sort(function (x, y) { return x - y; }); var t = s.slice(0, 5).join() + ':' + s[199]; t"),
    Crank("var s; var t; s.reverse(); s.splice(10, 20, 'a', 'b'); s.copyWithin(0, 150, 160); s.fill(0, 170, 180); t = s.length + ':' + s.slice(0, 12).join(); t"),
    Crank("var s; var t; s.unshift(1, 2, 3); s.shift(); s.splice(5, 0, 'x', 'y', 'z'); t = s.length + ':' + s.slice(0, 9).join() + ':' + s.concat([7, , 8]).length; t"),
    Restore,
    Crank("var u = [5, , 3, , 1]; u.sort(); var v = [1, , 3]; v.reverse(); var w = [, 1, , 2, , 3]; w.copyWithin(0, 3); var t = Object.keys(u).join() + '|' + Object.keys(v).join() + '|' + Object.keys(w).join() + '|' + w.join(); t"),
    Crank("var x = [[1, [2, , 3]], , [4]]; var t = x.flat(2).join() + ':' + x.flat(Infinity).length + ':' + [1, 2, 3].flatMap(function (q) { return [q, q]; }).join(); t"),
    Crank("var y = []; for (var i = 0; i < 100; i++) y[i * 2] = i; y.sort(); var t = y.length + ':' + Object.keys(y).length + ':' + y[49] + ':' + y[50]; t"),
];

const MUTATION_DURING_ITERATION: &[Step] = &[
    Crank("var z = [0, 1, 2, 3, 4, 5, 6, 7]; var log = []; z.forEach(function (v, i) { if (i === 2) z.length = 4; if (i === 1) z.push('p'); log.push(v); }); var t = log.join() + ':' + z.join(); t"),
    Crank("var z2 = [0, 1, 2, 3, 4]; var t = z2.map(function (v, i) { delete z2[i + 1]; return v; }).join() + ':' + Object.keys(z2).join(); t"),
    Crank("var z3 = [1, 2, 3, 4, 5, 6]; var out = []; for (var k in z3) { out.push(k); if (k === '1') { delete z3[3]; z3[10] = 1; } } var t = out.join(); t"),
    Crank("var z4 = [1, 2, 3]; var r = []; for (var v of z4) { r.push(v); if (r.length < 6) z4.push(v * 10); } var t = r.join(); t"),
    Collect,
    Crank("var z5 = [3, 2, 1]; var t = z5.filter(function (v, i) { z5[i + 1] = v * 2; return v > 2; }).join() + ':' + z5.join() + ':' + z5.indexOf(4) + ':' + z5.some(function (v) { z5.length = 1; return false; }); t"),
];

const OBJECTS_AND_ARGUMENTS: &[Step] = &[
    Crank("var o = {}; for (var i = 0; i < 300; i++) o[i] = i; for (var i = 0; i < 300; i += 3) delete o[i]; o[100000] = 'far'; var t = Object.keys(o).length + ':' + o[100000] + ':' + JSON.stringify(Object.entries(o).slice(0, 3)); t"),
    Restore,
    Crank("var o; var t; delete o[100000]; for (var i = 0; i < 600; i++) o[i] = -i; Object.defineProperty(o, '5', {enumerable: false}); t = Object.keys(o).length + ':' + o[5] + ':' + o[599]; t"),
    Crank("function f(a, b) { arguments[5] = 'x'; delete arguments[0]; arguments[1] = 'b2'; return arguments.length + ':' + a + ':' + b + ':' + Object.keys(arguments).join(); } var t = f(1, 2, 3); t"),
    Crank("function g() { 'use strict'; var r = Array.prototype.slice.call(arguments, 1); arguments[3] = 1; return r.join() + ':' + arguments.length; } var t = g(1, 2, 3, 4); t"),
    Crank("var lk = {length: 4, 0: 'a', 2: 'c'}; var t = Array.prototype.join.call(lk) + ':' + Array.prototype.indexOf.call(lk, 'c') + ':' + Array.from(lk).length + ':' + [...[1, , 3]].length; t"),
    Crank("var ta = new Uint8Array([1, 2, 3]); var t = ta.map(function (q) { return q * 2; }).join() + ':' + Array.from(ta).reverse().join(); t"),
];

const BULK_AND_METER: &[Step] = &[
    Crank("var big = []; for (var i = 0; i < 20000; i++) big.push(i); var s = 0; for (var i = 0; i < big.length; i++) { big[i] = big[i] + 1; s += big[i]; } s"),
    Collect,
    Restore,
    Crank("var big; var t; for (var i = 0; i < 20000; i += 2) delete big[i]; big.length = 15000; t = Object.keys(big).length; t"),
    Crank("var keys = []; var obj = {a: 1}; for (var i = 0; i < 3000; i++) keys[i] = String(i); var t = keys.join('').length + ':' + Array(50).fill(7).join('').length; t"),
];

const CEILING: &[Step] = &[
    Crank("var grow = []; for (var i = 0; i < 64; i++) grow.push(i); 0"),
    Ceiling(64 * 1024),
    Crank("/*may-halt*/ var grow; for (var i = 0; i < 1000000; i++) grow[i] = i; grow.length"),
];

const CEILING_SPARSE: &[Step] = &[
    Crank("var spr = []; spr[0] = 0; 0"),
    Ceiling(64 * 1024),
    Crank("/*may-halt*/ var spr; for (var i = 1; i < 1000000; i++) spr[i * 5] = i; spr.length"),
];

const NAMED_KEYS: &[Step] = &[
    Crank("var nk = [10, 11, 12]; nk['01'] = 'lead'; nk['4294967295'] = 'max'; var t = nk['1'] + ':' + nk['01'] + ':' + nk.length + ':' + Object.keys(nk).join() + ':' + JSON.stringify(Object.getOwnPropertyDescriptor(nk, '2')) + ':' + JSON.stringify(Object.getOwnPropertyDescriptor(nk, 'length')); t"),
    Crank("var nk; var t; t = Reflect.get(nk, '0') + ':' + ('length' in nk) + ':' + nk.hasOwnProperty('2') + ':' + nk.hasOwnProperty('3') + ':' + Reflect.ownKeys(nk).join() + ':' + nk.propertyIsEnumerable('length'); t"),
    Crank("function ak() { return JSON.stringify(Object.getOwnPropertyDescriptor(arguments, 'length')) + ':' + arguments['1'] + ':' + Object.getOwnPropertyDescriptor(arguments, '0').value; } var t = ak('x', 'y'); t"),
];

/// Hardened arrays and array natives under `lockdown()`, across a
/// collection and a snapshot restore.
const LOCKDOWN: &[Step] = &[
    Crank("lockdown(); var hz = harden([3, 1, 2]); var r = ''; try { hz.push(4); } catch (e) { r = e.name; } var t = Object.isFrozen(hz) + ':' + Object.isFrozen(Array.prototype) + ':' + r + ':' + hz.slice().sort().join() + ':' + hz.map(function (x) { return x * 2; }).join() + ':' + hz.indexOf(2) + ':' + hz.concat([9]).join(); t"),
    Crank("var h2 = []; for (var i = 0; i < 300; i++) h2[i] = i; h2[1000] = 'gap'; harden(h2); var r = ''; try { (function () { 'use strict'; h2[0] = 1; })(); } catch (e) { r = e.name; } var t = Object.isFrozen(h2) + ':' + r + ':' + h2.reduce(function (a, b) { return typeof b === 'number' ? a + b : a; }, 0) + ':' + h2.lastIndexOf('gap') + ':' + Object.keys(h2).length; t"),
    Collect,
    Restore,
    Crank("var h2; var hz; var t; var m = []; for (var i = 0; i < 2000; i++) m.push(i); m.length = 100; m[5000] = 1; delete m[5000]; for (var i = 100; i < 400; i++) m[i] = -i; var r = ''; try { (function () { 'use strict'; hz.length = 0; })(); } catch (e) { r = e.name; } t = r + ':' + m.length + ':' + m.filter(function (v) { return v < 0; }).length + ':' + h2.slice(295, 302).join() + ':' + Object.isFrozen(h2) + ':' + [].concat(hz, m.slice(0, 2)).join(); t"),
];

/// Arrays shared into guest `Compartment`s after `lockdown()`, and array
/// natives run inside them. A live or once-built guest `Compartment` makes the
/// image unpersistable here, so this program collects but never restores.
const COMPARTMENTS: &[Step] = &[
    Crank("lockdown(); var hz = harden([3, 1, 2]); var big = []; for (var i = 0; i < 500; i++) big.push(i); var t = (function () { var c = new Compartment({globals: {shared: hz, big: big}}); return c.evaluate('shared.concat(big.slice(0, 3)).join() + \":\" + big.filter(function (v) { return v % 100 === 0; }).join() + \":\" + Object.isFrozen(Array.prototype) + \":\" + (shared === globalThis.shared)'); })(); t"),
    Crank("var big; var t; (function () { new Compartment({globals: {big: big}}).evaluate('big.length = 10; big[20] = 1; delete big[20]; big[4294967294] = 2; delete big[4294967294]; big.length = 10; big.push(5)'); })(); t = big.join() + ':' + Object.isFrozen(big); t"),
    Collect,
    Crank("var h3 = []; for (var i = 0; i < 300; i++) h3[i] = i; h3[1000] = 'gap'; harden(h3); var t = new Compartment({globals: {h3: h3}}).evaluate('var r = \"\"; try { h3.push(1); } catch (e) { r = e.name; } r + \":\" + h3.lastIndexOf(\"gap\") + \":\" + Object.keys(h3).length'); t"),
    Crank("var t = new Compartment().evaluate('var x = []; for (var i = 0; i < 100; i++) x[i * 3] = i; x.sort(); var y = Array.from({length: 50}, function (_, i) { return i; }); y.splice(10, 30); x.length + \":\" + Object.keys(x).length + \":\" + y.join()'); t"),
];

const CORPUS: &[(&str, &[Step])] = &[
    ("lockdown", LOCKDOWN),
    ("compartments", COMPARTMENTS),
    ("named_keys", NAMED_KEYS),
    ("holes_and_far", HOLES_AND_FAR),
    ("length_changes", LENGTH_CHANGES),
    ("thin_and_refill", THIN_AND_REFILL),
    ("attributes", ATTRIBUTES),
    ("prototype_indices", PROTOTYPE_INDICES),
    ("reordering", REORDERING),
    ("mutation_during_iteration", MUTATION_DURING_ITERATION),
    ("objects_and_arguments", OBJECTS_AND_ARGUMENTS),
    ("bulk_and_meter", BULK_AND_METER),
    ("ceiling", CEILING),
    ("ceiling_sparse", CEILING_SPARSE),
];

#[test]
fn unmetered_runs_agree() {
    let mut dense = (0, 0);
    for (name, steps) in CORPUS {
        let seen = differential(name, steps, None, None);
        dense.0 += seen.0;
        dense.1 += seen.1;
    }
    assert!(
        dense.0 > 0 && dense.1 > 0,
        "the hybrid side never went dense: {dense:?}"
    );
}

#[test]
fn metered_runs_agree_on_every_check() {
    for (name, steps) in CORPUS {
        differential(name, steps, Some(50), None);
    }
}

/// Every round-2 accelerator on (dense items, exotic-membership fast paths,
/// dispatch fusion) against every one off, unmetered and metered.
#[test]
fn all_accelerators_off_agree_with_all_on() {
    for (name, steps) in CORPUS {
        differential_with(name, steps, None, None, true);
        differential_with(name, steps, Some(50), None, true);
    }
}

/// A host that refuses at the Nth check halts both sides at the same point.
#[test]
fn meter_aborts_agree() {
    for abort_at in [1, 7, 40, 300] {
        for (name, steps) in [
            ("bulk_and_meter", BULK_AND_METER),
            ("thin_and_refill", THIN_AND_REFILL),
        ] {
            differential(name, steps, Some(20), Some(abort_at));
        }
    }
}
