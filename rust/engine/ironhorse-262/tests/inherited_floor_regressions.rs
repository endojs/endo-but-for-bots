//! Dual-run locks for the three floor regressions the round-2 ratchet's
//! fresh sweep surfaced against the 2026-08-29 refresh floor — behavior
//! regressed on `llm` between that refresh's engine and the round-2 branch
//! point, then repaired on the ratchet branch:
//!
//! - descriptor attribute ToBoolean read `""` (and would read `0n`) as
//!   truthy (`to_boolean` cannot see payloads; use `Interp::truthy`) —
//!   test262 `built-ins/Object/defineProperty/15.2.3.6-3-56.js`;
//! - the generic (sparse-receiver) Array.prototype path permanently
//!   interned every probed absent index, exhausting the 16-bit id space on
//!   a 1e6-length sparse walk — `built-ins/Array/prototype/{every,forEach,
//!   some}/15.4.4.1?-7-c-ii-*.js`;
//! - `new TypedArray(array)` read source elements lazily, interleaved with
//!   element coercion, so a mutating `valueOf` changed later reads where
//!   the spec's IteratorToList snapshot fixes them —
//!   `built-ins/TypedArrayConstructors/ctors/object-arg/
//!   iterated-array-changed-by-tonumber.js`.

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

#[test]
fn descriptor_empty_string_attribute_is_falsy() {
    assert_result_agrees(
        "var o={}; Object.defineProperty(o,'p',{enumerable:''}); \
         var hit=false; for (var k in o){ if(k==='p') hit=true; } hit;",
    );
}

#[test]
fn descriptor_zero_writable_is_falsy() {
    assert_result_agrees(
        "var o={}; Object.defineProperty(o,'p',{value:1,writable:0}); o.p=2; o.p;",
    );
}

#[test]
fn sparse_million_length_walk_does_not_exhaust_ids() {
    assert_result_agrees("var a=[0,1]; a[999999]=-6.6; a.every(function(){return true;});");
    assert_result_agrees(
        "var a=[0,1]; a[999999]=-6.6; var n=0; a.forEach(function(){n++;}); n;",
    );
    assert_result_agrees(
        "var a=[0]; a[999999]=7; var last=-1; a.some(function(v,i){last=i; return v===7;}); last;",
    );
}

#[test]
fn sparse_walk_still_honors_prototype_holes_and_arraylikes() {
    assert_result_agrees(
        "var a=[7]; a.length=3; Array.prototype[1]=8; var s=''; \
         a.forEach(function(v){s+=v;}); delete Array.prototype[1]; s;",
    );
    assert_result_agrees(
        "var o={length:3}; o[1]=5; var s=0; \
         Array.prototype.forEach.call(o,function(v){s+=v;}); s;",
    );
}

#[test]
fn typed_array_from_array_snapshots_before_coercion() {
    assert_result_agrees(
        "var values=[0,{valueOf:function(){ values.length=0; return 100; }},2]; \
         var ta=new Uint8Array(values); '' + ta.length + ',' + ta[0] + ',' + ta[1] + ',' + ta[2];",
    );
}
