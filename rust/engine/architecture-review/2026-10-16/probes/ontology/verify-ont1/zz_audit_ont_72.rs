// Temporary adversarial-verifier probe for ONT-1 (test262 cases under the XS oracle). Deleted after the run.
#[test]
fn zz_audit_ont_72() {
    for i in [1, 4, 5, 9, 18] {
        let path = format!("../../../probes/ontology/verify-ont1/cases/c{i}.js");
        let source = std::fs::read_to_string(&path).unwrap();
        let o = xs_oracle::run(&source).expect("oracle machine");
        let out = ironhorse_262::run_script_source(&source).expect("compiles");
        println!(
            "c{i}: XS completed={} error={:?} | IRONHORSE completed={} halt={:?}",
            o.completed,
            o.error.chars().take(80).collect::<String>(),
            out.completed,
            match &out.halt { ironhorse_vm::Halt::Throw { rendered, .. } => format!("Throw({rendered})"), h => format!("{h:?}") }
        );
    }
}
