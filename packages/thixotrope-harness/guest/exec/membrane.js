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
 * `texts.powersExpired` (rule 12.13). Remotables in an answer (of a send or
 * of `E.get`) are wrapped again, and an answer holding one deeper than
 * `ANSWER_DEPTH` is refused, so no raw presence reaches model code; this
 * call's wrappers inside arguments are swapped for their targets. Arguments
 * are copied, never hardened in place: the model's own objects stay its own.
 * A tagged value (a CopySet, a CopyBag, ...) keeps its tag both ways (XC):
 * its payload is measured or wrapped and the copy carries the same tag.
 *
 * What may leave the vat (XC; rule 12.13): a message to a wrapper (one that
 * goes to another vat's object) may carry data and this call's wrappers
 * only. Any other remotable in it is refused before anything is sent: a
 * wrapper of an ended call with `texts.powersExpired`, anything else
 * (an object model code made itself, by building a remotable by hand: the
 * scope has no `Far`, but `Symbol.for('passStyle')` is a shared intrinsic)
 * with `MODEL_OBJECT_TEXT`. So no other vat receives a model-made object,
 * and a model-made object receives no call, and no raw presence as an
 * argument, from any other vat: it is called only by model code and by this
 * vat's own program (the inspector, for one stored through `powers.store`,
 * which `powers.js` lets pass; recorded for the PM). A message to a
 * non-wrapper remotable stays in this vat and is measured but not refused.
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
import { limits } from '../lib/limits.js';
import { texts, textOf } from '../lib/guards/base.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { Far, isRemotable } = /** @type {GuestGlobals} */ (globalThis);

/** A promise nested inside an argument (its resolution would go unmeasured). */
export const NESTED_PROMISE_TEXT =
  'Arguments sent to another vat may not hold unresolved promises; await them first';
/** A send with a method name that is not a string. */
export const METHOD_NAME_TEXT = 'Method names must be strings';
/**
 * A remotable model code made itself, in a message to another vat's object
 * (XC): only objects `powers` (or their answers) gave this call may leave.
 */
export const MODEL_OBJECT_TEXT =
  'Only objects obtained through powers in this call can be sent to another vat';

/** The pass-style brand (`@endo/pass-style`'s `PASS_STYLE`). */
const PASS_STYLE = Symbol.for('passStyle');

/**
 * The tag of a tagged value, else undefined. Read from own data properties
 * only (no getter of the model's runs here).
 * @param {object} value
 */
const tagOf = value => {
  const style = Object.getOwnPropertyDescriptor(value, PASS_STYLE);
  if (style === undefined || style.value !== 'tagged') return undefined;
  const tag = Object.getOwnPropertyDescriptor(value, Symbol.toStringTag);
  return typeof tag?.value === 'string' ? tag.value : undefined;
};

/**
 * A tagged value with this tag and payload (`makeTagged`'s construction).
 * @param {string} tag
 * @param {unknown} payload hardened
 */
