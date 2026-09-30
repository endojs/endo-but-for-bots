//! Native stack high-water marks for the recursion families and compiler pins:
//! the native lane of `STACK-DEPTH-REFACTOR.md` §5 Phase 0a.
//!
//! Each case runs on a fresh thread of [`NATIVE_STACK_BYTES`], the documented
//! contract stack. Before each stage under measurement (compiling the source;
//! running it on a fresh machine) the unused stack below the caller's frame is
//! painted with a sentinel, and afterwards the lowest byte the stage dirtied
//! gives its high-water mark in bytes below that frame. One run per case,
//! byte-exact, no bisection and no engine instrumentation.
//!
//! Frame sizes are a property of the build, so the marks are deterministic for
//! one compiler, target and profile and move when any of those does. The gate
//! is `benches/stack_height.py`, which keeps a baseline per build provenance
//! and fails when a case grows past it or changes outcome.
//!
//! The marks are native. They show whether a refactor shrinks frames; they do
//! not predict which cases trap on Wasmtime or V8, whose frames differ (report
//! §1.2-§1.4).
//!
//! ```sh
//! cargo test --release -p ironhorse-vm --test stack_height -- --ignored --nocapture --test-threads=1
//! ```
//!
//! The scenarios are those of `native_recursion_budget.rs` (the report's 25
//! family cases are "the `native_recursion_budget` cases plus their
//! within-budget twins", §1.3) and the accepted pins of
//! `ironhorse-compile/tests/recursion_bounds.rs`.

use ironhorse_vm::{Interp, RunOutcome, NATIVE_STACK_BYTES};

const SENTINEL: u8 = 0xA5;
const PAGE: usize = 4096;
/// Left unpainted at the bottom of the thread's stack: the guard pages, and the
/// thread's own start frames above the painter, whose sizes are not known.
const BOTTOM_MARGIN: usize = 256 * 1024;
/// Left unpainted just below the painter's own frame.
const TOP_GAP: usize = 2 * PAGE;

struct Painted {
    top: usize,
    bottom: usize,
}

/// Paint the unused stack below this frame. Pages are touched from the top
/// down: Windows commits thread stacks through a moving guard page and faults
/// on a touch more than one page below it.
#[inline(never)]
fn paint() -> Painted {
    let marker = 0u8;
    let here = std::hint::black_box(&marker) as *const u8 as usize;
    let top = (here - TOP_GAP) & !(PAGE - 1);
    let bottom = (here + BOTTOM_MARGIN - NATIVE_STACK_BYTES) & !(PAGE - 1);
    let mut page = top;
    while page > bottom {
        page -= PAGE;
        // SAFETY: `[bottom, top)` lies inside this thread's stack mapping and
        // below every live frame; nothing owns it until a callee grows into it.
        unsafe { std::ptr::write_bytes(page as *mut u8, SENTINEL, PAGE) };
    }
    Painted { top, bottom }
}

/// Bytes below `base` that were dirtied since `paint`, or the floor
/// (`base - top`) when nothing below the gap was touched.
#[inline(never)]
fn high_water(painted: &Painted, base: usize) -> usize {
    let mut addr = painted.bottom;
    while addr < painted.top {
        // SAFETY: as in `paint`.
        if unsafe { std::ptr::read_volatile(addr as *const u8) } != SENTINEL {
            return base - addr;
        }
        addr += 1;
    }
    base - painted.top
}

/// Run `f` with the stack below this frame painted; return its value and the
/// bytes of stack it used below this frame.
#[inline(never)]
fn stage<T>(f: impl FnOnce() -> T) -> (T, usize) {
    let marker = 0u8;
    let base = std::hint::black_box(&marker) as *const u8 as usize;
    let painted = paint();
    let value = f();
    let used = high_water(&painted, base);
    (value, used)
}

fn on_contract_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    std::thread::Builder::new()
        .stack_size(NATIVE_STACK_BYTES)
        .spawn(f)
        .expect("spawn the contract-stack thread")
        .join()
        .expect("the engine must halt, never panic or abort")
}

fn outcome_label(out: &RunOutcome) -> String {
    if out.completed {
        return "completed".into();
    }
    let debug = format!("{:?}", out.halt);
    debug
        .split(['{', '(', ' '])
        .next()
        .unwrap_or("halt")
        .to_string()
}

