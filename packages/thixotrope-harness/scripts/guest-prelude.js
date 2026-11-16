// @ts-check
/**
 * Give a Node process the names a vat has as globals (the Thixotrope guest
 * prelude: `E`, `Far`, `M`, `makeExo`, `mustMatch`, `Fail`, ...), so modules
 * under `guest/lib/` that read them off `globalThis` (for example
 * `guest/lib/interfaces.js`) run unchanged in unit tests and in the
 * agent-host adapter (M1a W1a.0, `designs/m1a-interfaces.md`).
 *
 * The prelude record is the core's own (`packages/thixotrope/src/guest/
 * prelude.js`), imported by relative path on purpose: it is not exported, and
 * using the same record is what makes a Node test see exactly a vat's
 * vocabulary. Call this under lockdown (ses-ava, or an adapter process) and
 * before the first import of a guest module; ES modules evaluate their
 * imports in order, so a test file imports `test/unit/_m1a-prelude.js` first.
 * Names already present (for example `harden` under lockdown) are kept.
 */
// eslint-disable-next-line import/no-relative-packages -- not exported (core internal, J-0132)
import { guestPrelude } from '../../thixotrope/src/guest/prelude.js';

/**
 * Define each prelude name on `globalThis` that is not already there.
 * Idempotent.
 * @returns {string[]} the names this call defined
 */
export const installGuestPrelude = () => {
  /** @type {string[]} */
  const defined = [];
  for (const [name, value] of Object.entries(guestPrelude)) {
    if (!(name in globalThis)) {
      Object.defineProperty(globalThis, name, {
        value,
        writable: false,
        enumerable: false,
        configurable: true,
      });
      defined.push(name);
    }
  }
  return defined;
};
harden(installGuestPrelude);

export { guestPrelude };
