//! End-to-end RegExp unicodeSets (`v`) regressions through literals,
//! construction, accessors, and execution. Bit-exact emitted-program and
//! matcher-meter coverage lives in `ironhorse-regexp/tests/parity.rs`.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

#[test]
fn nested_intersection_subtraction_and_union_execute() {
    for source in [
        "RegExp('^[[a-z]&&[^aeiou]]+$','v').test('rhythm') && !RegExp('[[a-z]&&[^aeiou]]','v').test('a')",
        "RegExp('^[[a-z]--[aeiou]]+$','v').test('rhythm') && !RegExp('[[a-z]--[aeiou]]','v').test('e')",
        "RegExp('^[[a-c][x-z]]+$','v').test('abcxyz')",
        "/^[\\p{ASCII}&&\\p{Letter}]+$/v.test('abcXYZ') && !/[\\p{ASCII}&&\\p{Letter}]/v.test('1')",
        "/^[\\p{ASCII}--\\p{Letter}]+$/v.test('123!')",
    ] {
        agrees(source);
    }
}

#[test]
fn q_disjunctions_are_longest_first_and_participate_in_set_algebra() {
    for source in [
        "/^[\\q{ab|a|xyz}]+$/v.test('xyzaba')",
        "/^[\\q{ab|cd}--\\q{cd}]$/v.test('ab') && !/[\\q{ab|cd}--\\q{cd}]/v.test('cd')",
        "/^[\\q{ab|cd}&&\\q{cd|ef}]$/v.test('cd') && !/[\\q{ab|cd}&&\\q{cd|ef}]/v.test('ab')",
        "/^[\\q{AB|xy}]$/iv.test('ab') && /^[\\q{AB|xy}]$/iv.test('XY')",
    ] {
        agrees(source);
    }
}

#[test]
fn properties_of_strings_match_multi_code_point_sequences() {
    for source in [
        "/^\\p{Basic_Emoji}$/v.test('☀️') && /^\\p{Basic_Emoji}$/v.test('😀')",
        "/^\\p{Emoji_Keycap_Sequence}$/v.test('1️⃣')",
        "/^\\p{RGI_Emoji_Flag_Sequence}$/v.test('🇺🇸')",
        "/^\\p{RGI_Emoji_Modifier_Sequence}$/v.test('👍🏽')",
        "/^\\p{RGI_Emoji_ZWJ_Sequence}$/v.test('👩‍💻')",
    ] {
        agrees(source);
    }
}

#[test]
fn reserved_punctuators_mixed_operators_and_string_complements_reject() {
    for source in [
        "try { RegExp('[a&b]', 'v'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('[a-b-c]', 'v'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('[a&&b--c]', 'v'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('[^\\\\q{ab}]', 'v'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('\\\\P{RGI_Emoji}', 'v'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('a', 'uv'); false } catch (e) { e instanceof SyntaxError }",
    ] {
        agrees(source);
    }
}

#[test]
fn unicode_sets_and_flags_surface_are_coherent() {
    for source in [
        "var r = /a/dgimsvy; r.flags === 'dgimsvy' && r.unicodeSets && !r.unicode",
        "var r = /a/u; r.unicode && !r.unicodeSets && r.flags === 'u'",
        "RegExp('a', 'v').unicodeSets && RegExp('a', 'v').flags === 'v'",
    ] {
        agrees(source);
    }
}
