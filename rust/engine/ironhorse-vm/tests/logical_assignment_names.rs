//! F153: logical assignment's NamedEvaluation applies only to identifiers.
use ironhorse_vm::{parse_symbols_checked, Interp};

fn run(source: &str) -> String {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let out = vm.run(&code);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

#[test]
fn anonymous_values_receive_the_identifier_name() {
    for (operator, initial) in [("||=", "false"), ("&&=", "true"), ("??=", "null")] {
        for value in [
            "function(){}",
            "() => 1",
            "class {}",
            "function*(){}",
            "async function(){}",
            "async function*(){}",
            "async () => 1",
            "(function(){})",
            "((function(){}))",
        ] {
            assert_eq!(
                run(&format!(
                    "var cache = {initial}; cache {operator} {value}; cache.name"
                )),
                "cache"
            );
        }
    }
}

#[test]
fn named_values_and_property_targets_are_not_renamed() {
    for value in [
        "function original(){}",
        "class original {}",
        "class { static name = 'original'; }",
    ] {
        assert_eq!(
            run(&format!("var cache; cache ||= {value}; cache.name")),
            "original"
        );
    }
    for target in ["o.cache", "o['cache']"] {
        assert_eq!(
            run(&format!(
                "var o = {{}}; {target} ||= function(){{}}; {target}.name"
            )),
            ""
        );
    }
    assert_eq!(
        run("var cache; cache ||= (0, function(){}); cache.name"),
        ""
    );
}

#[test]
fn short_circuit_does_not_rename_the_existing_value() {
    assert_eq!(
        run("var cache = function original(){}; cache ||= function(){}; cache.name"),
        "original"
    );
    assert_eq!(
        run("var cache = false; cache &&= function(){}; String(cache)"),
        "false"
    );
    assert_eq!(
        run("var cache = function original(){}; cache ??= class {}; cache.name"),
        "original"
    );
}
