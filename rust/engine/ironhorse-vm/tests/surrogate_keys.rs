//! F016: the compiler and runtime must share a lossless property key space.
use ironhorse_vm::run_program_with_symbols;

fn check(source: &str, expected: &str) {
    let (code, symbols) = ironhorse_compile::compile_atoms(source).expect("compile");
    let result = run_program_with_symbols(&code, &symbols);
    assert!(result.completed, "{source}: {:?}", result.halt);
    assert_eq!(result.result, expected, "{source}");
}

#[test]
fn evidence_probes() {
    check(r#"Object.keys({"\uD800":1,"\uD801":2}).length"#, "2");
    check(r#"({"\uD800":1})["\uD801"] === undefined"#, "true");
    check(r#"Object.keys({"\uD800":1})[0].charCodeAt(0)"#, "55296");
}

#[test]
fn literal_computed_and_reflective_keys_agree() {
    check(
        r#"var o={"\uD800":1,"\uDC00":2,"\uFFFD":3,"😀":4,"\0":5};
        o["\uD801"]=6; Object.defineProperty(o,"\uDC01",{value:7});
        o["\uD800"]+o["\uDC00"]+o["\uFFFD"]+o["\uD83D\uDE00"]+o["\0"]+o["\uD801"]+o["\uDC01"]"#,
        "28",
    );
    check(
        r#"var o={"\uD800":1,"\uD801":2}; delete o["\uD800"];
        !("\uD800" in o) && ("\uD801" in o)"#,
        "true",
    );
    check(
        r#"var o={get "\uD800"(){return 3},"\uD801"(){return 4}};
        o["\uD800"]+o["\uD801"]()"#,
        "7",
    );
    check(
        r#"var o={*"\uD800"(){}}; o["\uD800"].name.charCodeAt(0)"#,
        "55296",
    );
}

#[test]
fn enumeration_json_and_proxy_traps_preserve_units() {
    check(
        r#"var o={"\uD800":1,"\uD801":2}; var n=0;
        for(var k in o) n+=k.charCodeAt(0); n"#,
        "110593",
    );
    check(
        r#"var o=JSON.parse('{"\\ud800":1,"\\ud801":2}');
        Object.keys(o).length+o["\uD800"]+o["\uD801"]"#,
        "5",
    );
    check(
        r#"JSON.stringify({"\uD800":1}) === '{"\\ud800":1}'"#,
        "true",
    );
    check(
        r#"var p=new Proxy({}, {get(t,k){return k.charCodeAt(0)}}); p["\uD800"]"#,
        "55296",
    );
    check(
        r#"var n=0; var p=new Proxy({}, {defineProperty(t,k,d){n=k.charCodeAt(0);return true}});
        Object.defineProperty(p,"\uD800",{value:1}); n"#,
        "55296",
    );
    check(
        r#"var o={*"\uD800"(){}}; o["\uD800"].bind(null).name.charCodeAt(6)"#,
        "55296",
    );
    check(
        r#"var o={*"\uD800"(){}}; o["\uD800"].toString().charCodeAt(11)"#,
        "55296",
    );
    check(
        r#"var o=Object.groupBy([0,1],x=>String.fromCharCode(55296+x));
        Object.keys(o).length"#,
        "2",
    );
}

#[test]
fn malformed_symbol_atoms_decline_without_panicking() {
    for atom in [
        &[2, 0, 0xff, 0][..],
        &[2, 0, 0xed, 0xa0],
        &[1],
        &[1, 0, b'x', 0],
    ] {
        let result = run_program_with_symbols(&[], atom);
        assert!(!result.completed);
        assert!(matches!(result.halt, ironhorse_vm::Halt::Decode(_)));
    }
}
