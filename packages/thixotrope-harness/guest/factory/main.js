// @ts-check
/**
 * The factory vat program (M1a W1a.6; architecture 3.1;
 * `designs/m1a-interfaces.md` sections 3.4 and 9).
 *
 * Installed once as the application `harness`:
 *
 *   client.call('install', 'harness', <bundle of this module>,
 *     [['host', 'agentHostAdmin'], ['vats', 'vats']])
 *
 * `make({ host, vats })` runs once, in the install; its value, the
 * `HarnessRoot`, lives in this vat's heap from then on (orthogonal
 * persistence: there is no re-make at restart). `make` registers the
 * factory's start listener with the agent-host manager, whose
 * `lifecycle.started()` calls it at every daemon start (D-5).
 *
 * Guest rules: prelude globals only.
 */
import { makeFactoryKit } from './factory.js';
import { makeHarnessRoot, makeProgramStore } from './root.js';
import { makeRowTable } from './rows.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} powers
 * @param {any} powers.host the AgentHostAdmin
 * @param {any} powers.vats the worker controller
 */
export const make = ({ host, vats }) => {
  const rows = makeRowTable();
  const programs = makeProgramStore();
  const kit = makeFactoryKit({ admin: host, vats, programs, rows });
  // The Registration is kept for the vat's life. A failure leaves the
  // factory without restart recovery; the provisioning test checks that a
  // restart reaches the listener.
  /** @type {{ registration: any }} */
  const held = { registration: undefined };
  E(host)
    .onStart(kit.startListener)
    .then(
      (/** @type {any} */ value) => {
        held.registration = value;
      },
      () => undefined,
    );
  return makeHarnessRoot({ operator: kit.operator, rows, programs });
};
harden(make);
