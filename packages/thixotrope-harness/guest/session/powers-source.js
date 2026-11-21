// @ts-check
/**
 * The session's `ExecPowersSource` (W5.5; `designs/m5-interfaces.md`
 * 2.4.4, D-11, rule 12.13): the session's label map as its exec vat reads
 * it. One exo per session, minted in `make` by the `powers` runtime part
 * (`runtime-parts.js`); `tools/exec.js` sends it as `ExecRequest.powers` with
 * every `run`, and only the exec program's closure holds it (model code
 * gets the per-call wrapper of `guest/exec/powers.js`).
 *
 * Each method is answered from this vat's heap in the crank that receives
 * it: one label-map operation, no call out.
 * - `lookup(label)`: `undefined`, the object of an object binding, or
 *   `{ json }` (the stored text; the exec wrapper parses it there).
 * - `list()`: the held labels, sorted.
 * - `store(label, value)`: an object is bound with source `stored`;
 *   `{ json }` is bound as stored JSON text (never parsed here). The label
 *   map's refusals (`reservedLabel`, `labelTaken`, `labelsFull`,
 *   `valueTooLarge`, `storedValuesFull`) reject the call; the exec wrapper
 *   turns them into errors thrown in model code.
 * - `remove(label)`: whether a binding was removed.
 *
 * Guest rules.
 */
import { interfaces } from '../lib/guards/session.js';
import { makePublications } from './publications.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { Labels } from './labels.js' */
const { isRemotable } = /** @type {GuestGlobals} */ (globalThis);
const { makeExo } = /** @type {any} */ (globalThis);

/**
 * The `ExecPowersSource` over one label map.
 * @param {Labels} labels
 * @param {ReturnType<typeof makePublications>} [publish]
 */
export const makePowersSource = (labels, publish) =>
  makeExo('ExecPowersSource', interfaces.ExecPowersSource, {
    /** @param {string} label */
    lookup(label) {
      const binding = labels.get(label);
      if (binding === undefined) return undefined;
      if (binding.kind === 'object') return binding.value;
      return harden({ json: binding.text });
    },
    list() {
      return labels.list();
    },
    /**
     * @param {string} label
     * @param {any} value an object, or `{ json }` (guard-checked)
     */
    store(label, value) {
      if (isRemotable(value)) labels.bindObject(label, value, 'stored');
      else labels.bindJson(label, value.json);
    },
    /**
     * @param {string} label
     * @param {any} executor
     * @param {any} facade
     */
    publish(label, executor, facade) {
      if (!publish) throw Error('Publication needs an active exec call');
      return publish(label, executor, facade);
    },
    /** @param {string} label */
    remove(label) {
      return labels.remove(label);
    },
  });
harden(makePowersSource);

/**
 * The `powers` runtime part (`runtime-parts.js`): its value is the
 * `ExecPowersSource` exo itself (`tools/exec.js` sends
 * `context.runtime.powers` as `ExecRequest.powers`).
 */
export const powersPart = harden({
  name: /** @type {'powers'} */ ('powers'),
  /** @param {{ labels: Labels }} runtime */
  make: runtime => makePowersSource(runtime.labels, makePublications(runtime)),
});
