//! `%BigInt%`, `%BigInt.prototype%`, and BigInt primitive wrappers.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{source}: ironhorse halt={:?}, oracle={:?}, ironhorse={:?}",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

fn assert_agrees(source: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(
        run.agreement,
        Agreement::BothComplete,
        "{source}: ironhorse halt={:?}, oracle={:?}, ironhorse={:?}",
        run.ironhorse_halt,
        run.oracle_result,
        run.ironhorse_result,
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn constructor_accepts_primitive_inputs() {
    assert_result_agrees("BigInt(42)", "42");
    assert_result_agrees("BigInt(-42)", "-42");
    assert_result_agrees("BigInt(true)", "1");
    assert_result_agrees("BigInt(false)", "0");
    assert_result_agrees("BigInt(123n) === 123n", "true");
}

#[test]
fn constructor_parses_arbitrary_precision_strings() {
    assert_result_agrees(
        "BigInt('123456789012345678901234567890')",
        "123456789012345678901234567890",
    );
    assert_result_agrees(
        "BigInt('-123456789012345678901234567890')",
        "-123456789012345678901234567890",
    );
    assert_result_agrees(
        "BigInt('0xffffffffffffffffffff')",
        "1208925819614629174706175",
    );
    assert_result_agrees(
        "BigInt('0b100000000000000000000000000000001')",
        "4294967297",
    );
    assert_result_agrees("BigInt('   ')", "0");
}

#[test]
fn constructor_uses_ecmascript_string_integer_whitespace() {
    assert_result_agrees("BigInt('\\uFEFF1\\u3000')", "1");
    assert_result_agrees(
        "BigInt('\\u0009\\u000A\\u000B\\u000C\\u000D \\u00A0\\u1680\\u2000\\u2001\\u2002\\u2003\\u2004\\u2005\\u2006\\u2007\\u2008\\u2009\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF42\\uFEFF')",
        "42",
    );
    assert_result_agrees(
        "try { BigInt('\\u0085'); false } catch (e) { e instanceof SyntaxError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt('\\u00851'); false } catch (e) { e instanceof SyntaxError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt('1\\u0085'); false } catch (e) { e instanceof SyntaxError }",
        "true",
    );
}

#[test]
fn bigint_typed_arrays_use_ecmascript_string_integer_whitespace() {
    assert_result_agrees("new BigInt64Array(['\\uFEFF1\\u3000'])[0]", "1");
    assert_result_agrees(
        "try { new BigInt64Array(['\\u00851']); false } catch (e) { e instanceof SyntaxError }",
        "true",
    );
}

#[test]
fn constructor_coerces_objects() {
    assert_result_agrees(
        "BigInt({valueOf:function(){return '9007199254740993'}})",
        "9007199254740993",
    );
    assert_result_agrees("BigInt({toString:function(){return '77'}})", "77");
}

#[test]
fn constructor_errors_are_catchable() {
    assert_result_agrees(
        "try { new BigInt(1); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt(1.5); 'no' } catch (e) { e instanceof RangeError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt('1.5'); 'no' } catch (e) { e instanceof SyntaxError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt(Symbol('x')); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn object_boxes_bigints_with_realm_identity() {
    assert_result_agrees(
        "var a=Object(0n),b=Object(0n); ''+(a instanceof BigInt)+','+(a.valueOf()===0n)+','+(a!==b)",
        "true,true,true",
    );
    assert_result_agrees("Object.getPrototypeOf(1n) === BigInt.prototype", "true");
    assert_result_agrees(
        "try { BigInt.prototype.valueOf(); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
    assert_result_agrees(
        "Object.prototype.toString.call(Object(1n))",
        "[object BigInt]",
    );
    assert_result_agrees("Object.prototype.toString.call(1n)", "[object BigInt]");
}

#[test]
fn prototype_to_string_supports_radices() {
    assert_result_agrees("(255n).toString()", "255");
    assert_result_agrees("(255n).toString(16)", "ff");
    assert_result_agrees("void (255n).toString; (255n)['toString'](16)", "ff");
    assert_result_agrees("(-255n).toString(2)", "-11111111");
    assert_result_agrees("Object(35n).toString(36)", "z");
}

#[test]
fn prototype_methods_validate_receivers_and_radix() {
    assert_result_agrees(
        "try { BigInt.prototype.valueOf.call(1); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
    assert_result_agrees(
        "try { (1n).toString(1); 'no' } catch (e) { e instanceof RangeError }",
        "true",
    );
}

#[test]
fn wrapped_bigints_participate_in_numeric_coercion() {
    assert_result_agrees("Object(2n) ** 3n", "8");
    assert_result_agrees("2n ** Object(3n)", "8");
    assert_result_agrees("Object(2n) + 3n", "5");
}

#[test]
fn width_limiting_statics_cover_signed_and_unsigned_boundaries() {
    assert_result_agrees("BigInt.asIntN(8, 255n)", "-1");
    assert_result_agrees("BigInt.asIntN(8, -129n)", "127");
    assert_result_agrees("BigInt.asUintN(8, -1n)", "255");
    assert_result_agrees(
        "BigInt.asUintN(65, 0xabcdef0123456789abcdefn)",
        "18528729602926038511",
    );
    assert_result_agrees(
        "BigInt.asIntN(200, 0xcffffffffffffffffffffffffffffffffffffffffffffffffffn)",
        "-1",
    );
}

#[test]
fn width_limiting_statics_apply_toindex_and_tobigint_in_order() {
    assert_result_agrees("BigInt.asIntN('3.9', '10')", "2");
    assert_result_agrees("BigInt.asUintN(true, true)", "1");
    assert_result_agrees("BigInt.asUintN(1000, 1n)", "1");
    assert_result_agrees(
        "var log=''; BigInt.asIntN({valueOf:function(){log+='b';return 8}}, {valueOf:function(){log+='v';return 257n}}); log",
        "bv",
    );
}

#[test]
fn width_limiting_statics_raise_catchable_errors() {
    assert_result_agrees(
        "try { BigInt.asIntN(-1, 0n); 'no' } catch (e) { e instanceof RangeError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt.asUintN(Infinity, 0n); 'no' } catch (e) { e instanceof RangeError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt.asIntN(8, 1); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
    assert_result_agrees(
        "try { BigInt.asUintN(8, '1.5'); 'no' } catch (e) { e instanceof SyntaxError }",
        "true",
    );
    assert_result_agrees(
        "try { new BigInt.asIntN(8, 1n); 'no' } catch (e) { e instanceof TypeError }",
        "true",
    );
}

#[test]
fn width_limiting_statics_match_oracle_across_limb_boundaries() {
    let widths = [0, 1, 2, 7, 8, 31, 32, 33, 63, 64, 65, 127, 128, 129, 200];
    let values = [
        "-123456789012345678901234567890",
        "-4294967297",
        "-4294967296",
        "-257",
        "-256",
        "-255",
        "-129",
        "-128",
        "-127",
        "-3",
        "-2",
        "-1",
        "0",
        "1",
        "2",
        "3",
        "127",
        "128",
        "129",
        "255",
        "256",
        "257",
        "4294967295",
        "4294967296",
        "4294967297",
        "123456789012345678901234567890",
    ];
    for width in widths {
        for value in values {
            assert_agrees(&format!("BigInt.asIntN({width}, {value}n)"));
            assert_agrees(&format!("BigInt.asUintN({width}, {value}n)"));
        }
    }
}
