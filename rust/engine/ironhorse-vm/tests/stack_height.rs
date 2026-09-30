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
//! The cases are the shared corpus in `stack-lanes/cases.rs`, which every
//! Phase 0 lane measures.

use ironhorse_vm::{Interp, RunOutcome, NATIVE_STACK_BYTES};

#[path = "../../stack-lanes/cases.rs"]
mod cases;
use cases::{cases, Case};

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
