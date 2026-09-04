//! XS-differential regressions for the ISO Temporal plain families.

use ironhorse_262::{dual_run, Agreement};

fn temporal_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(
        run.agreement,
        Agreement::IronhorseOnlyComplete,
        "{source}: {run:?}"
    );
    assert_eq!(
        run.oracle_error,
        "ReferenceError: get Temporal: undefined variable"
    );
    assert_eq!(run.ironhorse_result, expected, "{source}: {run:?}");
}

#[test]
fn plain_iso_construction_parsing_and_fields() {
    for (source, expected) in [
        ("new Temporal.PlainDate(2024,2,29).toString()", "2024-02-29"),
        (
            "Temporal.PlainTime.from('12:34:56.123456789').nanosecond",
            "789",
        ),
        (
            "Temporal.PlainDateTime.from('2000-01-02T03:04:05').toString()",
            "2000-01-02T03:04:05",
        ),
        ("new Temporal.PlainYearMonth(2024,7).toString()", "2024-07"),
        ("new Temporal.PlainMonthDay(12,25).toString()", "12-25"),
        ("new Temporal.Calendar('iso8601').id", "iso8601"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn plain_iso_arithmetic_difference_and_conversion() {
    for (source, expected) in [
        (
            "Temporal.PlainDate.from('2024-02-28').add({days:2}).toString()",
            "2024-03-01",
        ),
        (
            "Temporal.PlainTime.from('23:30').add({hours:2}).toString()",
            "01:30:00",
        ),
        (
            "Temporal.PlainDateTime.from('2020-01-01T23:00').add({hours:2}).toString()",
            "2020-01-02T01:00:00",
        ),
        (
            "Temporal.PlainDate.from('2024-01-01').until('2024-01-11').days",
            "10",
        ),
        (
            "Temporal.PlainDateTime.from('2024-05-06T07:08:09').toPlainDate().toString()",
            "2024-05-06",
        ),
        (
            "Temporal.PlainDateTime.from('2024-05-06T07:08:09').toPlainTime().toString()",
            "07:08:09",
        ),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn plain_brands_are_immutable_and_ranges_are_catchable() {
    temporal_result(
        "var d=new Temporal.PlainDate(2024,1,2);d.year=9;d.year===2024",
        "true",
    );
    for source in [
        "var e;try{new Temporal.PlainDate(2023,2,29)}catch(x){e=x instanceof RangeError}e",
        "var e;try{Temporal.PlainDate.prototype.toString.call({})}catch(x){e=x instanceof TypeError}e",
        "var e;try{new Temporal.PlainTime(24)}catch(x){e=x instanceof RangeError}e",
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(run.ironhorse_result, "true", "{source}: {run:?}");
    }
}
