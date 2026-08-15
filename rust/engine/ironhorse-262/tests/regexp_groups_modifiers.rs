//! End-to-end RegExp inline-modifier (`(?ims-ims:...)`) and named-capture
//! coverage through the JavaScript surface: scoped flag application, duplicate
//! named groups across disjunction alternatives (ES2025), `\k<name>` and
//! numeric backreferences, the `.groups`/`.indices`/`.indices.groups` result
//! objects, and `$<name>` replacement substitution. Every case is locked
//! bit-for-observable against the pinned XS oracle. Lower-level emitted-program
//! and matcher-meter parity lives in `ironhorse-regexp/tests/parity.rs`.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}: {run:?}");
    assert!(run.result_agrees, "{source}: {run:?}");
}

#[test]
fn inline_modifiers_scope_and_restore_flags() {
    for source in [
        // Added ignoreCase applies only inside the group.
        "/(?i:a)b/.test('Ab') && !/(?i:a)b/.test('AB')",
        "'aXbXc'.replace(/(?i:x)/, '-') === 'a-bXc'",
        // Removed ignoreCase inside an `i` pattern.
        "/a(?-i:b)/i.test('Ab') && !/a(?-i:b)/i.test('AB')",
        // dotAll scoped on and off.
        "/(?s:.)/.test('\\n') && !/./.test('\\n')",
        "!/a(?-s:.)/s.test('a\\n')",
        // Multiline scoped.
        "/(?m:^b)/.test('a\\nb') && !/^b/.test('a\\nb')",
        // Combined add/remove and nesting.
        "/(?im-s:A.B)/.test('a_b') && !/(?im-s:A.B)/.test('a\\nb')",
        "/(?i:a(?-i:b)c)/.test('AbC') && !/(?i:a(?-i:b)c)/.test('ABC')",
        // The modified flag does not leak into the RegExp's own `.ignoreCase`.
        "/(?i:a)/.ignoreCase === false",
    ] {
        agrees(source);
    }
}

#[test]
fn inline_modifier_syntax_errors_match_the_oracle() {
    for source in [
        "try { RegExp('(?-:a)'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('(?ii:a)'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('(?i-i:a)'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('(?g:a)'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('(?i:a)+'); false } catch (e) { e instanceof SyntaxError }",
        // An empty remove after `-` is valid.
        "RegExp('(?i-:a)') instanceof RegExp",
    ] {
        agrees(source);
    }
}

#[test]
fn duplicate_named_groups_resolve_the_matched_alternative() {
    for source in [
        // The `.groups` value is whichever alternative matched.
        "/(?<a>x)|(?<a>y)/.exec('y').groups.a === 'y'",
        "/(?<a>x)|(?<a>y)/.exec('x').groups.a === 'x'",
        // The non-participating duplicate is undefined, and there is one key.
        "Object.keys(/(?<a>x)|(?<a>y)/.exec('x').groups).length === 1",
        "/(?<a>x)|(?<a>y)/.exec('x').groups.a !== undefined && /(?<a>x)|(?<a>y)/.exec('z') === null",
    ] {
        agrees(source);
    }
    // A more realistic either-order date, both branches exercised.
    let re = "/(?<y>[0-9]{4})-(?<m>[0-9]{2})|(?<m>[0-9]{2})\\/(?<y>[0-9]{4})/";
    agrees(&format!("{re}.exec('2026-08').groups.y === '2026'"));
    agrees(&format!("{re}.exec('08/2026').groups.y === '2026'"));
    agrees(&format!("{re}.exec('08/2026').groups.m === '08'"));
}

#[test]
fn duplicate_named_groups_are_syntax_errors_within_one_alternative() {
    for source in [
        "try { RegExp('(?<a>x)(?<a>y)'); false } catch (e) { e instanceof SyntaxError }",
        "try { RegExp('(?<a>x)((?<b>y)|(?<a>z))'); false } catch (e) { e instanceof SyntaxError }",
    ] {
        agrees(source);
    }
}

#[test]
fn named_and_numeric_backreferences_execute() {
    for source in [
        "/(?<c>.)\\k<c>/.test('aa') && !/(?<c>.)\\k<c>/.test('ab')",
        "/(?:(?<t>a)|(?<t>b))\\k<t>/.test('bb')",
        "/(a)\\1/.test('aa') && !/(a)\\1/.test('ab')",
    ] {
        agrees(source);
    }
}

#[test]
fn match_indices_and_indices_groups() {
    for source in [
        // `.indices` element pairs.
        "/b/d.exec('abc').indices[0][0] === 1 && /b/d.exec('abc').indices[0][1] === 2",
        // A named group's indices pair, plus `.indices.groups`.
        "JSON.stringify(/(?<x>b)/d.exec('abc').indices.groups.x) === '[1,2]'",
        // An unmatched optional group is undefined in both the array and groups.
        "/(?<x>b)?c/d.exec('c').indices[1] === undefined",
        "/(?<x>b)?c/d.exec('c').indices.groups.x === undefined",
        // Duplicate names resolve to the matched alternative's indices.
        "JSON.stringify(/(?<a>x)|(?<a>yy)/d.exec('yy').indices.groups.a) === '[0,2]'",
    ] {
        agrees(source);
    }
}

#[test]
fn replacement_named_captures_including_duplicates() {
    for source in [
        "'2026-08'.replace(/(?<y>[0-9]{4})-(?<m>[0-9]{2})/, '$<m>/$<y>') === '08/2026'",
        // A duplicate name in the matched (right) alternative.
        "'08/2026'.replace(/(?<y>[0-9]{4})-(?<m>[0-9]{2})|(?<m>[0-9]{2})\\/(?<y>[0-9]{4})/, '$<y>') === '2026'",
        // An unset named group substitutes empty.
        "'c'.replace(/(?<x>b)?c/, '[$<x>]') === '[]'",
    ] {
        agrees(source);
    }
}
