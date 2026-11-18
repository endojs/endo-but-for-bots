// @ts-check
/**
 * M5's provisioning step (W5.5, m5-interfaces.md 9.1 H-10), a registered
 * step file (`scripts/provision-steps.js` header; moved here from the table
 * at the M5 merge, INT-M5).
 */
import { has } from '../provision-steps.js';

/**
 * The M5 fixture step: a no-op answering `{ skipped: true }` unless
 * `options.m5Fixtures` is given, which only test templates do (provisioning
 * runs at every start, P-28). `options.m5Fixtures` is `{ name, source }` of
 * `test/fixtures/m5-objects.js` (`m5FixtureName`, `m5FixtureSource`): the
 * workspace vat evaluates `source` (an expression answering the fixture
 * maker) and keeps what it makes in its inventory under `name`, once.
 * @type {import('../provision-steps.js').ProvisionStep}
 */
export const m5FixtureStep = harden({
  name: 'm5 fixtures',
  run: async ({ client, options }) => {
    const fixtures = /** @type {any} */ (options).m5Fixtures;
    if (fixtures === undefined) return { skipped: true };
    const { name, source } = fixtures;
    if (await has(client, name)) return { skipped: true, detail: { name } };
    await client.call(
      'evaluate',
      `(inventory.set(${JSON.stringify(name)}, (${source})()), true)`,
    );
    if (!(await has(client, name)))
      throw Error(`the m5 fixtures were not kept as ${name}`);
    return { skipped: false, detail: { name } };
  },
});

/** @type {import('../provision-steps.js').ProvisionStep[]} */
export const steps = harden([m5FixtureStep]);
