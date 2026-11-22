//! Gate D: dispatch with and without the derived dispatch buffers.
//!
//! Round 2 of the performance campaign (`rust/engine/PORFFOR-ROUND2-PLAN.md`,
//! "The new differential gate (D)") adds accelerators that must be
//! unobservable: dispatch fusion over a layout-preserving derived buffer
//! (`ironhorse-vm/src/interp/fuse.rs`). [`Interp::set_dispatch_fusion`]
//! switches them off. Every case here runs the same cranks on two fresh
//! machines, one accelerated and one plain, and requires the same
//! observation: completion, halt, result, the machine-lifetime and per-run
//! computrons, dispatch count and raw meter index, the meter host's whole
//! check sequence (the computron value it was handed at every consultation),
//! and the snapshot bytes after every crank that leaves the machine
//! quiescent.
//!
//! The sweeps aim at the edges of a fused sequence: a meter host that
//! refuses at each of its consultations in turn, which moves the abort
//! through every loop-closing check point and every 4096-dispatch cadence
//! check, and a dispatch ceiling (`run_bounded`) at every dispatch count in
//! windows around the cadence boundaries and through whole loop iterations,
//! which stops the run at every instruction of every fused site. The
//! snapshot sweep suspends a generator and an async function at each
//! `yield`/`await` inside a fused loop, snapshots, and resumes the image on
//! an accelerated and a plain machine.
//!
//! It lives in this crate because the snapshot bytes are this crate's
//! encoding; `ironhorse-vm` cannot depend on it.
#[path = "common/compile.rs"]
mod guest_compile;
use guest_compile::compile;

use std::cell::RefCell;
use std::rc::Rc;

use ironhorse_snapshot::machine::{from_snapshot_bytes, MachineSnapshot};
use ironhorse_snapshot::Signature;
use ironhorse_vm::{Halt, Interp};

fn sig() -> Signature {
    Signature::new("ironhorse-worker-v1")
}

/// The in-test source bridge for `eval` and `Function`, as
/// `dynamic_segments.rs` wires it.
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
            Err(ironhorse_compile::CompileError::Parse(error)) => match error.kind {
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }
}

/// Whether the meter host lets a check continue, given how many checks it
/// has answered before this one.
#[derive(Clone, Copy, Debug)]
enum Host {
    /// No meter: the plain un-metered machine.
    Unmetered,
    /// Armed with this interval (computrons), always continuing.
    Continue(u64),
    /// Armed with this interval; refuses its `n`-th consultation (0-based).
    AbortAt(u64, usize),
}

/// One crank's observation. A thrown value is compared by its rendering,
/// never by the arena slot that holds it.
#[derive(Debug, PartialEq, Eq)]
struct Crank {
    completed: bool,
    halt: String,
    result: String,
    computrons: u64,
    dispatched: u64,
    meter_raw: u64,
    computrons_this_run: u64,
    dispatched_this_run: u64,
    meter_raw_this_run: u64,
    meter_index: u64,
    /// The snapshot after this crank, or why there is none.
    snapshot: Result<Vec<u8>, String>,
}

/// Everything one machine showed over a sequence of cranks.
#[derive(Debug, PartialEq, Eq)]
struct Run {
    cranks: Vec<Crank>,
    /// The computron value handed to the meter host at each consultation.
    checks: Vec<u64>,
}

fn halt_text(halt: &Halt) -> String {
    match halt {
        Halt::Throw { rendered, .. } => format!("Throw({rendered:?})"),
        other => format!("{other:?}"),
    }
}

/// Install the recording host `host` describes on `machine`, reporting
/// into `checks`. `fresh` arms a new meter; otherwise the restored meter's
/// window is kept and only the callback is attached.
fn attach(machine: &mut Interp, host: Host, checks: &Rc<RefCell<Vec<u64>>>, fresh: bool) {
    let (interval, abort_at) = match host {
        Host::Unmetered => return,
        Host::Continue(interval) => (interval, None),
        Host::AbortAt(interval, n) => (interval, Some(n)),
    };
    let checks = checks.clone();
    let callback = Box::new(move |computrons: u64| {
        let mut checks = checks.borrow_mut();
        let n = checks.len();
        checks.push(computrons);
        abort_at != Some(n)
    });
    if fresh {
        machine.arm_meter(interval, callback);
    } else {
        machine.reattach_meter_host(callback);
    }
}

