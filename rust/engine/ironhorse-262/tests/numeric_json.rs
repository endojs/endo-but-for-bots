//! Oracle-backed regressions for numeric conversion and JSON parse errors.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "`{source}` must complete on both engines (halt: {:?})",
        run.ironhorse_halt,
    );
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn number_to_string_handles_integral_radices_and_errors() {
    for source in [
        "(35).toString(36)",
        "(255).toString(16)",
        "(-10).toString(2)",
        "NaN.toString(7)",
        "Infinity.toString(3)",
        "(31).toString({ valueOf: function () { return 16; } })",
        "try { Number.prototype.toString.call('1'); false } catch (e) { e instanceof TypeError }",
        "try { (1).toString(1); false } catch (e) { e instanceof RangeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn numeric_globals_apply_ordinary_coercions() {
    for source in [
        "parseInt(123.9)",
        "parseInt({ toString: function () { return '0xff'; } })",
        "parseFloat(true)",
        "parseFloat({ toString: function () { return '12.5'; } })",
        "isNaN({ valueOf: function () { return 'x'; } })",
        "isFinite({ valueOf: function () { return '12'; } })",
    ] {
        agrees(source);
    }
}

#[test]
fn malformed_json_throws_a_catchable_syntax_error() {
    for source in [
        "try { JSON.parse('['); false } catch (e) { e instanceof SyntaxError }",
        "try { JSON.parse('{\"x\":}'); false } catch (e) { e instanceof SyntaxError }",
        "try { JSON.parse('true false'); false } catch (e) { e instanceof SyntaxError }",
        "try { JSON.parse('\"\\\\uZZZZ\"'); false } catch (e) { e instanceof SyntaxError }",
    ] {
        agrees(source);
    }
}

#[test]
fn json_parse_coerces_input_and_stringify_rejects_cycles_catchably() {
    for source in [
        "JSON.parse(true)",
        "JSON.parse({ toString: function () { return '[1,2]'; } }).length",
        "var a=[]; a[0]=a; try { JSON.stringify(a); false } catch (e) { e instanceof TypeError }",
        "var a={}, b={}; a.b=b; b.a=a; try { JSON.stringify(a); false } catch (e) { e instanceof TypeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn json_parse_supports_utf16_strings_and_astral_keys() {
    for source in [
        r#"JSON.parse('"😀"') === '😀'"#,
        r#"JSON.parse('"\\ud83d\\ude00"') === '😀'"#,
        r#"JSON.parse('"\\ud800"').charCodeAt(0) === 0xd800"#,
        r#"JSON.parse('"\\udfff"').charCodeAt(0) === 0xdfff"#,
        r#"var s=JSON.parse('"\\ud800A\\udfff"'); s.length===3 && s.charCodeAt(0)===0xd800 && s.charCodeAt(2)===0xdfff"#,
        r#"JSON.parse('{"😀":"𝒜"}')["😀"] === "𝒜""#,
        r#"JSON.parse('{"\\ud83d\\ude00":1}')["😀"] === 1"#,
        r#"var source; JSON.parse('"\\ud83d\\ude00"', function(k,v,c){ if(k==='') source=c.source; return v }); source"#,
    ] {
        agrees(source);
    }
}
