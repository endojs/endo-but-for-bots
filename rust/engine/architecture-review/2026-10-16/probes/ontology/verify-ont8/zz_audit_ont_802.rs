//! Temporary audit probe (ontology verify ONT-8, part 2). Deleted after the run.
//! Tally the IronHorse module-compiler error kind on every test262 module
//! parse-negative case: does any real case reach a non-grammar kind?
const ROOT: &str = "/home/user/endo-but-for-bots/rust/engine/target/test262-report/test262-src/test/";
const PATHS: &str = "../../../probes/ontology/verify-ont8/module_neg_parse.txt";

#[test]
fn zz_audit_ont_802() {
    let list = std::fs::read_to_string(PATHS).unwrap();
    let mut tally = std::collections::BTreeMap::<String, usize>::new();
    for path in list.lines() {
        let src = std::fs::read_to_string(format!("{ROOT}{path}")).unwrap();
        let ih = std::panic::catch_unwind(|| ironhorse_compile::compile_module_atoms(&src));
        let kind = match &ih {
            Ok(Ok(_)) => "accepted".to_string(),
            Ok(Err(e)) => match &e.kind {
                ironhorse_compile::ParseErrorKind::Lex(l) => format!("Lex({:?})", l.kind),
                k => format!("{k:?}"),
            },
            Err(_) => "PANIC".to_string(),
        };
        if !kind.starts_with("Syntax") && !kind.starts_with("accepted") {
            println!("  {path}: {kind}");
        }
        *tally.entry(kind).or_default() += 1;
    }
    for (k, v) in tally {
        println!("{v:4} {k}");
    }
}
