// @ts-check
/**
 * The session program (M1a W1a.4; `designs/m1a-interfaces.md` sections 3.1
 * and 9). `scripts/bundle-guest.mjs session` bundles this module; the
 * factory evaluates the bundle in a fresh worker vat (one evaluating crank)
 * and calls `makeSpareMaker()` on its namespace. The returned `SpareMaker`
 * makes the vat's one session.
 *
 * Two endowments are the session program's own, never the inventory's:
 * - `workspaceSeedLabel` (a legacy factory's project source): handed to
 *   `EnvironmentControl.useWorkspaceSeed` and kept as
 *   `services.projectSource`, which `spawnSubagent` passes to each child
 *   (D-M9-28);
 * - `subagentModelLabel` (a subagent's model choice, D-M9-27): checked by
 *   `checkedSubagentConfig` against the session's backend and applied to
 *   its config; `services.modelOverridden` tells `spawnSubagent` that the
 *   factory's record of this session's model is not the one it runs on.
 */
import { interfaces } from '../lib/guards/session.js';
import { workspaceSeedLabel } from '../lib/workspace-seed.js';
import {
  checkedSubagentConfig,
  subagentModelLabel,
} from '../lib/subagent-model.js';
import { makeSession } from './session.js';

// The exo methods are typed loosely; the interface guards check the values.
const { E, makeExo } = /** @type {any} */ (globalThis);

/** The text a second `make` throws (one session per vat). */
export const ALREADY_MADE = 'this vat already made its session';

/**
 * @param {any} services
 * @param {string} label
 */
const endowmentOf = (services, label) =>
  services.endowments?.find(
    (/** @type {any} */ entry) => entry.label === label,
  );

export const makeSpareMaker = () => {
  let made = false;
  return makeExo('SpareMaker', interfaces.SpareMaker, {
    /** @param {{ config: any, services: any, rowReporter: any }} makeArgs */
    make(makeArgs) {
      if (made) throw Error(ALREADY_MADE);
      made = true;
      const { services, config } = makeArgs;
      const seed = endowmentOf(services, workspaceSeedLabel);
      const model = endowmentOf(services, subagentModelLabel);
      if (seed === undefined && model === undefined)
        return makeSession(makeArgs);
      const seeding =
        seed === undefined
          ? undefined
          : E(services.environment).useWorkspaceSeed(seed.value);
      const checking =
        model === undefined
          ? undefined
          : checkedSubagentConfig(config, services.backend, model.value);
      return Promise.all([seeding, checking]).then(
        ([workspaceSeed, checked]) => {
          let next = checked === undefined ? config : checked.config;
          if (workspaceSeed !== undefined)
            next = { ...next, preset: { ...next.preset, workspaceSeed } };
          return makeSession(
            harden({
              ...makeArgs,
              config: next,
              services: {
                ...services,
                endowments: services.endowments.filter(
                  (/** @type {any} */ entry) =>
                    entry !== seed && entry !== model,
                ),
                ...(seed === undefined ? {} : { projectSource: seed.value }),
                ...(checked?.overridden ? { modelOverridden: true } : {}),
              },
            }),
          );
        },
      );
    },
  });
};
harden(makeSpareMaker);
