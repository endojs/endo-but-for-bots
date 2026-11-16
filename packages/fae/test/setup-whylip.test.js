// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { makeMarshal } from '@endo/marshal';
import { restoreWhylipDrivers, setupWhylip } from '../setup-whylip.js';

const DRIVER = new URL('../driver.js', import.meta.url).href;

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
  restoreWhylipDrivers(
    fixture.host,
    fixture.diagnostics,
    'private-pins',
    'recipe',
  );

test('private Whylip restoration resolves only validated owned drivers', async t => {
  const f = makeRestoreFixture();
  f.add('primer-agent');
  f.add('second-agent');
  const restored = await restore(f);
  t.is(restored, 2);
  t.deepEqual(f.revived, ['primer-agent-driver', 'second-agent-driver']);
});

test('private Whylip restoration validates the entire set before reviving any driver', async t => {
  const f = makeRestoreFixture();
  f.add('first-agent');
  f.add('second-agent').inventory.set('llm-provider', 'foreign-recipe');
  await t.throwsAsync(restore(f), { message: /recipe changed/ });
  t.deepEqual(f.revived, []);
});

test('private Whylip restoration refuses unrelated pins without resolving them', async t => {
  const f = makeRestoreFixture();
  f.add('first-agent');
  f.bindings.set('@pins/arbitrary-service', 'foreign-code');
  await t.throwsAsync(restore(f), { message: /Unexpected Whylip driver pin/ });
  t.deepEqual(f.revived, []);
});

for (const [description, corrupt] of [
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
]) {
  test(`private Whylip restoration rejects ${description}`, async t => {
    const f = makeRestoreFixture();
    f.add('book-agent');
    corrupt(f);
    await t.throwsAsync(restore(f));
    t.deepEqual(f.revived, []);
  });
}

for (const target of ['book-agent-driver-powers', 'book-agent-guest']) {
  test(`private Whylip restoration rejects borrowed guest ${target}`, async t => {
    const f = makeRestoreFixture();
    f.add('book-agent');
    f.formulas.get(target).properties.hostAgent.identifier = 'foreign-owner';
    await t.throwsAsync(restore(f));
    t.deepEqual(f.revived, []);
  });
}

test('private Whylip restoration rejects a host substituted for its agent guest', async t => {
  const f = makeRestoreFixture();
  f.add('book-agent');
  f.formulas.get('book-agent-guest').type = 'host';
  await t.throwsAsync(restore(f));
  t.deepEqual(f.revived, []);
});

const OWNER = '@pins/installations/whylip';
const SOURCE = 'floot/controller-profile/codex-inference';
const SUBSCRIPTION = new URL(
  '../../hosted-agent/src/subscription-module.js',
  import.meta.url,
).href;

