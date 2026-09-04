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
use ironhorse_vm::Halt;

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
fn descriptor_bigint_zero_writable_is_falsy() {
    // The actual delta between `to_boolean` and `Interp::truthy` is the
    // `String` and `BigInt` arms; `descriptor_zero_writable_is_falsy`
    // (`writable:0`) already passed on the pre-fix engine (`to_boolean` reads
    // `Integer(0)` as falsy), so it is not evidence for the fix. `0n` is the
    // uncovered arm the fix's own comment names ("would read `0n`"): a truthy
    // read would leave the property writable and let `o.p=2` take.
    assert_result_agrees(
        "var o={}; Object.defineProperty(o,'p',{value:1,writable:0n}); o.p=2; o.p;",
    );
}

#[test]
fn sparse_get_only_walk_does_not_exhaust_ids() {
    // `array_generic_has`'s non-interning probe is only half the pair: the
    // spec reaches `array_generic_get` with NO preceding `has` on
    // `find`/`findIndex`/`findLast`/`includes`/`at`, so a `get`-only walk over
    // a 1e6-length sparse receiver must not intern every absent index and trip
    // `id_space_exhausted`. These lock the shared non-interning probe on the
    // `get` edge, beside the `every`/`forEach`/`some` (`has`-edge) lock above.
    assert_result_agrees(
        "var a=[0,1]; a[999999]=7; var r=a.find(function(v){return v===7;}); r;",
    );
    assert_result_agrees(
        "var a=[0,1]; a[999999]=7; a.findIndex(function(v){return v===7;});",
    );
    assert_result_agrees("var a=[0,1]; a[999999]=7; a.includes(7);");
    assert_result_agrees("var a=[0,1]; a[999999]=7; a.at(999999);");
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

#[test]
fn typed_array_from_array_with_overridden_iterator_is_an_honest_skip() {
    // The front-loaded snapshot models the spec's `IteratorToList`, which is
    // selected ONLY for the intact default array iterator. When the source's
    // @@iterator is overridden (here set to `undefined`), the spec instead
    // takes `InitializeTypedArrayFromArrayLike`, whose step 5 INTERLEAVES
    // `Get(k)` with `Set` — so a mutating `valueOf` changes later reads
    // (`new Uint8Array(a)[1]` is `99` on XS/V8/SM/JSC, `2` under a front-loaded
    // snapshot). Ironhorse does not model the array-like interleaving path, so
    // it must SKIP honestly (`Halt::Unsupported`) rather than snapshot the
    // wrong semantics and silently over-accept `2`.
    let source = "var a=[{valueOf:function(){a[1]=99;return 1;}},2]; \
                  a[Symbol.iterator]=undefined; new Uint8Array(a)[1];";
    let dr = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        dr.agreement,
        Agreement::OracleOnlyComplete,
        "override case must be an ironhorse skip, not a shared completion \
         (ironhorse halt: {:?}; oracle={:?} ironhorse={:?})",
        dr.ironhorse_halt,
        dr.oracle_result,
        dr.ironhorse_result,
    );
    assert!(
        matches!(&dr.ironhorse_halt, Halt::Unsupported(op) if op.contains("from-array-like")),
        "expected the from-array-like honest skip, got {:?}",
        dr.ironhorse_halt,
    );
}
