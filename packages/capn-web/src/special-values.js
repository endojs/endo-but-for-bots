// Special-value codecs for the Cap'n Web wire format.
//
// Atomic values that cannot be represented directly in JSON are wrapped in a
// type-tagged array, e.g. ["bigint", "1234"], ["date", 1700000000000].
// See https://github.com/cloudflare/capnweb/blob/main/protocol.md

import harden from '@endo/harden';
import { decodeBase64NoPadding } from '@endo/base64/no-padding-decode';
import { encodeBase64NoPadding } from '@endo/base64/no-padding-encode';

const { isNaN } = Number;

// AggregateError is ES2021 and may be missing in some constrained
// runtimes; guard so module evaluation doesn't fail.
//
// Null prototype so a hostile wire `typeName` can't reach `Object.prototype`
// members: `["error", "constructor", …]` must fall through to `Error`, not
// resolve to `Object`.  Matches cloudflare/capnweb 0.10.0's hardening.
const ERROR_TYPES = harden(
  Object.assign(Object.create(null), {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,

    ...(typeof AggregateError !== 'undefined' ? { AggregateError } : {}),
  }),
);

const hasAggregateError = typeof AggregateError !== 'undefined';

/**
 * Encode a Uint8Array to base64.  Delegates to `@endo/base64`, which is
 * runtime-agnostic (no dependence on Node's `Buffer` or the browser `btoa`).
 *
 * @param {Uint8Array} bytes
 */
export const bytesToBase64 = bytes => encodeBase64NoPadding(bytes);

/**
 * Decode a base64 string (with or without padding) into a Uint8Array.
 * Delegates to `@endo/base64` for runtime-agnostic decoding.
 *
 * @param {string} base64
 */
export const base64ToBytes = base64 => decodeBase64NoPadding(base64);

/**
 * Encode an `Error` to capnweb's `["error", name, message, stack?, props?]`
 * form.  When a `recurse` devaluator is supplied, own-enumerable properties
 * (other than name/message/stack), `cause`, and — for an `AggregateError` —
 * the `errors` array are captured into a `props` bag, each recursively
 * devaluated.  Without `recurse` (e.g. a standalone caller), the legacy
 * three-element form is emitted.  Matches cloudflare/capnweb 0.10.0.
 *
 * @param {Error} err
 * @param {((v: unknown) => unknown) | undefined} recurse
 * @returns {unknown[]}
 */
const encodeError = (err, recurse) => {
  const name = typeof err.name === 'string' ? err.name : 'Error';
  /** @type {unknown[]} */
  const result = ['error', name, err.message];
  if (!recurse) return result;
  /** @type {Record<string, unknown> | undefined} */
  let props;
  const captureProp = (key, value) => {
    let encoded;
    try {
      encoded = recurse(value);
    } catch (_e) {
      // capnweb drops a prop it can't serialize rather than failing the
      // whole error; match that so one bad prop doesn't poison the send.
      return;
    }
    if (!props) props = {};
    props[key] = encoded;
  };
  for (const key of Object.keys(err)) {
    if (key !== 'name' && key !== 'message' && key !== 'stack') {
      captureProp(key, /** @type {any} */ (err)[key]);
    }
  }
  if ('cause' in err) captureProp('cause', /** @type {any} */ (err).cause);
  if (hasAggregateError && err instanceof AggregateError) {
    captureProp('errors', err.errors);
  }
  if (props) {
    // We don't serialize stacks; capnweb normalizes the stack slot to null
    // when props are present so the bag always lands at index 4.
    result.push(null);
    result.push(props);
  }
  return result;
};

/**
 * Try to encode a primitive/atomic value as a Cap'n Web special-value
 * expression.  Returns undefined if the value is not a special.
 *
 * @param {unknown} value
 * @param {((v: unknown) => unknown)} [recurse]  Devaluator for nested values
 *   (error props).  Omitted by standalone callers.
 * @returns {unknown[] | undefined}
 */
export const tryEncodeSpecial = (value, recurse) => {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'number') {
    if (isNaN(value)) return ['nan'];
    if (value === Infinity) return ['inf'];
    if (value === -Infinity) return ['-inf'];
    return undefined;
  }
  if (typeof value === 'bigint') return ['bigint', value.toString()];
  if (value instanceof Date) {
    const time = value.getTime();
    // An Invalid Date has a NaN time; capnweb encodes it as ["date", null].
    return ['date', isNaN(time) ? null : time];
  }
  if (value instanceof Uint8Array) return ['bytes', bytesToBase64(value)];
  if (value instanceof Error) return encodeError(value, recurse);
  return undefined;
};

