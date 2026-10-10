//! End-to-end Unicode property escape coverage through the JavaScript RegExp
//! constructor/literal surface. Lower-level endpoint and meter parity lives in
//! `ironhorse-regexp/tests/parity.rs`.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

fn assert_ironhorse_result(source: &str, expected: &str) {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    let run = ironhorse_vm::run_program_with_symbols(&bytecode, &symbols);
    assert!(
        run.completed,
        "IronHorse completes {source:?}: {:?}",
        run.halt
    );
    assert_eq!(run.result, expected, "standards-derived case {source:?}");
}

#[test]
fn unicode_property_families_and_aliases_execute() {
    for source in [
        "/\\p{ASCII}/u.test('A') && !/\\p{ASCII}/u.test('é')",
        "/\\p{Alphabetic}+/u.test('Aα') && /\\p{L}+/u.test('Aα')",
        "/\\p{General_Category=Uppercase_Letter}/u.test('A') && /\\p{gc=Lu}/u.test('A')",
        "/\\p{Script=Greek}/u.test('α') && /\\p{sc=Grek}/u.test('α')",
        "/\\p{Script_Extensions=Hira}/u.test('ー') && /\\p{scx=Kana}/u.test('ー')",
    ] {
        agrees(source);
    }
}

#[test]
fn negation_classes_astral_and_ignore_case_execute_in_u_and_v() {
    for source in [
        "/\\P{ASCII}/u.test('é') && /[^\\p{ASCII}]/u.test('😀')",
        "/^[\\p{Letter}\\p{Number}]+$/u.test('abc123') && /\\p{Emoji}/u.test('😀')",
        "/^\\p{Lowercase_Letter}$/iu.test('A')",
        "/\\p{Script=Greek}/v.test('α') && /\\P{ASCII}/v.test('é')",
        "/^\\p{Lowercase_Letter}$/iv.test('A') && !/^\\P{Lowercase_Letter}$/iv.test('A')",
    ] {
        agrees(source);
    }
}

#[test]
fn standards_lane_records_the_intended_xs_regexp_divergences() {
    for (source, expected) in [
        ("new RegExp('[]', 'v').test('A')", "false"),
        ("new RegExp('[^]', 'v').test('A')", "true"),
        ("/^[A]$/iv.test('a')", "true"),
        ("/^[\\p{Uppercase_Letter}]$/iv.test('a')", "true"),
        (
            "/^[\\p{Uppercase_Letter}--A]$/iv.test('A') || !/^[\\p{Uppercase_Letter}--A]$/iv.test('B')",
            "false",
        ),
        ("/^\\P{Lowercase_Letter}$/iu.test('A')", "true"),
        ("/^\\P{Lowercase_Letter}$/iu.test('a')", "true"),
        ("/^\\P{Lowercase_Letter}$/iv.test('A')", "false"),
        ("/^\\P{Uppercase_Letter}$/iu.test('A')", "true"),
        ("/^\\P{Uppercase_Letter}$/iv.test('A')", "false"),
        ("/^\\P{ASCII}$/iu.test('A')", "false"),
        ("/^\\P{ASCII}$/iu.test('k')", "true"),
        ("/^\\P{ASCII}$/iu.test('K')", "true"),
        ("/^\\P{ASCII}$/iv.test('k')", "false"),
        ("/^\\P{ASCII}$/iv.test('K')", "false"),
    ] {
        assert_ironhorse_result(source, expected);
    }
}

#[test]
fn invalid_aliases_are_parse_time_syntax_errors() {
    for source in [
        "try { RegExp('\\\\p{letter}', 'u'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\p{ASCII=Yes}', 'u'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\p{Block=Basic_Latin}', 'u'); false } catch (e) { e instanceof SyntaxError }",
    ] {
        agrees(source);
    }
}

// A `\p{…}` escape is a property escape in NON-Unicode mode as well: XS's
// `fxCharSetParseEscape` dispatches `p`/`P` unconditionally, so a legacy
// pattern never treats `\p` as an identity escape of `p`. These lock that
// behavior — accept, reject, and match — through the JS RegExp surface.
#[test]
fn non_unicode_property_escapes_execute() {
    for source in [
        "/\\p{L}/.test('A') && !/\\p{L}/.test('5')",
        "!/\\p{L}/.test('p{L}')",
        "/\\p{Nd}+/.test('42') && !/\\p{Nd}+/.test('ab')",
        "/^[\\p{L}\\p{Nd}]+$/.test('abc123')",
        "/\\P{L}/.test('5') && !/\\P{L}/.test('a')",
        "/\\p{Nd}/.exec('a1b2')[0] === '1'",
    ] {
        agrees(source);
    }
}

#[test]
fn non_unicode_property_and_annexb_early_errors_agree() {
    // XS rejects these at parse time in non-Unicode mode; the JS surface must
    // throw a catchable SyntaxError, exactly as the oracle does.
    for source in [
        "try { RegExp('\\\\p{Foo}'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\pL'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\p'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\1'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\c5'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('[\\\\d-a]'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('(?=x)*'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('a{2,1}'); false } catch (e) { e instanceof SyntaxError }",
    ] {
        agrees(source);
    }
}
