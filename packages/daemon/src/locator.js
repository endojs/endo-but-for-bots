// @ts-check

/** @import { FormulaNumber, NodeNumber, FormulaIdentifier } from './types.js' */

import { makeError, q } from '@endo/errors';
import { formatId, isValidNumber, parseId } from './formula-identifier.js';
import { isValidFormulaType } from './formula-type.js';

/**
 * Sentinel node number for locally-stored formula keys.
 * Analogous to 0.0.0.0 in networking — a "this host" placeholder.
 * All-zeros is never a valid Ed25519 public key.
 */
export const LOCAL_NODE = /** @type {NodeNumber} */ ('0'.repeat(64));

/**
 * The endo locator format:
 * ```
 * endo://{nodeNumber}/?id={formulaNumber}&type={formulaType}
 * ```
 * Note that the `id` query param is just the formula number.
 */

/**
 * In addition to all valid formula types, the locator `type` query parameter
 * also supports `remote` for remote values, since their actual formula type
 * cannot be known.
 *
 * @param {string} allegedType
 */
const isValidLocatorType = allegedType =>
  isValidFormulaType(allegedType) || allegedType === 'remote';

/**
 * @param {string} allegedType
 */
const assertValidLocatorType = allegedType => {
  if (!isValidLocatorType(allegedType)) {
    throw makeError(`Unrecognized locator type ${q(allegedType)}`);
  }
};

/**
 * @param {string} allegedLocator
 * @returns {{ formulaType: string, node: NodeNumber, number: FormulaNumber, hints: string[] }}
 */
export const parseLocator = allegedLocator => {
  const errorPrefix = `Invalid locator ${q(allegedLocator)}:`;

  if (!URL.canParse(allegedLocator)) {
    throw makeError(`${errorPrefix} Invalid URL.`);
  }
  const url = new URL(allegedLocator);

  if (!allegedLocator.startsWith('endo://')) {
    throw makeError(`${errorPrefix} Invalid protocol.`);
  }

  const node = url.host;
  if (!isValidNumber(node)) {
    throw makeError(`${errorPrefix} Invalid node identifier.`);
  }

  // Detect format: old format uses ?id= query param,
  // new format puts the formula number in the URL path.
  const hasIdParam = url.searchParams.has('id');
  const pathSegment = url.pathname.replace(/^\//, '');

  /** @type {string | null} */
  let number;
  if (hasIdParam) {
    // Old format: endo://{node}/?id={number}&type={type}
    number = url.searchParams.get('id');
    // Only 'id', 'type', and 'at' (connection hints) are allowed.
    for (const key of url.searchParams.keys()) {
      if (key !== 'id' && key !== 'type' && key !== 'at') {
        throw makeError(`${errorPrefix} Invalid search params.`);
      }
    }
  } else if (pathSegment && isValidNumber(pathSegment)) {
    // New format: endo://{node}/{number}?type={type}
    number = pathSegment;
    // Only 'type' and 'at' are allowed in the new format.
    for (const key of url.searchParams.keys()) {
      if (key !== 'type' && key !== 'at') {
        throw makeError(`${errorPrefix} Invalid search params.`);
      }
    }
  } else {
    throw makeError(`${errorPrefix} Missing formula number.`);
  }

  if (number === null || !isValidNumber(number)) {
    throw makeError(`${errorPrefix} Invalid id.`);
  }

  const formulaType = url.searchParams.get('type');
  if (formulaType === null || !isValidLocatorType(formulaType)) {
    throw makeError(`${errorPrefix} Invalid type.`);
  }

  const nodeNumber = /** @type {NodeNumber} */ (node);
  const formulaNumber = /** @type {FormulaNumber} */ (number);
  const hints = url.searchParams.getAll('at');
  return { formulaType, node: nodeNumber, number: formulaNumber, hints };
};

/** @param {string} allegedLocator */
export const assertValidLocator = allegedLocator => {
  parseLocator(allegedLocator);
};

/**
 * @param {string} id - The full formula identifier.
 * @param {string} formulaType - The type of the formula with the given id.
 */
export const formatLocator = (id, formulaType) => {
  const { number, node } = parseId(id);
  const url = new URL(`endo://${node}`);
  url.pathname = '/';

  // The id query param is just the number
  url.searchParams.set('id', number);

  assertValidLocatorType(formulaType);
  url.searchParams.set('type', formulaType);

  return url.toString();
};

/**
 * Format a locator using the new path-based format.
 * The formula number appears in the URL path instead of the query string.
 *
 * New format: endo://{node}/{number}?type={type}
 *
 * @param {string} id - The full formula identifier.
 * @param {string} formulaType - The type of the formula with the given id.
 */
export const formatLocatorV2 = (id, formulaType) => {
  const { number, node } = parseId(id);
  assertValidLocatorType(formulaType);
  const url = new URL(`endo://${node}/${number}`);
  url.searchParams.set('type', formulaType);
  return url.toString();
};
harden(formatLocatorV2);

/**
 * @param {string} locator
 */
export const idFromLocator = locator => {
  const { number, node } = parseLocator(locator);
  return formatId({ number, node });
};

/**
 * Format a locator with connection hints for sharing with remote peers.
 *
 * @param {string} id - The full formula identifier.
 * @param {string} formulaType - The type of the formula with the given id.
 * @param {string[]} addresses - Network addresses (connection hints).
 */
export const formatLocatorForSharing = (id, formulaType, addresses) => {
  const { number, node } = parseId(id);
  const url = new URL(`endo://${node}`);
  url.pathname = '/';

  url.searchParams.set('id', number);

  assertValidLocatorType(formulaType);
  url.searchParams.set('type', formulaType);

  for (const address of addresses) {
    url.searchParams.append('at', address);
  }

  return url.toString();
};

/**
 * Extract connection hint addresses from a locator, if any.
 *
 * @param {string} locator
 * @returns {string[]}
 */
export const addressesFromLocator = locator => {
  const url = new URL(locator);
  return url.searchParams.getAll('at');
};

/**
 * Convert an internal formula identifier to a locator for agent
 * consumption. Replaces the internal node with the agent's public key.
 *
 * @param {FormulaIdentifier} id - Internal formula identifier.
 * @param {string} formulaType - The type of the formula.
 * @param {NodeNumber} agentNodeNumber - The agent's public key.
 * @param {string[]} [addresses] - Optional network addresses.
 * @returns {string} A locator string.
 */
export const externalizeId = (
  id,
  formulaType,
  agentNodeNumber,
  addresses = [],
) => {
  if (addresses.length > 0) {
    return formatLocatorForSharing(id, formulaType, addresses);
  }
  return formatLocator(id, formulaType);
};

/**
 * Convert a locator back to an internal formula identifier.
 * The node is preserved as-is since formula identifiers carry
 * actual node numbers (no sentinel normalization needed).
 *
 * @param {string} locator - A locator string.
 * @returns {{ id: FormulaIdentifier, formulaType: string, addresses: string[] }}
 */
export const internalizeLocator = locator => {
  const { number, node, formulaType, hints } = parseLocator(locator);
  const id = formatId({ number, node });
  return { id, formulaType, addresses: hints };
};
