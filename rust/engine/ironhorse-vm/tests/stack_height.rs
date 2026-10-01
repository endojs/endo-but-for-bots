//! Native stack high-water marks for the recursion families and compiler pins:
//! the native lane of `STACK-DEPTH-REFACTOR.md` §5 Phase 0a.
//!
//! Each case runs on a fresh thread of [`NATIVE_STACK_BYTES`], the documented
//! contract stack. Before each stage under measurement (compiling the source;
//! running it on a fresh machine) the unused stack below the caller's frame is
//! painted with a sentinel, and afterwards the lowest byte the stage dirtied
//! gives its high-water mark in bytes below that frame (`stack-lanes/paint.rs`).
//! One run per case, byte-exact, no bisection and no engine instrumentation.
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
//! Phase 0 lane measures. A case that needs eval compiles it through the
//! production bridge, `ironhorse_runtime::IronhorseSourceCompiler`, as the
//! stack-lanes probe and the daemon do, so `eval-deep` and the other eval
//! cases compile on top of the VM's depth exactly as they do there (report
//! §2.4).

use ironhorse_runtime::IronhorseSourceCompiler;
use ironhorse_vm::{Interp, RunOutcome, NATIVE_STACK_BYTES};

#[path = "../../stack-lanes/cases.rs"]
mod cases;
#[path = "../../stack-lanes/paint.rs"]
mod paint;
use cases::{cases, Case};
use paint::stage;

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
            machine.set_source_compiler(std::rc::Rc::new(IronhorseSourceCompiler));
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
