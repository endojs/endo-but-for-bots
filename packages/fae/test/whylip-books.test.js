// @ts-check
/* eslint-disable no-await-in-loop -- Each case checks recovery in operation order. */
import '@endo/init/debug.js';
import test from 'ava';
import { Far } from '@endo/far';
import { E } from '@endo/eventual-send';
import {
  make,
  createWhylipBook,
  WHYLIP_SYSTEM_PROMPT,
} from '../whylip-books.js';

const installation = ['@pins', 'installations', 'whylip'];
const fixture = () => {
  const nodes = new Map();
  let sequence = 0;
  let failure;
  let hostCreations = 0;
  let agentCreations = 0;
  const agentRequests = new Map();
  const events = [];
  const pathOf = value => (Array.isArray(value) ? value : [value]);
  const resolve = path => {
    let id = 'root';
    for (const name of path) {
      id = nodes.get(id)?.children?.get(name);
      if (!id) return undefined;
    }
    return id;
  };
  const parent = path => nodes.get(resolve(path.slice(0, -1))).children;
  const bind = (path, type, id = undefined, properties = {}) => {
    if (id === undefined) {
      sequence += 1;
      id = `id-${sequence}`;
    }
    if (!nodes.has(id))
      nodes.set(id, { type, properties, children: new Map() });
    parent(path).set(path.at(-1), id);
    return id;
  };
  const trip = label => {
    if (failure === label) {
      failure = undefined;
      throw Error(`Lost acknowledgement: ${label}`);
    }
  };
  const facet = prefix =>
    Far('Book directory', {
      has: (...path) => Boolean(resolve([...prefix, ...path])),
      identify: (...path) => resolve([...prefix, ...path]),
      storeLocator(name, locator) {
        events.push('book:store');
        parent([...prefix, name]).set(name, locator.slice('locator:'.length));
        trip('book:store');
      },
    });
  const factory = Far('Factory', {
    __getMethodNames__: () => harden(['provideAgentLocator']),
    provideAgentLocator(name, options) {
      events.push('factory');
      if (agentRequests.has(name)) {
        const request = agentRequests.get(name);
        if (JSON.stringify(request.options) !== JSON.stringify(options))
          throw Error('Factory recipe collision');
      } else {
        agentCreations += 1;
        const id = `agent-${agentCreations}`;
        nodes.set(id, { type: 'handle', properties: {} });
        agentRequests.set(name, { id, options });
      }
      trip('factory');
      return `locator:${agentRequests.get(name).id}`;
    },
  });
  nodes.set('root', { type: 'host', children: new Map() });
  const root = Far('Root', {
    has: (...path) => Boolean(resolve(path)),
    identify: (...path) => resolve(path),
    list: (...path) => harden([...nodes.get(resolve(path)).children.keys()]),
    diagnostics: () =>
      Far('Diagnostics', {
        getFormula: id =>
          harden({
            type: nodes.get(id).type,
            properties: nodes.get(id).properties,
          }),
      }),
    lookup(path) {
      path = pathOf(path);
      const id = resolve(path);
      if (!id) throw Error('Missing object');
      if (id === 'factory') return factory;
      return facet(path);
    },
    provideDirectory(path) {
      const segments = /** @type {string[]} */ (path);
      events.push('directory');
      for (let i = 1; i <= segments.length; i += 1) {
        const part = segments.slice(0, i);
        const id = resolve(part);
        if (!id) bind(part, 'directory');
        else if (nodes.get(id).type !== 'directory')
          throw Error('Directory conflict');
      }
      trip('directory');
      return facet(path);
    },
    copy(from, to) {
      events.push('copy');
      parent(to).set(to.at(-1), resolve(from));
      trip('copy');
    },
    locate: (...path) => `locator:${resolve(path)}`,
    storeLocator(path, locator) {
      events.push('agent:store');
      path = pathOf(path);
      parent(path).set(path.at(-1), locator.slice('locator:'.length));
      trip('agent:store');
    },
    storeValue(value, path) {
      events.push('space:store');
      bind(path, 'marshal', undefined, {
        body: { kind: 'literal', value: JSON.stringify(value) },
        slots: { kind: 'reference-list', entries: {} },
      });
      trip('space:store');
    },
    provideHost(handlePath, { agentName, pins }) {
      events.push('host');
      hostCreations += 1;
      const handle = bind(handlePath, 'handle');
      if (failure === 'partial:host') {
        trip('partial:host');
      }
      bind(agentName, 'host', undefined, {
        handle: { kind: 'reference', identifier: handle },
        pins: {
          kind: 'reference',
          identifier: resolve([...handlePath.slice(0, -1), 'pins']),
        },
      });
      trip('host');
      return facet(agentName);
    },
  });
  for (let i = 1; i <= installation.length; i += 1)
    bind(installation.slice(0, i), 'directory');
  bind([...installation, 'factory'], 'make-unconfined', 'factory');
  const powers = Far('Service powers', {
    lookup: name => (name === 'root-host' ? root : factory),
  });
  return {
    root,
    factory,
    powers,
    resolve,
    nodes,
    bind,
    events,
    agentRequests,
    fail: label => {
      failure = label;
    },
    counts: () => ({ hostCreations, agentCreations }),
    create: name => createWhylipBook(root, factory, name),
  };
};

