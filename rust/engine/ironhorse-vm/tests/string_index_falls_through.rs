//! A string index past the end inherits; it is not `undefined`.
//!
//! `fxStringGetProperty` (`xsString.c:506`) answers with the string accessor
//! only for `length` or an index below the string's length, and otherwise
//! falls THROUGH to `fxOrdinaryGetProperty` — the ordinary prototype walk.
//! Both of ironhorse's String arms in `property_at_get`, the primitive
//! receiver and the wrapper instance, short-circuited the whole read to the
//! unit lookup instead, so an out-of-range index never reached the chain.
//!
//! The engine therefore gave two answers for one property: `'ab'[5]` was
//! `undefined` while `Reflect.get(Object('ab'), '5')` — the same read, spelled
//! reflectively, which routes through the MOP rather than the opcode — already
//! answered the inherited value. The differential tests below are the ones
//! that matter: for every receiver and index, the two spellings must agree.

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
fn a_primitive_string_index_past_the_end_inherits() {
    assert_result("String.prototype[5] = 'P'; 'ab'[5]", "P");
}

#[test]
fn a_string_wrapper_index_past_the_end_inherits() {
    assert_result(
        "var s = new String('ab'); String.prototype[5] = 'P'; s[5]",
        "P",
    );
}

#[test]
fn an_index_inherited_from_an_array_prototype_resolves() {
    // The wrapper prototype need not answer by name: after this
    // `setPrototypeOf`, index 2 is an ARRAY ITEM two levels up the chain, so
    // the walk has to reach the exotic that answers without a name.
    assert_result(
        "Object.setPrototypeOf(String.prototype, [1, 2, 3]); 'ab'[2]",
        "3",
    );
}

#[test]
fn an_in_range_index_is_still_the_unit_and_shadows_the_prototype() {
    assert_result("String.prototype[1] = 'P'; 'abc'[1]", "b");
    assert_result("String.prototype[1] = 'P'; new String('abc')[1]", "b");
    assert_result("'abc'[1]", "b");
}

#[test]
fn an_out_of_range_index_with_nothing_inherited_is_still_undefined() {
    assert_result("String(('ab')[9])", "undefined");
    assert_result("String(new String('ab')[9])", "undefined");
}

#[test]
fn deleting_an_absent_own_index_reveals_the_inherited_one() {
    // `delete` reports true (there is no own property to refuse), and the
    // read that follows must then see what the chain holds — it read
    // `undefined` before, contradicting the `delete` it had just answered.
    assert_result(
        "String.prototype[5] = 'P'; var s = Object('ab'); String(delete s[5]) + '|' + s[5]",
        "true|P",
    );
}

/// The whole point: one property, one answer, whichever way it is spelled.
#[test]
fn an_index_read_agrees_with_its_reflective_spelling_on_every_string() {
    let receivers = [
        ("'ab'", "Object('ab')"),
        ("new String('ab')", "new String('ab')"),
        ("Object('')", "Object('')"),
    ];
    for (direct, reflective) in receivers {
        for index in ["0", "1", "2", "5", "4294967294"] {
            assert_result(
                &format!(
                    "String.prototype[{index}] = 'P'; \
                     String(({direct})[{index}]) === String(Reflect.get({reflective}, '{index}'))"
                ),
                "true",
            );
        }
    }
}

/// `has`, `[[GetOwnProperty]]` and `delete` were already consistent with XS
/// for an out-of-range index; pinned here so the `get` fix cannot drift away
/// from them again.
#[test]
fn the_other_index_keyed_operations_agree_with_the_read() {
    assert_result(
        "String.prototype[5] = 'P'; var s = Object('ab'); \
         String(5 in s) + '|' + String(Object.getOwnPropertyDescriptor(s, '5')) \
         + '|' + String(Object.prototype.hasOwnProperty.call(s, '5'))",
        "true|undefined|false",
    );
}

/// 70,000 distinct out-of-range indices: the fall-through must look its name
/// up, not mint one, or it would re-arm the id-space exhaustion that poisons
/// the machine.
#[test]
fn an_out_of_range_index_read_mints_no_key() {
    let n = 70_000;
    assert_result(
        &format!(
            "var s = 'ab'; var n = 0; \
             for (var i = 0; i < {n}; i++) {{ if (s[i] !== undefined) n++; }} n"
        ),
        "2",
    );
    assert_result(
        &format!(
            "var s = new String('ab'); var n = 0; \
             for (var i = 0; i < {n}; i++) {{ if (s[i] !== undefined) n++; }} n"
        ),
        "2",
    );
}
