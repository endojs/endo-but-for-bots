//! A String wrapper's own keys are its units, then its index expandos, then
//! `length`, then its names — and `for-in` sees the units too.
//!
//! `fxStringOwnKeys` (`xsString.c`) queues the units, then the instance's own
//! index keys via `fxQueueIndexKeys`, then `length`, then the named chain.
//! Ironhorse emitted the units and then dropped EVERY expando whose name parses
//! as a canonical index — including one beyond the string's length, which is a
//! perfectly ordinary own property. So `s[5] = 'x'` on a two-unit wrapper was
//! invisible to every key walk.
//!
//! That is not only a listing bug. `harden` freezes what `[[OwnPropertyKeys]]`
//! reports, so the hidden property was never frozen while `Object.isFrozen`
//! still answered `true` — a hardened object carrying a writable, configurable,
//! deletable property, and an unhardened referent when its value was an object.
//!
//! Separately, `enumerable_keys` (the `for-in` walk) had no String-wrapper or
//! TypedArray arm at all, so `for (k in new String('ab'))` yielded nothing
//! while `Object.keys` on the same receiver answered `0,1`. Every expected
//! value below was measured on the XS oracle.

use ironhorse_vm::{run_program_with_symbols, RunOutcome};

fn run(source: &str) -> RunOutcome {
    let (bytecode, symbols) = ironhorse_compile::compile_atoms(source).expect("source compiles");
    run_program_with_symbols(&bytecode, &symbols)
}

fn assert_result(source: &str, expected: &str) {
    let out = run(source);
    assert!(
        out.completed,
        "must complete; halt: {:?}\n  {source}",
        out.halt
    );
    assert_eq!(out.result, expected, "{source}");
}

#[test]
fn an_index_expando_past_the_end_is_an_own_key() {
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; Object.keys(s).join('|')",
        "0|1|5",
    );
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; Object.getOwnPropertyNames(s).join('|')",
        "0|1|5|length",
    );
    // Ascending by index, not insertion order, and ahead of `length` and names.
    assert_result(
        "var s = Object('ab'); s[7] = 'b'; s[5] = 'a'; Object.keys(s).join('|')",
        "0|1|5|7",
    );
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; s.n = 1; \
         Object.getOwnPropertyNames(s).join('|')",
        "0|1|5|length|n",
    );
    // An IN-RANGE index is the unit, listed once, and cannot be overwritten.
    assert_result(
        "var s = Object('ab'); s[1] = 'Z'; Object.keys(s).join('|') + '|' + s[1]",
        "0|1|b",
    );
    assert_result(
        "var s = Object('abc'); Object.getOwnPropertyNames(s).join('|')",
        "0|1|2|length",
    );
    assert_result(
        "var s = Object('ab'); s.z = 1; Object.getOwnPropertyNames(s).join('|')",
        "0|1|length|z",
    );
}

/// The reason the listing bug mattered: `harden` freezes what the key walk
/// reports, so a hidden property stayed mutable behind a `true` from
/// `Object.isFrozen`.
#[test]
fn hardening_a_wrapper_freezes_its_index_expando() {
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; harden(s); s[5] = 9; String(s[5])",
        "x",
    );
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; harden(s); \
         String(delete s[5]) + '|' + String(5 in s)",
        "false|true",
    );
    // Transitive hardening reaches the referent, which it could not before.
    assert_result(
        "var s = Object('ab'); s[5] = {}; harden(s); String(Object.isFrozen(s[5]))",
        "true",
    );
    assert_result(
        "var s = Object('ab'); s[5] = {}; harden(s); s[5].x = 1; String(s[5].x)",
        "undefined",
    );
}

#[test]
fn the_expando_is_visible_to_every_other_key_walk() {
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; JSON.stringify(Object.entries(s))",
        "[[\"0\",\"a\"],[\"1\",\"b\"],[\"5\",\"x\"]]",
    );
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; var {...rest} = s; JSON.stringify(rest)",
        "{\"0\":\"a\",\"1\":\"b\",\"5\":\"x\"}",
    );
    // `JSON.stringify` of the wrapper itself is still the string, not the keys.
    assert_result(
        "var s = Object('ab'); s[5] = 'x'; JSON.stringify(s)",
        "\"ab\"",
    );
}

#[test]
fn for_in_sees_a_wrappers_units_and_a_typed_arrays_elements() {
    let collect = "var r = []; for (var k in s) r.push(k); r.join('|')";
    assert_result(&format!("var s = Object('ab'); {collect}"), "0|1");
    assert_result(
        &format!("var s = Object('ab'); s[5] = 'x'; {collect}"),
        "0|1|5",
    );
    assert_result(
        &format!("var s = Object('ab'); s.z = 1; {collect}"),
        "0|1|z",
    );
    assert_result(&format!("var s = Object(''); {collect} + '#'"), "#");
    assert_result(&format!("var s = new Uint8Array(3); {collect}"), "0|1|2");
    assert_result(
        &format!("var s = new Uint8Array(2); s.z = 1; {collect}"),
        "0|1|z",
    );
    // The keys are strings, as for-in requires.
    assert_result(
        "var s = Object('ab'); var r = []; for (var k in s) r.push(typeof k); r.join('|')",
        "string|string",
    );
    // Unchanged receivers stay unchanged.
    assert_result(&format!("var s = [1, 2]; s.z = 1; {collect}"), "0|1|z");
    assert_result(&format!("var s = {{a: 1, b: 2}}; {collect}"), "a|b");
    assert_result(
        &format!(
            "var s = [1, 2, 3]; Object.defineProperty(s, '1', {{enumerable: false}}); {collect}"
        ),
        "0|2",
    );
}

/// Reading one unit used to decode and allocate the WHOLE string first, so a
/// walk over a wrapper's units was quadratic: `harden` of a 70,000-unit
/// wrapper ran for over 400 seconds to spend ~18,000 computrons — work the
/// meter cannot see, which is a denial of service in a metered engine whether
/// or not anything is minted. It is linear now, and this completes in under a
/// second.
#[test]
fn walking_a_large_wrappers_units_is_linear() {
    assert_result(
        "var s = new String('x'.repeat(70000)); \
         String(Object.keys(s).length) + '|' + s[69999] + '|' + s[0]",
        "70000|x|x",
    );
}