test('creates a normal pinned Fae book with private recovery objects and no root setup names', async t => {
  const f = fixture();
  t.deepEqual(await f.create('physics'), ['whylip', 'physics']);
  const path = [...installation, 'books', 'physics'];
  t.deepEqual(await E(f.root).list(), ['@pins', 'whylip']);
  t.deepEqual(await E(f.root).list(...path), [
    'factory',
    'agent',
    'pins',
    'handle',
  ]);
  t.is(f.resolve(['whylip', 'physics', 'fae']), f.resolve([...path, 'agent']));
  t.deepEqual(f.agentRequests.get('physics-agent').options, {
    systemPrompt: WHYLIP_SYSTEM_PROMPT,
    pin: true,
  });
  t.deepEqual(f.counts(), { hostCreations: 1, agentCreations: 1 });
});

test('concurrent calls through separate service facets serialize and reuse both identities', async t => {
  const f = fixture();
  const first = await make(f.powers);
  const second = await make(f.powers);
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      E(i % 2 ? first : second).createBook('physics'),
    ),
  );
  for (const result of results) t.deepEqual(result, ['whylip', 'physics']);
  t.deepEqual(f.counts(), { hostCreations: 1, agentCreations: 1 });
});

test('lost acknowledgements recover after a new service facet without duplicate agent or host', async t => {
  for (const stage of [
    'directory',
    'copy',
    'factory',
    'agent:store',
    'host',
    'book:store',
  ]) {
    const f = fixture();
    f.fail(stage);
    const first = await make(f.powers);
    await t.throwsAsync(E(first).createBook('physics'), {
      message: /Lost acknowledgement/,
    });
    const second = await make(f.powers);
    t.deepEqual(await E(second).createBook('physics'), ['whylip', 'physics']);
    t.deepEqual(f.counts(), { hostCreations: 1, agentCreations: 1 }, stage);
  }
});

test('rejects root collisions and invalid names before creating any resources', async t => {
  for (const name of ['', '../escape', 'bad/name', 'a'.repeat(81)]) {
    const f = fixture();
    await t.throwsAsync(f.create(name), { message: /Invalid/ });
    t.deepEqual(f.events, []);
  }
  const f = fixture();
  const id = f.bind(['whylip'], 'guest');
  await t.throwsAsync(f.create('physics'), { message: /conflicts/ });
  t.is(f.resolve(['whylip']), id);
  t.deepEqual(f.events, []);
});

test('partial host publication refuses retry without replacing retained handle', async t => {
  const f = fixture();
  f.fail('partial:host');
  await t.throwsAsync(f.create('physics'), { message: /Lost/ });
  const path = [...installation, 'books', 'physics', 'handle'];
  const handle = f.resolve(path);
  await t.throwsAsync(f.create('physics'), { message: /profile conflicts/ });
  t.is(f.resolve(path), handle);
  t.deepEqual(f.counts(), { hostCreations: 1, agentCreations: 1 });
});

test('completed book refuses replaced factory, agent binding, pins, or public host without writes', async t => {
  for (const mutate of [
    f =>
      f.bind(
        [...installation, 'books', 'physics', 'factory'],
        'make-unconfined',
      ),
    f => f.bind(['whylip', 'physics', 'fae'], 'handle'),
    f => f.bind([...installation, 'books', 'physics', 'pins'], 'directory'),
    f => f.bind(['whylip', 'physics'], 'host'),
    f => f.bind([...installation, 'books', 'physics', 'unexpected'], 'marshal'),
  ]) {
    const f = fixture();
    await f.create('physics');
    mutate(f);
    f.events.length = 0;
    await t.throwsAsync(f.create('physics'));
    t.deepEqual(f.events, []);
  }
});

