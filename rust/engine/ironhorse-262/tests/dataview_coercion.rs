//! Behavioral gate for DataView construction and element access coercion.

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
fn constructor_to_index_and_view_bounds() {
    assert_result_agrees("new DataView(new ArrayBuffer(8), '2', true).byteLength");
    assert_result_agrees("new DataView(new ArrayBuffer(8), 2.9, 3.9).byteLength");
    assert_result_agrees(
        "new DataView(new ArrayBuffer(8), { valueOf() { return 3; } }).byteOffset",
    );
    assert_result_agrees(
        "try { new DataView(new ArrayBuffer(8), -1); false } catch (e) { e instanceof RangeError }",
    );
    assert_result_agrees(
        "try { new DataView({}, 0); false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "try { DataView(new ArrayBuffer(1)); false } catch (e) { e instanceof TypeError }",
    );
}

#[test]
fn every_numeric_element_type_round_trips_with_endianness() {
    for (setter, getter, value) in [
        ("setInt8", "getInt8", "-2"),
        ("setUint8", "getUint8", "254"),
        ("setInt16", "getInt16", "-258"),
        ("setUint16", "getUint16", "65534"),
        ("setInt32", "getInt32", "-16909060"),
        ("setUint32", "getUint32", "4278058235"),
        ("setFloat32", "getFloat32", "1.5"),
        ("setFloat64", "getFloat64", "-2.25"),
    ] {
        assert_result_agrees(&format!(
            "var d = new DataView(new ArrayBuffer(8)); d.{setter}(0, {value}, true); d.{getter}(0, true)"
        ));
    }
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigInt64(0, '-2', true); d.getBigInt64(0, true)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(8)); d.setBigUint64(0, '18446744073709551615'); d.getBigUint64(0)",
    );
}

#[test]
fn accessor_to_index_value_coercion_and_errors() {
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(4)); d.setUint16('1', '258'); d.getUint16(true)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(4)); d.setInt8(0, { valueOf() { return -7; } }); d.getInt8(0)",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(1)); try { d.getUint16(0); false } catch (e) { e instanceof RangeError }",
    );
    assert_result_agrees(
        "try { DataView.prototype.getInt8.call({}, 0); false } catch (e) { e instanceof TypeError }",
    );
    assert_result_agrees(
        "var d = new DataView(new ArrayBuffer(1)); try { d.setInt8(Symbol(), 0); false } catch (e) { e instanceof TypeError }",
    );
}