/// The crate's own source compiler as the eval bridge, as
/// `native_recursion_budget.rs` installs it, so `eval-deep` compiles on top of
/// the VM's depth (report §2.4).
struct IronhorseCompiler;
impl ironhorse_vm::SourceCompiler for IronhorseCompiler {
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
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpResourceLimit,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::HeapExhausted),
                ironhorse_compile::ParseErrorKind::Lex(ironhorse_compile::LexError {
                    kind: ironhorse_compile::LexErrorKind::RegExpBudgetExceeded,
                    ..
                }) => Err(ironhorse_vm::SourceCompileError::MeterAbort),
                ironhorse_compile::ParseErrorKind::Unsupported => Err(
                    ironhorse_vm::SourceCompileError::Unsupported(error.to_string()),
                ),
                _ => Err(ironhorse_vm::SourceCompileError::Syntax(error.message)),
            },
        }
    }
}

struct Case {
    name: &'static str,
    source: String,
    /// Run the program after compiling it; compiler pins only compile.
    run: bool,
    /// Install the eval bridge.
    eval_compiler: bool,
}

struct Measured {
    name: &'static str,
    compile_bytes: usize,
    compiled: bool,
    /// Bytes, outcome label and completion value of the run stage.
    run: Option<(usize, String, String)>,
}

fn measure(case: Case) -> Measured {
    on_contract_stack(move || {
        let (compiled, compile_bytes) = stage(|| {
            ironhorse_compile::compile_atoms(&case.source)
                .map(|(bytecode, symbols)| (bytecode, ironhorse_vm::parse_symbols(&symbols)))
        });
        let (bytecode, names) = match compiled {
            Ok(compiled) => compiled,
            Err(_) => {
                return Measured {
                    name: case.name,
                    compile_bytes,
                    compiled: false,
                    run: None,
                }
            }
        };
        if !case.run {
            return Measured {
                name: case.name,
                compile_bytes,
                compiled: true,
                run: None,
            };
        }
        let mut machine = Interp::new();
        machine.link_intrinsics(&names);
        if case.eval_compiler {
            machine.set_source_compiler(std::rc::Rc::new(IronhorseCompiler));
        }
        let (out, run_bytes) = stage(|| machine.run(&bytecode).host_coerced());
        Measured {
            name: case.name,
            compile_bytes,
            compiled: true,
            run: Some((run_bytes, outcome_label(&out), out.result.clone())),
        }
    })
}

/// `layers` proxies wrapped around `{x: 1}`, then `tail`.
fn proxy_chain(layers: usize, tail: &str) -> String {
    format!("var p = {{x: 1}}; for (var i = 0; i < {layers}; i++) p = new Proxy(p, {{}}); {tail}")
}

/// `depth` arrays nested inside `a`, each the sole element of its parent.
fn nested_arrays(depth: usize) -> String {
    format!("var a = []; var r = a; for (var i = 0; i < {depth}; i++) {{ var b = []; r[0] = b; r = b; }} ")
}

/// A reviver that installs a `depth`-deep sibling while the walk is on.
fn reviver(depth: usize) -> String {
    format!(
        "{} JSON.parse('[1,2]', function (k, v) {{ if (k === '0') this[1] = a; return v; }}); 1",
        nested_arrays(depth)
    )
}

fn foreach_nest(levels: usize) -> String {
    format!(
        "function f(n) {{ if (n > 0) [0].forEach(function () {{ f(n - 1); }}); }} f({levels}); 1"
    )
}

fn async_nest(levels: usize) -> String {
    format!("async function f(n) {{ if (n > 0) await f(n - 1); }} f({levels}); 1")
}

fn wrapped(open: &str, core: &str, close: &str, depth: usize) -> String {
    format!("{}{core}{}", open.repeat(depth), close.repeat(depth))
}

const EVAL_DEEP: &str = "var r = []; \
    function tryEval(src) { try { eval(src); r.push('ok'); } catch (e) { r.push(e instanceof SyntaxError ? 'syntax' : 'other'); } } \
    tryEval('('.repeat(5000) + '1' + ')'.repeat(5000)); \
    tryEval('1' + '+1'.repeat(5000)); \
    tryEval('{'.repeat(5000) + '}'.repeat(5000)); \
    tryEval('('.repeat(50) + '1' + ')'.repeat(50)); \
    r.join()";

const REGEXP_DEEP: &str = "var r = []; \
    try { new RegExp('('.repeat(5000) + 'a' + ')'.repeat(5000)); r.push('ok'); } \
    catch (e) { r.push(e instanceof SyntaxError ? 'syntax' : 'other'); } \
    r.push(new RegExp('a|'.repeat(20000) + 'b').test('b')); \
    r.push(new RegExp('a'.repeat(20000)).test('a'.repeat(20000))); \
    r.join()";

