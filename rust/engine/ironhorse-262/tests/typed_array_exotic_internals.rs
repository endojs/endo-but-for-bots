//! Behavioral gate: the **integer-indexed exotic** internal methods of a
//! TypedArray instance (ECMA-262 10.4.5) — `[[Get]]`, `[[Set]]`,
//! `[[HasProperty]]`, `[[GetOwnProperty]]`, `[[DefineOwnProperty]]`,
//! `[[Delete]]`, `[[OwnPropertyKeys]]`, and `[[PreventExtensions]]`/
//! `[[IsExtensible]]` — reached through the property MOP dispatch (`sample[k]`,
//! `Reflect.*`, `Object.getOwnPropertyDescriptor`/`defineProperty`,
//! `key in sample`, `delete sample[k]`, `hasOwnProperty`,
//! `propertyIsEnumerable`). Before this landed each self-named an
//! `:exotic-object` / `typed-array-set:*` honest skip; the `internals` slice
//! rose from 2 to 66 covered.
//!
//! The heart is `CanonicalNumericIndexString` → `IsValidIntegerIndex` → element
//! get/set with the destination-type coercion (`ToNumber`, or `ToBigInt` for a
//! BigInt64/BigUint64 view): a canonical numeric index string routes to the
//! integer-indexed element behavior (never the prototype chain), while every
//! other key is ordinary. Each snippet is dual-run against the XS differential
//! oracle and gated on observable result agreement where the oracle accepts the
//! program (`BothComplete` + `result_agrees`), the accuracy-over-parity bar the
//! sibling `array_buffer_ctor_coercion` gate uses.

use ironhorse_262::{dual_run, Agreement};

