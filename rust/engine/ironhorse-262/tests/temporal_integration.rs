//! XS-differential regressions for the js-25 "Temporal integration" surface:
//! `Temporal.Duration.compare`/`total`/`round` with a `relativeTo` reference,
//! and `Temporal.ZonedDateTime.prototype.until`/`since` with a calendar
//! `largestUnit`.
//!
//! The pinned Moddable XS oracle has no `Temporal` global, so — exactly as in
//! `temporal_zoned.rs` — every case runs to an `Agreement::IronhorseOnlyComplete`
//! against a `ReferenceError: get Temporal: undefined variable` oracle abort.
//! Because the oracle cannot compare a Temporal result, these tests are the only
//! correctness gate for the calendar-relative arithmetic: each pins Ironhorse's
//! own rendered result to an exact, spec-derived expected value (drawn from the
//! matching official test262 case's own assertions where possible).

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

/// Pin only Ironhorse's rendered result, not the oracle agreement — the correct
/// shape for a `try`/`catch` source, where the oracle *also* completes (it
/// catches its own missing-`Temporal` `ReferenceError`). Mirrors the catchable-
/// error idiom in `temporal_core.rs`/`temporal_plain.rs`.
fn temporal_ironhorse(source: &str, expected: &str) {
    let run = dual_run(source).expect("the XS oracle machine must start");
    assert_eq!(run.ironhorse_result, expected, "{source}: {run:?}");
}

/// Assert that `expr` throws a `RangeError` under Ironhorse.
fn temporal_range_error(expr: &str) {
    temporal_ironhorse(&format!("var e=false;try{{{expr}}}catch(x){{e=x instanceof RangeError}}e"), "true");
}

#[test]
fn duration_compare_time_units_needs_no_relative_to() {
    // built-ins/Temporal/Duration/compare/basic.js (time-only prefix).
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,0,0,0,5,5,5,5,5,5), new Temporal.Duration(0,0,0,0,5,5,5,5,5,5))", "0");
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,0,0,0,5,4,5,5,5,5), new Temporal.Duration(0,0,0,0,5,5,5,5,5,5))", "-1");
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,0,0,0,5,5,5,5,5,5), new Temporal.Duration(0,0,0,0,5,4,5,5,5,5))", "1");
    // Days without a relativeTo are exact 24-hour days.
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,0,0,2), new Temporal.Duration(0,0,0,0,48))", "0");
}

#[test]
fn duration_compare_calendar_units_require_relative_to() {
    // Calendar units with no relativeTo is a RangeError (compare/basic.js).
    temporal_range_error("Temporal.Duration.compare(new Temporal.Duration(5), new Temporal.Duration(4))");
    temporal_range_error("new Temporal.Duration(0,5).total({unit:'day'})");
    temporal_range_error("new Temporal.Duration(0,5).total({unit:'year'})");
}

#[test]
fn duration_compare_with_relative_to() {
    // built-ins/Temporal/Duration/compare/relativeto-year.js
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(1), new Temporal.Duration(0,0,0,365), { relativeTo: Temporal.PlainDate.from('2017-01-01') })", "0");
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(1), new Temporal.Duration(0,0,0,365), { relativeTo: Temporal.PlainDate.from('2016-01-01') })", "1");
    // A ZonedDateTime relativeTo reduces to its local date (fixed offset).
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,1), new Temporal.Duration(0,0,0,31), { relativeTo: new Temporal.ZonedDateTime(0n, 'UTC') })", "0");
    // A property-bag relativeTo (2016-02 has 29 days).
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,1), new Temporal.Duration(0,0,0,29), { relativeTo: { year: 2016, month: 2, day: 1 } })", "0");
    // A relativeTo string.
    temporal_result("Temporal.Duration.compare(new Temporal.Duration(0,0,1), new Temporal.Duration(0,0,0,7), { relativeTo: '2020-01-01' })", "0");
}

#[test]
fn duration_total_balances_calendar_units() {
    // built-ins/Temporal/Duration/prototype/total/balances-days-up-to-both-years-and-months.js
    temporal_result("new Temporal.Duration(0, 11, 0, 396).total({ unit: 'years', relativeTo: new Temporal.PlainDate(2017, 1, 1) })", "2");
    temporal_result("new Temporal.Duration(0, -11, 0, -396).total({ unit: 'years', relativeTo: new Temporal.PlainDate(2017, 1, 1) })", "-2");
    // Whole months across a year boundary.
    temporal_result("new Temporal.Duration(1, 1).total({ unit: 'months', relativeTo: new Temporal.PlainDate(2020, 1, 1) })", "13");
}