/// How a crank is run.
#[derive(Clone, Copy, Debug)]
enum Mode {
    Run,
    Bounded(u64),
}

fn observe_crank(machine: &mut Interp, source: &str, mode: Mode) -> Crank {
    let (bytecode, names) = compile(source);
    let bytecode = machine.relink_crank(&bytecode, &names).expect("relink");
    let outcome = match mode {
        Mode::Run => machine.run(&bytecode),
        Mode::Bounded(limit) => machine.run_bounded(&bytecode, limit),
    };
    Crank {
        completed: outcome.completed,
        halt: halt_text(&outcome.halt),
        result: outcome.result.clone(),
        computrons: outcome.computrons,
        dispatched: outcome.dispatched,
        meter_raw: outcome.meter_raw,
        computrons_this_run: outcome.computrons_this_run,
        dispatched_this_run: outcome.dispatched_this_run,
        meter_raw_this_run: outcome.meter_raw_this_run,
        meter_index: machine.meter_index(),
        snapshot: machine
            .write_snapshot(&sig())
            .map_err(|error| format!("{error:?}")),
    }
}

fn fresh_machine(fused: bool) -> Interp {
    let mut machine = Interp::new();
    machine.set_dispatch_fusion(fused);
    machine.set_source_compiler(Rc::new(TestCompiler));
    machine
}

/// Run `cranks` on a fresh machine. Only the last crank runs under `mode`.
fn run_machine(fused: bool, cranks: &[&str], host: Host, mode: Mode) -> Run {
    let checks = Rc::new(RefCell::new(Vec::new()));
    let mut machine = fresh_machine(fused);
    attach(&mut machine, host, &checks, true);
    let mut observed = Vec::new();
    for (i, source) in cranks.iter().enumerate() {
        let mode = if i + 1 == cranks.len() {
            mode
        } else {
            Mode::Run
        };
        observed.push(observe_crank(&mut machine, source, mode));
    }
    let checks = checks.borrow().clone();
    Run {
        cranks: observed,
        checks,
    }
}

/// Run `cranks` accelerated and plain and require the same observation.
/// Returns the plain observation for the sweeps.
fn differential(label: &str, cranks: &[&str], host: Host, mode: Mode) -> Run {
    let fused = run_machine(true, cranks, host, mode);
    let plain = run_machine(false, cranks, host, mode);
    if fused != plain {
        let first = fused
            .cranks
            .iter()
            .zip(&plain.cranks)
            .position(|(a, b)| a != b);
        panic!(
            "{label} ({host:?}, {mode:?}): accelerated and plain dispatch differ \
             at crank {first:?}\naccelerated: {:?}\nplain: {:?}\nchecks equal: {}",
            first.map(|i| summary(&fused.cranks[i])),
            first.map(|i| summary(&plain.cranks[i])),
            fused.checks == plain.checks
        );
    }
    plain
}

fn summary(crank: &Crank) -> String {
    format!(
        "completed={} halt={} result={} computrons={} dispatched={} raw={} snapshot={}",
        crank.completed,
        crank.halt,
        crank.result,
        crank.computrons,
        crank.dispatched,
        crank.meter_raw,
        match &crank.snapshot {
            Ok(bytes) => format!("{} bytes", bytes.len()),
            Err(error) => error.clone(),
        }
    )
}

/// Run `body` on a thread with the engine's native stack budget.
fn on_engine_stack(body: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(body)
        .unwrap()
        .join()
        .unwrap()
}

