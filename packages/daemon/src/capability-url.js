// @ts-check

// Capability URLs (designs/capability-url-locators.md).
//
// A locator is any capability URL: an `endo://` URL under the grammar in
// `./locator.js`, or an `https://` URL whose fragment carries every locator
// field as `application/x-www-form-urlencoded`-shaped pairs under the
// version key `v` (currently `1`) — the same version key minion.town's
// invitation envelope established. Everything outside the fragment of an
// https capability URL (origin, path, query) is semantically inert: it
// names no capability and carries no authority.
//
// Recognition is fail-open for URLs that make no capability claim and
// fail-closed for URLs that do: `parseCapabilityUrl` answers `undefined`
// for an https URL whose fragment is absent, does not carry a recognized
// `v`, or carries no capability key family, and throws for a fragment that
// claims a family (recognized `v` plus capability keys) but is malformed —
// duplicate keys, both families at once, bad hex, an unknown key.

import { makeError, q } from '@endo/errors';
import { isValidNumber } from './formula-identifier.js';
import { isValidFormulaType } from './formula-type.js';
import { parseLocator } from './locator.js';

/**
 * @typedef {object} CapabilityLocator
 * @property {string} node - 64-hex agent/node key.
 * @property {string} number - 64-hex formula number.
 * @property {string} formulaType - A formula type, or `remote`.
 * @property {string[]} hints - Transport URLs, in preference order.
 * @property {string} [from] - Invitation locators: the sender handle number.
 * @property {string} [fromNode] - Invitation locators: the sender node.
 * @property {string} [view] - Presentation metadata only; carries no
 *   authority.
 */

/** The recognized fragment versions. Currently exactly `1`. */
const RECOGNIZED_VERSIONS = new Set(['1']);

/**
 * The locator-family fragment keys, beyond `v`. `hint` may repeat; the
 * others may not.
 */
const LOCATOR_KEYS = new Set([
  'node',
  'formula',
  'type',
  'hint',
  'from',
  'fromNode',
  'view',
]);

/**
 * The envelope-family fragment keys (minion.town's invitation envelope):
 * origin-relative bearer credentials, valid capability URLs but not
 * self-contained locators.
 */
const ENVELOPE_KEYS = new Set(['invitation', 'guest', 'label']);

/**
 * @param {string} allegedType
 */
const isValidLocatorType = allegedType =>
  isValidFormulaType(allegedType) || allegedType === 'remote';

/**
 * Split a raw fragment into `[rawKey, rawValue]` pairs without decoding.
 * A pair with no `=` yields an empty value, as `URLSearchParams` would.
 *
 * @param {string} rawFragment
 * @returns {Array<[string, string]>}
 */
const rawPairs = rawFragment =>
  rawFragment.split('&').map(pair => {
    const index = pair.indexOf('=');
    if (index === -1) {
      return [pair, ''];
    }
    return [pair.slice(0, index), pair.slice(index + 1)];
  });

/**
 * Parse an https capability URL's fragment into a locator, `undefined` when
 * the fragment makes no capability claim, throwing when it makes one badly.
 *
 * Only `%XX` escapes are decoded; `+` is a literal plus, never a space
 * (values are produced with `encodeURIComponent`, which escapes `+`).
 *
 * @param {string} allegedUrl - The whole https URL (for error redaction:
 *   errors never echo it; they use a generic prefix).
 * @param {string} rawFragment - The fragment, `#` already stripped.
 * @returns {CapabilityLocator | undefined}
 */
