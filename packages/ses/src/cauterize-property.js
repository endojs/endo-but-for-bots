import { getOwnPropertyDescriptor, hasOwn } from './commons.js';

/**
 * @import {Reporter} from './reporting-types.js'
 */

/**
 * Delete `obj[prop]` or at least make it harmless.
 *
 * If the property was not expected, then emit a reporter-dependent warning
 * to bring attention to this case, so someone can determine what to do with it.
 *
 * If the property to be deleted is a function's `.prototype` property, this
 * will normally be because the function was supposed to be a
 * - builtin method or non-constructor function
 * - arrow function
 * - concise method
 *
 * all of whom are not supposed to have a `.prototype` property. Nevertheless,
 * on some platforms (like older versions of Hermes), or as a result of
 * some shim-based mods to the primordials (like core-js?), some of these
 * functions may accidentally be more like `function` functions with
 * an undeletable `.prototype` property. In these cases, if we can
 * set the value of that bogus `.prototype` property to `undefined`,
 * we do so, issuing a warning, rather than failing to initialize ses.
 *
 * Similarly, some host environments expose native constructors as
 * `function` style objects that carry non-configurable `arguments` and
 * `caller` own properties (for example, Chromium V8 exposes its native
 * `TextEncoder` and `TextDecoder` this way; Node's class-style
 * implementations do not). These own properties cannot be deleted and
 * cannot be reassigned; the only safe action is to leave them in place
 * and warn. In strict mode any subsequent read of `.arguments` or
 * `.caller` throws, so the property's continued presence is not a
 * post-lockdown integrity hazard.
 *
 * @param {object} obj
 * @param {PropertyKey} prop
 * @param {boolean} known If deletion is expected, don't warn
 * @param {string} subPath Used for warning messages
 * @param {Reporter} reporter Where to issue warning or error.
 * @returns {void}
 */
export const cauterizeProperty = (
  obj,
  prop,
  known,
  subPath,
  { warn, error },
) => {
  // Either the object lacks a permit or the object doesn't match the
  // permit.
  // If the permit is specifically false, not merely undefined,
  // this is a property we expect to see because we know it exists in
  // some environments and we have expressly decided to exclude it.
  // Any other disallowed property is one we have not audited and we log
  // that we are removing it so we know to look into it, as happens when
  // the language evolves new features to existing intrinsics.
  if (!known) {
    warn(`Removing ${subPath}`);
  }
  // Detect the Chromium-native-function case: V8 surfaces native function
  // intrinsics (such as `TextEncoder` and `TextDecoder`) with own,
  // non-configurable `arguments` and `caller` properties that neither
  // `delete` nor reassignment can dislodge. Skip with a warning rather
  // than fall into the catch path's `error` branch, which would abort
  // lockdown.
  if (
    typeof obj === 'function' &&
    (prop === 'arguments' || prop === 'caller')
  ) {
    const desc = getOwnPropertyDescriptor(obj, prop);
    if (desc && desc.configurable === false) {
      warn(`Tolerating undeletable ${subPath} on native function`);
      return;
    }
  }
  try {
    delete obj[prop];
  } catch (err) {
    const reason = /** @type {string | object} */ (err);
    if (hasOwn(obj, prop)) {
      if (typeof obj === 'function' && prop === 'prototype') {
        obj.prototype = undefined;
        if (obj.prototype === undefined) {
          warn(`Tolerating undeletable ${subPath} === undefined`);
          return;
        }
      }
      error(`failed to delete ${subPath}`, reason);
    } else {
      error(`deleting ${subPath} threw`, reason);
    }
    throw err;
  }
};
