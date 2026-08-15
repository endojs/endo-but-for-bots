//! Behavioral gate for integer-indexed TypedArray element coercion and
//! CanonicalNumericIndexString handling.

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
fn numeric_element_set_uses_to_number() {
    assert_result_agrees("var a = new Int8Array(4); a[0] = '258'; a[0]");
    assert_result_agrees("var a = new Uint8Array(4); a[0] = null; a[0]");
    assert_result_agrees("var a = new Float64Array(4); a[0] = undefined; isNaN(a[0])");
    assert_result_agrees(
        "var a = new Int16Array(1); var n = 0; a[0] = { valueOf: function () { n++; return '513'; } }; a[0] + n",
    );
    assert_result_agrees(
        "var a = new Int16Array(1); a[0] = { valueOf: function () { return {}; }, toString: function () { return '258'; } }; a[0]",
    );
}

#[test]
fn numeric_element_set_rejects_bigint_and_symbol() {
    assert_result_agrees(
        "var a = new Uint8Array(1); try { a[0] = 1n; false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var a = new Uint8Array(1); try { a[0] = Symbol(); false } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn bigint_element_set_uses_to_bigint() {
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = '42'; a[0]");
    assert_result_agrees("var a = new BigUint64Array(1); a[0] = '0xffffffffffffffff'; a[0]");
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = ''; a[0]");
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = '-7'; a[0]");
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = '+7'; a[0]");
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = '0o10'; a[0]");
    assert_result_agrees("var a = new BigInt64Array(1); a[0] = '0b11'; a[0]");
    assert_result_agrees(
        "var a = new BigInt64Array(1); a[0] = { valueOf: function () { return -7n; } }; a[0]",
    );
    assert_result_agrees(
        "var a = new BigInt64Array(1); try { a[0] = 1; false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var a = new BigInt64Array(1); try { a[0] = 'not a bigint'; false } catch (e) { e instanceof SyntaxError }",
    );
}

#[test]
fn canonical_numeric_index_strings_do_not_become_properties() {
    assert_result_agrees("var a = new Uint8Array([7]); a['0'] = 9; a['0']");
    assert_result_agrees("var a = new Uint8Array([7]); a['-0'] = 9; a[0] + ':' + a['-0']");
    assert_result_agrees("var a = new Uint8Array([7]); a['1.5'] = 9; a['1.5']");
    assert_result_agrees("var a = new Uint8Array([7]); a['NaN'] = 9; a['NaN']");
    assert_result_agrees("var a = new Uint8Array([7]); a['01'] = 9; a['01']");
}

#[test]
fn has_own_property_observes_integer_indexed_elements() {
    assert_result_agrees("var a = new Uint8Array(1); a.hasOwnProperty('0')");
    assert_result_agrees("var a = new Uint8Array(1); a.hasOwnProperty('1')");
    assert_result_agrees("var a = new Uint8Array(1); a.hasOwnProperty('-0')");
}
