//! Oracle-backed `Array.prototype.toLocaleString` invocation and coercion
//! regressions.

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

fn ironhorse_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the pinned XS oracle must start");
    assert!(
        matches!(
            run.agreement,
            Agreement::BothComplete | Agreement::IronhorseOnlyComplete
        ),
        "{run:?}",
    );
    assert_eq!(run.ironhorse_result, expected, "for `{source}`");
}

#[test]
fn locale_string_is_generic_and_uses_live_element_methods() {
    for source in [
        "['',''].toLocaleString()",
        "Array.prototype.toLocaleString.call({length:2,0:{toLocaleString:function(){return 'a'}},1:null})",
        "var marker={}; var a=[{toLocaleString:function(){throw marker}}]; try{a.toLocaleString();false}catch(e){e===marker}",
    ] {
        agrees(source);
    }

    // Current ECMA-402 forwards both arguments. The pinned XS profile calls
    // the element methods with no arguments, so assert the modern behavior on
    // IronHorse while retaining the oracle-backed generic cases above.
    ironhorse_result(
        "var a=[1,2],calls=[]; Number.prototype.toLocaleString=function(l,o){calls.push(this+':'+l+':'+o.x);if(calls.length===1)a[1]=3;return this}; a.toLocaleString('zz',{x:4})+':'+calls.join('|')",
        "1,3:1:zz:4|3:zz:4",
    );
}

#[test]
fn number_locale_string_uses_the_frozen_intl_profile() {
    agrees("Number.prototype.toLocaleString.name+':'+Number.prototype.toLocaleString.length");
    // XS has no ECMA-402 host and renders these with Number#toString. These
    // values pin IronHorse's deterministic NumberFormat-backed profile.
    ironhorse_result("(1234567.5).toLocaleString()", "1,234,567.5");
    ironhorse_result(
        "(0).toLocaleString('th-u-nu-thai',{minimumFractionDigits:3})",
        "๐.๐๐๐",
    );
    ironhorse_result(
        "(123456789012345678901234567890n).toLocaleString('en-IN')",
        "1,23,45,67,89,01,23,45,67,89,01,23,45,67,890",
    );
    for (source, expected) in [
        (
            "(1).toLocaleString('en-US',{style:'currency',currency:'USD'})",
            "$1.00",
        ),
        (
            "(1n).toLocaleString('en-US',{style:'currency',currency:'USD'})",
            "$1.00",
        ),
        (
            "(1).toLocaleString('en-US',{style:'unit',unit:'meter'})",
            "1 m",
        ),
        (
            "(1n).toLocaleString('en-US',{style:'unit',unit:'meter'})",
            "1 m",
        ),
    ] {
        ironhorse_result(source, expected);
    }
}
