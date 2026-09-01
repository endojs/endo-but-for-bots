//! Stage-7 child 2/7 behavioral gate: typed-array-from-source construction
//! (design [`designs/ironhorse-engine.md`] § the engine boot-surface
//! residuals — the ses-boot bundles build byte views with `new Uint8Array([…])`).
//!
//! `new <TypedArray>(source)` from a **dense Array** (`new Uint8Array([1,2,3])`)
//! or a **source TypedArray** allocates a fresh backing store and copies each
//! element, coercing per the destination element type. Each snippet is dual-run
//! against the XS oracle; the gate is **result agreement where the oracle
//! accepts the program** (`BothComplete` + `result_agrees`), per the
//! accuracy-over-parity doctrine — computron agreement (the iterator-protocol
//! vs. array-like metering difference) is advisory, not asserted here.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str) {
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        dr.result_agrees,
        "`{source}` result divergence: oracle={:?} ironhorse={:?}",
        dr.oracle_result, dr.ironhorse_result,
    );
}

// -------------------------------------------------------------------------
// §1  From a dense Array literal — the boot-bundle byte-view form.
// -------------------------------------------------------------------------

#[test]
fn uint8_from_array_literal() {
    assert_result_agrees("new Uint8Array([1, 2, 3]).length");
    assert_result_agrees("new Uint8Array([1, 2, 3])[0]");
    assert_result_agrees("new Uint8Array([1, 2, 3])[1]");
    assert_result_agrees("new Uint8Array([1, 2, 3])[2]");
    assert_result_agrees("new Uint8Array([10, 20, 30, 40])[3]");
    assert_result_agrees("new Uint8Array([]).length");
}

#[test]
fn uint8_from_array_coerces_and_wraps() {
    // Out-of-range values wrap to the byte type (ToUint8 truncation).
    assert_result_agrees("new Uint8Array([256])[0]");
    assert_result_agrees("new Uint8Array([257])[0]");
    assert_result_agrees("new Uint8Array([-1])[0]");
    // A fractional value truncates toward zero.
    assert_result_agrees("new Uint8Array([3.9])[0]");
}

#[test]
fn other_element_types_from_array() {
    assert_result_agrees("new Int32Array([1, -2, 3])[1]");
    assert_result_agrees("new Int32Array([1, -2, 3]).length");
    assert_result_agrees("new Int16Array([40000])[0]");
    assert_result_agrees("new Float64Array([1.5, 2.5])[1]");
    assert_result_agrees("new Float32Array([0.5])[0]");
    assert_result_agrees("new Uint16Array([65536])[0]");
}

// -------------------------------------------------------------------------
// §2  From a source TypedArray — the cross-type element copy.
// -------------------------------------------------------------------------

#[test]
fn from_source_typed_array() {
    assert_result_agrees("var a = new Uint8Array([1, 2, 3]); new Uint8Array(a).length");
    assert_result_agrees("var a = new Uint8Array([1, 2, 3]); new Uint8Array(a)[2]");
    // Cross-type: a Uint8 source read into an Int32 view (value-preserving here).
    assert_result_agrees("var a = new Uint8Array([5, 6, 7]); new Int32Array(a)[1]");
}

// -------------------------------------------------------------------------
// §3  General object sources — array-like and iterator protocol paths.
// -------------------------------------------------------------------------

#[test]
fn from_array_like_object() {
    assert_result_agrees(
        "var o={0:3,2:5,length:3}; var a=new Uint8Array(o); a.length+':'+a[0]+','+a[1]+','+a[2]",
    );
    assert_result_agrees("var o={0:257,length:1}; new Uint8Array(o)[0]");
}

#[test]
fn from_custom_iterable() {
    assert_result_agrees(
        "var o={}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<3?{value:++i,done:false}:{done:true}}}}; var a=new Uint8Array(o); a.length+':'+a[0]+','+a[1]+','+a[2]",
    );
}

#[test]
fn iterable_precedes_array_like_length() {
    assert_result_agrees(
        "var reads=0,o={length:{valueOf:function(){reads++;return 99}}}; o[Symbol.iterator]=function(){var i=0;return {next:function(){return i<2?{value:7+i++,done:false}:{done:true}}}}; var a=new Uint8Array(o); a[0]+','+a[1]+':'+reads",
    );
}
