//! The stack-lanes probe: compiles and runs one program of the shared corpus, or
//! one read from standard input, and prints its outcome in a form that must be
//! byte-identical on every host. Built for the host (the native reference) and
//! for `wasm32-wasip1` (Wasmtime, Node's `node:wasi`, workerd) by
//! `build_probe.py`.
//!
//! ```text
//! ih-stack-probe dump-cases              # the corpus, one JSON object per line
//! ih-stack-probe case <name> [--compile-only]
//! ih-stack-probe family <heavy|walker|chain> <name> <n>   # a family at depth n
//! ih-stack-probe family-source <heavy|walker|chain> <name> <n>   # its program, as JSON
//! ih-stack-probe source [--compile-only] [--eval-compiler]  # the program on standard input
//! ```
//!
//! Every run command also takes `--stack`, `--digest` and `--meter-trace`.
//!
//! Natively, a case runs on a thread of the documented contract stack
//! (`NATIVE_STACK_BYTES`), as the recursion-budget tests do. The eval bridge
//! (`ironhorse_runtime::IronhorseSourceCompiler`) is installed for the cases
//! that ask for it and for `source --eval-compiler`.
//!
//! A run prints one line, `halt=<Halt> result=<string> meter=<n>`; a compile
//! prints `compile=ok` or `compile=refused message=<string>`. With `--stack`,
//! natively, each line also carries the stage's host-stack high-water mark
//! (`stack-lanes/paint.rs`), so scripts can measure bytes per level without
//! the harness. With `--digest`, each line also carries a fingerprint of the
//! compile: an FNV-1a hash of the bytecode and symbols, the raw parse meter,
//! and a hash of every charge the parse meter made in order. With
//! `--meter-trace`, a run arms the meter at every computron with a host that
//! records the computron count at each check it is shown, and the line
//! carries the number of checks and a hash of the counts, so a check that
//! moves shows even when the total does not. `differential.py`, which
//! compares two builds, reads both.

#[path = "../../cases.rs"]
mod cases;
#[path = "../../paint.rs"]
mod paint;

use std::io::{Read, Write};

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn compile(source: &str) -> Result<(Vec<u8>, Vec<ironhorse_vm::SymbolName>), String> {
    match ironhorse_compile::compile_atoms(source) {
        Ok((bytecode, symbols)) => Ok((bytecode, ironhorse_vm::parse_symbols(&symbols))),
        Err(error) => Err(format!("{error:?}")),
    }
}

/// FNV-1a over a sequence of byte strings, each prefixed by its length so
/// that the boundaries count.
#[inline(never)]
fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for part in parts {
        for byte in (part.len() as u64).to_le_bytes().iter().chain(part.iter()) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0100_0000_01b3);
        }
    }
    hash
}

/// ` digest=<bytecode and symbols> parse_meter=<raw> charges=<n>:<hash>`: the
/// same Script compile as [`compile`], through the budgeted entry that reports
/// every parse-meter charge, so two builds can be compared for identical
/// output and identical metering, including a refused compile's. Kept out of
/// line so that [`run`]'s frame, which every lane measures, does not grow.
#[inline(never)]
fn digest(source: &str) -> String {
    let mut charges: Vec<u8> = Vec::new();
    let mut count: u64 = 0;
    let mut charge = |delta: u64| {
        charges.extend_from_slice(&delta.to_le_bytes());
        count += 1;
        true
    };
    let compiled = ironhorse_compile::compile_atoms_budgeted(
        source,
        ironhorse_compile::Goal::Script,
        false,
        &mut charge,
    );
    let charged = format!("{count}:{:016x}", fnv1a(&[&charges]));
    match compiled {
        Ok(atoms) => format!(
            " digest={:016x} parse_meter={} charges={charged}",
            fnv1a(&[&atoms.bytecode, &atoms.symbols]),
            atoms.parse_meter_raw
        ),
        Err(error) => format!(
            " digest=refused:{:016x} charges={charged}",
            fnv1a(&[format!("{error:?}").as_bytes()])
        ),
    }
}

