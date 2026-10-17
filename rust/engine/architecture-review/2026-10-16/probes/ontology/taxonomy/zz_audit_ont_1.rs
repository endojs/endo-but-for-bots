// Temporary audit probe (ontology/taxonomy lens). Deleted after the run.
use ironhorse_262::report::{classify, Category, Verdict};

fn oracle(label: &str, source: &str) {
    let o = xs_oracle::run(source).expect("oracle machine");
    println!(
        "ORACLE {label}: completed={} result={:?} error={:?} exit_status={} resource_abort={}",
        o.completed,
        o.result.chars().take(80).collect::<String>(),
        o.error.chars().take(120).collect::<String>(),
        o.exit_status,
        xs_oracle::is_resource_abort(o.exit_status)
    );
}

fn ironhorse(label: &str, source: &str) {
    let out = ironhorse_262::run_script_source(source).expect("compiles");
    println!(
        "IRONHORSE {label}: completed={} result={:?} halt={:?}",
        out.completed,
        out.result.chars().take(80).collect::<String>(),
        out.halt
    );
}

#[test]
fn zz_audit_ont_1() {
    let cases: &[(&str, &str)] = &[
        (
            "regexp-greedy-70000",
            "String(/^a+$/.test('a'.repeat(70000)))",
        ),
        (
            "padEnd-2^24+1",
            "String('x'.padEnd(16777217, 'x').length)",
        ),
        (
            "repeat-2^24+1",
            "String('x'.repeat(16777217).length)",
        ),
        (
            "fill-70000-then-fresh-name",
            "var a = new Array(70000).fill(0); var o = {}; o['fresh' + a.length] = 1; String(a[69999])",
        ),
        (
            "weakmap-ctor-symbol",
            "String(new WeakMap([[Symbol('k'), 1]]) instanceof WeakMap)",
        ),
        (
            "weakmap-set-symbol",
            "String(new WeakMap().set(Symbol('k'), 1) instanceof WeakMap)",
        ),
    ];
    for (label, source) in cases {
        oracle(label, source);
        ironhorse(label, source);
    }
    let m = xs_oracle::compile_module("var x = 1;\nexport { x as \"\u{263F}\" };").unwrap();
    println!("ORACLE module string-export-name: compiled={} error={:?}", m.compiled, m.error);
    let ih = ironhorse_compile::compile_module_atoms("var x = 1;\nexport { x as \"\u{263F}\" };");
    println!("IRONHORSE module string-export-name: {:?}", ih.map(|_| "accepted"));

    for (outcome, reason) in [
        (Verdict::RunSkip, "unsupported-opcode:module:static-linking"),
        (Verdict::RunSkip, "module:resolution-linking"),
        (Verdict::RunSkip, "module:compiler-rejected"),
        (Verdict::RunSkip, "module:compiler-byte-divergence"),
        (Verdict::RunSkip, "module:harness-compiler-rejected"),
        (Verdict::RunSkip, "compiler-unimplemented:module"),
        (Verdict::RunSkip, "parse-or-decode"),
        (Verdict::RunSkip, "ironhorse-aborted-limit"),
        (Verdict::RunSkip, "refused:String.prototype.pad:result-too-large"),
        (Verdict::RunSkip, "shared-positive-test-failure"),
        (Verdict::Fail, "compiler-panicked:parse"),
    ] {
        let c: Category = classify(outcome, reason);
        println!("CLASSIFY {:?} {reason:?} => {}", outcome, c.as_str());
    }
}
