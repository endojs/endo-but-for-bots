//! Behavioral gate: `<TypedArray>` constructor argument coercion, error
//! semantics, and the `BYTES_PER_ELEMENT` element-size constant (js-26
//! TypedArray/ArrayBuffer cluster, constructor forms).
//!
//! `new TA(length)` takes `ToIndex` on the length (ECMA-262 23.2.5.1): a
//! boolean / string / null / object is coerced through the general `ToNumber`
//! path (observing `valueOf`/`toString`); a `Symbol`/`BigInt` throws a
//! **catchable** `TypeError`; a negative or over-ceiling result throws a
//! **catchable** `RangeError`. `new TA(buffer, byteOffset, length)` takes
//! `ToIndex` on both `byteOffset` and `length`, with a non-multiple offset or
//! an out-of-range span a **catchable** `RangeError`. Calling a typed-array
//! constructor without `new` is a `TypeError`. Each snippet is dual-run against
//! the XS oracle and gated on observable agreement where the oracle accepts the
//! program (`BothComplete` + `result_agrees`) — the accuracy-over-parity bar the
//! sibling `array_buffer_ctor_coercion` / `typed_array_from_source` gates use.
//! Before this landed these all self-named `native-call:TypedArray:*` skips, and
//! `TA.BYTES_PER_ELEMENT` read back `undefined`.

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
// §1  ToIndex coercion of a non-integer length argument.
// -------------------------------------------------------------------------

#[test]
fn boolean_and_null_length_coerce() {
    assert_result_agrees("new Uint8Array(true).length");
    assert_result_agrees("new Uint8Array(false).length");
    assert_result_agrees("new Int32Array(null).length");
    assert_result_agrees("new Float64Array(undefined).length");
}

#[test]
fn string_length_coerces() {
    assert_result_agrees("new Uint8Array('3').length");
    assert_result_agrees("new Uint8Array('').length");
    assert_result_agrees("new Uint8Array('   ').length");
    assert_result_agrees("new Uint16Array('0').length");
}

#[test]
fn fractional_length_truncates() {
    // A primitive fractional length truncates toward zero (ToIntegerOrInfinity).
    // (An *object* first argument is never a length — it takes the array-like /
    // iterable source path, so it is deliberately excluded here.)
    assert_result_agrees("new Uint8Array(3.9).length");
    assert_result_agrees("new Uint8Array(NaN).length");
    assert_result_agrees("new Int32Array(2.999).length");
}

// -------------------------------------------------------------------------
// §2  Catchable RangeError on a negative / oversized length.
// -------------------------------------------------------------------------

#[test]
fn negative_length_throws_catchable_range_error() {
    assert_result_agrees("try { new Uint8Array(-1); 'none' } catch (e) { e instanceof RangeError }");
    assert_result_agrees(
        "try { new Int16Array(-Infinity); 'none' } catch (e) { e instanceof RangeError }",
    );
}

#[test]
fn oversized_length_throws_catchable_range_error() {
    assert_result_agrees(
        "try { new Uint8Array(9007199254740991); 'none' } catch (e) { e instanceof RangeError }",
    );
    // A byte span above XS's 0x7FFFFFFF chunk ceiling (element count * size).
    assert_result_agrees(
        "try { new Float64Array(0x20000000); 'none' } catch (e) { e instanceof RangeError }",
    );
}

// -------------------------------------------------------------------------
// §3  Catchable TypeError on a Symbol/BigInt length or a no-`new` call.
// -------------------------------------------------------------------------

#[test]
fn symbol_length_throws_catchable_type_error() {
    assert_result_agrees(
        "try { new Uint8Array(Symbol()); 'none' } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn bigint_length_throws_catchable_type_error() {
    assert_result_agrees(
        "try { new Uint8Array(1n); 'none' } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn call_without_new_throws_type_error() {
    assert_result_agrees("try { Uint8Array(8); 'none' } catch (e) { e instanceof TypeError }");
    assert_result_agrees("try { Int32Array(); 'none' } catch (e) { e instanceof TypeError }");
    assert_result_agrees("try { Float64Array(0); 'none' } catch (e) { e instanceof TypeError }");
}

// -------------------------------------------------------------------------
// §4  Buffer-view form: ToIndex on byteOffset/length, RangeError on a
//     non-multiple offset or an out-of-range span.
// -------------------------------------------------------------------------

#[test]
fn buffer_view_offset_and_length_coerce() {
    assert_result_agrees("var b = new ArrayBuffer(16); new Uint8Array(b, '4').length");
    assert_result_agrees("var b = new ArrayBuffer(16); new Uint8Array(b, true).length");
    assert_result_agrees("var b = new ArrayBuffer(16); new Uint8Array(b, 0, '4').length");
    assert_result_agrees(
        "var b = new ArrayBuffer(16); new Uint8Array(b, { valueOf: function () { return 4; } }).length",
    );
}

#[test]
fn buffer_view_bad_offset_multiple_throws_range_error() {
    // A byteOffset that is not a multiple of the element size (2 for Int16).
    assert_result_agrees(
        "var b = new ArrayBuffer(16); try { new Int16Array(b, 1); 'none' } catch (e) { e instanceof RangeError }",
    );
}

#[test]
fn buffer_view_excessive_length_throws_range_error() {
    assert_result_agrees(
        "var b = new ArrayBuffer(8); try { new Uint8Array(b, 0, 100); 'none' } catch (e) { e instanceof RangeError }",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(8); try { new Uint8Array(b, 100); 'none' } catch (e) { e instanceof RangeError }",
    );
}

// -------------------------------------------------------------------------
// §5  `BYTES_PER_ELEMENT` on the constructor, its prototype, and an instance.
// -------------------------------------------------------------------------

#[test]
fn bytes_per_element_on_constructor_and_prototype() {
    for (ctor, size) in [
        ("Int8Array", 1),
        ("Uint8Array", 1),
        ("Uint8ClampedArray", 1),
        ("Int16Array", 2),
        ("Uint16Array", 2),
        ("Int32Array", 4),
        ("Uint32Array", 4),
        ("Float32Array", 4),
        ("Float64Array", 8),
        ("BigInt64Array", 8),
        ("BigUint64Array", 8),
    ] {
        assert_result_agrees(&format!("{ctor}.BYTES_PER_ELEMENT === {size}"));
        assert_result_agrees(&format!("{ctor}.prototype.BYTES_PER_ELEMENT === {size}"));
    }
    assert_result_agrees("new Uint32Array(2).BYTES_PER_ELEMENT === 4");
}

// -------------------------------------------------------------------------
// §6  `typeof` of an undeclared global is "undefined", never a ReferenceError
//     (the harness `typeof Float16Array` guard depends on it).
// -------------------------------------------------------------------------

#[test]
fn typeof_undeclared_global_is_undefined() {
    assert_result_agrees("typeof ThereIsNoSuchGlobalName");
    assert_result_agrees("typeof ThereIsNoSuchGlobalName === 'undefined'");
    // A declared-but-undefined binding still reads its value, not a throw.
    assert_result_agrees("var x; typeof x");
}
