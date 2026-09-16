//! `ironhorse-xst` — ironhorse as a plain test262 HOST, for `test262-harness`.
//!
//! The `ses-xs-parity` axis has three hosts. Two of them are `node` and `xst`,
//! driven by `test262-harness` with a SES prelude: the harness assembles the
//! case, writes it to a file, runs the binary on it, and reads an uncaught
//! throw off stderr as the failure. The third was `endot-ih`, which is a
//! DIFFERENTIAL runner — it answers "does ironhorse agree with XS", and every
//! verdict it reaches is a function of that agreement, so it cannot award
//! coverage without the oracle's assent.
//!
//! That is the wrong question for this lane. The corpus is test262; its own
//! `Test262Error` assertions already encode pass and fail, and a SES prelude
//! supplies the Hardened-JavaScript surface. Running ironhorse against those
//! sources needs no second engine at all — and feeding XS an ironhorse-shaped
//! prelude, as the dual-run necessarily does, makes XS fail cases it passes
//! under its own.
//!
//! So this binary is deliberately tiny, and exists to be driven by the real
//! harness rather than to replace it:
//!
//! ```sh
//! test262-harness --host-type xs --host-path .../ironhorse-xst \
//!   --prelude prelude/ironhorse.js --features-include ses-xs-parity ...
//! ```
//!
//! `--host-type xs` is `eshost`'s "a binary that takes JS files and runs
//! them" adapter (`eshost/lib/agents/xs.js`): it passes `-s <file>` and parses
//! stderr with `/^(\w+):? ?(.*)$/m`. `Halt::Throw` already renders as
//! `Name: message`, so that is printed verbatim.

use ironhorse_262::{compile_failure_name, run_script_source};
use ironhorse_vm::Halt;

fn main() {
    let mut files: Vec<String> = Vec::new();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            // eshost's script/module selectors. Modules are not supported
            // here yet; say so rather than silently running as a script.
            "-s" | "-u" => {}
            "-m" => {
                eprintln!("InternalError: ironhorse-xst does not run module-goal cases yet");
                std::process::exit(2);
            }
            other if other.starts_with('-') => {}
            other => files.push(other.to_string()),
        }
    }
    if files.is_empty() {
        eprintln!("InternalError: ironhorse-xst needs at least one file");
        std::process::exit(2);
    }

    let mut source = String::new();
    for f in &files {
        match std::fs::read_to_string(f) {
            Ok(text) => {
                source.push_str(&text);
                source.push('\n');
            }
            Err(e) => {
                eprintln!("InternalError: {f}: {e}");
                std::process::exit(2);
            }
        }
    }

    // test262 sources recurse deeply enough to need the engine's own stack
    // budget, exactly as the differential runner gives them.
    let code = std::thread::Builder::new()
        .stack_size(ironhorse_vm::NATIVE_STACK_BYTES)
        .spawn(move || run(&source))
        .expect("spawn")
        .join()
        .unwrap_or_else(|_| {
            eprintln!("InternalError: ironhorse panicked");
            1
        });
    std::process::exit(code);
}

fn run(source: &str) -> i32 {
    let outcome = match run_script_source(source) {
        Ok(o) => o,
        Err(e) => {
            // A compile failure is how a negative parse-phase case reports --
            // but ONLY when it is really the grammar's early error. An
            // unported construct or an exhausted allowance reported as
            // `SyntaxError` would pass such a case on our own gap, so
            // `compile_failure_name` decides which name this is.
            eprintln!("{}: {e}", compile_failure_name(&e));
            return 1;
        }
    };
    if outcome.completed {
        return 0;
    }
    match &outcome.halt {
        // Already `Name: message`, which is what eshost parses.
        Halt::Throw { rendered, .. } => eprintln!("{rendered}"),
        other => eprintln!("InternalError: ironhorse halted: {other:?}"),
    }
    1
}
