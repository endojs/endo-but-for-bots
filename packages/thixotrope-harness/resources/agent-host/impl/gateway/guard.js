// @ts-check
/**
 * The bridge's pre-dispatch check of one browser call (M3 W3.2;
 * designs/m3-interfaces.md 4.4, D-M3-2). It reads the call in its encoded
 * form (captp's `capdata` body: JSON with `@qclass` encodings, plus
 * `slots`), before CapTP decodes it, because an exo guard runs only after
 * a vat has decoded, hardened and interned the message (architecture 3,
 * fact 4). Rules, in order:
 *
 * 1. target: an answer or export the gateway holds (else `notSignedIn`);
 * 2. page objects: no slot the browser exported (`o+n`, `p+n`, `t+n`; else
 *    `browserObject`), and no slot the gateway does not hold (`notSignedIn`);
 * 3. frame: the body's UTF-8 bytes at most `frameBytes`, unless the target
 *    and method are a `LargeCall` (`messageTooLarge`);
 * 4. keys: every key of every plain record in the arguments, to nesting
 *    depth `argumentDepth`, is in the vocabulary (`unexpectedField`,
 *    `tooDeep`);
 * 4a. names (M3-FIX): a call to a target that is not gateway-local (a vat
 *    presence, or an answer a page pipelines on) names a method, or gets a
 *    property, from `methods` (the method names of every contract interface
 *    guard; `unknownMethod`); a passable symbol, as an argument or as the
 *    method of any target, also names one of `methods`. A vat decodes
 *    every selector and symbol as a registered symbol, so without this a
 *    page could make a vat register any number of fresh names;
 * 5. calls in flight: at most `callsInFlight` answered calls whose target is
 *    not gateway-local (`tooManyCalls`).
 *
 * A message that is not a well-formed CapTP call (no string body, a body
 * that is not JSON or not `[method]` / `[method, args]`, a slot that is not
 * a string) is rule `protocol`: the bridge closes the connection, as captp
 * itself would abort it.
 *
 * Nesting depth: each argument is at depth 1; an array, a record or a
 * tagged value one level deeper than its container; a scalar has none. A
 * container deeper than `argumentDepth` is refused.
 *
 * Node module (agent-host adapter).
 */
import { Buffer } from 'node:buffer';

import { gatewayLimits, gatewayTexts } from './contract-m3.js';

