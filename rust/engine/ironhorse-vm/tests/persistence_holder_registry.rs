//! Independent obligations for the roster-generated native-reference walk.
use ironhorse_vm::interp::persistence::PERSIST_HOLDER_SOURCE;

fn compact(source: &str) -> String {
    source
        .lines()
        .map(|line| line.split("//").next().unwrap())
        .collect::<String>()
        .split_whitespace()
        .collect()
}

fn check_wiring(interp: &str, persistence: &str) {
    let interp = compact(interp);
    let persistence = compact(persistence);
    assert!(interp.contains("ifself.persisted_holders_contain(&names,&|i|doomed.contains(&i)){returnSome(\"astoredreferencetoanon-persistednativefunction\");}"));
    for required in [
        "false$(||persist_holder!(persist_run,self,$field,names,index,$persist))*",
        "macro_rules!persist_run{($($code:tt)*)=>{$($code)*};}",
        "macro_rules!persist_text{($($code:tt)*)=>{stringify!($($code)*)};}",
        "pubconstPERSIST_HOLDER_SOURCE:&[(&str,&str)]=&[$((stringify!($field),persist_holder!(persist_text,self,$field,names,index,$persist)),)*];",
        "interp_state!(define_persist_holders);",
        "fnsaved_frame_contains(f:&SavedFrame,names:&implFn(&Slot)->bool)->bool{f.locals.iter().any(names)||f.args.iter().any(names)||f.stack_slice.iter().any(names)||names(&f.this_val)||names(&f.env)||names(&f.result)||f.jumps.iter().any(|j|names(&j.env))}",
    ] {
        assert!(persistence.contains(required), "missing executable wiring: {required}");
    }
}

#[test]
fn every_persisted_holder_keeps_its_native_reference_checks() {
    check_wiring(
        include_str!("../src/interp/persist.rs"),
        include_str!("../src/interp/persistence.rs"),
    );
    // Kept independent of field annotations. This is the historical holder
    // inventory plus the indexed-property omission's regression obligation.
    let expected: &[(&str, &[&str])] = &[
        ("stack", &[".iter().any(names)"]),
        ("arrays", &[".items().iter().map(|(_,v)|v)", ".any(names)"]),
        ("index_props", &[".items().iter().map(|(_,v)|v)", ".any(names)"]),
        ("collections", &[".entries().iter().flatten().flat_map(|e|[&e.0,&e.1])", ".any(names)"]),
        ("accessors", &["d.get.as_ref().is_some_and(names)||d.set.as_ref().is_some_and(names)"]),
        ("private_accessors", &["d.get.as_ref().is_some_and(names)||d.set.as_ref().is_some_and(names)"]),
        ("private_values", &[".values().any(names)"]),
        ("wrapper_data", &[".values().any(names)"]),
        ("bound_functions", &["index(d.target.0)||names(&d.this_arg)||d.args.iter().any(names)"]),
        ("proxies", &["index(p.target.0)||index(p.handler.0)"]),
        ("disposable_stacks", &[".records.iter()", "names(&r.resource)||names(&r.method)"]),
        ("promises", &["names(&p.result)||p.reactions.iter().any", "names(&r.on_fulfilled)||names(&r.on_rejected)||names(&r.resolve)||names(&r.reject)"]),
        ("combinators", &["names(&c.resolve)||names(&c.reject)"]),
        ("generators", &[".frame.as_ref()", "saved_frame_contains(f,names)"]),
        ("async_instances", &[".frame.as_ref().is_some_and(|f|saved_frame_contains(f,names))||names(&a.resolve_fn)||names(&a.reject_fn)"]),
    ];
    let active: Vec<_> = PERSIST_HOLDER_SOURCE
        .iter()
        .filter(|(_, source)| compact(source) != "false")
        .collect();
    assert_eq!(active.len(), expected.len());
    for (field, obligations) in expected {
        let (_, source) = active.iter().find(|(name, _)| name == field).expect(field);
        let source = compact(source);
        assert!(
            source.starts_with(&format!("self.{field}.")),
            "{field}: {source}"
        );
        for obligation in *obligations {
            assert!(source.contains(obligation), "{field} lost {obligation}");
        }
    }
}

#[test]
fn disconnected_holder_emitters_are_rejected() {
    let interp = include_str!("../src/interp/persist.rs");
    let persistence = include_str!("../src/interp/persistence.rs");
    check_wiring(interp, persistence);
    for (before, after) in [
        ("false $(|| persist_holder!", "false $(&& persist_holder!"),
        ("=> { $($code)* }", "=> { false }"),
        ("stringify!($($code)*)", "\"false\""),
        ("interp_state!(define_persist_holders);", ""),
        (
            "persist_holder!(persist_text, self, $field, names, index, $persist)",
            "\"false\"",
        ),
        ("|| f.args.iter().any(names)", ""),
    ] {
        let mutated = persistence.replace(before, after);
        assert_ne!(mutated, persistence, "mutation must match: {before}");
        assert!(std::panic::catch_unwind(|| check_wiring(interp, &mutated)).is_err());
    }
    let mutated = interp.replace(
        "self.persisted_holders_contain(&names, &|i| doomed.contains(&i))",
        "false",
    );
    assert_ne!(mutated, interp);
    assert!(std::panic::catch_unwind(|| check_wiring(&mutated, persistence)).is_err());
}
