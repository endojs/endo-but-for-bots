// @ts-check

export const dateFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: 'full',
  timeStyle: 'long',
});

export const timeFormatter = new Intl.DateTimeFormat(undefined, {
  timeStyle: 'short',
});

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, {
  numeric: 'auto',
  style: 'long',
});

/**
 * Units paired with their length in seconds, largest first. The first unit the
 * elapsed time reaches determines the granularity of the phrase.
 *
 * @type {Array<[Intl.RelativeTimeFormatUnit, number]>}
 */
const relativeTimeDivisions = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
];

/**
 * Human-readable relative time such as "5 minutes ago", "yesterday", or
 * "in 2 hours". Uses `Intl.RelativeTimeFormat` so the wording is localized and
 * reads naturally, and covers the full range from minutes to years (the old
 * hand-rolled version went blank beyond a week). Anything under a minute reads
 * as "just now".
 *
 * @param {Date} date
 * @returns {string}
 */
export const relativeTime = date => {
  // Positive when the date is in the past, matching "N units ago"; a negative
  // value yields the future phrasing ("in N units").
  const diffSec = Math.round((Date.now() - date.getTime()) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 60) return 'just now';
  for (const [unit, secondsInUnit] of relativeTimeDivisions) {
    if (absSec >= secondsInUnit) {
      // Intl phrases past events with a negative value, so negate diffSec.
      const value = Math.round(-diffSec / secondsInUnit);
      return relativeTimeFormatter.format(value, unit);
    }
  }
  return 'just now';
};

export const numberFormatter = new Intl.NumberFormat();
