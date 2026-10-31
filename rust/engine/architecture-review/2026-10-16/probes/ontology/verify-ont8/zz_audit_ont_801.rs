//! Temporary audit probe (ontology verify ONT-8). Deleted after the run.
use std::path::Path;

use ironhorse_262::report::{classify, Verdict as ReportVerdict};
use ironhorse_262::xst::{run_case, Config};

const ROOT: &str = "/home/user/endo-but-for-bots/rust/engine/target/test262-report/test262-src/test/";
const PATHS: &str = "../../../probes/ontology/verify-ont8/paths.txt";

#[test]
fn zz_audit_ont_801() {
    // 1. Classification of the module reason families.
    for reason in [
        "module:compiler-rejected",
        "module:resolution-linking",
        "module:compiler-byte-divergence",
        "module:harness-compiler-rejected",
        "module:harness-oracle-rejected",
        "module:harness-byte-divergence",
        "compiler-unimplemented:module",
        "compiler-unimplemented:module-harness",
        "unsupported-opcode:module:static-linking",
        "shared-positive-test-failure",
    ] {
        println!(
            "classify(RunSkip, {reason:?}) = {}",
            classify(ReportVerdict::RunSkip, reason).as_str()
        );
    }

    // 2. Regexp resource stop ahead of a genuine early error, both goals.
    let module_src = "/*---\nflags: [module]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar r = /b{2147483648}/;\nexport default 1;\nexport default 2;\n";
    let script_src = "/*---\nflags: [raw]\nnegative:\n  phase: parse\n  type: SyntaxError\n---*/\nvar r = /b{2147483648}/;\nlet a; let a;\n";
    // Positive control: only the regexp, as a valid module.
    let module_pos = "/*---\nflags: [module]\n---*/\nvar r = /b{2147483648}/;\nexport default 1;\n";
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
    println!("module positive (regexp only) verdict: {:?}", run_case(&cfg, Path::new("."), module_pos).verdict);
    let o = xs_oracle::compile_module("var r = /b{2147483648}/;\nexport default 1;\n").unwrap();
    println!("oracle compiles regexp-only module: {}", o.compiled);

    // 3. For each sweep case under the three families: oracle.compiled and
    //    the IronHorse compile error kind.
    let list = std::fs::read_to_string(PATHS).unwrap();
    let mut tally = std::collections::BTreeMap::<String, usize>::new();
    for line in list.lines() {
        let (reason, path) = line.split_once('\t').unwrap();
        let src = std::fs::read_to_string(format!("{ROOT}{path}")).unwrap();
        let oracle = xs_oracle::compile_module(&src).map(|o| o.compiled);
        let ih = std::panic::catch_unwind(|| ironhorse_compile::compile_module_atoms(&src));
        let ih_kind = match &ih {
            Ok(Ok(_)) => "accepted".to_string(),
            Ok(Err(e)) => format!("{:?}", e.kind),
            Err(_) => "PANIC".to_string(),
        };
        let key = format!("{reason} | oracle.compiled={oracle:?} | ironhorse={ih_kind}");
        *tally.entry(key).or_default() += 1;
        if reason != "module:resolution-linking" {
            let v = run_case(&cfg, Path::new(&format!("{ROOT}../harness")), &src).verdict;
            let vk = format!("{reason} | rerun verdict={v:?}");
            *tally.entry(vk).or_default() += 1;
        }
    }
    for (k, v) in tally {
        println!("{v:4} {k}");
    }
}
