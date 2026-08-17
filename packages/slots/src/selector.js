// @ts-check

import harden from '@endo/harden';
import { makeError, q, X } from '@endo/errors';
import {
  nameForPassableSymbol,
  passableSymbolForName,
  passStyleOf,
} from '@endo/pass-style';

/**
 * Slot-machine method selectors mirror `@endo/ocapn`'s
 * (`packages/ocapn/src/selector.js`): a JavaScript method name is
 * carried on the wire as a *passable symbol* — the leading argument
 * of an object-Exo delivery — so that a single flat argument vector
 * expresses both method invocation and function application (see
 * `packages/ocapn/docs/cbor-encoding.md` § Body Content Format).
 *
 * Well-known symbols (whose registered name starts with `@@`) are
 * reserved and never valid selectors, matching the OCapN rule.
 */

/**
 * Coerce a string method name into its wire selector symbol.
 *
 * @param {string} name
 * @returns {symbol}
 */
export const makeSelector = name => {
  if (typeof name !== 'string') {
    throw makeError(X`selector name must be a string, got ${q(name)}`);
  }
  if (name.startsWith('@@')) {
    throw makeError(
      X`selector name must not start with "@@" (reserved for well-known symbols), got ${q(name)}`,
    );
  }
  return harden(passableSymbolForName(name));
};
harden(makeSelector);

/**
 * Validate and decode a wire selector back into its string method
 * name.  Rejects any leading argument that is not a registered
 * passable symbol — the guard behind "malformed or non-selector
 * object calls are rejected".
 *
 * @param {any} selector
 * @returns {string}
 */
export const getSelectorName = selector => {
  // Sense the pass-style rather than the JavaScript `typeof`: a selector
  // is a *passable* symbol, and routing the check through pass-style keeps
  // this guard correct should the wire representation of a selector ever
  // migrate to another passable shape.
  if (passStyleOf(selector) !== 'symbol') {
    throw makeError(
      X`method selector must be a symbol, got ${q(selector)}`,
    );
  }
  const name = nameForPassableSymbol(selector);
  if (name === undefined) {
    throw makeError(
      X`method selector ${q(String(selector))} is not a passable symbol (must be registered or well-known)`,
    );
  }
  if (name.startsWith('@@')) {
    throw makeError(
      X`method selector name must not start with "@@" (reserved for well-known symbols), got ${q(name)}`,
    );
  }
  return name;
};
harden(getSelectorName);
