// @ts-check
/**
 * The exec membrane (M5 W5.4; `m5-interfaces.md` D-M5-3, 2.7; open decision
 * O-9). Model code in the exec vat holds objects of other vats through
 * `powers.lookup`. One message above about 94 KB halts the vat it reaches,
 * and every fresh record key takes one of that vat's names for life (facts
 * 2, 4). So every message model code sends to a remotable is measured in
 * this vat first and refused, before it leaves, when its estimated bytes
 * (units x 3) exceed `membraneArgBytes`, a record has more than
 * `membraneRecordKeys` keys, the message more than `membraneMessageKeys`
 * record keys in all, or it nests deeper than `membraneDepth`.
 *
 * Objects `powers` hands to model code are wrappers: empty local
 * remotables standing for their targets, one per target per call (a
 * `WeakMap` wrapper -> target). A send to a wrapper goes to its target
 * through the call's `E`, so a closed call's wrappers send nowhere, and a
 * wrapper of an earlier call used under a later call's `E` is refused with
 * `texts.powersExpired` (rule 12.13). Remotables in an answer are wrapped
 * again; this call's wrappers inside arguments are swapped for their
 * targets; other objects (made in this vat) pass as they are. Arguments are
 * copied, never hardened in place: the model's own objects stay its own.
 *
 * The model's `E` is a membrane `E`: it measures every message whose target
 * is a remotable (a wrapper, an object the model made, a presence an answer
 * carried inside a tagged value), and leaves sends to plain local records
 * (`powers`) as the call's `E` does them. Top-level promise arguments are
 * awaited first; a promise nested in an argument is refused (its later
 * resolution would leave unmeasured).
 *
 * Residual risk (O-9, core request CC-071): each message is bounded, a
 * sequence is not; model code can drip distinct keys into another vat over
 * many calls.
 */
import { limitsM5 } from '../lib/limits-m5.js';
import { texts, textOf } from './render.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, isRemotable } = /** @type {GuestGlobals} */ (globalThis);

/** A promise nested inside an argument (its resolution would go unmeasured). */
export const NESTED_PROMISE_TEXT =
  'Arguments sent to another vat may not hold unresolved promises; await them first';
/** A send with a method name that is not a string. */
export const METHOD_NAME_TEXT = 'Method names must be strings';

/** Estimated bytes of a value that is not a string (a number, a handle). */
const SCALAR_BYTES = 24;

/** Every wrapper any call of this vat made, to refuse one of an ended call. */
const allWrappers = new WeakSet();

/**
 * Whether `value` is a wrapper some call of this vat made.
 * @param {unknown} value
 */
export const isWrapper = value =>
  typeof value === 'object' && value !== null && allWrappers.has(value);
harden(isWrapper);

/** @param {unknown} value */
const isPromise = value => value instanceof Promise;

/**
 * @typedef {object} MembraneBounds
 * @property {number} membraneArgBytes
 * @property {number} membraneRecordKeys
 * @property {number} membraneMessageKeys
 * @property {number} membraneDepth
 */

/**
 * Measure one message's arguments and copy them with `swap` applied to
 * every remotable. Answers `{ args }` (hardened copies) or `{ refusal }` (the
 * text). The walk stops at the first bound it passes, so its work is
 * bounded by the bounds, not by the arguments.
 *
 * @param {readonly unknown[]} args
 * @param {{ bounds?: MembraneBounds, swap?: (value: any) => any }} [options]
 * @returns {{ args: unknown[] } | { refusal: string }}
 */
export const measureArguments = (
  args,
  { bounds = limitsM5, swap = value => value } = {},
) => {
  const {
    membraneArgBytes,
    membraneRecordKeys,
    membraneMessageKeys,
    membraneDepth,
  } = bounds;
  let bytes = 0;
  let keys = 0;
  /** @type {string | undefined} */
  let refusal;
  /** @param {number} more */
  const add = more => {
    bytes += more;
    if (bytes > membraneArgBytes && refusal === undefined)
      refusal = textOf.membraneTooLarge(bytes, membraneArgBytes);
  };
  /**
   * @param {unknown} value
   * @param {number} depth
   * @returns {unknown}
   */
  const walk = (value, depth) => {
    if (refusal !== undefined) return undefined;
    if (depth > membraneDepth) {
      refusal = textOf.membraneTooDeep(membraneDepth);
      return undefined;
    }
    if (typeof value === 'string') {
      add(value.length * 3);
      return value;
    }
    if (typeof value === 'bigint') {
      add(String(value).length * 3);
      return value;
    }
    if (typeof value !== 'object' || value === null) {
      add(SCALAR_BYTES);
      return value;
    }
    add(3);
    // Arrays first: `isRemotable` of a hardened array scans its elements.
    if (!Array.isArray(value) && isRemotable(value)) return swap(value);
    if (isPromise(value)) {
      refusal = NESTED_PROMISE_TEXT;
      return undefined;
    }
    if (Array.isArray(value)) {
      /** @type {unknown[]} */
      const out = [];
      for (const item of value) {
        out.push(walk(item, depth + 1));
        if (refusal !== undefined) return undefined;
      }
      return harden(out);
    }
    if (value instanceof Error) {
      add(String(value.message).length * 3);
      return value;
    }
    const names = Object.keys(value);
    if (names.length > membraneRecordKeys) {
      refusal = textOf.membraneTooManyKeys(names.length, membraneRecordKeys);
      return undefined;
    }
    keys += names.length;
    if (keys > membraneMessageKeys) {
      refusal = textOf.membraneTooManyKeys(keys, membraneMessageKeys);
      return undefined;
    }
    /** @type {[string, unknown][]} */
    const entries = [];
    for (const name of names) {
      add(name.length * 3);
      // The keys are the model's own record's, already in this vat.
      entries.push([name, walk(/** @type {any} */ (value)[name], depth + 1)]);
      if (refusal !== undefined) return undefined;
    }
    return harden(Object.fromEntries(entries));
  };
  /** @type {unknown[]} */
  const out = [];
  for (const arg of args) {
    out.push(walk(arg, 1));
    if (refusal !== undefined) return { refusal };
  }
  return { args: harden(out) };
};
harden(measureArguments);