// A metadata-oriented host fixture. Formula inspection never resolves a module;
// only lookup does, and every write/resolution is observable by these tests.
const makeSetupFixture = () => {
  const names = new Map();
  const formulas = new Map();
  const values = new Map();
  const capIds = new WeakMap();
  const envs = new Map();
  const namespaces = new Map();
  const writes = [];
  const lookups = [];
  const catalogCalls = [];
  let nextId = 0;
  let failWrite;
  const catalog = [
    {
      backendId: 'fae-codex',
      modelId: 'gpt-5.6-sol',
      reasoningEfforts: ['low', 'medium'],
      contextLength: 272_000,
    },
  ];
  /** @param {string | string[]} path */
  const keyOf = path => (Array.isArray(path) ? path.join('/') : path);
  const mint = (type, properties = {}, value = Far(type, {})) => {
    nextId += 1;
    const id = `${type}-${nextId}`;
    formulas.set(id, { type, properties });
    values.set(id, value);
    if (value && typeof value === 'object') capIds.set(value, id);
    return id;
  };
  const recordWrite = (operation, path) => {
    const key = keyOf(path);
    writes.push({ operation, path: key });
    if (failWrite?.operation === operation && failWrite?.path === key) {
      failWrite = undefined;
      throw Error('Injected setup interruption');
    }
  };
  const addDirectory = path => {
    const parts = keyOf(path).split('/');
    for (let i = 1; i <= parts.length; i += 1) {
      const key = parts.slice(0, i).join('/');
      if (!names.has(key)) names.set(key, mint('directory'));
    }
  };
  const marshal = makeMarshal(
    cap => {
      const id = capIds.get(cap);
      if (!id) throw Error('Unknown fixture capability');
      return id;
    },
    id => values.get(id),
    { serializeBodyFormat: 'smallcaps' },
  );
  const store = (value, key) => {
    const encoded = marshal.serialize(value);
    const id = mint(
      'marshal',
      {
        body: { value: encoded.body },
        slots: {
          entries: Object.fromEntries(
            encoded.slots.map((slot, i) => [String(i), slot]),
          ),
        },
      },
      value,
    );
    names.set(key, id);
    return id;
  };
  const namespace = (id, pins) => {
    const bindings = new Map([['@agent', id]]);
    if (pins) bindings.set('@pins', pins);
    namespaces.set(id, bindings);
    const cap = Far('Owned namespace', {
      has: (...path) => bindings.has(path.join('/')),
      identify: (...path) => bindings.get(path.join('/')),
      list: () =>
        harden(
          [...bindings.keys()]
            .filter(name => name.startsWith('@pins/'))
            .map(name => name.slice(6)),
        ),
      lookup: path => values.get(bindings.get(keyOf(path))),
      storeLocator: (name, locator) => {
        recordWrite('storeLocator', `${id}/${name}`);
        bindings.set(name, locator.slice('fixture:'.length));
      },
    });
    values.set(id, cap);
    capIds.set(cap, id);
    return cap;
  };
  const rootId = mint('host');
  const rootHandle = mint('handle', { agent: { identifier: rootId } });
  names.set('@agent', rootId);
  names.set('@self', rootHandle);
  addDirectory('@pins');
  addDirectory('floot/controller-profile');
  const brokerId = mint('make-unconfined');
  const workerId = mint('worker');
  const sourceId = mint('make-unconfined', {
    specifier: { value: SUBSCRIPTION },
    powers: { identifier: brokerId },
    worker: { identifier: workerId },
  });
  envs.set(sourceId, {});
  names.set(SOURCE, sourceId);
  const controllerId = mint(
    'make-unconfined',
    {},
    Far('Shared Floot catalog', {
      listModels: backend => {
        catalogCalls.push(backend);
        return harden(catalog.map(row => ({ ...row })));
      },
    }),
  );
  names.set('floot/controller', controllerId);
  const diagnostics = Far('Formula metadata', {
    getFormula: id => {
      const formula = formulas.get(id);
      if (!formula) throw Error('Missing historical formula');
      return harden(JSON.parse(JSON.stringify(formula)));
    },
  });
  const root = Far('Fixture host', {
    diagnostics: () => diagnostics,
    has: (...path) => names.has(path.join('/')),
    identify: (...path) => names.get(path.join('/')),
    locate: (...path) => `fixture:${names.get(path.join('/'))}`,
    getFormulaEnvironment: id => harden({ ...envs.get(id) }),
    lookup: path => {
      const key = keyOf(path);
      lookups.push(key);
      const id = names.get(key);
      if (!id) throw Error(`Unknown fixture name ${key}`);
      return values.get(id);
    },
    list: (...path) => {
      const prefix = `${path.join('/')}/`;
      return harden(
        [...names.keys()]
          .filter(
            name =>
              name.startsWith(prefix) &&
              !name.slice(prefix.length).includes('/'),
          )
          .map(name => name.slice(prefix.length)),
      );
    },
    provideDirectory: path => {
      recordWrite('provideDirectory', path);
      addDirectory(path);
      return values.get(names.get(keyOf(path)));
    },
    storeValue: (value, path) => {
      recordWrite('storeValue', path);
      store(value, keyOf(path));
    },
    provideHost: (path, options) => {
      recordWrite('provideHost', path);
      const pins = capIds.get(options.pins);
      const id = mint('host', {
        pins: { identifier: pins },
        hostHandle: { identifier: rootHandle },
      });
      const handle = mint('handle', { agent: { identifier: id } });
      formulas.get(id).properties.handle = { identifier: handle };
      names.set(keyOf(path), handle);
      names.set(keyOf(options.agentName), id);
      return namespace(id, pins);
    },
    provideGuest: (path, options) => {
      recordWrite('provideGuest', path);
      const id = mint('guest', { hostAgent: { identifier: rootId } });
      const handle = mint('handle', { agent: { identifier: id } });
      formulas.get(id).properties.handle = { identifier: handle };
      names.set(keyOf(path), handle);
      names.set(keyOf(options.agentName), id);
      return namespace(id);
    },
    provideWorker: path => {
      recordWrite('provideWorker', path);
      names.set(keyOf(path), mint('worker'));
    },
    makeUnconfined: (worker, specifier, options) => {
      recordWrite('makeUnconfined', options.resultName);
      const id = mint('make-unconfined', {
        specifier: { value: specifier },
        worker: { identifier: names.get(keyOf(worker)) },
        powers: { identifier: names.get(keyOf(options.powersName)) },
      });
      names.set(keyOf(options.resultName), id);
      envs.set(id, options.env || {});
      return values.get(id);
    },
  });
  values.set(rootId, root);
  capIds.set(root, rootId);
  return {
    root,
    names,
    formulas,
    envs,
    values,
    namespaces,
    writes,
    lookups,
    catalogCalls,
    catalog,
    sourceId,
    mint,
    store,
    failNext: (operation, path) => {
      failWrite = { operation, path };
    },
    leafId: leaf => names.get(`${OWNER}/${leaf}`),
  };
};

