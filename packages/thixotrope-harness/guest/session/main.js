// @ts-check
/**
 * The session program (M1a W1a.4; `designs/m1a-interfaces.md` sections 3.1
 * and 9). `scripts/bundle-guest.mjs session` bundles this module; the
 * factory evaluates the bundle in a fresh worker vat (one evaluating crank)
 * and calls `makeSpareMaker()` on its namespace. The returned `SpareMaker`
 * makes the vat's one session.
 */
import { interfaces } from '../lib/guards/session.js';
import { workspaceSeedLabel } from '../lib/workspace-seed.js';
import { makeSession } from './session.js';

// The exo methods are typed loosely; the interface guards check the values.
const { E, makeExo } = /** @type {any} */ (globalThis);

/** The text a second `make` throws (one session per vat). */
export const ALREADY_MADE = 'this vat already made its session';

export const makeSpareMaker = () => {
  let made = false;
  return makeExo('SpareMaker', interfaces.SpareMaker, {
    /** @param {{ config: any, services: any, rowReporter: any }} makeArgs */
    make(makeArgs) {
      if (made) throw Error(ALREADY_MADE);
      made = true;
      const { services } = makeArgs;
      const marker = services.endowments?.find(
        (/** @type {any} */ entry) => entry.label === workspaceSeedLabel,
      );
      if (marker === undefined) return makeSession(makeArgs);
      return E(services.environment)
        .useWorkspaceSeed(marker.value)
        .then((/** @type {any} */ workspaceSeed) =>
          makeSession(
            harden({
              ...makeArgs,
              config: {
                ...makeArgs.config,
                preset: { ...makeArgs.config.preset, workspaceSeed },
              },
              services: {
                ...services,
                endowments: services.endowments.filter(
                  (/** @type {any} */ entry) => entry !== marker,
                ),
              },
            }),
          ),
        );
    },
  });
};
harden(makeSpareMaker);
