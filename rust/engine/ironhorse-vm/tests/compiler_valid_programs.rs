//! F067: oracle-free acceptance and execution, with neighboring early errors.
use ironhorse_compile::{compile_atoms, ParseErrorKind};
use ironhorse_vm::{parse_symbols_checked, Interp};

fn run(source: &str) -> String {
    let (bytecode, symbols) = compile_atoms(source).unwrap();
    let mut vm = Interp::new();
    vm.link_intrinsics(&parse_symbols_checked(&symbols).unwrap());
    let out = vm.run(&bytecode);
    assert!(out.completed, "{source}: {:?}", out.halt);
    out.result
}

#[test]
fn regexp_first_for_headers_compile_and_execute() {
    assert!(compile_atoms("for (/a/;;) {}").is_ok());
    assert!(compile_atoms("async function f() { for (await /a/; false;) {} }").is_ok());
    for pattern in ["/a/", "/=/", "/[;)]/", "/a/i"] {
        let source = format!("var n = 0; for ({pattern}; n < 2; n++) {{}} n");
        assert_eq!(run(&source), "2");
    }
    assert_eq!(run("var n = 0; for (let x of [1,2]) n += x; n"), "3");
    assert_eq!(run("var let = 2; for (let / 2; false;) {} let"), "2");
    assert_eq!(run("var using = 2; for (using / 2; false;) {} using"), "2");
}

#[test]
fn catch_var_is_hoisted_but_initializer_assigns_the_catch_binding() {
    assert!(compile_atoms("try {} catch (e) { var e; }").is_ok());
    for strict in ["", "'use strict';"] {
        assert_eq!(run(&format!("{strict} (function() {{ var e = 1; var inside; try {{ throw 2; }} catch (e) {{ var e = 3; inside = e; }} return inside + ':' + e; }})()")), "3:1");
        assert_eq!(run(&format!("{strict} (function() {{ try {{ throw 2; }} catch (e) {{ {{ var e = 3; }} }} return typeof e; }})()")), "undefined");
        assert_eq!(run(&format!("{strict} (function() {{ var f; try {{ throw 2; }} catch (e) {{ var e = 3; f = () => e; }} return f(); }})()")), "3");
    }
}

#[test]
fn catch_patterns_and_lexical_conflicts_are_still_rejected() {
    for source in [
        "try {} catch ({e}) { var e; }",
        "try {} catch ([e]) { var e; }",
        "let e; try {} catch (e) { var e; }",
        "try {} catch ({e}) { try {} catch (e) { var e; } }",
        "try {} catch (e) { let e; }",
        "try {} catch (e) { const e = 1; }",
        "try {} catch (e) { { let e; var e; } }",
        "try {} catch (e) { { var e; let e; } }",
        "for (/a/ in {}) {}",
        "for (/a/ of []) {}",
    ] {
        assert_eq!(
            compile_atoms(source).unwrap_err().kind,
            ParseErrorKind::Syntax,
            "{source}"
        );
    }
}
