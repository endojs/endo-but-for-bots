//! Behavioral gate for DataView detached-buffer error paths, the get/set
//! method reflective `name`/`length`, `Symbol.toStringTag`, and the
//! `ToInt8`/`ToUint8`/… modular element coercion of non-finite and large
//! values (the `f64 as iN` saturation fix).

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
fn detached_buffer_get_set_throw_type_error() {
    // A get/set on a view whose backing buffer was detached is a TypeError,
    // ahead of an out-of-range RangeError.
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b); $262.detachArrayBuffer(b); \
         try { d.getInt32(0); false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b); $262.detachArrayBuffer(b); \
         try { d.setFloat64(0, 1.5); false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b); $262.detachArrayBuffer(b); \
         try { d.setBigInt64(0, 1n); false } catch (e) { e instanceof TypeError }",
    );
    // Detached TypeError precedes the out-of-range RangeError.
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b); $262.detachArrayBuffer(b); \
         try { d.getInt32(100); false } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn detached_buffer_getters_and_constructor_throw() {
    // `get byteLength`/`get byteOffset` throw on a detached buffer; `buffer`
    // still returns the (detached) reference.
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b, 2); $262.detachArrayBuffer(b); \
         try { d.byteLength; false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b, 2); $262.detachArrayBuffer(b); \
         try { d.byteOffset; false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var b = new ArrayBuffer(8); var d = new DataView(b, 2); $262.detachArrayBuffer(b); d.buffer === b",
    );
    // The constructor throws a TypeError when the buffer is detached, after
    // ToNumber(byteOffset) has been observed once.
    assert_result_agrees(
        "var log = 0; var o = { valueOf() { log += 1; return 0; } }; \
         var b = new ArrayBuffer(8); $262.detachArrayBuffer(b); \
         var t = false; try { new DataView(b, o); } catch (e) { t = e instanceof TypeError; } \
         t && log === 1",
    );
}

#[test]
fn get_set_methods_expose_spec_name_and_length() {
    for (name, len) in [
        ("getInt8", 1),
        ("getUint32", 1),
        ("getFloat64", 1),
        ("getBigInt64", 1),
        ("setInt8", 2),
        ("setUint16", 2),
        ("setFloat32", 2),
        ("setBigUint64", 2),
    ] {
        assert_result_agrees(&format!("DataView.prototype.{name}.name === '{name}'"));
        assert_result_agrees(&format!("DataView.prototype.{name}.length === {len}"));
    }
}

#[test]
fn prototype_to_string_tag_is_dataview() {
    assert_result_agrees("DataView.prototype[Symbol.toStringTag] === 'DataView'");
    assert_result_agrees(
        "Object.prototype.toString.call(new DataView(new ArrayBuffer(1))) === '[object DataView]'",
    );
}

#[test]
fn non_finite_and_large_values_reduce_modulo() {
    // ToInt8/ToUint8/… of Infinity, -Infinity and NaN is +0 (not a saturated
    // 0xFF..FF from an `f64 as iN` cast).
    for setter_getter in [
        ("setInt8", "getInt8"),
        ("setUint8", "getUint8"),
        ("setInt16", "getInt16"),
        ("setUint16", "getUint16"),
        ("setInt32", "getInt32"),
        ("setUint32", "getUint32"),
    ] {
        let (s, g) = setter_getter;
        for v in ["Infinity", "-Infinity", "NaN"] {
            assert_result_agrees(&format!(
                "var d = new DataView(new ArrayBuffer(8)); d.{s}(0, {v}); d.{g}(0)"
            ));
        }
    }
    // Large finite values wrap modulo 2^bits rather than saturating.
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setInt8(0, -4294967295); d.getInt8(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setInt16(0, 9007199254740992); d.getInt16(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setUint32(0, 4294967296 + 5); d.getUint32(0)",
    );
}
