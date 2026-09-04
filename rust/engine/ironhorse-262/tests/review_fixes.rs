//! Oracle-backed regression gate for the review findings closed on this branch.
//!
//! Each case reproduced a divergence from the pinned XS oracle at
//! `fa3ecfcfd`; the assertions here pin the fixed behaviour so it cannot
//! silently regress. Result agreement is the gate throughout, plus raw-meter
//! equality on the `JSON.stringify` cases, where the defect was purely a
//! metering over-charge.

use ironhorse_262::{dual_run, Agreement};

/// Both engines complete with the same completion value.
fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (ironhorse halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

/// Both engines complete with the same value *and* the same raw 16.16 meter.
fn agrees_raw_exact(source: &str) {
    agrees(source);
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(
        run.ironhorse_meter_raw,
        run.oracle_meter_raw,
        "`{source}`: oracle={} ({}) ironhorse={} ({})",
        run.oracle_computrons,
        run.oracle_meter_raw,
        run.ironhorse_computrons,
        run.ironhorse_meter_raw,
    );
}

/// `IsLooselyEqual` steps 10-11 only convert an object operand when the other
/// side is a String, Number, BigInt or Symbol. Against `null`/`undefined` the
/// comparison returns `false` at step 12 with no conversion, so a `valueOf`
/// that would record its own invocation must never run.
#[test]
fn loose_equality_does_not_coerce_an_object_against_nullish() {
    agrees(
        "var called=false;var o={valueOf:function(){called=true;return 1}};var r=(o==null);r+':'+called",
    );
    agrees(
        "var called=false;var o={valueOf:function(){called=true;return 1}};var r=(o==undefined);r+':'+called",
    );
    agrees(
        "var called=false;var o={toString:function(){called=true;return '1'}};var r=(null==o);r+':'+called",
    );
    // A throwing conversion must not propagate either: the spec guarantees no
    // conversion happens at all on this path.
    agrees("var o={valueOf:function(){throw new Error('boom')}};(o==null)+''");
    agrees("var o={};({}).hasOwnProperty?(o!=null)+'':''");
}

/// The conversions the spec *does* require are unaffected.
#[test]
fn loose_equality_still_coerces_against_primitives() {
    agrees("var o={valueOf:function(){return 1}};(o==1)+':'+(o==true)+':'+(1==o)");
    agrees("(null==undefined)+':'+(undefined==null)+':'+(null==0)+':'+(undefined==0)");
    agrees("var o={};(o==o)+':'+(o!=null)");
    agrees("var o={valueOf:function(){return 1}};(o=='1')+''");
}

/// `CONST_LOCAL`/`CONST_CLOSURE` stamp the immutable flag on the local slot and
/// the shared closure cell. A by-name write reaching `resolve_set` through a
/// `with` scope or a direct `eval` has to observe the same guard that
/// `SET_LOCAL`/`SET_CLOSURE` enforce by index.
#[test]
fn const_bindings_reject_by_name_writes() {
    agrees("const c=1;var t;try{with({}){c=2}t='no throw'}catch(e){t=e.constructor.name}t+':'+c");
    agrees("const d=1;var u;try{eval('d=2');u='no throw'}catch(e){u=e.constructor.name}u+':'+d");
    agrees(
        "const e1=1;function f(){try{with({}){e1=2}return 'no throw'}catch(x){return x.constructor.name}}f()+':'+e1",
    );
}

/// A mutable binding reached the same way still writes.
#[test]
fn mutable_bindings_still_accept_by_name_writes() {
    agrees("let m=1;with({}){m=2}m");
    agrees("var v=1;with({}){v=2}v");
    agrees("let n=1;eval('n=2');n");
}

/// `Object.prototype.toString` steps 1-3: `undefined` and `null` answer before
/// ToObject, and every other primitive receiver takes the builtinTag of the
/// wrapper ToObject would produce. `this` arrives at the native unboxed, so
/// each of these used to fall through to `[object Object]`.
#[test]
fn object_to_string_tags_primitive_receivers() {
    for source in [
        "Object.prototype.toString.call(undefined)",
        "Object.prototype.toString.call(null)",
        "Object.prototype.toString.call(1)",
        "Object.prototype.toString.call(1.5)",
        "Object.prototype.toString.call('s')",
        "Object.prototype.toString.call('')",
        "Object.prototype.toString.call(true)",
        "Object.prototype.toString.call(false)",
        "Object.prototype.toString.call(Symbol('x'))",
        "Object.prototype.toString.call(1n)",
    ] {
        agrees(source);
    }
}

/// The object and wrapper receivers keep their existing tags.
#[test]
fn object_to_string_retains_object_receiver_tags() {
    for source in [
        "Object.prototype.toString.call({})",
        "Object.prototype.toString.call([])",
        "Object.prototype.toString.call(new Number(1))",
        "Object.prototype.toString.call(new String('s'))",
        "Object.prototype.toString.call(new Boolean(true))",
        "Object.prototype.toString.call(new Date(0))",
        "Object.prototype.toString.call(new Error('e'))",
        "Object.prototype.toString.call(function(){})",
        "(function(){return Object.prototype.toString.call(arguments)})()",
    ] {
        agrees(source);
    }
}

/// `JSON.stringify` walks an array by index and XS never mints a key for it,
/// so IronHorse must take the index id without charging `intern_key`'s slot
/// allocation. Charging it put IronHorse exactly 256 raw units per element
/// above the oracle, which accumulates across a persisted meter.
#[test]
fn json_stringify_array_indices_are_raw_exact() {
    for source in [
        "JSON.stringify([1])",
        "JSON.stringify([1,2])",
        "JSON.stringify([1,2,3])",
        "JSON.stringify([1,2,3,4])",
        "JSON.stringify([[1,2],[3,4]])",
        // An object whose keys really are names: unaffected either way, and
        // the control showing the per-element charge was array-index-specific.
        "JSON.stringify({a:1})",
    ] {
        agrees_raw_exact(source);
    }
    // `{a:[1,2]}` reaches the same array walk and agrees on whole computrons,
    // but carries an unrelated -8 raw drift from the ordinary object-property
    // path that is present on this branch independently of the index fix, so
    // it is gated on result agreement rather than raw equality.
    agrees("JSON.stringify({a:[1,2]})");
}
