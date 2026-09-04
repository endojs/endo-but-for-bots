//! XS-differential regressions for exact Temporal.Instant/Duration records.

use ironhorse_262::{dual_run, Agreement};

fn temporal_result(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.agreement, Agreement::IronhorseOnlyComplete, "{source}: {run:?}");
    assert_eq!(run.oracle_error, "ReferenceError: get Temporal: undefined variable");
    assert_eq!(run.ironhorse_result, expected, "{source}: {run:?}");
}

#[test]
fn instant_parsing_arithmetic_and_nanoseconds_are_exact() {
    for (source, expected) in [
        ("Temporal.Instant.from('1970-01-01T00:00:00.000000001Z').epochNanoseconds", "1"),
        ("Temporal.Instant.fromEpochNanoseconds(-1n).toString()", "1969-12-31T23:59:59.999999999Z"),
        ("Temporal.Instant.from('2000-01-01T00:00:00Z').add('PT1.000000001S').toString()", "2000-01-01T00:00:01.000000001Z"),
        ("Temporal.Instant.compare('1970-01-01T00:00:00Z','1970-01-01T00:00:00.000000001Z')", "-1"),
        ("Temporal.Instant.fromEpochMilliseconds(1234).epochNanoseconds", "1234000000"),
        ("Temporal.Instant.fromEpochNanoseconds(1500000000n).round('second').epochNanoseconds", "2000000000"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn duration_records_are_immutable_branded_and_balanced() {
    for (source, expected) in [
        ("Temporal.Duration.from('P1DT2H3M4.005006007S').toString()", "P1DT2H3M4.005006007S"),
        ("new Temporal.Duration(0,0,0,0,1,2,3,4,5,6).negated().toString()", "-PT1H2M3.004005006S"),
        ("Temporal.Duration.from({hours:1,minutes:30}).total('minutes')", "90"),
        ("Temporal.Duration.compare('PT60S','PT1M')", "0"),
        ("Temporal.Duration.from('PT1H').add('PT30M').toString()", "PT1H30M"),
        ("var d=Temporal.Duration.from('PT1H'); d.hours=9; d.hours", "1"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn temporal_brand_and_range_errors_are_catchable() {
    for source in [
        "var e;try{Temporal.Instant.prototype.toString.call({})}catch(x){e=x instanceof TypeError}e",
        "var e;try{new Temporal.Instant(8640000000000000000001n)}catch(x){e=x instanceof RangeError}e",
        "var e;try{new Temporal.Duration(1,-1)}catch(x){e=x instanceof RangeError}e",
        "var e;try{Temporal.Instant.from('not-an-instant')}catch(x){e=x instanceof RangeError}e",
        "var e;try{Temporal.Instant.from('2023-02-29T00:00:00Z')}catch(x){e=x instanceof RangeError}e",
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(run.ironhorse_result, "true", "{source}: {run:?}");
    }
}
