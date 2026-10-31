//! Audit probe (ontology/vocabulary): how the harness names and classifies
//! the same compile-time condition on the script and module paths.
use std::path::Path;

use ironhorse_262::report::{classify, Verdict as ReportVerdict};
use ironhorse_262::xst::{run_case, Config};

#[test]
fn zz_audit_ont_1() {
    for reason in [
        "module:compiler-rejected",
        "module:resolution-linking",
        "module:compiler-byte-divergence",
        "compiler-unimplemented:module",
        "compiler-unimplemented:parse",
        "unsupported-opcode:module:static-linking",
        "ironhorse-aborted-limit",
        "refused:join:oversized-array-like",
    ] {
        println!("classify(RunSkip, {reason:?}) = {:?}", classify(ReportVerdict::RunSkip, reason));
    }
    // The same regexp literal (quantifier bound > 2^31-1, a valid ECMA-262
    // pattern) followed by a genuine early error, in both goals.
    let module_src = "/*---\nflags: [module]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar r = /b{2147483648}/;\nexport default 1;\nexport default 2;\n";
    let script_src = "/*---\nflags: [raw]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar r = /b{2147483648}/;\nlet a; let a;\n";
    println!(
        "module compile kind: {:?}",
        ironhorse_compile::compile_module_atoms(module_src).err().map(|e| e.kind)
    );
    println!(
        "script compile kind: {:?}",
        ironhorse_compile::compile_atoms(script_src).err().map(|e| e.kind)
    );
    let cfg = Config::default();
    println!("module negative verdict: {:?}", run_case(&cfg, Path::new("."), module_src).verdict);
    println!("script negative verdict: {:?}", run_case(&cfg, Path::new("."), script_src).verdict);
    // Control: the same genuine early errors without the regexp.
    let module_ctl = "/*---\nflags: [module]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nexport default 1;\nexport default 2;\n";
    let script_ctl = "/*---\nflags: [raw]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nlet a; let a;\n";
    println!("module control verdict: {:?}", run_case(&cfg, Path::new("."), module_ctl).verdict);
    println!("script control verdict: {:?}", run_case(&cfg, Path::new("."), script_ctl).verdict);
}