test('Whylip setup shares inference and keeps all installation identities on rerun', async t => {
  const f = makeSetupFixture();
  const result = await setupWhylip(f.root);
  t.deepEqual(result, { ready: true, restored: 0 });
  const recipeId = f.leafId('recipe');
  const recipe = f.values.get(recipeId);
  t.is(recipe.subscription, f.values.get(f.sourceId));
  t.is(recipe.model, 'gpt-5.6-sol');
  t.deepEqual(f.catalogCalls, ['fae-codex']);
  const before = [...f.names.entries()];
  f.writes.length = 0;
  f.lookups.length = 0;
  f.catalog.length = 0; // Retained books do not get reconfigured by catalog churn.
  await setupWhylip(f.root, { model: 'different', reasoningEffort: 'ultra' });
  t.deepEqual([...f.names.entries()], before);
  t.deepEqual(f.writes, []);
  t.false(f.lookups.includes(SOURCE));
  t.false(f.lookups.includes(`${OWNER}/recipe`));
  t.is(f.leafId('recipe'), recipeId);
  t.true(f.writes.every(write => write.path.startsWith(OWNER)));
});

test('Whylip setup rejects unsupported model before installing anything', async t => {
  const f = makeSetupFixture();
  await t.throwsAsync(setupWhylip(f.root, { model: 'unknown' }), {
    message: /not supported/,
  });
  t.deepEqual(f.writes, []);
});

test('Whylip setup retains recipe identity across equivalent shared facade republication', async t => {
  const f = makeSetupFixture();
  await setupWhylip(f.root);
  const recipeId = f.leafId('recipe');
  const replacement = f.mint(
    'make-unconfined',
    structuredClone(f.formulas.get(f.sourceId).properties),
  );
  f.envs.set(replacement, {});
  f.names.set(SOURCE, replacement);
  f.writes.length = 0;
  await setupWhylip(f.root);
  t.is(f.leafId('recipe'), recipeId);
  t.deepEqual(f.writes, []);
});

