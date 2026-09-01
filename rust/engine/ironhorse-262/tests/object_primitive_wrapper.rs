//! `Object(value)` and `new Object(value)` perform `ToObject` for primitive
//! values. Both forms must create a fresh wrapper with the corresponding realm
//! prototype and preserve the primitive through ordinary coercion.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn object_call_boxes_boolean_number_and_string() {
    assert_result_agrees(
        "var o = Object(true); '' + (typeof o) + ',' + (o.constructor === Boolean) + ',' + (o == true) + ',' + (o === true)",
        "object,true,true,false",
    );
    assert_result_agrees(
        "var o = Object(1.25); '' + (typeof o) + ',' + (o.constructor === Number) + ',' + (o == 1.25) + ',' + (o === 1.25)",
        "object,true,true,false",
    );
    assert_result_agrees(
        "var o = Object('ab'); '' + (typeof o) + ',' + (o.constructor === String) + ',' + (o == 'ab') + ',' + (o === 'ab')",
        "object,true,true,false",
    );
    assert_result_agrees(
        "var o = Object('ab'); '' + o.length + ',' + o[0] + ',' + o[1] + ',' + o[2]",
        "2,a,b,undefined",
    );
}

#[test]
fn object_construct_boxes_primitive_values() {
    assert_result_agrees(
        "var o = new Object(false); '' + (o instanceof Boolean) + ',' + o.valueOf()",
        "true,false",
    );
    assert_result_agrees(
        "var o = new Object(7); '' + (o instanceof Number) + ',' + o.valueOf()",
        "true,7",
    );
    assert_result_agrees(
        "var o = new Object('x'); '' + (o instanceof String) + ',' + o.valueOf()",
        "true,x",
    );
}

#[test]
fn object_boxes_symbols_to_fresh_objects() {
    assert_result_agrees(
        "var s = Symbol('s'); var a = Object(s); var b = Object(s); '' + (typeof a) + ',' + (a !== s) + ',' + (a !== b)",
        "object,true,true",
    );
}

#[test]
fn object_is_compares_wrappers_by_identity() {
    assert_result_agrees(
        "var a = Object(0); var b = new Object(''); '' + Object.is(a, a) + ',' + Object.is(b, b) + ',' + Object.is(a, Object(0))",
        "true,true,false",
    );
    assert_result_agrees(
        "'' + Object.is(NaN, NaN) + ',' + Object.is(0, -0) + ',' + Object.is('x', 'x')",
        "true,false,true",
    );
}

#[test]
fn object_from_entries_defines_dense_array_entries() {
    assert_result_agrees(
        "var o = Object.fromEntries([['z', 1], ['x', 2], ['z', 3]]); '' + o.z + ',' + o.x + ',' + Object.keys(o).join('|')",
        "3,2,z|x",
    );
    assert_result_agrees("Object.fromEntries([Object('ab')]).a", "b");
    assert_result_agrees("Object.fromEntries([new String('xy')]).x", "y");
}
