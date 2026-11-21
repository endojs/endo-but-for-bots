// @ts-check
/**
 * The public facet speaks JSON data to the session supervisor. Only the
 * private executor holds the model's closures. Both facets live in the
 * originating exec vat and stop answering if that vat is retired.
 */
import { limits } from '../lib/limits.js';
import { utf8Bytes } from '../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);
const DATA_ERROR = 'Published methods accept and return bounded JSON data';
const METHODS_ERROR = 'Publish a plain record of named methods';
/** @param {unknown} value */
const plainRecord = value =>
  value !== null &&
  typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/**
 * Serialize data properties only. Build a bounded string without calling any
 * getters or toJSON methods on the supplied values.
 * @param {unknown} root
 */
const encode = root => {
  let bytes = 0;
  let keys = 0;
  /** @type {string[]} */
  const parts = [];
  /** @param {string} text */
  const append = text => {
    bytes += utf8Bytes(text);
    if (bytes > limits.labelValueBytes) throw Error(DATA_ERROR);
    parts.push(text);
  };
  /**
   * @param {unknown} value
   * @param {number} depth
   */
  const visit = (value, depth) => {
    if (depth > limits.membraneDepth) throw Error(DATA_ERROR);
    if (
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' && value.length <= limits.labelValueBytes)
    ) {
      append(JSON.stringify(value));
      return;
    }
    const array = Array.isArray(value);
    if (array && value.length > limits.labelValueBytes) throw Error(DATA_ERROR);
    if (!array && !plainRecord(value)) throw Error(DATA_ERROR);
    const object = /** @type {object} */ (value);
    const names = Reflect.ownKeys(object).filter(
      k => !(array && k === 'length'),
    );
    if (
      (!array && names.length > limits.membraneRecordKeys) ||
      (array && names.length !== value.length)
    )
      throw Error(DATA_ERROR);
    append(array ? '[' : '{');
    for (const [i, name] of names.entries()) {
      if (
        typeof name !== 'string' ||
        name.length > limits.labelValueBytes ||
        (array && name !== String(i))
      )
        throw Error(DATA_ERROR);
      const d = Object.getOwnPropertyDescriptor(object, name);
      if (!d?.enumerable || !Object.hasOwn(d, 'value')) throw Error(DATA_ERROR);
      if (i) append(',');
      if (!array) {
        keys += 1;
        if (keys > limits.membraneMessageKeys) throw Error(DATA_ERROR);
        append(JSON.stringify(name));
        append(':');
      }
      visit(d.value, depth + 1);
    }
    append(array ? ']' : '}');
  };
  visit(root, 0);
  return parts.join('');
};

/** @param {unknown} text */
const decode = text => {
  if (
    typeof text !== 'string' ||
    text.length > limits.labelValueBytes ||
    utf8Bytes(text) > limits.labelValueBytes
  )
    throw Error(DATA_ERROR);
  const data = JSON.parse(text);
  encode(data);
  return harden(data);
};

/**
 * @param {unknown} methods
 * @param {(executor: any, facade: any) => Promise<any>} register
 */
export const publishMethods = async (methods, register) => {
  if (!plainRecord(methods)) throw Error(METHODS_ERROR);
  const record = /** @type {object} */ (methods);
  const names = Reflect.ownKeys(record);
  if (!names.length || names.length > limits.maxMethodNames)
    throw Error(METHODS_ERROR);
  /** @type {Map<string, (...args: any[]) => unknown>} */
  const implementations = new Map();
  for (const name of names) {
    if (
      typeof name !== 'string' ||
      name.length > limits.methodNameUnits ||
      !/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
      name === 'then' ||
      Object.hasOwn(Object.prototype, name)
    )
      throw Error(METHODS_ERROR);
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor?.enumerable || typeof descriptor.value !== 'function')
      throw Error(METHODS_ERROR);
    implementations.set(name, descriptor.value);
  }
  const executor = Far('PublishedExecutor', {
    /**
     * @param {string} method
     * @param {string} argsJson
     */
    invoke(method, argsJson) {
      const fn = implementations.get(method);
      if (!fn) throw Error('Unknown published method');
      const args = decode(argsJson);
      if (!Array.isArray(args)) throw Error(DATA_ERROR);
      try {
        const result = Reflect.apply(fn, undefined, args);
        if (result instanceof Promise) {
          // An asynchronous method is refused. Observe an eventual rejection
          // without allowing it to become an unhandled worker error.
          Promise.prototype.then.call(result, undefined, () => {});
          throw Error(DATA_ERROR);
        }
        return encode(result);
      } catch {
        throw Error('Published method failed or returned unsupported data');
      }
    },
  });
  /** @type {Promise<any>} */
  let supervisor;
  const facade = Far(
    'PublishedObject',
    Object.fromEntries(
      [...implementations.keys()].map(name => [
        name,
        async (/** @type {unknown[]} */ ...args) => {
          const reply = await E(supervisor).invoke(name, encode(args));
          return decode(reply);
        },
      ]),
    ),
  );
  supervisor = register(executor, facade);
  await supervisor;
};
harden(publishMethods);