/// The micro roster's programs (`ironhorse-vm/tests/porffor_micro_bench.rs`)
/// at small trip counts that still cross several 4096-dispatch cadence
/// boundaries.
const ROSTER: &[&str] = &[
    "var t = 0; for (var i = 0; i < 700; i++) { t = (t + i * 3 - (i >> 1)) | 0; } t",
    "var x = 0.5; var s = 0; for (var i = 0; i < 500; i++) { x = x * 1.000001 + 0.25; s = s + x / 3.5; } s > 0 ? 1 : 0",
    "var o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }; for (var i = 0; i < 500; i++) { o.f = o.a + o.e; o.a = o.f - o.e + 1; } o.a",
    "var a = []; for (var i = 0; i < 300; i++) { a.push(i); } var s = 0; for (var j = 0; j < 3; j++) { for (var i = 0; i < a.length; i++) { a[i] = a[i] + 1; s += a[i]; } } s",
    "var s = ''; for (var i = 0; i < 300; i++) { s += 'ab'; } s.length",
    "var s = 'abcdefghijklmnopqrstuvwxyz0123456789'; s = s + s + s + s; var t = 0; for (var i = 0; i < 500; i++) { t += s.charCodeAt(i % s.length); } t",
    "var s = 'abcdefghijklmnopqrstuvwxyz0123456789'; s = s + s + s + s; var t = 0; for (var i = 0; i < 500; i++) { if (s[i % 144] === 'a') t++; } t",
    "function add(a, b) { return a + b; } var t = 0; for (var i = 0; i < 500; i++) { t = add(t, i) % 1000003; } t",
    "function mk(k) { return function (x) { return x + k; }; } var f = mk(3); var t = 0; for (var i = 0; i < 500; i++) { t = f(t) % 1000003; } t",
    "function P(x) { this.x = x; } P.prototype.inc = function (d) { this.x = this.x + d; return this; }; var p = new P(0); for (var i = 0; i < 500; i++) { p.inc(2); } p.x",
    "var m = new Map(); var st = new Set(); for (var i = 0; i < 300; i++) { m.set(i, i * 2); st.add(i & 1023); } var s = 0; for (var i = 0; i < 300; i++) { s += m.get(i); } s + st.size",
    "var a = new Int32Array(100); var s = 0; for (var r = 0; r < 5; r++) { for (var i = 0; i < 100; i++) { a[i] = a[i] + i; s = (s + a[i]) | 0; } } s",
    "var o = { a: [1, 2, 3, { b: 'xyz', c: true }], d: 'hello world', e: 12.5 }; var n = 0; for (var i = 0; i < 40; i++) { n += JSON.parse(JSON.stringify(o)).a.length; } n",
    "(function () { var t = 0; for (var i = 0; i < 700; i++) { t = (t + i * 3 - (i >> 1)) | 0; } return t; })()",
    "(function () { var i = 0; for (i = 0; i < 2000; i++) { } return i; })()",
    "(function () { var o = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 }; for (var i = 0; i < 500; i++) { o.f = o.a + o.e; o.a = o.f - o.e + 1; } return o.a; })()",
    "(function () { var a = []; for (var i = 0; i < 300; i++) { a.push(i); } var s = 0; for (var j = 0; j < 3; j++) { for (var i = 0; i < a.length; i++) { a[i] = a[i] + 1; s += a[i]; } } return s; })()",
    "(function () { var s = 'abcdefghijklmnopqrstuvwxyz0123456789'; s = s + s + s + s; var t = 0; for (var i = 0; i < 500; i++) { t += s.charCodeAt(i % 144); } return t; })()",
    "(function () { function add(a, b) { return a + b; } var t = 0; for (var i = 0; i < 500; i++) { t = add(t, i) % 1000003; } return t; })()",
    "(function () { function P(x) { this.x = x; } P.prototype.inc = function (d) { this.x = this.x + d; return this; }; var p = new P(0); for (var i = 0; i < 500; i++) { p.inc(2); } return p.x; })()",
    "(function () { var a = new Int32Array(100); var s = 0; for (var r = 0; r < 5; r++) { for (var i = 0; i < 100; i++) { a[i] = a[i] + i; s = (s + a[i]) | 0; } } return s; })()",
    "(function () { class A { constructor() { this.v = 1; } get1() { return this.v; } } class B extends A {} class C extends B {} var c = new C(); var t = 0; for (var i = 0; i < 500; i++) { t += c.get1(); } return t; })()",
    "(function () { var a = []; for (var i = 0; i < 300; i++) { a[i] = i; } var s = 0; for (var j = 0; j < 3; j++) { for (var i = 0; i < 300; i++) { s += a[i]; } } return s; })()",
    "(function () { var a = [1, 2, 3]; var t = 0; for (var i = 0; i < 500; i++) { if (a[i & 7] === undefined) t++; } return t; })()",
    "(function () { function P(x, y) { this.x = x; this.y = y; this.z = x + y; } var t = 0; for (var i = 0; i < 300; i++) { var p = new P(i, 1); t += p.z; } return t; })()",
];

