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
//! ih-stack-probe source [--compile-only] [--eval-compiler]  # the program on standard input
//! ```
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
//! the harness.

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

/// With `--stack`, each stage's native high-water mark is appended as
/// ` stack=<bytes>` (0 on wasm, where the host paints the shadow stack).
fn run(source: &str, compile_only: bool, eval_compiler: bool, stack: bool) {
    let (compiled, compile_bytes) = paint::stage(|| compile(source));
    let suffix = |bytes: usize| {
        if stack {
            format!(" stack={bytes}")
        } else {
            String::new()
        }
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
    let (out, run_bytes) = paint::stage(|| machine.run(&bytecode).host_coerced());
    println!(
        "halt={:?} result={} meter={}{}",
        out.halt,
        json_string(&out.result),
        machine.meter_index(),
        suffix(run_bytes)
    );
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
    let stack = args.iter().any(|a| a == "--stack");
    match args.get(1).map(String::as_str) {
        Some("dump-cases") => dump_cases(),
        Some("case") => {
            let name = args.get(2).map(String::as_str).unwrap_or("");
            match cases::cases().into_iter().find(|c| c.name == name) {
                Some(case) => run(
                    &case.source,
                    compile_only || !case.run,
                    case.eval_compiler,
                    stack,
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
                    run(&source, compile_only || kind == "chain", needs_eval, stack)
                }
                None => {
                    eprintln!("unknown family: {kind} {name}");
                    std::process::exit(2);
                }
            }
        }
        Some("source") => {
            let mut source = String::new();
            std::io::stdin()
                .read_to_string(&mut source)
                .expect("read the program from standard input");
            run(&source, compile_only, eval_compiler, stack);
        }
        _ => {
            eprintln!(
                "usage: ih-stack-probe dump-cases | case <name> [--compile-only] | \
                 family <heavy|walker|chain> <name> <n> | source [--compile-only] [--eval-compiler]"
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