for (const dependency of ['powers', 'worker', 'specifier', 'env']) {
  test(`Whylip setup refuses a shared facade with different ${dependency}`, async t => {
    const f = makeSetupFixture();
    await setupWhylip(f.root);
    const props = structuredClone(f.formulas.get(f.sourceId).properties);
    if (dependency === 'specifier')
      props.specifier.value = 'file:///foreign.js';
    else if (dependency !== 'env') props[dependency].identifier = 'foreign';
    const replacement = f.mint('make-unconfined', props);
    f.envs.set(replacement, dependency === 'env' ? { DIFFERENT: 'true' } : {});
    f.names.set(SOURCE, replacement);
    f.writes.length = 0;
    await t.throwsAsync(setupWhylip(f.root));
    t.deepEqual(f.writes, []);
  });
}

for (const broken of [
  'recipe',
  'agent-pins',
  'factory-state',
  'factory-worker',
]) {
  test(`Whylip setup refuses missing existing ${broken} before any write`, async t => {
    const f = makeSetupFixture();
    await setupWhylip(f.root);
    f.names.delete(`${OWNER}/${broken}`);
    f.writes.length = 0;
    await t.throwsAsync(setupWhylip(f.root));
    t.deepEqual(f.writes, []);
  });
}

test('Whylip setup rejects malformed retained recipe without resolving it', async t => {
  const f = makeSetupFixture();
  await setupWhylip(f.root);
  f.store(
    harden({ kind: 'anything', subscription: f.values.get(f.sourceId) }),
    `${OWNER}/recipe`,
  );
  f.writes.length = 0;
  f.lookups.length = 0;
  await t.throwsAsync(setupWhylip(f.root), { message: /Invalid retained/ });
  t.deepEqual(f.writes, []);
  t.false(f.lookups.includes(`${OWNER}/recipe`));
  t.false(f.lookups.includes(SOURCE));
});

for (const changed of ['host-agent', 'llm-provider']) {
  test(`Whylip setup rejects changed factory ${changed} before any write`, async t => {
    const f = makeSetupFixture();
    await setupWhylip(f.root);
    f.namespaces.get(f.leafId('factory-state')).set(changed, 'foreign');
    f.writes.length = 0;
    await t.throwsAsync(setupWhylip(f.root), { message: /endowment changed/ });
    t.deepEqual(f.writes, []);
  });
}

test('Whylip setup rejects changed factory construction environment before any write', async t => {
  const f = makeSetupFixture();
  await setupWhylip(f.root);
  f.envs.set(f.leafId('factory'), { FAE_SUBAGENT_MAX_DEPTH: '12' });
  f.writes.length = 0;
  await t.throwsAsync(setupWhylip(f.root), { message: /dependencies changed/ });
  t.deepEqual(f.writes, []);
});

test('Whylip setup retries an interrupted factory mint without reminting owner or recipe', async t => {
  const f = makeSetupFixture();
  f.failNext('makeUnconfined', `${OWNER}/factory`);
  await t.throwsAsync(setupWhylip(f.root), { message: /Injected/ });
  const owner = f.leafId('agents');
  const recipe = f.leafId('recipe');
  await setupWhylip(f.root);
  t.is(f.leafId('agents'), owner);
  t.is(f.leafId('recipe'), recipe);
});

test('concurrent Whylip setup calls share one installation', async t => {
  const f = makeSetupFixture();
  await Promise.all([setupWhylip(f.root), setupWhylip(f.root)]);
  t.is(f.writes.filter(write => write.operation === 'provideHost').length, 1);
  t.is(f.writes.filter(write => write.operation === 'storeValue').length, 1);
});

for (const changed of ['root-host', 'factory']) {
  test(`Whylip setup rejects changed books ${changed} before any write`, async t => {
    const f = makeSetupFixture();
    await setupWhylip(f.root);
    f.namespaces.get(f.leafId('books-state')).set(changed, 'foreign');
    f.writes.length = 0;
    await t.throwsAsync(setupWhylip(f.root), {
      message: /books endowment changed/,
    });
    t.deepEqual(f.writes, []);
  });
}

