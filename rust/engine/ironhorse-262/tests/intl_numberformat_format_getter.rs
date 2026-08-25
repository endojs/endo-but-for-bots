//! Oracle-backed regressions for the `Intl.NumberFormat.prototype.format`
//! **accessor getter** (child `numberformat-getter-structural`) and the
//! general callable/`Reflect.construct`/getter-throw fixes it required.
//!
//! ECMA-402 models `format` as an accessor property whose getter returns a
//! cached `[[BoundFormat]]` function — not a plain method. The pinned XS
//! oracle has no ECMA-402 host, so each Intl case is proven by requiring
//! Ironhorse to run it to completion (`IronhorseOnlyComplete`) with the exact
//! value while the oracle reports the missing `Intl` binding, the same
//! host-only-exclusion shape `intl_numberformat.rs` uses. The three general
//! fixes (`Object.prototype.toString` → `[object Function]` for callables;
//! `Reflect.construct` requiring `IsConstructor`; a thrown getter routing
//! through the enclosing `catch`) are pinned as ordinary `BothComplete`
//! bit-exact regressions, since they do not depend on Intl.

use ironhorse_262::{dual_run, Agreement};

/// Assert Ironhorse completes `source` with `expected`, the oracle lacking Intl.
fn intl_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::IronhorseOnlyComplete,
        "the pinned XS oracle has no Intl host; Ironhorse must complete `{source}` \
         (halt: {:?}, err: {:?})",
        run.ironhorse_halt,
        run.ironhorse_error,
    );
    assert_eq!(
        run.oracle_error, "ReferenceError: get Intl: undefined variable",
        "the host-only exclusion must stay exact for `{source}`",
    );
    assert_eq!(run.ironhorse_result, expected, "for `{source}`");
}

/// Assert both engines complete and agree bit-exactly (result + computrons) —
/// for the general, Intl-independent fixes.
fn both_exact(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "both engines must complete `{source}` (ih halt: {:?})",
        run.ironhorse_halt,
    );
    assert_eq!(run.ironhorse_result, expected, "ironhorse value for `{source}`");
    assert_eq!(run.oracle_result, expected, "oracle value for `{source}`");
    assert!(
        run.is_bit_exact(),
        "`{source}` must be bit-exact (result_agrees={}, computrons_agree={})",
        run.result_agrees,
        run.computrons_agree,
    );
}

/// Assert both engines complete with the same completion value. Used for the
/// exception-taking `Reflect.construct` paths, where the throw's exact
/// computron count is not calibrated against XS (only the observable value —
/// that a TypeError is thrown — is pinned here).
fn both_value(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "both engines must complete `{source}` (ih halt: {:?})",
        run.ironhorse_halt,
    );
    assert_eq!(run.ironhorse_result, expected, "ironhorse value for `{source}`");
    assert_eq!(run.oracle_result, expected, "oracle value for `{source}`");
}

#[test]
fn format_is_an_accessor_property_on_the_prototype() {
    // getOwnPropertyDescriptor reports {get: function, set: undefined,
    // enumerable: false, configurable: true} (prop-desc.js).
    intl_result(
        "var d=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format');\
         typeof d.get+','+(d.set===undefined)+','+d.enumerable+','+d.configurable",
        "function,true,false,true",
    );
    // It is a real own property of the prototype, reachable by the string key.
    intl_result("Intl.NumberFormat.prototype.hasOwnProperty('format')", "true");
    // The accessor is configurable: it can be deleted and redefined.
    intl_result(
        "delete Intl.NumberFormat.prototype.format;\
         Intl.NumberFormat.prototype.hasOwnProperty('format')",
        "false",
    );
}

#[test]
fn format_getter_has_the_spec_name_and_length() {
    // `get format` / length 0 (name.js, length.js read these off desc.get).
    intl_result(
        "Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get.name",
        "get format",
    );
    intl_result(
        "Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get.length",
        "0",
    );
}

#[test]
fn format_getter_is_a_builtin_function() {
    // builtin.js: the getter is a non-constructor Function chained to
    // %Function.prototype% with no own `prototype`.
    intl_result(
        "var g=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get;\
         Object.prototype.toString.call(g)+','+Object.isExtensible(g)+','+\
         (Object.getPrototypeOf(g)===Function.prototype)+','+g.hasOwnProperty('prototype')",
        "[object Function],true,true,false",
    );
}

#[test]
fn format_getter_returns_a_cached_bound_function() {
    // The same bound function is returned on every read (the [[BoundFormat]]
    // cache) — bound-to-numberformat-instance.js relies on this identity.
    intl_result("var nf=new Intl.NumberFormat('en-US'); nf.format===nf.format", "true");
    // The bound function is an anonymous, length-1, non-constructor builtin
    // with no own `prototype` (format-function-{name,length,builtin}.js).
    intl_result(
        "var f=new Intl.NumberFormat('en-US').format;\
         typeof f+','+f.name+','+f.length+','+f.hasOwnProperty('prototype')+','+\
         (Object.getPrototypeOf(f)===Function.prototype)",
        "function,,1,false,true",
    );
    intl_result(
        "var f=new Intl.NumberFormat().format; Object.prototype.toString.call(f)",
        "[object Function]",
    );
}

