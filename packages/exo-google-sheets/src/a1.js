// @ts-check

/**
 * A1 notation, treated as *powerless data*.
 *
 * Nothing in this module holds or can reach spreadsheet authority: it parses
 * range strings into records and compares those records.  A range string is a
 * *designation*, not a capability — mistaking one for the other is the classic
 * `cwd / userPath` confusion — so the parsing lives apart from the modules that
 * hold the Sheets client, and confinement is decided by `powers.js` using these
 * results.
 */

import harden from '@endo/harden';

/**
 * @typedef {object} Scope
 * @property {string} [sheet] Tab a power is confined to, if any.
 * @property {string} [range] A1 rectangle a power is confined to, if any.
 */

/**
 * @typedef {object} A1Rectangle
 * @property {string | undefined} sheet Tab name, when the notation named one.
 * @property {number} left Leftmost column, 1-based.
 * @property {number} top Topmost row, 1-based.
 * @property {number} right Rightmost column, 1-based, inclusive.
 * @property {number} bottom Bottommost row, 1-based, inclusive.
 */

/** @param {string} letters */
const columnNumber = letters =>
  [...letters.toUpperCase()].reduce(
    (number, letter) => number * 26 + letter.charCodeAt(0) - 64,
    0,
  );

/**
 * Parse an A1 selector such as `Tasks!B2:D10` into a rectangle.
 *
 * @param {string} value
 * @returns {A1Rectangle | undefined} Undefined when the cells part is not a
 *   plain rectangle this module can compare — an unbounded range, a named
 *   range, or nonsense.
 */
export const parseA1 = value => {
  const bang = value.lastIndexOf('!');
  const sheetPart = bang < 0 ? undefined : value.slice(0, bang);
  const cells = bang < 0 ? value : value.slice(bang + 1);
  const match = /^([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?$/i.exec(cells);
  if (!match) return undefined;
  const [, startColumn, startRow, endColumn, endRow] = match;
  return harden({
    sheet:
      sheetPart && sheetPart.startsWith("'") && sheetPart.endsWith("'")
        ? sheetPart.slice(1, -1).replace(/''/g, "'")
        : sheetPart,
    left: columnNumber(startColumn),
    top: Number(startRow),
    right: columnNumber(endColumn || startColumn),
    bottom: Number(endRow || startRow),
  });
};
harden(parseA1);

/**
 * True when `outer` covers every cell of `inner`.  Sheet names are not
 * compared; callers decide whether the tabs must match.
 *
 * @param {A1Rectangle} outer
 * @param {A1Rectangle} inner
 */
export const contains = (outer, inner) =>
  outer.left <= inner.left &&
  outer.top <= inner.top &&
  outer.right >= inner.right &&
  outer.bottom >= inner.bottom;
harden(contains);

/**
 * Quote a tab name for use before the `!` of an A1 selector.
 *
 * @param {string} sheet
 */
export const sheetPrefix = sheet =>
  /[ !']/.test(sheet) ? `'${sheet.replace(/'/g, "''")}'` : sheet;
harden(sheetPrefix);

/**
 * Read one part designation as the scope narrowing it names.  This is the
 * mereological verb's parser: a tab is a part of the spreadsheet, a rectangle
 * is a part of a tab, and `'Tasks!A1:C10'` names both in one step.  Which axis
 * a designation narrows is decided by whether it parses as A1 — so the parse,
 * not a second method name, carries the distinction.
 *
 * It lives here, with the rest of the powerless parsing, because reading a
 * string into a `Scope` grants nothing: the result is a designation awaiting a
 * power to be applied to, and it is `powers.js` that decides what a scope
 * confines.
 *
 * The one designation this cannot read is a tab whose *title* is A1-shaped (a
 * tab literally named `A1`); `sheet(title)` remains for that case, and no
 * corresponding hazard runs the other way, since a string that parses as A1
 * always denotes cells.
 *
 * @param {string} designation
 * @returns {Scope}
 */
export const partScope = designation => {
  if (typeof designation !== 'string' || designation.length === 0)
    throw new TypeError('part must be a non-empty tab name or A1 range');
  const parsed = parseA1(designation);
  if (!parsed) return harden({ sheet: designation });
  return parsed.sheet
    ? harden({ sheet: parsed.sheet, range: designation })
    : harden({ range: designation });
};
harden(partScope);
