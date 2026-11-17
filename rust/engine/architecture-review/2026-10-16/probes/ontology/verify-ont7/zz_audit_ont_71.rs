// Temporary audit probe (ontology verify ONT-7). Deleted after the run.
use ironhorse_262::report::{classify, Category, Verdict};

fn oracle(label: &str, source: &str) {
    let o = xs_oracle::run(source).expect("oracle machine");
    println!(
        "ORACLE {label}: completed={} result={:?} error={:?} resource_abort={}",
        o.completed,
        o.result.chars().take(80).collect::<String>(),
        o.error.chars().take(120).collect::<String>(),
        xs_oracle::is_resource_abort(o.exit_status)
    );
}

fn ironhorse(label: &str, source: &str) {
    let out = ironhorse_262::run_script_source(source).expect("compiles");
    println!(
        "IRONHORSE {label}: completed={} result={:?} halt={:?} is_panic={}",
        out.completed,
        out.result.chars().take(80).collect::<String>(),
        out.halt,
        out.halt.is_panic()
    );
}

#[test]
fn zz_audit_ont_71() {
    let cases: &[(&str, &str)] = &[
        ("padEnd-2^24+1", "String('x'.padEnd(16777217, 'x').length)"),
        ("repeat-2^24+1", "String('x'.repeat(16777217).length)"),
        ("holey-join-2^24+2", "String(Array(16777218).join('x').length)"),
        ("bigint-shl-120000", "String((1n << 120000n).toString(2).length)"),
        ("bigint-mul-120001", "var x = 1n << 60000n; String((x * x).toString(2).length)"),
        ("padEnd-2^31", "try { 'x'.padEnd(2 ** 31, 'x'); 'completed' } catch (e) { 'caught ' + e }"),
        ("repeat-200MiB", "try { String('a'.repeat(200 * 1024 * 1024).length) } catch (e) { 'caught ' + e }"),
    ];
    for (label, source) in cases {
        oracle(label, source);
        ironhorse(label, source);
    }
    for (outcome, reason) in [
        (Verdict::RunSkip, "ironhorse-aborted-limit"),
        (Verdict::RunSkip, "refused:String.prototype.pad:result-too-large"),
        (Verdict::RunSkip, "refused:join:oversized-array-like"),
    ] {
        let c: Category = classify(outcome, reason);
        println!("CLASSIFY {:?} {reason:?} => {}", outcome, c.as_str());
    }
}
