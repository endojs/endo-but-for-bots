// @ts-check
/**
 * The per-call `powers` of the exec program (M5 W5.4; `m5-interfaces.md`
 * 2.7, D-11, rule 12.13). Per call, a hardened plain record `{ lookup,
 * list, store, remove }` over the session's `ExecPowersSource` (held only
 * by the exec program's closure, never by the model's scope). Each method
 * checks its arguments here and forwards through the call's `E`; once the
 * call is closed every method answers a promise rejected with
 * `texts.powersExpired` and sends nothing.
 *
 * `lookup`'s object answers go behind the call's membrane; its `{ json }`
 * answers are parsed here (the exec vat parses model data on purpose: a key
 * flood throws the engine's "key space exhausted" error, which the call
 * answers as `exhausted`, M1b). `store` sends an object (a wrapper is
 * swapped for its target) or `{ json }`: the value rendered as JSON text,
 * big integers as decimals (R3-23), refused here over `labelValueBytes`.
 * Model code calls `E(powers).lookup('x')` or `await powers.lookup('x')`.
 */
import { limits } from '../lib/limits.js';
import { limitsM5 } from '../lib/limits-m5.js';
import { utf8Bytes } from '../lib/bounded.js';
import { bigintsAsDecimalStrings, texts, textOf } from './render.js';
import { isWrapper } from './membrane.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { isRemotable } = /** @type {GuestGlobals} */ (globalThis);

/** A label that is not a string of 1 to `labelUnits` units. */
export const LABEL_TEXT = `A label is a string of 1 to ${limits.labelUnits} characters`;
/** `store` of a value JSON cannot represent (a function, `undefined`). */
export const NOT_JSON_TEXT =
  'Only JSON values (big integers as decimals) and objects can be stored';

/** @param {unknown} label */
const badLabel = label =>
  typeof label !== 'string' ||
  label.length === 0 ||
  label.length > limits.labelUnits;

/**
 * @param {object} options
 * @param {any} options.source the session's `ExecPowersSource`
 * @param {any} options.callE the call's `E`
 * @param {() => boolean} options.isOpen
 * @param {{ wrap: (target: any) => any, unwrap: (value: any) => any }} [options.membrane]
 */
export const makeCallPowers = ({ source, callE, isOpen, membrane }) => {
  const expired = () => Promise.reject(Error(texts.powersExpired));
  /** @param {string} text */
  const refuse = text => Promise.reject(Error(text));

  /** @param {unknown} label */
  const lookup = async label => {
    if (!isOpen()) return expired();
    if (badLabel(label)) return refuse(LABEL_TEXT);
    const answer = await callE(source).lookup(label);
    if (answer === undefined) return undefined;
    if (isRemotable(answer))
      return membrane === undefined ? answer : membrane.wrap(answer);
    // Model data, parsed in the exec vat on purpose (rule 12.10).
    return harden(JSON.parse(answer.json));
  };

  const list = async () => {
    if (!isOpen()) return expired();
    return callE(source).list();
  };

  /**
   * @param {unknown} label
   * @param {unknown} value
   */
  const store = async (label, value) => {
    if (!isOpen()) return expired();
    if (badLabel(label)) return refuse(LABEL_TEXT);
    if (isWrapper(value)) {
      const target =
        membrane === undefined
          ? value
          : membrane.unwrap(/** @type {any} */ (value));
      // A wrapper of an ended call stands for nothing any more.
      if (target === value) return expired();
      return callE(source).store(label, target);
    }
    if (isRemotable(value)) return callE(source).store(label, value);
    /** @type {string | undefined} */
    let json;
    try {
      json = JSON.stringify(value, bigintsAsDecimalStrings);
    } catch (error) {
      return refuse(`${NOT_JSON_TEXT}: ${/** @type {any} */ (error)?.message}`);
    }
    if (typeof json !== 'string') return refuse(NOT_JSON_TEXT);
    const bytes = utf8Bytes(json);
    if (bytes > limitsM5.labelValueBytes)
      return refuse(textOf.valueTooLarge(bytes, limitsM5.labelValueBytes));
    return callE(source).store(label, harden({ json }));
  };

  /** @param {unknown} label */
  const remove = async label => {
    if (!isOpen()) return expired();
    if (badLabel(label)) return refuse(LABEL_TEXT);
    return callE(source).remove(label);
  };

  return harden({ lookup, list, store, remove });
};
harden(makeCallPowers);