fn cases() -> Vec<Case> {
    fn run(name: &'static str, source: String) -> Case {
        Case {
            name,
            source,
            run: true,
            eval_compiler: false,
        }
    }
    fn compile_only(name: &'static str, source: String) -> Case {
        Case {
            name,
            source,
            run: false,
            eval_compiler: false,
        }
    }
    let mut cases = vec![
        // The harness floor: what an empty program costs.
        run("floor", "1".into()),
        // Proxy forwarding, one light frame per trap-absent layer (report §2.2).
        // The 10k cases halt at the budget; 2016 is the largest accepted [[Get]] chain.
        run("proxy-get-10k", proxy_chain(10_000, "p.x")),
        run("proxy-get-2016", proxy_chain(2016, "p.x")),
        run("proxy-get-256", proxy_chain(256, "p.x")),
        run("proxy-get-index-10k", proxy_chain(10_000, "p[0]")),
        run("proxy-set-10k", proxy_chain(10_000, "p.x = 2; 1")),
        run("proxy-has-10k", proxy_chain(10_000, "'x' in p")),
        run("proxy-delete-10k", proxy_chain(10_000, "delete p.x")),
        run("proxy-keys-10k", proxy_chain(10_000, "Object.keys(p).length")),
        run(
            "proxy-getownproperty-10k",
            proxy_chain(10_000, "Object.getOwnPropertyDescriptor(p, 'x').value"),
        ),
        run(
            "proxy-define-10k",
            proxy_chain(10_000, "Object.defineProperty(p, 'y', {value: 1}); 1"),
        ),
        run(
            "proxy-getprototypeof-10k",
            proxy_chain(10_000, "Object.getPrototypeOf(p) === Object.prototype"),
        ),
        run("proxy-setprototypeof-10k", proxy_chain(10_000, "Object.setPrototypeOf(p, null); 1")),
        run("proxy-isextensible-10k", proxy_chain(10_000, "Object.isExtensible(p)")),
        run("proxy-preventextensions-10k", proxy_chain(10_000, "Object.preventExtensions(p); 1")),
        run(
            "proxy-call-10k",
            "var p = function () { return 1; }; for (var i = 0; i < 10000; i++) p = new Proxy(p, {}); p()".into(),
        ),
        run(
            "proxy-construct-10k",
            "var p = function () {}; for (var i = 0; i < 10000; i++) p = new Proxy(p, {}); new p(); 1".into(),
        ),
        run(
            "proxy-proto-cycle",
            "var t = {}; var p = new Proxy(t, {}); Object.setPrototypeOf(t, p); t.zzz".into(),
        ),
        // Native-to-native re-entry (§2.1): join stringifies an element that is the array.
        run("join-self", "var a = []; a[0] = a; a.join()".into()),
        run("string-self", "var a = []; a[0] = a; String(a)".into()),
        // The host renderer of the completion value.
        run("render-nested-256", format!("{} a", nested_arrays(256))),
        run("render-self", "var a = []; a[0] = a; a".into()),
        // Data-structure walkers (§2.3).
        run("json-parse-arr-10k", "JSON.parse('['.repeat(10000) + ']'.repeat(10000)); 1".into()),
        run(
            "json-parse-obj-10k",
            "JSON.parse('{\"a\":'.repeat(10000) + '1' + '}'.repeat(10000)); 1".into(),
        ),
        run("json-parse-arr-256", "JSON.parse('['.repeat(256) + ']'.repeat(256)); 1".into()),
        run("json-reviver-10k", reviver(10_000)),
        run("json-reviver-200", reviver(200)),
        run("json-stringify-10k", format!("{} JSON.stringify(a).length", nested_arrays(10_000))),
        run("json-stringify-256", format!("{} JSON.stringify(a).length", nested_arrays(256))),
        run("flat-self", "var a = []; a[0] = a; a.flat(Infinity)".into()),
        run("flat-256", format!("{} a.flat(Infinity).length", nested_arrays(256))),
        // Heavy re-entry through `dispatch_at` (§2.1).
        run("foreach-63", foreach_nest(63)),
        run("foreach-64", foreach_nest(64)),
        run("foreach-10k", foreach_nest(10_000)),
        run("async-64", async_nest(64)),
        run("async-10k", async_nest(10_000)),
        run(
            "iter-setter",
            "var k='constructor';var d=Object.getOwnPropertyDescriptor(Iterator.prototype,k);var o={};Object.defineProperty(o,k,d);o[k]=1;'done'".into(),
        ),
        run("regexp-deep", REGEXP_DEEP.into()),
        // Walks that stay in place: controls that must stay flat in the chain length.
        run(
            "proto-chain-ordinary-20k",
            "var o = {x: 1}; for (var i = 0; i < 20000; i++) o = Object.create(o); o.x".into(),
        ),
        run(
            "proto-chain-arrays-20k",
            "var o = []; for (var i = 0; i < 20000; i++) { var a = []; Object.setPrototypeOf(a, o); o = a; } o.zzz === undefined".into(),
        ),
        run(
            "bind-call-10k",
            "function f() { return 7; } var c = f; for (var i = 0; i < 10000; i++) c = c.call.bind(c); c()".into(),
        ),
        run(
            "async-gen-drain-40k",
            "async function* ag() {} var g = ag(); for (var i = 0; i < 40000; i++) g.next(); 1".into(),
        ),
        // Runtime compiles through the eval bridge, on top of the VM's depth (§2.4).
        Case { name: "eval-deep", source: EVAL_DEEP.into(), run: true, eval_compiler: true },
    ];
    // Compiler pins at their accepted depth (`recursion_bounds.rs`); compile stage only.
    for (name, source) in [
        ("parse-parens-91", wrapped("(", "1", ")", 91)),
        ("parse-array-91", wrapped("[", "1", "]", 91)),
        (
            "parse-object-90",
            format!("({})", wrapped("{a:", "1", "}", 90)),
        ),
        ("parse-call-args-91", wrapped("f(", "1", ")", 91)),
        ("parse-arrow-91", wrapped("()=>", "1", "", 91)),
        ("parse-template-91", wrapped("`${", "1", "}`", 91)),
        ("parse-blocks-512", wrapped("{", "", "}", 512)),
        (
            "parse-functions-512",
            wrapped("function f(){", "", "}", 512),
        ),
        ("parse-if-505", wrapped("if(1) ", "1", "", 505)),
        ("parse-new-505", wrapped("new ", "f", "", 505)),
        (
            "parse-binding-510",
            format!("var {} = x", wrapped("[", "a", "]", 510)),
        ),
        ("parse-cond-chain-1011", wrapped("a?b:", "1", "", 1011)),
        ("parse-assign-chain-1011", wrapped("a=", "1", "", 1011)),
        ("parse-binary-chain-2045", format!("1{}", "+1".repeat(2045))),
        ("parse-member-chain-2045", format!("a{}", ".b".repeat(2045))),
        ("parse-call-chain-2044", format!("f{}", "()".repeat(2044))),
        (
            "parse-elseif-chain-2044",
            format!("if (a) x; {}else y;", "else if (a) x; ".repeat(2044)),
        ),
        ("parse-tagged-chain-2043", format!("f{}", "``".repeat(2043))),
    ] {
        cases.push(compile_only(name, source));
    }
    cases
}

