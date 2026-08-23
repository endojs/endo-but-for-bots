// @ts-check

import '@endo/init/debug.js';

import test from 'ava';
import {
  dateFormatter,
  timeFormatter,
  relativeTime,
  numberFormatter,
} from '@endo/spaces-util/time-formatters.js';

test('dateFormatter is an Intl.DateTimeFormat', t => {
  t.true(dateFormatter instanceof Intl.DateTimeFormat);
});

test('dateFormatter formats dates', t => {
  const date = new Date('2024-01-15T10:30:00Z');
  const formatted = dateFormatter.format(date);
  t.is(typeof formatted, 'string');
  t.true(formatted.length > 0);
  // Should contain year
  t.true(formatted.includes('2024'));
});

test('timeFormatter is an Intl.DateTimeFormat', t => {
  t.true(timeFormatter instanceof Intl.DateTimeFormat);
});

test('timeFormatter formats times', t => {
  const date = new Date('2024-01-15T10:30:00');
  const formatted = timeFormatter.format(date);
  t.is(typeof formatted, 'string');
  t.true(formatted.length > 0);
});

test('relativeTime returns "just now" for recent times', t => {
  const now = new Date();
  const result = relativeTime(now);
  t.is(result, 'just now');
});

test('relativeTime returns "just now" for times within 60 seconds', t => {
  const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
  t.is(relativeTime(thirtySecondsAgo), 'just now');

  const fiftyNineSecondsAgo = new Date(Date.now() - 59 * 1000);
  t.is(relativeTime(fiftyNineSecondsAgo), 'just now');
});

test('relativeTime returns spelled-out minutes for times within an hour', t => {
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);
  t.is(relativeTime(fiveMinutesAgo), '5 minutes ago');

  const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
  t.is(relativeTime(thirtyMinutesAgo), '30 minutes ago');

  const fiftyNineMinutesAgo = new Date(Date.now() - 59 * 60 * 1000);
  t.is(relativeTime(fiftyNineMinutesAgo), '59 minutes ago');
});

test('relativeTime returns spelled-out hours for times within a day', t => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  t.is(relativeTime(oneHourAgo), '1 hour ago');

  const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
  t.is(relativeTime(fiveHoursAgo), '5 hours ago');

  const twentyThreeHoursAgo = new Date(Date.now() - 23 * 60 * 60 * 1000);
  t.is(relativeTime(twentyThreeHoursAgo), '23 hours ago');
});

test('relativeTime returns spelled-out days for times within a week', t => {
  // numeric: 'auto' idiomizes the ±1 case to "yesterday".
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  t.is(relativeTime(oneDayAgo), 'yesterday');

  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  t.is(relativeTime(threeDaysAgo), '3 days ago');

  const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000);
  t.is(relativeTime(sixDaysAgo), '6 days ago');
});

test('relativeTime keeps counting past a week (weeks, months, years)', t => {
  // The old hand-rolled version returned '' beyond a week; Intl carries on.
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  t.is(relativeTime(oneWeekAgo), 'last week');

  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  t.is(relativeTime(twoWeeksAgo), '2 weeks ago');

  const twoMonthsAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  t.is(relativeTime(twoMonthsAgo), '2 months ago');

  const twoYearsAgo = new Date(Date.now() - 2 * 365 * 24 * 60 * 60 * 1000);
  t.is(relativeTime(twoYearsAgo), '2 years ago');
});

test('numberFormatter is an Intl.NumberFormat', t => {
  t.true(numberFormatter instanceof Intl.NumberFormat);
});

test('numberFormatter formats numbers', t => {
  const formatted = numberFormatter.format(1_234_567);
  t.is(typeof formatted, 'string');
  t.true(formatted.length > 0);
  // Should contain locale-specific separators
  t.true(formatted.includes('1') && formatted.includes('234'));
});

test('numberFormatter handles decimals', t => {
  const formatted = numberFormatter.format(1234.56);
  t.is(typeof formatted, 'string');
  t.true(formatted.length > 0);
});

test('numberFormatter handles negative numbers', t => {
  const formatted = numberFormatter.format(-1234);
  t.is(typeof formatted, 'string');
  // Should contain the digits and a minus sign (locale may vary separators)
  t.true(formatted.includes('1'));
  t.regex(formatted, /-/);
});

test('numberFormatter handles zero', t => {
  const formatted = numberFormatter.format(0);
  t.is(formatted, '0');
});