/// Loop shapes at the edges of the fusions: every relational operator in
/// both branch directions, counters that are not Integers or overflow the
/// Integer range mid-loop, uninitialised and immutable bindings, wide local
/// indices, a loop body that throws and catches inside the fused test, and
/// branch targets that land inside a fused sequence (`continue` and the
/// `do`-`while` back edge).
const EDGES: &[&str] = &[
    "(function () { var n = 0; for (var i = 0; i <= 900; i++) { n++; } for (var i = 900; i > 0; i--) { n++; } for (var i = 900; i >= 0; i -= 1) { n++; } return n; })()",
    "(function () { var n = 0; for (var i = 2147483000; i < 2147483647; i++) { n++; } return n + ':' + i; })()",
    "(function () { var n = 0; for (var i = -2147483000; i > -2147483647; i--) { n++; } return n + ':' + i; })()",
    "(function () { var n = 0; for (var i = 0.5; i < 600; i++) { n++; } return n + ':' + i; })()",
    "(function () { var n = 0; for (var i = 0; i < 600.5; i++) { n += i; } return n; })()",
    "(function () { var n = 0; var i = '0'; for (; i < 600; i++) { n++; } return n + ':' + typeof i; })()",
    "(function () { var n = 0; for (var i = 0; i < NaN; i++) { n++; } for (var j = NaN; !(j >= 5); j = 7) { n++; } return n; })()",
    "(function () { var n = 0; var o = { valueOf() { n += 100; return 300; } }; for (var i = 0; i < o; i++) { n++; } return n; })()",
    "(function () { var s = 0; for (let i = 0; i < 700; i++) { s += i; } return s; })()",
    "(function () { var fs = []; for (let i = 0; i < 300; i++) { fs.push(() => i); } var s = 0; for (var j = 0; j < fs.length; j++) { s += fs[j](); } return s; })()",
    "(function () { try { for (let i = 0; i < x; i++) {} let x = 3; } catch (e) { return e.name; } })()",
    "(function () { const k = 5; var n = 0; try { for (var i = 0; i < 300; i++) { n++; if (i === 299) k++; } } catch (e) { return n + e.name; } })()",
    "(function () { var n = 0; for (var i = 0; i < 1000; i++) { if (i % 3) continue; n++; } return n; })()",
    "(function () { var n = 0, i = 0; do { n += i; i++; } while (i < 900); return n; })()",
    "(function () { var n = 0, i = 0; while (i < 900) { i++; if (i & 1) { continue; } n += i; } return n; })()",
    "(function () { var n = 0; for (var i = 0; i < 400; i++) { try { if (i % 50 === 0) throw i; n++; } catch (e) { n += 1000; } } return n; })()",
    "(function () { var n = 0; for (var i = 0; i < 400; i++) { for (var j = 0; j < 10; j++) { n = (n + i * j) | 0; } } return n; })()",
    "(function () { var t = 0; for (var i = 0; i < 700; i++) { t = (t * 31 + i) % 65521; t = t - (i & 3) + (i >> 2) - (i << 1); } return t; })()",
    "(function () { var a = 1, b = 2, c = 0; for (var i = 0; i < 700; i++) { c = a + b; a = b; b = c % 1000; c = a * b; c = a - b; } return c; })()",
    "(function () { var x = 0; for (var i = 0; i < 500; i++) { x = x + 0.1; x = x * 1.5; x = x / 1.5; x = x - 0.1; } return x.toFixed(6); })()",
    "(function () { var big = 0n; for (var i = 0; i < 300; i++) { big++; } for (var j = 10n; j > 0n; j--) { big += j; } return String(big); })()",
    "(function () { var s = 'a'; for (var i = 0; i < 300; i++) { s = s + i; } return s.length; })()",
    "(function () { var n = 0; for (var i = 0; i < 200; i++) { n += i < 100 ? 1 : 2; n += (i == 150) + (i === 150) + (i != 3) + (i !== 4); } return n; })()",
    "var g = 0; for (var i = 0; i < 700; i++) { g = (g + i) | 0; } g",
    "(function () { 'use strict'; var n = 0; for (var i = 0; i < 700; i++) { n = n + i; } return n; })()",
    "eval('(function () { var n = 0; for (var i = 0; i < 700; i++) { n = (n + i * 3) | 0; } return n; })()')",
    "(function () { var n = 0; for (var i = 0; i < 300; i++) { n = eval('n + i'); } return n; })()",
    "Function('var n = 0; for (var i = 0; i < 700; i++) { n = (n + i * 3 - (i >> 1)) | 0; } return n;')()",
    "(function () { var a = [5, 3, 9, 1, 7]; return a.map(function (x) { var t = 0; for (var i = 0; i < x * 40; i++) { t++; } return t; }).join(); })()",
    "(function* () { var t = 0; for (var i = 0; i < 400; i++) { t += i; } yield t; })().next().value",
    "(function () { var r; (async function () { var t = 0; for (var i = 0; i < 50; i++) { t += await i; } r = t; })(); return r; })()",
    // Compartments and lockdown: code evaluated in a compartment, against
    // its own globals and evaluators, and `eval`/`Function` after lockdown.
    "var c = new Compartment(); c.evaluate('var t = 0; for (var i = 0; i < 700; i++) { t = (t + i * 3) | 0; } t')",
    "var c = new Compartment({ globals: { n: 600 }, __options__: true }); c.evaluate('(function () { var t = 0; for (var i = 0; i < n; i++) { t = t + 1; } return t; })()') + c.evaluate('typeof n') + typeof n",
    "var c = new Compartment(); c.evaluate('var f = Function(\"var t = 0; for (var i = 0; i < 500; i++) { t += i & 3; } return t;\"); f() + eval(\"(function () { var s = 0; for (var j = 9; j > 0; j--) { s += j; } return s; })()\")')",
    "lockdown(); var t = 0; for (var i = 0; i < 500; i++) { t = (t + i) | 0; } var o = harden({ k: 1 }); [t, Object.isFrozen(o), Object.isFrozen(Array.prototype), eval('(function () { var s = 0; for (var j = 0; j < 400; j++) { s = s + j; } return s; })()'), Function('var s = 0; for (var j = 0; j < 300; j++) { s++; } return s;')()].join()",
    "lockdown(); var c = new Compartment(); [c.evaluate('(function () { var t = 0; for (let i = 0; i < 600; i++) { t += i; } return t; })()'), c.evaluate('Object.isFrozen(Object.prototype)'), c.evaluate('try { Object.prototype.x = 1; \"wrote\" } catch (e) { e.name }')].join()",
    "(function () { var t = 0; for (var i = 0; i < 300; i++) { t += [1, 2, 3].reduce(function (a, b) { for (var j = 0; j < 3; j++) { a++; } return a + b; }, 0); } return t; })()",
];