const parseCapabilityFragment = (allegedUrl, rawFragment) => {
  if (rawFragment === '') {
    return undefined;
  }
  const pairs = rawPairs(rawFragment);

  // Recognition: a raw `v` pair with a recognized value. The version value
  // never needs percent-encoding, so raw comparison is exact.
  const versionValues = pairs
    .filter(([key]) => key === 'v')
    .map(([, value]) => value);
  if (versionValues.length === 0) {
    return undefined;
  }
  if (!versionValues.some(value => RECOGNIZED_VERSIONS.has(value))) {
    // An unrecognized version is not ours to interpret: not a locator.
    return undefined;
  }

  // A capability claim is being made. From here, malformations throw, and
  // the error text never includes the URL or fragment (a locator fragment
  // is a bearer).
  const errorPrefix = `Invalid capability URL fragment:`;
  if (versionValues.length > 1) {
    throw makeError(`${errorPrefix} duplicate v.`);
  }

  /** @type {Map<string, string[]>} */
  const decoded = new Map();
  for (const [rawKey, rawValue] of pairs) {
    let key;
    let value;
    try {
      key = decodeURIComponent(rawKey);
      value = decodeURIComponent(rawValue);
    } catch {
      throw makeError(`${errorPrefix} malformed percent-encoding.`);
    }
    const values = decoded.get(key);
    if (values === undefined) {
      decoded.set(key, [value]);
    } else {
      values.push(value);
    }
  }
  decoded.delete('v');

  const keys = [...decoded.keys()];
  const locatorKeys = keys.filter(key => LOCATOR_KEYS.has(key));
  const envelopeKeys = keys.filter(key => ENVELOPE_KEYS.has(key));
  const unknownKeys = keys.filter(
    key => !LOCATOR_KEYS.has(key) && !ENVELOPE_KEYS.has(key),
  );

  if (locatorKeys.length === 0 && envelopeKeys.length === 0) {
    // A recognized version with no capability keys: stray fields, no claim.
    return undefined;
  }
  if (unknownKeys.length > 0) {
    throw makeError(`${errorPrefix} unrecognized key ${q(unknownKeys[0])}.`);
  }
  if (locatorKeys.length > 0 && envelopeKeys.length > 0) {
    throw makeError(`${errorPrefix} mixed locator and envelope families.`);
  }
  if (envelopeKeys.length > 0) {
    // The envelope family (`invitation` / `guest`) is an origin-relative
    // credential, redeemed against the daemon behind the serving origin.
    // It is a capability URL but not a self-contained locator, so it
    // cannot be adopted here.
    throw makeError(
      `${errorPrefix} an origin-relative invitation envelope, not a self-contained locator.`,
    );
  }

  /** @param {string} key */
  const exactlyOnce = key => {
    const values = decoded.get(key);
    if (values === undefined) {
      throw makeError(`${errorPrefix} missing ${q(key)}.`);
    }
    if (values.length > 1) {
      throw makeError(`${errorPrefix} duplicate ${q(key)}.`);
    }
    return values[0];
  };
  /** @param {string} key */
  const atMostOnce = key => {
    const values = decoded.get(key);
    if (values === undefined) {
      return undefined;
    }
    if (values.length > 1) {
      throw makeError(`${errorPrefix} duplicate ${q(key)}.`);
    }
    return values[0];
  };

  const node = exactlyOnce('node');
  if (!isValidNumber(node)) {
    throw makeError(`${errorPrefix} invalid node.`);
  }
  const number = exactlyOnce('formula');
  if (!isValidNumber(number)) {
    throw makeError(`${errorPrefix} invalid formula.`);
  }
  const formulaType = exactlyOnce('type');
  if (!isValidLocatorType(formulaType)) {
    throw makeError(`${errorPrefix} invalid type.`);
  }
  const hints = decoded.get('hint') ?? [];
  const from = atMostOnce('from');
  if (from !== undefined && !isValidNumber(from)) {
    throw makeError(`${errorPrefix} invalid from.`);
  }
  const fromNode = atMostOnce('fromNode');
  if (fromNode !== undefined && !isValidNumber(fromNode)) {
    throw makeError(`${errorPrefix} invalid fromNode.`);
  }
  const view = atMostOnce('view');

  return { node, number, formulaType, hints, from, fromNode, view };
};

/**
 * Recognize and parse any capability URL.
 *
 * - An `endo://` URL parses under the locator grammar (throws if malformed).
 * - An `https://` URL whose fragment carries a recognized `v` and the
 *   locator key family parses to the same record (throws if the claimed
 *   family is malformed, including the origin-relative envelope family).
 * - Anything else — a non-string, a non-URL, any other scheme, an https URL
 *   with no fragment, an unrelated fragment, or an unrecognized `v` — is
 *   not a locator: `undefined`, never an error.
 *
 * @param {unknown} allegedUrl
 * @returns {CapabilityLocator | undefined}
 */
export const parseCapabilityUrl = allegedUrl => {
  if (typeof allegedUrl !== 'string' || !URL.canParse(allegedUrl)) {
    return undefined;
  }
  if (allegedUrl.startsWith('endo://')) {
    const { formulaType, node, number, hints, from, fromNode, view } =
      parseLocator(allegedUrl);
    return { node, number, formulaType, hints, from, fromNode, view };
  }
  const url = new URL(allegedUrl);
  if (url.protocol !== 'https:') {
    return undefined;
  }
  const rawFragment = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;
  return parseCapabilityFragment(allegedUrl, rawFragment);
};