test('Whylip setup provisions only the books service with root authority', async t => {
  const f = makeSetupFixture();
  await setupWhylip(f.root);
  const factory = f.namespaces.get(f.leafId('factory-state'));
  const books = f.namespaces.get(f.leafId('books-state'));
  t.false(factory.has('root-host'));
  t.is(factory.get('host-agent'), f.leafId('agents'));
  t.is(books.get('root-host'), f.names.get('@agent'));
  t.is(books.get('factory'), f.leafId('factory'));
  t.is(
    f.formulas.get(f.leafId('books-service')).properties.powers.identifier,
    f.leafId('books-state'),
  );
  t.is(
    f.formulas.get(f.leafId('books-service')).properties.worker.identifier,
    f.leafId('factory-worker'),
  );
  t.true(
    f.writes
      .filter(write => !write.operation.startsWith('storeLocator'))
      .every(write => write.path.startsWith(OWNER)),
  );
});

for (const field of ['powers', 'worker', 'specifier']) {
  test(`Whylip setup rejects changed books service ${field} before any write`, async t => {
    const f = makeSetupFixture();
    await setupWhylip(f.root);
    const props = f.formulas.get(f.leafId('books-service')).properties;
    if (field === 'specifier') props[field].value = 'file:///foreign.js';
    else props[field].identifier = 'foreign';
    f.writes.length = 0;
    await t.throwsAsync(setupWhylip(f.root), {
      message: /books service dependencies changed/,
    });
    t.deepEqual(f.writes, []);
  });
}

test('Whylip setup can resume failed books-service construction', async t => {
  const f = makeSetupFixture();
  f.failNext('makeUnconfined', `${OWNER}/books-service`);
  await t.throwsAsync(setupWhylip(f.root), { message: /Injected/ });
  const factoryId = f.leafId('factory');
  const stateId = f.leafId('books-state');
  await setupWhylip(f.root);
  t.is(f.leafId('factory'), factoryId);
  t.is(f.leafId('books-state'), stateId);
  t.truthy(f.leafId('books-service'));
});

test('Whylip setup rejects a forged recipe subscription without incarnating it', async t => {
  const f = makeSetupFixture();
  await setupWhylip(f.root);
  const foreignId = f.mint('make-unconfined', {
    specifier: { value: SUBSCRIPTION },
    powers: { identifier: 'foreign-broker' },
    worker: {
      identifier: f.formulas.get(f.sourceId).properties.worker.identifier,
    },
  });
  f.envs.set(foreignId, {});
  f.store(
    harden({
      kind: 'subscription-responses',
      subscription: f.values.get(foreignId),
      model: 'gpt-5.6-sol',
    }),
    `${OWNER}/recipe`,
  );
  f.writes.length = 0;
  f.lookups.length = 0;
  await t.throwsAsync(setupWhylip(f.root), {
    message: /differs from shared backend/,
  });
  t.deepEqual(f.writes, []);
  t.deepEqual(f.lookups, []);
});

test('Whylip setup refuses a lost historical subscription formula instead of adopting current facade', async t => {
  const f = makeSetupFixture();
  await setupWhylip(f.root);
  const replacement = f.mint(
    'make-unconfined',
    structuredClone(f.formulas.get(f.sourceId).properties),
  );
  f.envs.set(replacement, {});
  f.names.set(SOURCE, replacement);
  f.formulas.delete(f.sourceId);
  f.writes.length = 0;
  await t.throwsAsync(setupWhylip(f.root), {
    message: /Missing historical formula/,
  });
  t.deepEqual(f.writes, []);
});

test('Whylip source comparison accepts an absolute-path spelling of the same module', async t => {
  const f = makeSetupFixture();
  f.formulas.get(f.sourceId).properties.specifier.value = new URL(
    SUBSCRIPTION,
  ).pathname;
  await t.notThrowsAsync(setupWhylip(f.root));
});
