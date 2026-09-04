//! XS-differential regressions for `Temporal.ZonedDateTime` and `Temporal.Now`.
//!
//! The pinned Moddable XS oracle has no `Temporal` global, so every case here
//! runs to an `Agreement::IronhorseOnlyComplete` against a `ReferenceError: get
//! Temporal: undefined variable` oracle abort — the causal, host-only exclusion
//! the full-suite report groups under `oracle-host-missing-temporal`. These
//! tests pin Ironhorse's *own* observable behaviour (the exact rendered result)
//! so the fixed-offset ZonedDateTime/Now implementation cannot silently regress.

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
fn zoned_construction_getters_and_offsets() {
    for (source, expected) in [
        ("new Temporal.ZonedDateTime(0n, 'UTC').toString()", "1970-01-01T00:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').offset", "+00:00"),
        ("new Temporal.ZonedDateTime(0n, '+05:30').toString()", "1970-01-01T05:30:00+05:30[+05:30]"),
        ("new Temporal.ZonedDateTime(0n, '+05:30').offset", "+05:30"),
        ("new Temporal.ZonedDateTime(0n, '+05:30').timeZoneId", "+05:30"),
        ("new Temporal.ZonedDateTime(0n, '+05:30').offsetNanoseconds", "19800000000000"),
        ("new Temporal.ZonedDateTime(0n, '-05:00').toString()", "1969-12-31T19:00:00-05:00[-05:00]"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').epochNanoseconds === 0n", "true"),
        ("new Temporal.ZonedDateTime(1000000n, 'UTC').epochMilliseconds", "1"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').calendarId", "iso8601"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').hoursInDay", "24"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').year", "1970"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').dayOfWeek", "4"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').daysInWeek", "7"),
        ("new Temporal.ZonedDateTime(0n, 'UTC').inLeapYear", "false"),
        ("typeof new Temporal.ZonedDateTime(0n, 'UTC').era", "undefined"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn zoned_from_string_and_object_and_compare() {
    for (source, expected) in [
        ("Temporal.ZonedDateTime.from('1970-01-01T00:00:00+00:00[UTC]').toString()", "1970-01-01T00:00:00+00:00[UTC]"),
        ("Temporal.ZonedDateTime.from('2020-03-08T09:30:00-05:00[America/New_York]').toString()", "2020-03-08T09:30:00-05:00[America/New_York]"),
        ("Temporal.ZonedDateTime.from('2020-01-01T12:00[+01:00]').toString()", "2020-01-01T12:00:00+01:00[+01:00]"),
        ("Temporal.ZonedDateTime.from({year:2020,month:1,day:1,hour:12,timeZone:'UTC'}).toString()", "2020-01-01T12:00:00+00:00[UTC]"),
        ("Temporal.ZonedDateTime.compare(new Temporal.ZonedDateTime(0n,'UTC'), new Temporal.ZonedDateTime(1n,'UTC'))", "-1"),
        ("Temporal.ZonedDateTime.compare(new Temporal.ZonedDateTime(5n,'UTC'), new Temporal.ZonedDateTime(5n,'+01:00'))", "0"),
        ("new Temporal.ZonedDateTime(0n,'UTC').equals(new Temporal.ZonedDateTime(0n,'UTC'))", "true"),
        ("new Temporal.ZonedDateTime(0n,'UTC').equals(new Temporal.ZonedDateTime(0n,'+00:00'))", "false"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn zoned_arithmetic_difference_and_rounding() {
    for (source, expected) in [
        ("new Temporal.ZonedDateTime(0n,'UTC').add({hours:25}).toString()", "1970-01-02T01:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').add({days:1}).toString()", "1970-01-02T00:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').add({months:1}).toString()", "1970-02-01T00:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').subtract({hours:1}).toString()", "1969-12-31T23:00:00+00:00[UTC]"),
        ("Temporal.ZonedDateTime.from('1970-01-01T00:00:00+00:00[UTC]').until('1970-01-01T02:30:00+00:00[UTC]').toString()", "PT2H30M"),
        ("Temporal.ZonedDateTime.from('1970-01-03T00:00:00+00:00[UTC]').until('1970-01-01T00:00:00+00:00[UTC]',{largestUnit:'day'}).toString()", "-P2D"),
        ("Temporal.ZonedDateTime.from('1970-01-01T02:30:00+00:00[UTC]').since('1970-01-01T00:00:00+00:00[UTC]').toString()", "PT2H30M"),
        ("new Temporal.ZonedDateTime(2400000000000n,'UTC').round('hour').toString()", "1970-01-01T01:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(1200000000000n,'UTC').round('hour').toString()", "1970-01-01T00:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(3600000000000n,'UTC').startOfDay().toString()", "1970-01-01T00:00:00+00:00[UTC]"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn zoned_conversions_with_and_transition() {
    for (source, expected) in [
        ("new Temporal.ZonedDateTime(0n,'+05:30').toInstant().toString()", "1970-01-01T00:00:00Z"),
        ("new Temporal.ZonedDateTime(0n,'+05:30').toPlainDate().toString()", "1970-01-01"),
        ("new Temporal.ZonedDateTime(0n,'+05:30').toPlainTime().toString()", "05:30:00"),
        ("new Temporal.ZonedDateTime(0n,'+05:30').toPlainDateTime().toString()", "1970-01-01T05:30:00"),
        ("new Temporal.ZonedDateTime(0n,'UTC').with({hour:12}).toString()", "1970-01-01T12:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').withPlainTime('06:00').toString()", "1970-01-01T06:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').withTimeZone('+01:00').toString()", "1970-01-01T01:00:00+01:00[+01:00]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').withCalendar('iso8601').calendarId", "iso8601"),
        ("new Temporal.ZonedDateTime(0n,'UTC').getTimeZoneTransition('next') === null", "true"),
        ("new Temporal.ZonedDateTime(0n,'UTC').toJSON()", "1970-01-01T00:00:00+00:00[UTC]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').toString({calendarName:'always'})", "1970-01-01T00:00:00+00:00[UTC][u-ca=iso8601]"),
        ("new Temporal.ZonedDateTime(0n,'UTC').toString({offset:'never',timeZoneName:'never'})", "1970-01-01T00:00:00"),
    ] {
        temporal_result(source, expected);
    }
}

#[test]
fn zoned_brand_and_range_errors_are_catchable() {
    // These catch the error, so the oracle also *completes* (its own `Temporal`
    // ReferenceError is caught and stringified to `false`); the causal assertion
    // is that Ironhorse threw the spec-mandated error type, so only Ironhorse's
    // own result is pinned — the same shape the plain-family regressions use.
    for source in [
        "var e;try{Temporal.ZonedDateTime(0n,'UTC')}catch(x){e=x instanceof TypeError}e",
        "var e;try{new Temporal.ZonedDateTime(0,'UTC')}catch(x){e=x instanceof TypeError}e",
        "var e;try{new Temporal.ZonedDateTime(0n,'No/Such_Zone')}catch(x){e=x instanceof RangeError}e",
        "var e;try{new Temporal.ZonedDateTime(0n,'UTC').valueOf()}catch(x){e=x instanceof TypeError}e",
        "var e;try{Temporal.ZonedDateTime.prototype.toString.call({})}catch(x){e=x instanceof TypeError}e",
        "var e;try{new Temporal.ZonedDateTime(0n,'UTC').withCalendar('hebrew')}catch(x){e=x instanceof RangeError}e",
    ] {
        let run = dual_run(source).expect("the XS oracle machine must start");
        assert_eq!(run.ironhorse_result, "true", "{source}: {run:?}");
    }
}

#[test]
fn now_deterministic_hooks() {
    for (source, expected) in [
        ("Temporal.Now.instant().epochNanoseconds === 0n", "true"),
        ("Temporal.Now.timeZoneId()", "UTC"),
        ("Temporal.Now.zonedDateTimeISO().toString()", "1970-01-01T00:00:00+00:00[UTC]"),
        ("Temporal.Now.zonedDateTimeISO().timeZoneId === Temporal.Now.timeZoneId()", "true"),
        ("Temporal.Now.zonedDateTimeISO('+05:30').toString()", "1970-01-01T05:30:00+05:30[+05:30]"),
        ("Temporal.Now.zonedDateTimeISO().calendarId", "iso8601"),
        ("Temporal.Now.plainDateISO().toString()", "1970-01-01"),
        ("Temporal.Now.plainDateTimeISO().toString()", "1970-01-01T00:00:00"),
        ("Temporal.Now.plainTimeISO().toString()", "00:00:00"),
        ("Temporal.Now.plainDateTimeISO('+05:30').toString()", "1970-01-01T05:30:00"),
        ("Temporal.Now.zonedDateTimeISO() instanceof Temporal.ZonedDateTime", "true"),
    ] {
        temporal_result(source, expected);
    }
}