/// A wide frame: more than 255 locals, so the loop's local operands are
/// the two-byte `_2` forms.
fn wide_frame() -> String {
    let mut source = String::from("(function () { ");
    for k in 0..300 {
        source.push_str(&format!("var v{k} = {k}; "));
    }
    source.push_str(
        "var n = 0; for (var i = 0; i < 700; i++) { n = (n + i + v299) | 0; } return n + v7; })()",
    );
    source
}

/// Deterministic generated loops: a seeded mixer picks the counter's start,
/// bound, step, operator and body from the shapes the fusions target.
fn generated(count: usize) -> Vec<String> {
    let mut state: u64 = 0x9e37_79b9_7f4a_7c15;
    let mut next = move |n: u64| {
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        state % n
    };
    let ops = ["<", "<=", ">", ">=", "!==", "!="];
    let bodies = [
        "t = (t + i) | 0;",
        "t = (t + i * 3 - (i >> 1)) | 0;",
        "t = t + 1;",
        "t += i & 7;",
        "t = (t ^ i) - (i % 5);",
        "if (i % 4 === 1) continue; t++;",
        "t = t + 0.5;",
        "t = (t << 1) | (i & 1);",
        "",
    ];
    (0..count)
        .map(|_| {
            let op = ops[next(ops.len() as u64) as usize];
            let up = op.starts_with('<') || next(2) == 0;
            let trips = 200 + next(500) as i64;
            let start = [0i64, -7, 1000, 2147483000, -2147483000][next(5) as usize];
            // An inequality test only stops a unit step on its bound.
            let wide = next(3) == 0 && !op.starts_with('!');
            let (bound, step) = if up {
                (start + trips, if wide { "i += 2" } else { "i++" })
            } else {
                (start - trips, if wide { "i -= 2" } else { "i--" })
            };
            let op = match (op, up) {
                ("<" | "<=", false) => ">",
                (">" | ">=", true) => "<",
                (op, _) => op,
            };
            let body = bodies[next(bodies.len() as u64) as usize];
            let decl = if next(2) == 0 { "var" } else { "let" };
            format!(
                "(function () {{ var t = 0; for ({decl} i = {start}; i {op} {bound}; {step}) {{ {body} if (t > 1e9) break; }} return t; }})()"
            )
        })
        .collect()
}