test('many independent books keep root and installation namespaces bounded', async t => {
  const f = fixture();
  await Promise.all(
    Array.from({ length: 16 }, (_, i) => f.create(`book-${i}`)),
  );
  t.deepEqual(await E(f.root).list(), ['@pins', 'whylip']);
  t.deepEqual(await E(f.root).list(...installation), ['factory', 'books']);
  t.is((await E(f.root).list(...installation, 'books')).length, 16);
  t.is((await E(f.root).list('whylip')).length, 16);
  t.deepEqual(f.counts(), { hostCreations: 16, agentCreations: 16 });
});

const selfId = `${'a'.repeat(64)}:${'b'.repeat(64)}`;
const savedPath = ['@pins', 'installations', 'chat', 'a'.repeat(64), 'spaces'];
const config = harden({
  name: 'Physics',
  icon: 'P',
  mode: 'whylip',
  profilePath: ['whylip', 'physics'],
  scheme: 'dark',
});
const prepareSpaces = async f => {
  f.bind(['@self'], 'handle', selfId);
  await E(f.root).provideDirectory(savedPath);
  await E(f.root).storeValue(
    harden({
      id: '1',
      name: 'Files',
      icon: 'F',
      mode: 'files',
      profilePath: ['files'],
    }),
    [...savedPath, '1'],
  );
};

test('two stale clients save one deterministic view and keep the first preferences and unrelated space', async t => {
  const f = fixture();
  await prepareSpaces(f);
  const other = f.resolve([...savedPath, '1']);
  const one = await make(f.powers);
  const two = await make(f.powers);
  const [first, second] = await Promise.all([
    E(one).provideSpace(config),
    E(two).provideSpace(harden({ ...config, name: 'Second', scheme: 'light' })),
  ]);
  t.deepEqual(second, first);
  t.is(first.id, 'whylip-physics');
  t.is(first.name, 'Physics');
  t.deepEqual(await E(f.root).list(...savedPath), ['1', 'whylip-physics']);
  t.is(f.resolve([...savedPath, '1']), other);
  const identity = f.resolve([...savedPath, first.id]);
  await E(two).provideSpace(config);
  t.is(f.resolve([...savedPath, first.id]), identity);
});

test('lost sidebar save acknowledgement reuses persisted record after service reopen', async t => {
  const f = fixture();
  await prepareSpaces(f);
  f.fail('space:store');
  await t.throwsAsync(E(await make(f.powers)).provideSpace(config), {
    message: /Lost/,
  });
  const identity = f.resolve([...savedPath, 'whylip-physics']);
  t.truthy(identity);
  const value = await E(await make(f.powers)).provideSpace(config);
  t.is(value.id, 'whylip-physics');
  t.is(f.resolve([...savedPath, value.id]), identity);
});

test('legacy numeric Whylip view is reused unchanged, reserved-key collision refuses overwrite', async t => {
  const f = fixture();
  await prepareSpaces(f);
  await E(f.root).storeValue(
    harden({ ...config, id: '2', name: 'Renamed primer' }),
    [...savedPath, '2'],
  );
  const legacy = f.resolve([...savedPath, '2']);
  const service = await make(f.powers);
  const value = await E(service).provideSpace(config);
  t.is(value.id, '2');
  t.is(value.name, 'Renamed primer');
  t.is(f.resolve([...savedPath, '2']), legacy);
  t.falsy(f.resolve([...savedPath, 'whylip-physics']));
  await E(f.root).storeValue(
    harden({ id: 'whylip-physics', mode: 'files', profilePath: ['other'] }),
    [...savedPath, 'whylip-physics'],
  );
  const conflict = f.resolve([...savedPath, 'whylip-physics']);
  await t.throwsAsync(E(service).provideSpace(config), {
    message: /key conflicts/,
  });
  t.is(f.resolve([...savedPath, 'whylip-physics']), conflict);
  t.is(f.resolve([...savedPath, '2']), legacy);
});

test('service reports only its fixed root handle identifier for browser scope checks', async t => {
  const f = fixture();
  f.bind(['@self'], 'handle', selfId);
  const service = await make(f.powers);
  t.is(await E(service).getOwnerIdentity(), selfId);
  t.false((await E(service).getOwnerIdentity()).includes('://'));
  t.deepEqual(f.events, []);
});