/**
 * Decode an `["error", name, message, stack?, props?]` tail into an Error.
 * The `name` is looked up in the null-prototype `ERROR_TYPES` table so a
 * hostile wire name can't reach a prototype member; an unknown name falls
 * back to `Error`.  `AggregateError` is constructed with an empty errors
 * list so the message lands in the right constructor slot.  When a `recurse`
 * evaluator is supplied and a `props` bag is present, its entries are
 * evaluated and assigned — except structurally dangerous keys (anything on
 * `Object.prototype`, plus `toJSON`), which are still evaluated (so embedded
 * stubs are introduced/released) but not assigned.  Matches
 * cloudflare/capnweb 0.10.0.
 *
 * @param {unknown[]} rest  The tag's arguments: [name, message, stack?, props?]
 * @param {((v: unknown) => unknown)} [recurse]
 * @returns {Error}
 */
const decodeError = (rest, recurse) => {
  const [typeName, rawMessage, stack, props] = rest;
  const Cls = /** @type {ErrorConstructor} */ (
    ERROR_TYPES[/** @type {keyof typeof ERROR_TYPES} */ (typeName)] || Error
  );
  const message = typeof rawMessage === 'string' ? rawMessage : '';
  // AggregateError's first constructor argument is the errors iterable, not
  // the message, so build it explicitly (with an empty list; a serialized
  // `errors` prop, if any, is restored from the props bag below).
  const err =
    hasAggregateError && typeName === 'AggregateError'
      ? new AggregateError([], message)
      : new Cls(message);
  if (typeof stack === 'string') {
    try {
      err.stack = stack;
    } catch (_e) {
      /* ignore */
    }
  }
  if (
    recurse &&
    props !== null &&
    typeof props === 'object' &&
    !Array.isArray(props)
  ) {
    for (const key of Object.keys(/** @type {object} */ (props))) {
      const encoded = /** @type {any} */ (props)[key];
      if (key === 'name' || key === 'message' || key === 'stack') {
        // Reserved slots are carried positionally, not in the props bag.
      } else if (key in Object.prototype || key === 'toJSON') {
        // Filter structurally dangerous keys exactly as capnweb does:
        // evaluate the value (so any embedded stubs are still introduced and
        // later released) but never assign it onto the error.
        recurse(encoded);
      } else {
        /** @type {any} */ (err)[key] = recurse(encoded);
      }
    }
  }
  return err;
};

/**
 * Decode a special-value tagged array into a JS value.  Throws if the tag is
 * unknown.  The caller has already determined the array is a tagged value
 * (i.e. it begins with a string tag we recognise).
 *
 * @param {unknown[]} expression
 * @param {((v: unknown) => unknown)} [recurse]  Evaluator for nested values
 *   (error props).  Omitted by standalone callers.
 */
export const decodeSpecial = (expression, recurse) => {
  const [tag, ...rest] = expression;
  switch (tag) {
    case 'undefined':
      return undefined;
    case 'nan':
      return NaN;
    case 'inf':
      return Infinity;
    case '-inf':
      return -Infinity;
    case 'bigint': {
      const [s] = rest;
      if (typeof s !== 'string') throw new TypeError('bigint must be a string');
      return BigInt(s);
    }
    case 'date': {
      const [ms] = rest;
      // A null ms is an Invalid Date (capnweb encodes NaN-time dates this way).
      if (ms === null) return new Date(NaN);
      if (typeof ms !== 'number') throw new TypeError('date must be a number');
      return new Date(ms);
    }
    case 'bytes': {
      const [s] = rest;
      if (typeof s !== 'string') throw new TypeError('bytes must be a string');
      return base64ToBytes(s);
    }
    case 'error':
      return decodeError(rest, recurse);
    default:
      throw new TypeError(`unknown special-value tag: ${String(tag)}`);
  }
};

// Tags handled by `decodeSpecial`/`tryEncodeSpecial` (atomic, leaf values).
// Compound/structural fetch tags (`headers`, `request`, `response`) are
// handled separately in `evaluate.js`/`devaluate.js` via `fetch-codec.js`,
// because they need recursive (de)valuation.  Including them here would be a
// lie that would route them through `decodeSpecial`, which doesn't know
// about them.
const SPECIAL_TAGS = harden(
  new Set([
    'undefined',
    'nan',
    'inf',
    '-inf',
    'bigint',
    'date',
    'bytes',
    'error',
  ]),
);

/**
 * @param {unknown} tag
 */
export const isSpecialTag = tag =>
  typeof tag === 'string' && SPECIAL_TAGS.has(tag);

/**
 * Tags that name reference-introducing expressions.
 *
 * - import / pipeline: reference to sender's imports = our exports.
 * - export / promise: a fresh capability the sender introduces (= our import).
 * - remap: a recorded mapper to be replayed on the peer.
 * - writable / readable: stream halves.  At the protocol level these are
 *   exactly like export / promise (positive vs negative id allocation,
 *   refcount semantics) but the receiver may interpret them as streams.
 */
const REF_TAGS = harden(
  new Set([
    'import',
    'pipeline',
    'export',
    'promise',
    'remap',
    'writable',
    'readable',
  ]),
);

/**
 * @param {unknown} tag
 */
export const isRefTag = tag => typeof tag === 'string' && REF_TAGS.has(tag);