fn computron_fixtures() -> Vec<String> {
    include_str!("../../ironhorse-vm/tests/fixtures/computrons.tsv")
        .lines()
        .skip(1)
        .map(|line| line.split('\t').nth(1).unwrap().to_string())
        .collect()
}

/// Every program, and whether it must complete (the written ones do; the
/// computron fixtures include deliberate throws).
fn corpus() -> Vec<(String, bool)> {
    let mut programs: Vec<(String, bool)> = ROSTER.iter().map(|s| (s.to_string(), true)).collect();
    programs.extend(EDGES.iter().map(|s| (s.to_string(), true)));
    programs.push((wide_frame(), true));
    programs.extend(generated(48).into_iter().map(|s| (s, true)));
    programs.extend(computron_fixtures().into_iter().map(|s| (s, false)));
    programs
}

#[test]
fn corpus_runs_identically_unmetered_and_metered() {
    on_engine_stack(|| {
        for (i, (program, must_complete)) in corpus().iter().enumerate() {
            let label = format!("program {i}: {program:.80}");
            let started = std::time::Instant::now();
            let run = differential(&label, &[program], Host::Unmetered, Mode::Run);
            assert!(
                run.cranks[0].completed || !must_complete,
                "{label}: {}",
                summary(&run.cranks[0])
            );
            // Interval 1: the host is consulted at every check point, so
            // the recorded sequence names every check's position.
            differential(&label, &[program], Host::Continue(1), Mode::Run);
            differential(&label, &[program], Host::Continue(1000), Mode::Run);
            if std::env::var_os("GATE_D_TIMES").is_some() {
                eprintln!("GATE_D {i} {:?} {program:.60}", started.elapsed());
            }
        }
    });
}

/// Programs for the sweeps: the loop shapes fusion targets, a few thousand
/// dispatches long.
const SWEPT: &[&str] = &[
    "(function () { var i = 0; for (i = 0; i < 1200; i++) { } return i; })()",
    "(function () { var t = 0; for (var i = 0; i < 500; i++) { t = (t + i * 3 - (i >> 1)) | 0; } return t; })()",
    "(function () { var n = 0; for (var i = 0; i < 1000; i++) { if (i % 3) continue; n++; } return n; })()",
    "(function () { var n = 0, i = 0; do { n += i; i++; } while (i < 900); return n; })()",
    "(function () { var n = 0; for (let i = 2147483000; i < 2147483647; i++) { n++; } return n; })()",
];

#[test]
fn meter_refusal_sweep_matches_at_every_check() {
    on_engine_stack(|| {
        for program in SWEPT {
            for interval in [1u64, 7] {
                let checks = differential(program, &[program], Host::Continue(interval), Mode::Run)
                    .checks
                    .len();
                assert!(checks > 0, "{program}: the host was never consulted");
                // Every refusal through the first loop iterations and the
                // last, and a stride across the rest that is coprime with
                // the loops' check spacing.
                let refusals = (0..checks).filter(|&n| n < 48 || n + 16 >= checks || n % 13 == 0);
                for n in refusals {
                    let run =
                        differential(program, &[program], Host::AbortAt(interval, n), Mode::Run);
                    assert_eq!(run.cranks[0].halt, "MeterAbort", "{program} refusal {n}");
                }
            }
        }
    });
}

/// The dispatch counts a step-limit sweep stops at: a window around each
/// of the first three 4096-dispatch cadence boundaries, and every count
/// through a stretch of the loop.
fn step_window(total: u64) -> Vec<u64> {
    let mut limits: Vec<u64> = (1..=3u64)
        .flat_map(|k| (k * 4096).saturating_sub(24)..=k * 4096 + 24)
        .filter(|&n| n < total)
        .collect();
    limits.extend((total / 3..total / 3 + 64).filter(|&n| n < total));
    limits.push(total);
    limits.sort_unstable();
    limits.dedup();
    limits
}