/// What a `--meter-trace` host saw: how many checks, and a running FNV-1a
/// hash of the computron count at each.
#[derive(Default)]
struct MeterTrace {
    checks: u64,
    hash: u64,
}

/// Arm `machine`'s meter at every computron with a host that records each
/// count it is shown and never stops the run. It re-arms rather than arms, so a
/// charge made before the run (none is today) stays in the index.
#[inline(never)]
fn arm_meter_trace(
    machine: &mut ironhorse_vm::Interp,
) -> std::rc::Rc<std::cell::RefCell<MeterTrace>> {
    let trace = std::rc::Rc::new(std::cell::RefCell::new(MeterTrace {
        checks: 0,
        hash: 0xcbf2_9ce4_8422_2325,
    }));
    let seen = trace.clone();
    machine.rearm_meter(
        1,
        Box::new(move |computrons| {
            let mut seen = seen.borrow_mut();
            seen.checks += 1;
            for byte in computrons.to_le_bytes() {
                seen.hash ^= u64::from(byte);
                seen.hash = seen.hash.wrapping_mul(0x0100_0000_01b3);
            }
            true
        }),
    );
    trace
}

/// What `run` appends to its line for `--stack`, `--digest` and
/// `--meter-trace`.
#[derive(Clone, Copy)]
struct Extras {
    stack: bool,
    fingerprint: bool,
    meter_trace: bool,
}

/// With `--stack`, each stage's native high-water mark is appended as
/// ` stack=<bytes>` (0 on wasm, where the host paints the shadow stack); with
/// `--digest`, the compile's fingerprint ([`digest`]), computed after the
/// run so it never stands in for the run's own outcome; with
/// `--meter-trace`, the checks the meter host saw ([`arm_meter_trace`]).
fn run(source: &str, compile_only: bool, eval_compiler: bool, extras: Extras) {
    let (compiled, compile_bytes) = paint::stage(|| compile(source));
    let suffix = |bytes: usize| {
        let painted = if extras.stack {
            format!(" stack={bytes}")
        } else {
            String::new()
        };
        let digested = if extras.fingerprint {
            digest(source)
        } else {
            String::new()
        };
        format!("{painted}{digested}")
    };
    let (bytecode, names) = match compiled {
        Ok(compiled) => compiled,
        Err(message) => {
            println!(
                "compile=refused message={}{}",
                json_string(&message),
                suffix(compile_bytes)
            );
            return;
        }
    };
    if compile_only {
        println!("compile=ok{}", suffix(compile_bytes));
        return;
    }
    let mut machine = ironhorse_vm::Interp::new();
    machine.link_intrinsics(&names);
    if eval_compiler {
        machine.set_source_compiler(std::rc::Rc::new(ironhorse_runtime::IronhorseSourceCompiler));
    }
    let trace = extras.meter_trace.then(|| arm_meter_trace(&mut machine));
    let (out, run_bytes) = paint::stage(|| machine.run(&bytecode).host_coerced());
    let traced = match trace {
        Some(trace) => {
            let trace = trace.borrow();
            format!(" checks={}:{:016x}", trace.checks, trace.hash)
        }
        None => String::new(),
    };
    println!(
        "halt={:?} result={} meter={}{}{}",
        out.halt,
        json_string(&out.result),
        machine.meter_index(),
        suffix(run_bytes),
        traced
    );
}

/// `family-source <kind> <name> <n>`: the program `family` would run, as one
/// JSON object with the flags it would run under, so that two builds can be
/// handed the same text.
fn family_source(kind: &str, name: &str, n: usize) {
    let generated = match kind {
        "heavy" => cases::heavy(name, n),
        "walker" => cases::walker(name, n).map(|s| (s, false)),
        "chain" => cases::chain(name, n).map(|s| (s, false)),
        _ => None,
    };
    match generated {
        Some((source, needs_eval)) => println!(
            "{{\"compile_only\":{},\"eval_compiler\":{},\"source\":{}}}",
            kind == "chain",
            needs_eval,
            json_string(&source)
        ),
        None => {
            eprintln!("unknown family: {kind} {name}");
            std::process::exit(2);
        }
    }
}

