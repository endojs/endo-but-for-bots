//! Date error paths retain the pinned XS diagnostics and coercion ordering.

fn assert_result(source: &str, expected: &str) {
    let run = ironhorse_262::dual_run(source).expect("compile and run both engines");
    assert_eq!(
        run.agreement,
        ironhorse_262::Agreement::BothComplete,
        "{source}: {run:?}"
    );
    assert_eq!(
        run.oracle_result, expected,
        "oracle: {source}; port: {}",
        run.ironhorse_result
    );
    assert_eq!(run.ironhorse_result, expected, "ironhorse: {source}");
}

#[test]
fn date_receiver_and_invalid_time_messages() {
    for method in [
        "getTime",
        "valueOf",
        "getFullYear",
        "getUTCFullYear",
        "toISOString",
        "toString",
        "setTime",
        "setFullYear",
        "setUTCSeconds",
    ] {
        assert_result(
            &format!("try {{ Date.prototype.{method}.call({{}}) }} catch(e) {{ e.message }}"),
            "this: not a Date instance",
        );
    }
    assert_result(
        "try { new Date(NaN).toISOString() } catch(e) { e.message }",
        "Invalid Date",
    );
    assert_result("new Date(NaN).toJSON()", "null");
}

#[test]
fn date_primitive_hint_errors_and_order() {
    for hint in ["undefined", "null", "1", "{}", "'bogus'"] {
        assert_result(&format!("try {{ Date.prototype[Symbol.toPrimitive].call({{}}, {hint}) }} catch(e) {{ e.message }}"), "invalid hint");
    }
    assert_result(
        "try { Date.prototype[Symbol.toPrimitive].call(null, 'bogus') } catch(e) { e.message }",
        "invalid this",
    );
    for (hint, expected) in [
        ("default", "cannot coerce object to string"),
        ("string", "cannot coerce object to string"),
        ("number", "cannot coerce object to number"),
    ] {
        assert_result(&format!("try {{ Date.prototype[Symbol.toPrimitive].call({{valueOf() {{ return {{}} }}, toString() {{ return {{}} }} }}, '{hint}') }} catch(e) {{ e.message }}"), expected);
    }
    assert_result("var order = ''; var o = {valueOf() { order += 'v'; return {} }, toString() { order += 's'; return {} }}; try { Date.prototype[Symbol.toPrimitive].call(o, 'number') } catch(e) { order + ':' + e.message }", "vs:cannot coerce object to number");
}

#[test]
fn petrified_date_setters_keep_readonly_diagnostics() {
    for method in ["setTime", "setFullYear", "setUTCSeconds"] {
        assert_result(
            &format!(
                "var d = petrify(new Date(0)); try {{ d.{method}(1) }} catch(e) {{ e.message }}"
            ),
            "this: read-only Date instance",
        );
    }
}

#[test]
fn date_setter_readonly_checks_preserve_coercion_order() {
    assert_result("var d = Object.freeze(new Date(0)); d.setTime(1)", "1");
    assert_result("var count = 0; var d = petrify(new Date(0)); try { d.setTime({valueOf() { count++; return 1 }}) } catch(e) { count + ':' + e.message }", "0:this: read-only Date instance");
    assert_result("var count = 0; var d = petrify(new Date(0)); try { d.setUTCSeconds({valueOf() { count++; return 1 }}) } catch(e) { count + ':' + e.message }", "1:this: read-only Date instance");
}

#[test]
fn date_json_coercion_and_method_errors_remain_catchable() {
    for (receiver, expected) in [
        ("null", "cannot coerce null to object"),
        ("undefined", "cannot coerce undefined to object"),
        ("{}", "call: not a function"),
    ] {
        assert_result(
            &format!("try {{ Date.prototype.toJSON.call({receiver}) }} catch(e) {{ e.message }}"),
            expected,
        );
    }
    assert_result("Date.prototype.toJSON.call({valueOf() { return NaN }, get toISOString() { throw 'must not read' }})", "null");
}