/// Assert a program completes on BOTH engines with the SAME completion value.
fn agrees(source: &str) {
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
// §1  [[Get]] — a canonical numeric index reads the element (or `undefined`
//     for an invalid index) and NEVER consults the prototype chain.
// -------------------------------------------------------------------------

#[test]
fn get_valid_index_reads_element() {
    agrees("var s = new Int8Array([42, 7]); '' + s[0] + ',' + s[1]");
    agrees("var s = new Int8Array([42, 7]); '' + s['0'] + ',' + s['1']");
    // Reflect.get reaches the same element behavior, receiver ignored.
    agrees("var s = new Uint16Array([9, 8]); '' + Reflect.get(s, '1')");
}

#[test]
fn get_invalid_index_is_undefined_not_inherited() {
    // Out of range / negative / -0 / non-integral canonical indices read
    // `undefined` — the exotic [[Get]] short-circuits before OrdinaryGet, so a
    // prototype property under the SAME canonical string is NOT inherited.
    agrees(
        "var s = new Int8Array([1]); Int8Array.prototype['5'] = 'x'; \
         var r = '' + s['5'] + ',' + s['-1'] + ',' + s['-0'] + ',' + s['1.5']; \
         delete Int8Array.prototype['5']; r",
    );
    // A NON-canonical string ('1.0', '+1', '01') is ordinary — it DOES inherit.
    agrees(
        "var s = new Int8Array([1]); Int8Array.prototype['1.0'] = 'y'; \
         var r = '' + s['1.0']; delete Int8Array.prototype['1.0']; r",
    );
}

// -------------------------------------------------------------------------
// §2  [[Set]] — element coercion (ToNumber / ToBigInt) runs for any canonical
//     numeric index, writing only a valid one; the receiver-differs path
//     stores on the receiver.
// -------------------------------------------------------------------------

#[test]
fn set_valid_index_coerces_and_stores() {
    agrees("var s = new Int8Array(2); s[0] = 5; s[1] = 300; '' + s[0] + ',' + s[1]");
    // ToNumber runs valueOf.
    agrees("var s = new Uint8Array(1); s[0] = { valueOf: function () { return 9; } }; '' + s[0]");
    // Reflect.set with the view as receiver returns true and stores.
    agrees("var s = new Int16Array(1); '' + Reflect.set(s, '0', 42) + ',' + s[0]");
}

#[test]
fn set_invalid_index_still_coerces_but_does_not_store() {
    // An out-of-bounds write coerces (observable valueOf side effect) yet
    // stores nothing and — through the assignment / Reflect.set — is `true`.
    agrees(
        "var count = 0; var v = { valueOf: function () { count++; return 1; } }; \
         var s = new Int8Array(1); s[5] = v; s[-1] = v; '' + count + ',' + s.length",
    );
    agrees("var s = new Int8Array(1); '' + Reflect.set(s, '5', 1) + ',' + Reflect.set(s, '-1', 1)");
}

#[test]
fn set_receiver_differs_stores_on_receiver() {
    // A valid index with a receiver that is NOT the view falls to
    // OrdinarySetWithOwnDescriptor: the plain-object receiver gets the RAW
    // (uncoerced) value; the source view is untouched.
    agrees(
        "var s = new Int8Array([0]); var r = {}; \
         var ok = Reflect.set(s, 0, 7, r); '' + ok + ',' + s[0] + ',' + r[0]",
    );
    // A non-extensible receiver rejects the create.
    agrees(
        "var s = new Int8Array([0]); var r = Object.preventExtensions({}); \
         var ok = Reflect.set(s, 0, 7, r); '' + ok + ',' + r.hasOwnProperty(0)",
    );
}

// -------------------------------------------------------------------------
// §3  BigInt element coercion (ToBigInt): a BigInt / Boolean / integer-valued
//     String stores; a Number / undefined throws; a non-integer String is a
//     SyntaxError.
// -------------------------------------------------------------------------

#[test]
fn bigint_set_coercion() {
    // Compare with `===` rather than string-concatenating a BigInt (`'' + 5n`
    // is a separate, unrelated engine residual).
    agrees("var b = new BigInt64Array(2); b[0] = 5n; b[1] = true; b[0] === 5n && b[1] === 1n");
    agrees("var b = new BigUint64Array(1); b[0] = '10'; b[0] === 10n");
    agrees("var b = new BigInt64Array(1); b[0] = ''; b[0] === 0n");
    // ToBigInt(Number) is a TypeError; undefined too.
    agrees(
        "var b = new BigInt64Array(1); var r = ''; \
         try { b[0] = 1; } catch (e) { r += e instanceof TypeError ? 'T' : 'x'; } \
         try { b[0] = undefined; } catch (e) { r += e instanceof TypeError ? 'T' : 'x'; } r",
    );
    // A non-integer string is a SyntaxError.
    agrees(
        "var b = new BigInt64Array(1); var r = ''; \
         try { b[0] = '1.5'; } catch (e) { r += e instanceof SyntaxError ? 'S' : 'x'; } \
         try { b[0] = 'zzz'; } catch (e) { r += e instanceof SyntaxError ? 'S' : 'x'; } r",
    );
}

// -------------------------------------------------------------------------
// §4  [[HasProperty]] — a canonical numeric index is present iff it is a valid
//     integer index; any other key walks the chain.
// -------------------------------------------------------------------------

#[test]
fn has_property() {
    agrees(
        "var s = new Int8Array(2); \
         '' + ('0' in s) + ',' + ('2' in s) + ',' + ('-1' in s) + ',' + ('1.5' in s)",
    );
    agrees("var s = new Int8Array(2); '' + Reflect.has(s, '1') + ',' + Reflect.has(s, '9')");
    agrees("var s = new Int8Array(2); s.foo = 1; '' + ('foo' in s) + ',' + s.hasOwnProperty('0') + ',' + s.hasOwnProperty('2')");
}

// -------------------------------------------------------------------------
// §5  [[GetOwnProperty]] — a valid index yields a configurable, enumerable,
//     writable data descriptor; an invalid index is `undefined`.
// -------------------------------------------------------------------------

#[test]
fn get_own_property_descriptor() {
    agrees(
        "var s = new Int8Array([9]); var d = Object.getOwnPropertyDescriptor(s, '0'); \
         '' + d.value + d.writable + d.enumerable + d.configurable",
    );
    agrees("var s = new Int8Array([9]); '' + Object.getOwnPropertyDescriptor(s, '5')");
    agrees("var s = new Int8Array([9]); '' + Reflect.getOwnPropertyDescriptor(s, '-0')");
    agrees("var s = new Int8Array([9]); '' + s.propertyIsEnumerable('0') + ',' + s.propertyIsEnumerable('5')");
}

// -------------------------------------------------------------------------
// §6  [[DefineOwnProperty]] — a valid-index data descriptor stores; a
//     non-configurable / non-enumerable / non-writable / accessor clause, or
//     an out-of-range index, is rejected.
// -------------------------------------------------------------------------

#[test]
fn define_own_property() {
    agrees(
        "var s = new Int8Array([0, 0]); \
         Reflect.defineProperty(s, '0', { value: 8, writable: true, enumerable: true, configurable: true }); \
         '' + s[0]",
    );
    // Out-of-range index is rejected.
    agrees("var s = new Int8Array([1, 1]); '' + Reflect.defineProperty(s, '2', { value: 9 })");
    // A restrictive attribute is rejected (the value is unchanged).
    agrees("var s = new Int8Array([3]); '' + Reflect.defineProperty(s, '0', { configurable: false }) + ',' + s[0]");
    agrees("var s = new Int8Array([3]); '' + Reflect.defineProperty(s, '0', { writable: false })");
    agrees("var s = new Int8Array([3]); '' + Reflect.defineProperty(s, '0', { get: function () { return 1; } })");
    // Object.defineProperty on a valid index stores; a rejected define throws a
    // catchable TypeError.
    agrees("var s = new Int8Array([0]); Object.defineProperty(s, '0', { value: 5 }); '' + s[0]");
    agrees(
        "var s = new Int8Array([0]); var r = 'n'; \
         try { Object.defineProperty(s, '0', { configurable: false }); } \
         catch (e) { r = e instanceof TypeError ? 'T' : 'x'; } r",
    );
}

// -------------------------------------------------------------------------
// §7  [[OwnPropertyKeys]] — every in-range integer index (ascending, as a
//     string) first, then the ordinary string keys, then the symbol keys.
// -------------------------------------------------------------------------

#[test]
fn own_property_keys() {
    agrees("var s = new Int8Array(3); Reflect.ownKeys(s).join(',')");
    agrees("var s = new Int8Array(0); Reflect.ownKeys(s).length");
    agrees(
        "var s = new Int8Array(2); s.foo = 1; \
         var k = Reflect.ownKeys(s); '' + k.length + ',' + k[0] + ',' + k[1] + ',' + k[2]",
    );
}

// -------------------------------------------------------------------------
// §8  [[Delete]] — a valid integer index cannot be deleted; an invalid
//     canonical numeric index is a vacuous success.
// -------------------------------------------------------------------------

#[test]
fn delete_property() {
    agrees("var s = new Int8Array(2); '' + Reflect.deleteProperty(s, '0') + ',' + Reflect.deleteProperty(s, '5')");
    // Non-strict `delete` yields the boolean.
    agrees("var s = new Int8Array(2); '' + (delete s[0]) + ',' + (delete s[5]) + ',' + (delete s['-1'])");
    // A named expando deletes ordinarily.
    agrees("var s = new Int8Array(2); s.foo = 1; '' + (delete s.foo) + ',' + ('foo' in s)");
}

// -------------------------------------------------------------------------
// §9  [[PreventExtensions]] / [[IsExtensible]] — a fixed-length view marks
//     non-extensible (rejecting a later ordinary named define) while its
//     elements stay writable.
// -------------------------------------------------------------------------

#[test]
fn prevent_extensions() {
    agrees(
        "var s = new Int8Array([1, 2]); Object.preventExtensions(s); \
         '' + Object.isExtensible(s) + ',' + Reflect.defineProperty(s, 'foo', { value: 1 })",
    );
    // Elements stay writable through the exotic [[Set]] after preventExtensions.
    agrees("var s = new Int8Array([1, 2]); Object.preventExtensions(s); s[0] = 9; '' + s[0]");
    // An already-present expando is still redefinable.
    agrees(
        "var s = new Int8Array([1]); s.foo = 1; Object.preventExtensions(s); \
         '' + Reflect.defineProperty(s, 'foo', { value: 2 }) + ',' + s.foo",
    );
}
