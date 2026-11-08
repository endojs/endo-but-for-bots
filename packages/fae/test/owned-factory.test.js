// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { restoreOwnedDrivers } from '../src/owned-factory.js';

const DRIVER = new URL('driver.js', import.meta.resolve('@endo/fae')).href;

const makeRestoreFixture = () => {
  const bindings = new Map([
    ['@pins', 'private-pins'],
    ['@agent', 'private-owner'],
  ]);
  const formulas = new Map();
  const inventories = new Map();
  const revived = [];
  const add = name => {
    const driver = `${name}-driver`;
    const powers = `${driver}-powers`;
    const agent = `${name}-guest`;
    bindings.set(`@pins/${driver}`, driver);
    bindings.set(driver, driver);
    bindings.set(`profile-for-${driver}-handle`, powers);
    bindings.set(`profile-for-${name}`, agent);
    bindings.set(`${driver}-handle`, `${powers}-handle`);
    bindings.set(name, `${agent}-handle`);
    formulas.set(`${powers}-handle`, {
      type: 'handle',
      properties: { agent: { identifier: powers } },
    });
    formulas.set(`${agent}-handle`, {
      type: 'handle',
      properties: { agent: { identifier: agent } },
    });
    formulas.set(driver, {
      type: 'make-unconfined',
      properties: {
        specifier: { value: DRIVER },
        powers: { identifier: powers },
      },
    });
    formulas.set(powers, {
      type: 'guest',
      properties: {
        hostAgent: { identifier: 'private-owner' },
        handle: { identifier: `${powers}-handle` },
      },
    });
    formulas.set(agent, {
      type: 'guest',
      properties: {
        hostAgent: { identifier: 'private-owner' },
        handle: { identifier: `${agent}-handle` },
      },
    });
    const inventory = new Map([
      ['agent', agent],
      ['llm-provider', 'recipe'],
    ]);
    inventories.set(powers, inventory);
    return { driver, powers, agent, inventory };
  };
  const host = Far('Whylip private owner', {
    identify: (...path) => bindings.get(path.join('/')),
    list: () =>
      harden(
        [...bindings.keys()]
          .filter(key => key.startsWith('@pins/'))
          .map(key => key.slice('@pins/'.length)),
      ),
    lookup: path => {
      const key = Array.isArray(path) ? path.join('/') : path;
      const id = bindings.get(key);
      if (key.startsWith('@pins/')) {
        revived.push(id);
        return Far('Restored driver', {});
      }
      const inventory = inventories.get(id);
      if (!inventory) throw Error('Unexpected lookup');
      return Far('Driver powers', {
        identify: name => inventory.get(name),
      });
    },
  });
  const diagnostics = Far('Whylip diagnostics', {
    getFormula: id => harden(formulas.get(id)),
  });
  return { host, diagnostics, bindings, formulas, inventories, revived, add };
};

const restore = fixture =>
  restoreOwnedDrivers(
    fixture.host,
    fixture.diagnostics,
    'private-pins',
    'recipe',
  );

test('owned Fae driver restoration resolves only validated owned drivers', async t => {
  const f = makeRestoreFixture();
  f.add('primer-agent');
  f.add('second-agent');
  const restored = await restore(f);
  t.is(restored, 2);
  t.deepEqual(f.revived, ['primer-agent-driver', 'second-agent-driver']);
});

test('owned Fae driver restoration validates the entire set before reviving any driver', async t => {
  const f = makeRestoreFixture();
  f.add('first-agent');
  f.add('second-agent').inventory.set('llm-provider', 'foreign-recipe');
  await t.throwsAsync(restore(f), { message: /recipe changed/ });
  t.deepEqual(f.revived, []);
});

test('owned Fae driver restoration refuses unrelated pins without resolving them', async t => {
  const f = makeRestoreFixture();
  f.add('first-agent');
  f.bindings.set('@pins/arbitrary-service', 'foreign-code');
  await t.throwsAsync(restore(f), { message: /Unexpected Fae driver pin/ });
  t.deepEqual(f.revived, []);
});

/** @type {Array<[string,(f:ReturnType<typeof makeRestoreFixture>) => unknown]>} */
const corruptions = [
  ['shared pins directory', f => f.bindings.set('@pins', 'root-pins')],
  ['pin alias substitution', f => f.bindings.set('book-agent-driver', 'other')],
  ['missing agent', f => f.bindings.delete('profile-for-book-agent')],
  [
    'different entrypoint',
    f => {
      f.formulas.get('book-agent-driver').properties.specifier.value =
        'file:///unrelated.js';
    },
  ],
  [
    'different driver powers',
    f => {
      f.formulas.get('book-agent-driver').properties.powers.identifier =
        'other';
    },
  ],
  [
    'non-guest driver powers',
    f => {
      f.formulas.get('book-agent-driver-powers').type = 'host';
    },
  ],
  [
    'different agent reference',
    f => {
      f.inventories.get('book-agent-driver-powers').set('agent', 'other');
    },
  ],
];
for (const [description, corrupt] of corruptions) {
  test(`owned Fae driver restoration rejects ${description}`, async t => {
    const f = makeRestoreFixture();
    f.add('book-agent');
    corrupt(f);
    await t.throwsAsync(restore(f));
    t.deepEqual(f.revived, []);
  });
}

for (const target of ['book-agent-driver-powers', 'book-agent-guest']) {
  test(`owned Fae driver restoration rejects borrowed guest ${target}`, async t => {
    const f = makeRestoreFixture();
    f.add('book-agent');
    f.formulas.get(target).properties.hostAgent.identifier = 'foreign-owner';
    await t.throwsAsync(restore(f));
    t.deepEqual(f.revived, []);
  });
}

test('owned Fae driver restoration rejects a host substituted for its agent guest', async t => {
  const f = makeRestoreFixture();
  f.add('book-agent');
  f.formulas.get('book-agent-guest').type = 'host';
  await t.throwsAsync(restore(f));
  t.deepEqual(f.revived, []);
});
