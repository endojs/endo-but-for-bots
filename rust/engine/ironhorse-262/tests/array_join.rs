//! Array join regressions for separator and element coercion ordering.

use ironhorse_262::{dual_run, Agreement};

fn agrees(source: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert_eq!(run.agreement, Agreement::BothComplete, "{run:?}");
    assert!(
        run.result_agrees,
        "`{source}` diverged: oracle={:?} ironhorse={:?}",
        run.oracle_result, run.ironhorse_result,
    );
}

#[test]
fn object_separator_precedes_live_element_reads() {
    agrees("var a=[{toString:function(){a[1]=9;return 1}},2]; var s={toString:function(){a.push(3);return '-'}}; a.join(s)");
}

#[test]
fn symbol_separator_throws_type_error() {
    agrees("try { [1,2].join(Symbol()); false } catch (e) { e instanceof TypeError }");
}