fn dump_cases() {
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    for case in cases::cases() {
        let written = writeln!(
            out,
            "{{\"name\":{},\"run\":{},\"eval_compiler\":{},\"source\":{}}}",
            json_string(case.name),
            case.run,
            case.eval_compiler,
            json_string(&case.source)
        );
        if let Err(error) = written {
            // A reader that stopped early (`| head`) is not a failure.
            if error.kind() == std::io::ErrorKind::BrokenPipe {
                std::process::exit(0);
            }
            panic!("write to stdout: {error}");
        }
    }
}

fn dispatch(args: Vec<String>) {
    let compile_only = args.iter().any(|a| a == "--compile-only");
    let eval_compiler = args.iter().any(|a| a == "--eval-compiler");
    let extras = Extras {
        stack: args.iter().any(|a| a == "--stack"),
        fingerprint: args.iter().any(|a| a == "--digest"),
        meter_trace: args.iter().any(|a| a == "--meter-trace"),
    };
    match args.get(1).map(String::as_str) {
        Some("dump-cases") => dump_cases(),
        Some("case") => {
            let name = args.get(2).map(String::as_str).unwrap_or("");
            match cases::cases().into_iter().find(|c| c.name == name) {
                Some(case) => run(
                    &case.source,
                    compile_only || !case.run,
                    case.eval_compiler,
                    extras,
                ),
                None => {
                    eprintln!("unknown case: {name}");
                    std::process::exit(2);
                }
            }
        }
        Some("family") => {
            // family <heavy|walker|chain> <name> <n>: generate the program at that
            // depth and run it (chains compile only), for `ceilings.py`.
            let kind = args.get(2).map(String::as_str).unwrap_or("");
            let name = args.get(3).map(String::as_str).unwrap_or("");
            let n: usize = args.get(4).and_then(|a| a.parse().ok()).unwrap_or(0);
            let generated = match kind {
                "heavy" => cases::heavy(name, n),
                "walker" => cases::walker(name, n).map(|s| (s, false)),
                "chain" => cases::chain(name, n).map(|s| (s, false)),
                _ => None,
            };
            match generated {
                Some((source, needs_eval)) => {
                    run(&source, compile_only || kind == "chain", needs_eval, extras)
                }
                None => {
                    eprintln!("unknown family: {kind} {name}");
                    std::process::exit(2);
                }
            }
        }
        Some("family-source") => family_source(
            args.get(2).map(String::as_str).unwrap_or(""),
            args.get(3).map(String::as_str).unwrap_or(""),
            args.get(4).and_then(|a| a.parse().ok()).unwrap_or(0),
        ),
        Some("source") => {
            let mut source = String::new();
            std::io::stdin()
                .read_to_string(&mut source)
                .expect("read the program from standard input");
            run(&source, compile_only, eval_compiler, extras);
        }
        _ => {
            eprintln!(
                "usage: ih-stack-probe dump-cases | case <name> [--compile-only] | \
                 family <heavy|walker|chain> <name> <n> | family-source <kind> <name> <n> | \
                 source [--compile-only] [--eval-compiler] \
                 (a run with --stack, --digest or --meter-trace)"
            );
            std::process::exit(2);
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // Natively, run on the documented contract stack, as the recursion-budget
    // tests do, so the reference does not depend on the main thread's
    // `ulimit -s`. On wasm the shadow stack is fixed at link time and WASI
    // preview1 has no threads, so run inline.
    if cfg!(target_arch = "wasm32") {
        dispatch(args);
        return;
    }
    std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || dispatch(args))
        .expect("spawn the contract-stack thread")
        .join()
        .expect("the probe must halt, never panic or abort");
}
