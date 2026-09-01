//! Ordinary integer-indexed property names participate in the same own
//! enumerability query as other string keys.

use ironhorse_262::{dual_run, Agreement};

fn assert_result_agrees(source: &str, expected: &str) {
    let run = dual_run(source).expect("pinned XS oracle is available");
    assert_eq!(run.agreement, Agreement::BothComplete, "{source}");
    assert_eq!(run.oracle_result, expected, "oracle result for {source}");
    assert_eq!(
        run.ironhorse_result, expected,
        "ironhorse result for {source}"
    );
    assert!(run.result_agrees, "results must agree for {source}");
}

#[test]
fn integer_indexed_ordinary_properties_are_enumerable() {
    assert_result_agrees(
        "var object = { 1: 'one' }; object.propertyIsEnumerable('1') + ':' + object.propertyIsEnumerable('2')",
        "true:false",
    );
}

#[test]
fn computed_numeric_class_fields_are_enumerable() {
    assert_result_agrees(
        "var C = class { [10] = 'ten'; }; var c = new C(); c.propertyIsEnumerable('10')",
        "true",
    );
}
