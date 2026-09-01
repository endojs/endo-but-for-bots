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
    assert_result_agrees(
        "Object.prototype.toString.call(1n)",
        "[object BigInt]",
    );
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
