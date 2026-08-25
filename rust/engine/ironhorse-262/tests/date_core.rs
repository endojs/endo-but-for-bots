//! Oracle-backed regressions for the deterministic UTC `Date` profile.

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
fn constructor_utc_and_time_clip_match_xs() {
    for source in [
        "new Date(0).getTime()",
        "new Date(-0).getTime() === 0 && 1 / new Date(-0).getTime() === Infinity",
        "new Date(8640000000000001).getTime() !== new Date(8640000000000001).getTime()",
        "Date.UTC(1970, 0, 1)",
        "Date.UTC(99, 11, 31, 23, 59, 59, 999)",
        "Date.UTC(2016, 12, 1) === Date.UTC(2017, 0, 1)",
    ] {
        agrees(source);
    }
}

#[test]
fn utc_getters_and_iso_rendering_match_xs() {
    for source in [
        "var d=new Date(Date.UTC(2000,1,29,23,58,57,123)); [d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate(),d.getUTCDay(),d.getUTCHours(),d.getUTCMinutes(),d.getUTCSeconds(),d.getUTCMilliseconds()].join(',')",
        "new Date(0).toISOString()",
        "new Date(-62167219200000).toISOString()",
        "new Date(0).toUTCString()",
        "new Date(NaN).toString()",
        "try { new Date(NaN).toISOString(); false } catch (e) { e instanceof RangeError }",
    ] {
        agrees(source);
    }
}

#[test]
fn parsing_and_set_time_match_xs() {
    for source in [
        "Date.parse('1970-01-01T00:00:00.000Z')",
        "Date.parse('2000-02-29')",
        "new Date('2000-02-29T12:34:56.789Z').toISOString()",
        "var d=new Date(1); d.setTime(null) === 0 && d.getTime() === 0",
        "new Date(NaN).toJSON()",
    ] {
        agrees(source);
    }
}