#[test]
#[ignore = "instrument: run explicitly in --release; benches/stack_height.py gates it"]
fn native_stack_high_water_marks() {
    assert!(
        !cfg!(debug_assertions),
        "measure the release profile: debug frames are several times larger"
    );
    for case in cases() {
        let m = measure(case);
        println!(
            "STACK_METRIC {}.compile {} {}",
            m.name,
            m.compile_bytes,
            if m.compiled { "compiled" } else { "refused" }
        );
        if let Some((bytes, outcome, result)) = m.run {
            println!(
                "STACK_METRIC {}.run {bytes} {outcome} result={result:?}",
                m.name
            );
        }
    }
}

/// A frame of about 4 KiB, `depth` deep, that the optimizer cannot flatten.
#[inline(never)]
fn burn(depth: usize) -> usize {
    let mut pad = [0u8; 4096];
    pad[0] = depth as u8;
    std::hint::black_box(&mut pad);
    if depth == 0 {
        pad[0] as usize
    } else {
        burn(depth - 1) + pad[1] as usize
    }
}

#[test]
fn the_painter_measures_a_known_recursion() {
    let ((_, at_100), (_, at_200)) =
        on_contract_stack(|| (stage(|| burn(100)), stage(|| burn(200))));
    assert!(at_100 >= 100 * 4096, "100 frames of 4 KiB: {at_100} B");
    assert!(at_100 <= 100 * 4096 * 2, "100 frames of 4 KiB: {at_100} B");
    let ratio = at_200 as f64 / at_100 as f64;
    assert!(
        (1.8..=2.2).contains(&ratio),
        "200 frames against 100: {ratio:.3}x"
    );
}

#[test]
fn the_measurement_is_deterministic() {
    let first = on_contract_stack(|| stage(|| burn(50)).1);
    let second = on_contract_stack(|| stage(|| burn(50)).1);
    assert_eq!(first, second, "the same recursion must paint the same mark");
}
