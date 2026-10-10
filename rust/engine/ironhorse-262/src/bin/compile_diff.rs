//! Full-corpus **byte-identity differential** runner (stage-5 child 7/7,
//! the STAGE BAR). For every source file in a test262 subtree (or the
//! curated corpora), where the XS oracle compiler accepts the file,
//! asserts `ironhorse_compile::compile_with(src, false)` (the eval-goal
//! entry — the goal the oracle shim compiles; see `compile_diff`'s module
//! doc) == `xs_oracle::run(src).bytecode` byte for byte, and prints the honest
//! `total / identical / divergent / oracle-rejected / ironhorse-rejected`
//! split with NAMED divergence classes and per-file identification.
//!
//! Usage:
//!   cargo run -p ironhorse-262 --bin compile-diff                       # curated corpora (bounded)
//!   cargo run -p ironhorse-262 --bin compile-diff -- language/expressions/addition
//!   cargo run -p ironhorse-262 --bin compile-diff -- --module language/module-code
//!   cargo run -p ironhorse-262 --bin compile-diff -- built-ins/Boolean
//!
//! Memory note (same as `endot-ih`): the XS oracle accumulates
//! process RSS across the machine create/destroy cycles a whole-tree run
//! makes, so walking all of `language/` in one process can exhaust RAM.
//! Run it **per subtree**; each subprocess frees everything on exit.
//!
//! Exit code is nonzero on any bar violation (a byte divergence or an
//! accept/reject disagreement), so CI/nightly can gate on it.

use ironhorse_262::compile_diff::{
    collect_js, compile_diff_files, compile_diff_programs, corpora_programs,
    module_compile_diff_programs, print_report, print_symbols_report, symbols_diff_programs,
};
use ironhorse_262::test262::locate_test262;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();

    // The curated no-arg run also proves the SYMB-atom identity the flipped
    // default relies on (ironhorse emits its own symbols, not the oracle's).
    let mut symbols_report = None;

    let module_mode = args.first().map(String::as_str) == Some("--module");
    let paths = if module_mode { &args[1..] } else { &args[..] };
    if module_mode && paths.is_empty() {
        eprintln!("--module requires a test262 subtree");
        std::process::exit(2);
    }

    let (report, label) = if paths.is_empty() && !module_mode {
        // Default: the bounded curated corpora (no test262 subset needed).
        let programs = corpora_programs();
        symbols_report = Some(symbols_diff_programs(&programs));
        (compile_diff_programs(&programs), "corpora".to_string())
    } else {
        let (root, _harness) = match locate_test262() {
            Some(p) => p,
            None => {
                eprintln!("test262 subset not found under packages/test262-runner/test262");
                std::process::exit(2);
            }
        };
        let sub = &paths[0];
        let base = if sub.starts_with("language") || sub.starts_with("built-ins") {
            root.join(sub)
        } else {
            root.join("language").join(sub)
        };
        let files = collect_js(&base);
        if files.is_empty() {
            eprintln!("no test files under {}", base.display());
            std::process::exit(2);
        }
        eprintln!("compiling {} files under {}", files.len(), base.display());
        if module_mode {
            let programs = files
                .iter()
                .filter_map(|path| {
                    std::fs::read_to_string(path)
                        .ok()
                        .map(|source| (path.display().to_string(), source))
                })
                .collect::<Vec<_>>();
            (
                module_compile_diff_programs(&programs),
                format!("{} (Module goal)", base.display()),
            )
        } else {
            (compile_diff_files(&files), base.display().to_string())
        }
    };

    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    print_report(&mut lock, &report, &label).unwrap();

    let symbols_ok = match &symbols_report {
        Some(sr) => {
            print_symbols_report(&mut lock, sr, &label).unwrap();
            sr.met_bar()
        }
        None => true,
    };

    if !report.met_bar() || !symbols_ok {
        std::process::exit(1);
    }
}