/**
 * True iff the string is a capability URL this module fully accepts.
 * Never throws: a malformed capability claim answers `false`.
 *
 * @param {unknown} allegedUrl
 * @returns {boolean}
 */
export const isCapabilityUrl = allegedUrl => {
  try {
    return parseCapabilityUrl(allegedUrl) !== undefined;
  } catch {
    return false;
  }
};

/** @param {CapabilityLocator} locator */
const assertLocatorFields = locator => {
  const { node, number, formulaType, hints } = locator;
  if (!isValidNumber(node)) {
    throw makeError(`Invalid locator node.`);
  }
  if (!isValidNumber(number)) {
    throw makeError(`Invalid locator formula number.`);
  }
  if (!isValidLocatorType(formulaType)) {
    throw makeError(`Invalid locator type ${q(formulaType)}.`);
  }
  if (!Array.isArray(hints) || hints.some(hint => typeof hint !== 'string')) {
    throw makeError(`Invalid locator hints.`);
  }
};

/**
 * Canonical `endo://` serialization:
 * `endo://<node>/<formula>[@<hint>]*?type=<type>[&from=…][&fromNode=…][&view=…]`
 * with path components `encodeURIComponent`-encoded, matching
 * `formatLocatorWithHints`.
 *
 * @param {CapabilityLocator} locator
 * @returns {string}
 */
export const formatEndoLocator = locator => {
  assertLocatorFields(locator);
  const { node, number, formulaType, hints, from, fromNode, view } = locator;
  const path = [number, ...hints].map(encodeURIComponent).join('@');
  const query = [['type', formulaType]];
  if (from !== undefined) {
    query.push(['from', from]);
  }
  if (fromNode !== undefined) {
    query.push(['fromNode', fromNode]);
  }
  if (view !== undefined) {
    query.push(['view', view]);
  }
  const search = query
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  return `endo://${node}/${path}?${search}`;
};

/**
 * The canonical capability fragment (without `#`): keys in the fixed order
 * `v`, `node`, `formula`, `type`, `hint`*, `from`, `fromNode`, `view`;
 * values `encodeURIComponent`-encoded. Equal locators have exactly one
 * serialization.
 *
 * @param {CapabilityLocator} locator
 * @returns {string}
 */
export const formatCapabilityFragment = locator => {
  assertLocatorFields(locator);
  const { node, number, formulaType, hints, from, fromNode, view } = locator;
  const pairs = [
    ['v', '1'],
    ['node', node],
    ['formula', number],
    ['type', formulaType],
    ...hints.map(hint => ['hint', hint]),
  ];
  if (from !== undefined) {
    pairs.push(['from', from]);
  }
  if (fromNode !== undefined) {
    pairs.push(['fromNode', fromNode]);
  }
  if (view !== undefined) {
    pairs.push(['view', view]);
  }
  return pairs
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
};

/**
 * The canonical https form: `${base}#${fragment}`. The base must be an
 * https URL with no fragment of its own; it is otherwise passed through
 * verbatim and is not part of the locator's identity.
 *
 * @param {CapabilityLocator} locator
 * @param {{ base: string }} options
 * @returns {string}
 */
export const formatCapabilityUrl = (locator, { base }) => {
  if (
    typeof base !== 'string' ||
    !URL.canParse(base) ||
    new URL(base).protocol !== 'https:' ||
    base.includes('#')
  ) {
    throw makeError(
      `Capability URL base must be an https URL with no fragment.`,
    );
  }
  return `${base}#${formatCapabilityFragment(locator)}`;
};

/**
 * Normalize any capability URL to its canonical `endo://` form, throwing
 * (without echoing the input, which may be a bearer) when the input is not
 * a locator. The boundary normalizer for daemon methods that accept foreign
 * locator input.
 *
 * @param {unknown} allegedUrl
 * @returns {string}
 */
export const canonicalEndoLocator = allegedUrl => {
  const locator = parseCapabilityUrl(allegedUrl);
  if (locator === undefined) {
    throw makeError(
      `Not a locator: expected an endo:// URL or an https capability URL with a recognized v fragment.`,
    );
  }
  return formatEndoLocator(locator);
};