#[test]
fn duration_total_fixed_units() {
    // A day is 24 hours; a week is 7 days.
    temporal_result("new Temporal.Duration(0,0,0,1).total({ unit: 'hours', relativeTo: new Temporal.PlainDate(2020, 1, 1) })", "24");
    temporal_result("new Temporal.Duration(0,0,0,14).total({ unit: 'weeks', relativeTo: new Temporal.PlainDate(2020, 1, 1) })", "2");
    // The bare-string unit form needs no relativeTo for time-only durations.
    temporal_result("new Temporal.Duration(0,0,0,0,90).total('minutes')", "5400");
    temporal_result("new Temporal.Duration(0,0,0,0,1,30).total('minutes')", "90");
}

#[test]
fn duration_round_relative_time_units() {
    // Half-expand rounding of a sub-day duration against a relativeTo.
    temporal_result("new Temporal.Duration(0,0,0,0,1,30).round({ smallestUnit: 'hour', relativeTo: new Temporal.PlainDate(2020, 1, 1) }).toString()", "PT2H");
    temporal_result("new Temporal.Duration(0,0,0,0,1,29).round({ smallestUnit: 'hour', relativeTo: new Temporal.PlainDate(2020, 1, 1) }).toString()", "PT1H");
    // Day-granularity rounding, balanced to a day largestUnit.
    temporal_result("new Temporal.Duration(0,0,0,1,12).round({ smallestUnit: 'day', relativeTo: new Temporal.PlainDate(2020, 1, 1) }).toString()", "P2D");
    // built-ins/Temporal/Duration/prototype/round/valid-increments.js — the
    // result is a Temporal.Duration for a calendar-carrying duration.
    temporal_result("new Temporal.Duration(5,5,5,5,5,5,5,5,5,5).round({ smallestUnit: 'hours', roundingIncrement: 12, relativeTo: new Temporal.PlainDate(2020, 1, 1) }) instanceof Temporal.Duration", "true");
}

#[test]
fn duration_round_requires_a_unit_and_relative_to() {
    // Neither smallestUnit nor largestUnit given is a RangeError.
    temporal_range_error("new Temporal.Duration(0,0,0,0,1).round({})");
    // largestUnit finer than smallestUnit is a RangeError.
    temporal_range_error("new Temporal.Duration(0,0,0,0,1).round({ smallestUnit: 'hour', largestUnit: 'minute', relativeTo: new Temporal.PlainDate(2020,1,1) })");
    // Calendar units without relativeTo is a RangeError.
    temporal_range_error("new Temporal.Duration(0,5).round({ smallestUnit: 'month' })");
}

#[test]
fn zoned_until_since_calendar_largest_unit() {
    // ZonedDateTime difference with a calendar largestUnit.
    temporal_result("Temporal.ZonedDateTime.from('2020-01-01T00:00[UTC]').until('2021-03-01T00:00[UTC]', { largestUnit: 'year' }).toString()", "P1Y2M");
    temporal_result("Temporal.ZonedDateTime.from('2020-01-01T00:00[UTC]').until('2020-02-15T00:00[UTC]', { largestUnit: 'month' }).toString()", "P1M14D");
    temporal_result("Temporal.ZonedDateTime.from('2020-01-01T00:00[UTC]').until('2020-01-20T00:00[UTC]', { largestUnit: 'week' }).toString()", "P2W5D");
    // A calendar largestUnit with a time-of-day remainder.
    temporal_result("Temporal.ZonedDateTime.from('2020-01-01T00:00[UTC]').until('2021-03-01T06:30[UTC]', { largestUnit: 'year' }).toString()", "P1Y2MT6H30M");
    // since is the negated until.
    temporal_result("Temporal.ZonedDateTime.from('2021-03-01T00:00[UTC]').since('2020-01-01T00:00[UTC]', { largestUnit: 'year' }).toString()", "P1Y2M");
    // Invalid largestUnit string is a RangeError.
    temporal_range_error("new Temporal.ZonedDateTime(0n,'UTC').until(new Temporal.ZonedDateTime(1n,'UTC'), { largestUnit: 'bogus' })");
    // largestUnit finer than smallestUnit is a RangeError.
    temporal_range_error("new Temporal.ZonedDateTime(0n,'UTC').until(new Temporal.ZonedDateTime(1n,'UTC'), { largestUnit: 'hour', smallestUnit: 'year' })");
    // Weeks and months never coexist in the output (largestUnit month -> no weeks).
    temporal_result("Temporal.ZonedDateTime.from('2020-01-01T00:00[UTC]').until('2020-02-20T00:00[UTC]', { largestUnit: 'month' }).toString()", "P1M19D");
}
