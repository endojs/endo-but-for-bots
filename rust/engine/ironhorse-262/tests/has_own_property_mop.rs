//! Object-MOP residual 1/7 behavioral gate: `Object.prototype.hasOwnProperty`
//! through `ToObject` / `ToPropertyKey` / the receiver's `[[GetOwnProperty]]`
//! (design [`designs/ironhorse-engine.md`] § the object-MOP residuals).
//!
//! `hasOwnProperty(V)` (ECMA-262 20.1.3.2) is `? ToPropertyKey(V)` +
//! `? ToObject(this)` + `HasOwnProperty(O, P)` — never consulting the prototype
//! chain. This child removes the `hasOwnProperty:non-string-key` and
//! `hasOwnProperty:index-key` honest-skips by implementing the real path:
//! primitive-boxing receivers, symbol / number / index keys, and the
//! array / function / string-wrapper exotic own-property views. Each snippet is
//! dual-run against the XS oracle; the gate is **result agreement where the
//! oracle accepts the program** (`BothComplete` + `result_agrees`), per the
//! accuracy-over-parity doctrine. Typed-array-specific integer-index own
//! behavior is deliberately left to the typed-array cluster (an index key on a
//! typed-array receiver honest-skips), so it is not exercised here.

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
// §1  Ordinary receivers, non-string / index keys (was `non-string-key` /
//     `index-key`).
// -------------------------------------------------------------------------

#[test]
fn ordinary_string_and_absent_keys() {
    assert_result_agrees("({a:1}).hasOwnProperty('a')");
    assert_result_agrees("({a:1}).hasOwnProperty('b')");
    // A well-known inherited name is not an own property.
    assert_result_agrees("({a:1}).hasOwnProperty('toString')");
    // A missing argument stringifies `undefined`.
    assert_result_agrees("({undefined:1}).hasOwnProperty()");
}

#[test]
fn ordinary_index_keys() {
    // An integer-index-named own property of a plain object is an ordinary
    // slot; both the string and the number form of the key find it.
    assert_result_agrees("var o = {}; o[0] = 'x'; o.hasOwnProperty('0')");
    assert_result_agrees("var o = {}; o[0] = 'x'; o.hasOwnProperty(0)");
    assert_result_agrees("var o = {}; o[0] = 'x'; o.hasOwnProperty(1)");
    assert_result_agrees("({0:'z'}).hasOwnProperty('0')");
    assert_result_agrees("({0:'z'}).hasOwnProperty(0)");
    // A non-canonical index string ("00", "01", "-0") is a plain name.
    assert_result_agrees("var o = {}; o['00'] = 1; o.hasOwnProperty('00')");
    assert_result_agrees("var o = {}; o['00'] = 1; o.hasOwnProperty('0')");
}

#[test]
fn ordinary_numeric_key_coercions() {
    assert_result_agrees("var o = {}; o[1] = 'a'; o.hasOwnProperty(1.0)");
    assert_result_agrees("var o = {}; o['12'] = 'a'; o.hasOwnProperty(12)");
    assert_result_agrees("var o = {}; o['true'] = 1; o.hasOwnProperty(true)");
    assert_result_agrees("var o = {}; o['null'] = 1; o.hasOwnProperty(null)");
}

#[test]
fn ordinary_symbol_keys() {
    assert_result_agrees("var s = Symbol(); var o = {}; o[s] = 1; o.hasOwnProperty(s)");
    assert_result_agrees("var s = Symbol(); var o = {}; o.hasOwnProperty(s)");
    assert_result_agrees(
        "var a = Symbol(); var b = Symbol(); var o = {}; o[a] = 1; o.hasOwnProperty(b)",
    );
    assert_result_agrees("var o = {}; o[Symbol.iterator] = 1; o.hasOwnProperty(Symbol.iterator)");
    // `.call` form (the SES/Reflect idiom) with a symbol key.
    assert_result_agrees(
        "var s = Symbol(); var o = {}; o[s] = 1; Object.prototype.hasOwnProperty.call(o, s)",
    );
}

// -------------------------------------------------------------------------
// §2  Array exotic own properties (index + `length`).
// -------------------------------------------------------------------------

