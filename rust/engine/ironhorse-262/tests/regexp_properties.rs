//! End-to-end Unicode property escape coverage through the JavaScript RegExp
//! constructor/literal surface. Lower-level endpoint and meter parity lives in
//! `ironhorse-regexp/tests/parity.rs`.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
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
        "/^\\p{Lowercase_Letter}$/iu.test('A') && !/^\\P{Lowercase_Letter}$/iu.test('A')",
        "/\\p{Script=Greek}/v.test('α') && /\\P{ASCII}/v.test('é')",
        "/^\\p{Lowercase_Letter}$/iv.test('A') && !/^\\P{Lowercase_Letter}$/iv.test('A')",
    ] {
        agrees(source);
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