#[test]
fn step_limit_sweep_matches_at_every_dispatch() {
    on_engine_stack(|| {
        for program in SWEPT {
            let total = differential(program, &[program], Host::Unmetered, Mode::Run).cranks[0]
                .dispatched_this_run;
            for limit in step_window(total) {
                for host in [Host::Unmetered, Host::Continue(1)] {
                    let run = differential(program, &[program], host, Mode::Bounded(limit));
                    if limit < total {
                        assert!(
                            run.cranks[0].halt.starts_with("StepLimit"),
                            "{program} limit {limit}: {}",
                            run.cranks[0].halt
                        );
                    }
                }
            }
        }
    });
}

/// A machine that ran `setup` and then `resumes[..k]`, snapshotted,
/// restored on an accelerated and a plain machine, each running the rest.
fn suspended_sweep(setup: &str, resumes: &[&str], host: Host) {
    for k in 0..resumes.len() {
        let before: Vec<&str> = std::iter::once(setup)
            .chain(resumes[..k].iter().copied())
            .collect();
        let live = differential(setup, &before, host, Mode::Run);
        let image = live
            .cranks
            .last()
            .unwrap()
            .snapshot
            .clone()
            .unwrap_or_else(|error| panic!("{setup} after {k} resumes: {error}"));
        let resume = |fused: bool| {
            let mut machine = from_snapshot_bytes(&image, &sig()).expect("restore");
            machine.set_dispatch_fusion(fused);
            machine.set_source_compiler(Rc::new(TestCompiler));
            let checks = Rc::new(RefCell::new(Vec::new()));
            attach(&mut machine, host, &checks, false);
            let cranks: Vec<Crank> = resumes[k..]
                .iter()
                .map(|source| observe_crank(&mut machine, source, Mode::Run))
                .collect();
            let checks = checks.borrow().clone();
            Run { cranks, checks }
        };
        let fused = resume(true);
        let plain = resume(false);
        assert_eq!(
            fused, plain,
            "{setup}: resumed after {k} cranks, accelerated and plain differ"
        );
        // The restored twin also matches the machine that never stopped.
        let mut all = before.clone();
        all.extend(&resumes[k..]);
        let uninterrupted = differential(setup, &all, host, Mode::Run);
        assert_eq!(
            plain.cranks.iter().map(|c| &c.result).collect::<Vec<_>>(),
            uninterrupted.cranks[k + 1..]
                .iter()
                .map(|c| &c.result)
                .collect::<Vec<_>>(),
            "{setup}: the resumed results follow the uninterrupted machine"
        );
    }
}

#[test]
fn generator_and_async_resume_from_snapshots_inside_fused_loops() {
    on_engine_stack(|| {
        let generator = "var g = (function* () { var t = 0; for (var i = 0; i < 600; i++) { t = (t + i) | 0; if (i % 97 === 5) { yield t; } } return -t; })(); 0";
        let next = ["g.next().value"; 8];
        suspended_sweep(generator, &next, Host::Unmetered);
        suspended_sweep(generator, &next, Host::Continue(1));
        let asynchronous = "var resolvers = []; var out = 0; function tick() { return new Promise(function (r) { resolvers.push(r); }); } (async function () { for (var i = 0; i < 6; i++) { for (var j = 0; j < 300; j++) { out = (out + j) | 0; } await tick(); } out = -out; })(); out";
        let resume = ["resolvers.shift()(0); out"; 7];
        suspended_sweep(asynchronous, &resume, Host::Unmetered);
        suspended_sweep(asynchronous, &resume, Host::Continue(1));
    });
}

#[test]
fn eval_function_and_cross_crank_code_run_identically() {
    on_engine_stack(|| {
        let cranks = [
            "var f = Function('n', 'var t = 0; for (var i = 0; i < n; i++) { t = (t + i) | 0; } return t;'); f(500)",
            "var h = eval('(function (n) { var t = 0; for (var i = n; i > 0; i--) { t += i & 3; } return t; })'); f(300) + h(400)",
            "function k(n) { var t = 0; for (var i = 0; i < n; i++) { t = t + 2; } return t; } f(100) + h(100) + k(700)",
            "k(900) + f(900) + h(900)",
        ];
        for host in [Host::Unmetered, Host::Continue(1)] {
            differential("cross-crank code", &cranks, host, Mode::Run);
        }
    });
}
