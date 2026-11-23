//! The proleptic Gregorian day arithmetic of ECMA-262 §21.4.1 (Date
//! objects: time values and time range), in exact integers.

/// ECMA-262 §21.4.1 DaysInYear ( y ):
///
/// > 1. Let ry be ℝ(y).
/// > 2. If (ry modulo 400) = 0, return 366𝔽.
/// > 3. If (ry modulo 100) = 0, return 365𝔽.
/// > 4. If (ry modulo 4) = 0, return 366𝔽.
/// > 5. Return 365𝔽.
pub fn days_in_year(y: i64) -> i128 {
    let y = i128::from(y);
    if y.rem_euclid(400) == 0 {
        366
    } else if y.rem_euclid(100) == 0 {
        365
    } else if y.rem_euclid(4) == 0 {
        366
    } else {
        365
    }
}

/// ECMA-262 §21.4.1 DayFromYear ( y ):
///
/// > 1. Let ry be ℝ(y).
/// > 2. NOTE: In the following steps, numYears1, numYears4, numYears100,
/// >    and numYears400 represent the number of years divisible by 1, 4,
/// >    100, and 400, respectively, that occur between the epoch and the
/// >    start of year y. The number is negative if y is before the epoch.
/// > 3. Let numYears1 be (ry - 1970).
/// > 4. Let numYears4 be floor((ry - 1969) / 4).
/// > 5. Let numYears100 be floor((ry - 1901) / 100).
/// > 6. Let numYears400 be floor((ry - 1601) / 400).
/// > 7. Return 𝔽(365 × numYears1 + numYears4 - numYears100 + numYears400).
pub fn day_from_year(y: i64) -> i128 {
    let ry = i128::from(y);
    let num_years1 = ry - 1970;
    let num_years4 = (ry - 1969).div_euclid(4);
    let num_years100 = (ry - 1901).div_euclid(100);
    let num_years400 = (ry - 1601).div_euclid(400);
    365 * num_years1 + num_years4 - num_years100 + num_years400
}

/// The day number (days since the epoch, §21.4.1 Day) of the date `y`,
/// month `m` (1 to 12), day `d`, or `None` when the month or day does not
/// exist. ECMA-262 §21.4.1 MonthFromTime and DateFromTime define the month
/// and date of a time value from its DayWithinYear with `inLeapYear` from
/// InLeapYear:
///
/// > MonthFromTime: … 0 if 0 ≤ dayWithinYear < 31; 1 if 31 ≤ dayWithinYear
/// > < 59 + inLeapYear; 2 if 59 + inLeapYear ≤ dayWithinYear < 90 +
/// > inLeapYear; … 11 if 334 + inLeapYear ≤ dayWithinYear < 365 +
/// > inLeapYear.
/// >
/// > DateFromTime: … dayWithinYear + 1 if month is 0; dayWithinYear - 30
/// > if month is 1; dayWithinYear - 58 - inLeapYear if month is 2; …
///
/// so month `m` starts at the `m`-th of those lower bounds and the date `d`
/// is at DayWithinYear `start + d - 1`, below the next bound; the day
/// number is `DayFromYear(y) + start + d - 1` (§21.4.1 DayWithinYear:
/// `Day(t) - DayFromYear(YearFromTime(t))`).
pub fn day_from_civil(y: i64, m: u32, d: u32) -> Option<i128> {
    let leap = i128::from(days_in_year(y) == 366);
    // The lower bounds of MonthFromTime, without and with inLeapYear.
    const STARTS: [i128; 13] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
    if !(1..=12).contains(&m) || d == 0 {
        return None;
    }
    let bound = |month: usize| STARTS[month] + if month >= 2 { leap } else { 0 };
    let start = bound(m as usize - 1);
    let next = bound(m as usize);
    let within = start + i128::from(d) - 1;
    (within < next).then(|| day_from_year(y) + within)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_from_year_known_answers() {
        // test262 test/built-ins/Date/UTC and the epoch: 1970 is day 0,
        // 2000 is day 10957, 1969 is -365, year 0 is -719528.
        assert_eq!(day_from_year(1970), 0);
        assert_eq!(day_from_year(1971), 365);
        assert_eq!(day_from_year(1969), -365);
        assert_eq!(day_from_year(2000), 10957);
        assert_eq!(day_from_year(2001), 11323);
        assert_eq!(day_from_year(0), -719528);
        assert_eq!(day_from_year(-1), -719528 - 365);
        // The TimeClip edges: ±8.64e15 ms = ±100,000,000 days, which are
        // 275760-09-13 and -271821-04-20.
        assert_eq!(day_from_civil(275760, 9, 13), Some(100_000_000));
        assert_eq!(day_from_civil(-271821, 4, 20), Some(-100_000_000));
        for y in -3000..3000 {
            assert_eq!(day_from_year(y + 1) - day_from_year(y), days_in_year(y));
        }
    }

    #[test]
    fn day_from_civil_known_answers() {
        assert_eq!(day_from_civil(1970, 1, 1), Some(0));
        assert_eq!(day_from_civil(2000, 2, 29), Some(10957 + 59));
        assert_eq!(day_from_civil(2000, 3, 1), Some(10957 + 60));
        assert_eq!(day_from_civil(1900, 2, 29), None);
        assert_eq!(day_from_civil(2100, 3, 1), Some(day_from_year(2100) + 59));
        assert_eq!(day_from_civil(2023, 12, 31), Some(day_from_year(2024) - 1));
        assert_eq!(day_from_civil(2023, 4, 31), None);
        assert_eq!(day_from_civil(2023, 13, 1), None);
        assert_eq!(day_from_civil(2023, 0, 1), None);
        assert_eq!(day_from_civil(2023, 1, 0), None);
        for y in [
            -401, -400, -100, -4, -1, 0, 1, 4, 100, 400, 1600, 1900, 2000,
        ] {
            let mut expected = day_from_year(y);
            for m in 1..=12 {
                for d in 1..=31 {
                    if let Some(day) = day_from_civil(y, m, d) {
                        assert_eq!(day, expected, "{y}-{m}-{d}");
                        expected += 1;
                    }
                }
            }
            assert_eq!(expected, day_from_year(y + 1), "{y}");
        }
    }
}