/** Remotables of an answer are wrapped down to this depth. */
const ANSWER_DEPTH = 64;

/**
 * The membrane of one exec call.
 *
 * @param {{ callE: any, limits?: MembraneBounds }} options `callE` is the
 *   call's `E` (it sends nowhere once the call is closed)
 */
export const makeMembrane = ({ callE, limits = limitsM5 }) => {
  /** @type {WeakMap<object, any>} wrapper -> target */
  const targets = new WeakMap();
  /** @type {WeakMap<object, object>} target -> wrapper (one per call) */
  const wrappers = new WeakMap();

  /**
   * The wrapper of a remotable (itself for a wrapper of this call).
   * @param {any} target
   */
  const wrap = target => {
    if (targets.has(target)) return target;
    let wrapper = wrappers.get(target);
    if (wrapper === undefined) {
      wrapper = Far('Capability', {});
      targets.set(wrapper, target);
      wrappers.set(target, wrapper);
      allWrappers.add(wrapper);
    }
    return wrapper;
  };

  /**
   * The target of this call's wrapper, else the value.
   * @param {any} value
   */
  const unwrap = value =>
    typeof value === 'object' && value !== null && targets.has(value)
      ? targets.get(value)
      : value;

  /**
   * An answer with every remotable wrapped.
   * @param {unknown} value
   * @param {number} [depth]
   * @returns {any}
   */
  const wrapAnswer = (value, depth = 0) => {
    if (typeof value !== 'object' || value === null || depth > ANSWER_DEPTH)
      return value;
    if (Array.isArray(value))
      return harden(value.map(item => wrapAnswer(item, depth + 1)));
    if (isRemotable(value)) return wrap(value);
    if (isPromise(value))
      return /** @type {Promise<unknown>} */ (value).then(v =>
        wrapAnswer(v, depth),
      );
    if (value instanceof Error) return value;
    if (Object.getPrototypeOf(value) !== Object.prototype) return value;
    return harden(
      Object.fromEntries(
        Object.entries(value).map(([name, item]) => [
          name,
          wrapAnswer(item, depth + 1),
        ]),
      ),
    );
  };

  /**
   * Measure and send one message, or refuse it.
   * @param {unknown} target
   * @param {string | symbol} name
   * @param {unknown[]} args
   * @param {boolean} sendOnly
   * @returns {Promise<unknown> | undefined}
   */
  const send = (target, name, args, sendOnly) => {
    if (typeof name !== 'string')
      return Promise.reject(Error(METHOD_NAME_TEXT));
    if (isPromise(target))
      return /** @type {Promise<unknown>} */ (target).then(resolved =>
        send(resolved, name, args, sendOnly),
      );
    if (args.some(isPromise))
      return Promise.all(args).then(resolved =>
        send(target, name, resolved, sendOnly),
      );
    if (!isRemotable(target)) {
      // A local record (`powers`, model data): nothing leaves the vat here.
      return sendOnly
        ? callE.sendOnly(target)[name](...args)
        : callE(target)[name](...args);
    }
    if (isWrapper(target) && !targets.has(target))
      return Promise.reject(Error(texts.powersExpired));
    const measured = measureArguments(args, { bounds: limits, swap: unwrap });
    if ('refusal' in measured) return Promise.reject(Error(measured.refusal));
    const real = targets.get(target);
    const to = real ?? target;
    if (sendOnly) {
      callE.sendOnly(to)[name](...measured.args);
      return undefined;
    }
    const answer = callE(to)[name](...measured.args);
    return real === undefined ? answer : answer.then(wrapAnswer);
  };

  const methodsHolder = harden({});
  /**
   * @param {unknown} target
   * @param {boolean} sendOnly
   */
  const methodsOf = (target, sendOnly) =>
    new Proxy(methodsHolder, {
      get:
        (_holder, name) =>
        (/** @type {unknown[]} */ ...args) => {
          const answer = send(target, name, args, sendOnly);
          // A sendOnly answers nothing; its refusal is not observable.
          if (sendOnly) {
            if (answer !== undefined) answer.catch(() => {});
            return undefined;
          }
          return answer;
        },
    });

  /** @param {unknown} target */
  const membraneE = target => methodsOf(target, false);
  membraneE.sendOnly = (/** @type {unknown} */ target) =>
    methodsOf(target, true);
  // A property get carries no arguments; its answer is not wrapped (a send
  // to a remotable it holds is still measured, above).
  membraneE.get = (/** @type {unknown} */ target) => callE.get(unwrap(target));
  membraneE.resolve = callE.resolve;
  membraneE.when = callE.when;

  return harden({ wrap, unwrap, wrapAnswer, E: membraneE });
};
harden(makeMembrane);