/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { limits as guestLimits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/**
 * @typedef {{ value: unknown, local: boolean }} GatewayTarget a value the
 *   gateway holds for a browser id: an export of this connection, or an
 *   answer (`value` undefined while a forwarded call has not settled);
 *   `local` when it is a gateway-local object (not a vat presence)
 */

/**
 * @typedef {object} GuardLimits
 * @property {number} frameBytes
 * @property {number} argumentDepth
 * @property {number} callsInFlight
 */

/** The bridge's default limits (contract-m3.js, limits.js). */
export const defaultGuardLimits = harden({
  frameBytes: guestLimits.frameBytes,
  argumentDepth: gatewayLimits.argumentDepth,
  callsInFlight: gatewayLimits.callsInFlight,
});

/**
 * @typedef {'target' | 'browserObject' | 'frame' | 'keys' | 'depth' |
 *   'method' | 'inFlight' | 'protocol'} GuardRule
 */

/**
 * @typedef {object} Refusal
 * @property {GuardRule} rule
 * @property {string} text the CTP_RETURN exception's message
 */

const QCLASS = '@qclass';

/** `@qclass` encodings that carry no record keys of their own. */
const leafClasses = new Set([
  'slot',
  'undefined',
  'NaN',
  'Infinity',
  '-Infinity',
  'bigint',
]);

/** Fixed fields of an error encoding (marshal's capdata). */
const errorFields = new Set([QCLASS, 'name', 'message', 'errorId']);

/**
 * @param {GuardRule} rule
 * @param {string} text
 * @returns {Refusal}
 */
const refuse = (rule, text) => harden({ rule, text });

/**
 * Walk the decoded JSON of a call's arguments (rules 4 and 4a).
 * @param {unknown[]} args
 * @param {Set<string>} vocabulary
 * @param {Set<string>} methods
 * @param {number} maxDepth
 * @returns {Refusal | undefined}
 */
const checkKeys = (args, vocabulary, methods, maxDepth) => {
  /** @type {[unknown, number][]} */
  const stack = args.map(arg => [arg, 1]);
  /**
   * Check a record's keys (except `skip`) and queue its values.
   * @param {Record<string, unknown>} record
   * @param {number} depth
   * @param {Set<string>} [skip]
   * @returns {boolean} false when a key is outside the vocabulary
   */
  const pushRecord = (record, depth, skip) => {
    for (const [key, inner] of Object.entries(record)) {
      if (skip === undefined || !skip.has(key)) {
        if (!vocabulary.has(key)) return false;
        stack.push([inner, depth + 1]);
      }
    }
    return true;
  };
  while (stack.length > 0) {
    const [value, depth] = /** @type {[unknown, number]} */ (stack.pop());
    if (value !== null && typeof value === 'object') {
      if (depth > maxDepth) return refuse('depth', gatewayTexts.tooDeep);
      const record = /** @type {Record<string, unknown>} */ (value);
      const qclass = Object.hasOwn(record, QCLASS) ? record[QCLASS] : undefined;
      if (Array.isArray(value)) {
        for (const inner of value) stack.push([inner, depth + 1]);
      } else if (qclass === undefined) {
        if (!pushRecord(record, depth)) {
          return refuse('keys', gatewayTexts.unexpectedField);
        }
      } else if (qclass === 'tagged') {
        stack.push([record.payload, depth + 1]);
      } else if (qclass === 'symbol') {
        if (typeof record.name !== 'string' || !methods.has(record.name)) {
          return refuse('method', gatewayTexts.unknownMethod);
        }
      } else if (qclass === 'error') {
        if (!pushRecord(record, depth, errorFields)) {
          return refuse('keys', gatewayTexts.unexpectedField);
        }
      } else if (typeof qclass !== 'string' || !leafClasses.has(qclass)) {
        // `hilbert` (a record with its own `@qclass` key) and anything
        // unknown: `@qclass` is never a vocabulary key.
        return refuse('keys', gatewayTexts.unexpectedField);
      }
    }
  }
  return undefined;
};

/**
 * Rule 4a for the method position: a string name toward a target that is
 * not gateway-local must be in `methods`; an encoded symbol (any target)
 * must name one of `methods`; anything else toward a vat (`null`, a
 * function application) is refused. Toward a gateway-local object a
 * string name is that object's own guard's business (no vat sees it).
 * @param {unknown} name
 * @param {boolean} local
 * @param {Set<string>} methods
 * @returns {Refusal | undefined}
 */
const checkName = (name, local, methods) => {
  if (typeof name === 'string') {
    return local || methods.has(name)
      ? undefined
      : refuse('method', gatewayTexts.unknownMethod);
  }
  if (name !== null && typeof name === 'object') {
    const encoded = /** @type {Record<string, unknown>} */ (name);
    if (
      encoded[QCLASS] === 'symbol' &&
      typeof encoded.name === 'string' &&
      methods.has(encoded.name)
    ) {
      return undefined;
    }
    return refuse('method', gatewayTexts.unknownMethod);
  }
  return local ? undefined : refuse('method', gatewayTexts.unknownMethod);
};

/**
 * @param {unknown} decoded
 * @returns {decoded is [unknown] | [unknown, unknown[]]}
 */
const isMethodShape = decoded =>
  Array.isArray(decoded) &&
  (decoded.length === 1 || (decoded.length === 2 && Array.isArray(decoded[1])));

/**
 * Check one `CTP_CALL` (m3-interfaces.md 4.4); the full answer.
 * @param {object} options
 * @param {any} options.message the parsed CTP_CALL
 * @param {(id: string) => GatewayTarget | undefined} options.targetOf the
 *   gateway's value for a browser target or slot id (`o-n`, `p-n`, `q-n`)
 * @param {Set<string>} options.vocabulary
 * @param {Set<string>} options.methods method names a page may name toward
 *   a vat (`vocabulary.js` `harnessNames`)
 * @param {(target: unknown, method: string) => boolean} options.isLargeCall
 * @param {number} options.inFlight answered calls to vat targets waiting
 * @param {GuardLimits} [options.limits]
 * @returns {Refusal | undefined}
 */
export const inspectCall = ({
  message,
  targetOf,
  vocabulary,
  methods,
  isLargeCall,
  inFlight,
  limits = defaultGuardLimits,
}) => {
  const { target, method } = message ?? {};
  if (
    typeof target !== 'string' ||
    method === null ||
    typeof method !== 'object' ||
    typeof method.body !== 'string' ||
    !Array.isArray(method.slots) ||
    !method.slots.every(
      /** @param {unknown} slot */ slot => typeof slot === 'string',
    )
  ) {
    return refuse('protocol', gatewayTexts.notSignedIn);
  }
  if (message.trap !== undefined) {
    return refuse('target', gatewayTexts.notSignedIn);
  }

  // 1. Target.
  const held = target[1] === '-' ? targetOf(target) : undefined;
  if (held === undefined) return refuse('target', gatewayTexts.notSignedIn);

  // 2. Page objects; slots the gateway does not hold.
  for (const slot of /** @type {string[]} */ (method.slots)) {
    if (slot[1] === '+') {
      return refuse('browserObject', gatewayTexts.browserObject);
    }
    if (
      slot[1] !== '-' ||
      (slot[0] !== 'o' && slot[0] !== 'p') ||
      targetOf(slot) === undefined
    ) {
      return refuse('target', gatewayTexts.notSignedIn);
    }
  }

  /** @type {unknown} */
  let decoded;
  try {
    decoded = JSON.parse(method.body);
  } catch {
    return refuse('protocol', gatewayTexts.notSignedIn);
  }
  if (!isMethodShape(decoded)) {
    return refuse('protocol', gatewayTexts.notSignedIn);
  }
  const [name, args = []] = decoded;

  // 3. Frame.
  if (Buffer.byteLength(method.body, 'utf8') > limits.frameBytes) {
    const large =
      typeof name === 'string' &&
      held.value !== undefined &&
      isLargeCall(held.value, name);
    if (!large) return refuse('frame', gatewayTexts.messageTooLarge);
  }

  // 4a. The method (or property) name.
  const methodRefusal = checkName(name, held.local, methods);
  if (methodRefusal !== undefined) return methodRefusal;

  // 4. Keys and depth (4a for symbols in the arguments).
  const keyRefusal = checkKeys(args, vocabulary, methods, limits.argumentDepth);
  if (keyRefusal !== undefined) return keyRefusal;

  // 5. Calls in flight (vat targets only).
  if (!held.local && inFlight >= limits.callsInFlight) {
    return refuse('inFlight', gatewayTexts.tooManyCalls);
  }
  return undefined;
};
harden(inspectCall);

/**
 * Check one `CTP_CALL` (m3-interfaces.md 4.4, section 17 signature).
 * @param {Parameters<typeof inspectCall>[0]} options
 * @returns {string | undefined} the refusal text, or undefined to dispatch
 */
export const checkCall = options => inspectCall(options)?.text;
harden(checkCall);