#[test]
fn array_index_and_length() {
    assert_result_agrees("[10,20,30].hasOwnProperty(0)");
    assert_result_agrees("[10,20,30].hasOwnProperty('1')");
    assert_result_agrees("[10,20,30].hasOwnProperty(2)");
    assert_result_agrees("[10,20,30].hasOwnProperty(3)");
    assert_result_agrees("[10,20,30].hasOwnProperty('length')");
    // A hole is not an own property.
    assert_result_agrees("var a = [1]; a[3] = 4; a.hasOwnProperty(2)");
    assert_result_agrees("var a = [1]; a[3] = 4; a.hasOwnProperty(3)");
    // An array expando named key.
    assert_result_agrees("var a = [1]; a.foo = 2; a.hasOwnProperty('foo')");
}

// -------------------------------------------------------------------------
// §3  Function exotic own properties (`length` / `name` / `prototype`).
// -------------------------------------------------------------------------

#[test]
fn function_own_properties() {
    assert_result_agrees("function f(a, b) {} f.hasOwnProperty('length')");
    assert_result_agrees("function f(a, b) {} f.hasOwnProperty('name')");
    assert_result_agrees("function f(a, b) {} f.hasOwnProperty('prototype')");
    assert_result_agrees("function f(a, b) {} f.hasOwnProperty('call')");
}

// -------------------------------------------------------------------------
// §4  Primitive receivers (`ToObject` boxing) and String-exotic own keys.
// -------------------------------------------------------------------------

#[test]
fn string_primitive_receiver() {
    assert_result_agrees("'abc'.hasOwnProperty(0)");
    assert_result_agrees("'abc'.hasOwnProperty('1')");
    assert_result_agrees("'abc'.hasOwnProperty(2)");
    assert_result_agrees("'abc'.hasOwnProperty(3)");
    assert_result_agrees("'abc'.hasOwnProperty('length')");
    assert_result_agrees("'abc'.hasOwnProperty('charAt')");
    assert_result_agrees("''.hasOwnProperty(0)");
    assert_result_agrees("''.hasOwnProperty('length')");
}

#[test]
fn string_wrapper_receiver() {
    assert_result_agrees("new String('ab').hasOwnProperty(0)");
    assert_result_agrees("new String('ab').hasOwnProperty(1)");
    assert_result_agrees("new String('ab').hasOwnProperty(2)");
    assert_result_agrees("new String('ab').hasOwnProperty('length')");
    assert_result_agrees("var s = new String('ab'); s.x = 1; s.hasOwnProperty('x')");
}

#[test]
fn other_primitive_receivers() {
    assert_result_agrees("(5).hasOwnProperty('toFixed')");
    assert_result_agrees("(5).hasOwnProperty('x')");
    assert_result_agrees("(5).hasOwnProperty(0)");
    // Boxed Number/Boolean/Symbol/BigInt receivers have no own properties; the
    // `.call` form drives `ToObject` boxing of the algorithm directly, without
    // depending on primitive-receiver method dispatch through each wrapper
    // prototype.
    assert_result_agrees("Object.prototype.hasOwnProperty.call(5, 'x')");
    assert_result_agrees("Object.prototype.hasOwnProperty.call(true, 'x')");
    assert_result_agrees("Object.prototype.hasOwnProperty.call(Symbol(), 'x')");
    assert_result_agrees("Object.prototype.hasOwnProperty.call(10n, 'x')");
}

// -------------------------------------------------------------------------
// §5  `ToObject(this)` throws for `null` / `undefined`.
// -------------------------------------------------------------------------

#[test]
fn nullish_receiver_throws() {
    assert_result_agrees(
        "var t; try { Object.prototype.hasOwnProperty.call(null, 'x'); t = 'no' } catch (e) { t = e instanceof TypeError } t",
    );
    assert_result_agrees(
        "var t; try { Object.prototype.hasOwnProperty.call(undefined, 'x'); t = 'no' } catch (e) { t = e instanceof TypeError } t",
    );
}

// -------------------------------------------------------------------------
// §6  Proxy `getOwnProperty` trap routing.
// -------------------------------------------------------------------------

#[test]
fn proxy_receiver() {
    assert_result_agrees("new Proxy({a:1}, {}).hasOwnProperty('a')");
    assert_result_agrees("new Proxy({a:1}, {}).hasOwnProperty('b')");
    assert_result_agrees(
        "var seen; var p = new Proxy({a:1}, { getOwnPropertyDescriptor(t,k){ seen = k; return Object.getOwnPropertyDescriptor(t,k) } }); var r = p.hasOwnProperty('a'); r + '|' + seen",
    );
}