#[test]
fn bound_format_formats_like_the_method() {
    // Calling the bound function formats with the NumberFormat it was read
    // from (bound-to-numberformat-instance.js).
    intl_result(
        "var nf=new Intl.NumberFormat('en-US'); var f=nf.format; f(1234.5)",
        "1,234.5",
    );
    intl_result(
        "var nf=new Intl.NumberFormat('de-DE'); var f=nf.format; f(1234.5)===nf.format(1234.5)",
        "true",
    );
    // The getter, applied to an instance explicitly, yields a working bound fn.
    intl_result(
        "var g=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get;\
         g.call(new Intl.NumberFormat('en-US'))(5)",
        "5",
    );
}

#[test]
fn format_getter_requires_a_numberformat_this() {
    // Reading `format` on the bare prototype (not an initialized NumberFormat)
    // throws a TypeError from the getter (this-value-numberformat-prototype.js).
    // Read the getter outside the `try` (so the oracle's missing-Intl abort
    // is the run's terminal, not swallowed by the catch), then invoke it on a
    // non-NumberFormat `this`.
    intl_result(
        "var g=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get;\
         var caught; try{ g.call(Intl.NumberFormat.prototype) }catch(e){ caught=e }\
         caught instanceof TypeError",
        "true",
    );
    intl_result(
        "var g=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get;\
         var caught; try{ g.call({}) }catch(e){ caught=e } caught.constructor.name",
        "TypeError",
    );
}

#[test]
fn format_getter_is_not_a_constructor() {
    // no-instanceof.js / format's builtin.js: isConstructor(getter) is false —
    // Reflect.construct with the getter as newTarget throws.
    intl_result(
        "var g=Object.getOwnPropertyDescriptor(Intl.NumberFormat.prototype,'format').get;\
         var ok; try{ Reflect.construct(function(){}, [], g); ok=false }catch(e){ ok=(e instanceof TypeError) } ok",
        "true",
    );
    intl_result(
        "var f=new Intl.NumberFormat().format;\
         var ok; try{ Reflect.construct(function(){}, [], f); ok=false }catch(e){ ok=(e instanceof TypeError) } ok",
        "true",
    );
}

// ---- the general (Intl-independent) fixes ----

#[test]
fn object_to_string_tags_callables_as_function() {
    // Object.prototype.toString on any callable is "[object Function]"
    // (ECMA-262 20.1.3.6 step 6) — user function, native constructor, and
    // native prototype method alike.
    both_exact(
        "Object.prototype.toString.call(function(){})",
        "[object Function]",
    );
    both_exact("Object.prototype.toString.call(Object)", "[object Function]");
    both_exact(
        "Object.prototype.toString.call(Array.prototype.map)",
        "[object Function]",
    );
    // A plain object is still "[object Object]".
    both_exact("Object.prototype.toString.call({})", "[object Object]");
}

#[test]
fn reflect_construct_requires_a_constructor() {
    // A native prototype method has no [[Construct]] — Reflect.construct with
    // it (as target or newTarget) throws a TypeError; a real constructor works.
    both_value(
        "var ok; try{ Reflect.construct(Array.prototype.map, []); ok=false }\
         catch(e){ ok=(e instanceof TypeError) } ok",
        "true",
    );
    both_value(
        "var ok; try{ Reflect.construct(function(){}, [], Array.prototype.map); ok=false }\
         catch(e){ ok=(e instanceof TypeError) } ok",
        "true",
    );
    // A genuine constructor still works (value-level; Reflect.construct's exact
    // computron count is not calibrated against XS here).
    both_value(
        "Reflect.construct(function(a){this.a=a;}, [7]).a",
        "7",
    );
}

#[test]
fn a_thrown_getter_is_caught_by_the_enclosing_try() {
    // A getter that throws inside a `try` is caught (GET_PROPERTY must route
    // the getter's Halt::Resume to the catch, not exit the loop).
    both_exact(
        "var o={get x(){throw new TypeError('u')}};\
         var c; try{ o.x }catch(e){ c=e.constructor.name } c",
        "TypeError",
    );
    both_exact(
        "var proto={get f(){throw new RangeError('r')}}; var o=Object.create(proto);\
         var c; try{ o.f }catch(e){ c=e.constructor.name } c",
        "RangeError",
    );
    // The value produced by a non-throwing getter is unaffected.
    both_exact("var o={get x(){return 41+1}}; o.x", "42");
}