const tagged = (tag, payload) =>
  harden(
    Object.create(Object.prototype, {
      [PASS_STYLE]: { value: 'tagged' },
      [Symbol.toStringTag]: { value: tag },
      payload: { value: payload, enumerable: true },
    }),
  );

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
  { bounds = limits, swap = value => value } = {},
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
    const tag = tagOf(value);
    if (tag !== undefined) {
      add(tag.length * 3);
      keys += 1;
      if (keys > membraneMessageKeys) {
        refusal = textOf.membraneTooManyKeys(keys, membraneMessageKeys);
        return undefined;
      }
      const payload = walk(/** @type {any} */ (value).payload, depth + 1);
      if (refusal !== undefined) return undefined;
      return tagged(tag, payload);
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

/**
 * Remotables of an answer are wrapped down to this depth; below it an answer
 * holding a remotable or a promise is refused (`answerBeyondDepth`), so no
 * raw presence reaches model code (rule 12.13).
 */
export const ANSWER_DEPTH = 64;

/**
 * The part of an answer below `ANSWER_DEPTH`, as it is when it holds only
 * data; refused when it holds a remotable or a promise. Walked with a stack,
 * not by recursion: the answer is already in this vat, so the walk is bounded
 * by its size, and a deep one cannot overflow the call stack.
 * @param {unknown} value
 */
const answerBeyondDepth = value => {
  /** @type {unknown[]} */
  const stack = [value];
  while (stack.length) {
    const item = stack.pop();
    if (Array.isArray(item)) {
      for (const element of item) stack.push(element);
    } else if (
      typeof item === 'object' &&
      item !== null &&
      !(item instanceof Error)
    ) {
      if (isRemotable(item) || isPromise(item))
        throw Error(textOf.membraneTooDeep(ANSWER_DEPTH));
      for (const name of Object.keys(item))
        stack.push(/** @type {any} */ (item)[name]);
    }
  }
  return value;
};

/**
 * The membrane of one exec call.
 *
 * @param {{ callE: any, bounds?: MembraneBounds }} options `callE` is the
 *   call's `E` (it sends nowhere once the call is closed)
 */
export const makeMembrane = ({ callE, bounds = limits }) => {
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
   * `unwrap` for a message that leaves the vat: a remotable that is not
   * this call's wrapper is refused (module comment).
   * @param {any} value a remotable
   */
  const unwrapLeaving = value => {
    if (targets.has(value)) return targets.get(value);
    throw Error(isWrapper(value) ? texts.powersExpired : MODEL_OBJECT_TEXT);
  };

  /**
   * An answer with every remotable wrapped.
   * @param {unknown} value
   * @param {number} [depth]
   * @returns {any}
   */
  const wrapAnswer = (value, depth = 0) => {
    if (typeof value !== 'object' || value === null) return value;
    if (depth > ANSWER_DEPTH) return answerBeyondDepth(value);
    if (Array.isArray(value))
      return harden(value.map(item => wrapAnswer(item, depth + 1)));
    if (isRemotable(value)) return wrap(value);
    if (isPromise(value))
      return /** @type {Promise<unknown>} */ (value).then(v =>
        wrapAnswer(v, depth),
      );
    if (value instanceof Error) return value;
    const tag = tagOf(value);
    if (tag !== undefined)
      return tagged(
        tag,
        wrapAnswer(/** @type {any} */ (value).payload, depth + 1),
      );
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
    const real = targets.get(target);
    /** @type {ReturnType<typeof measureArguments>} */
    let measured;
    try {
      measured = measureArguments(args, {
        bounds,
        swap: real === undefined ? unwrap : unwrapLeaving,
      });
    } catch (error) {
      return Promise.reject(error);
    }
    if ('refusal' in measured) return Promise.reject(Error(measured.refusal));
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
  /**
   * One property get. It carries no arguments, so nothing is measured; an
   * ended call's wrapper is refused, and the answer of a get through a
   * wrapper is wrapped like a send's, so no raw presence outlives the call.
   * @param {unknown} target
   * @param {string | symbol} name
   * @returns {Promise<unknown>}
   */
  const getProperty = (target, name) => {
    if (isPromise(target))
      return /** @type {Promise<unknown>} */ (target).then(resolved =>
        getProperty(resolved, name),
      );
    if (isWrapper(target) && !targets.has(target))
      return Promise.reject(Error(texts.powersExpired));
    const real = unwrap(target);
    const answer = callE.get(real)[name];
    return real === target ? answer : answer.then(wrapAnswer);
  };
  membraneE.get = (/** @type {unknown} */ target) =>
    new Proxy(methodsHolder, {
      get: (_holder, name) => getProperty(target, name),
    });
  membraneE.resolve = callE.resolve;
  membraneE.when = callE.when;

  return harden({ wrap, unwrap, wrapAnswer, E: membraneE });
};
harden(makeMembrane);
