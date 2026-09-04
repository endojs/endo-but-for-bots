use ironhorse_262::{dual_run, Agreement};

fn assert_oracle_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
}

#[test]
fn direct_and_indirect_eval_return_non_string_arguments_without_parsing() {
    assert_oracle_result("eval(42)", "42");
    assert_oracle_result("(0, eval)(false)", "false");
    assert_oracle_result("eval()", "undefined");
}

#[test]
fn eval_declaration_instantiation_raises_realm_errors() {
    assert_oracle_result(
        "var caught = false; try { (0, eval)('function NaN() {}') } catch (e) { caught = e instanceof TypeError } caught",
        "true",
    );
    assert_oracle_result(
        "var caught = false; try { (0, eval)('typeof x; let x;') } catch (e) { caught = e instanceof ReferenceError } caught",
        "true",
    );
}
