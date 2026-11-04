// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { main } from '../src/networks/setup-iroh.js';

const worker = '@pins/installations/iroh/worker';
const oldWorker = 'iroh-worker-serialized-v2-20261024';
const key = path => path.flat().join('/');

const fixture = () => {
  const names = new Map([
    ['@pins', 'pins'],
    ['@nets', 'nets'],
  ]);
  /** @type {Map<string, any>} */
  const records = new Map([
    ['pins', { type: 'directory' }],
    ['nets', { type: 'directory' }],
  ]);
  /** @type {any[]} */
  const created = [];
  let serial = 0;
  let failRemove = false;
  let interleaveParent = false;
  const bind = (name, id, record) => {
    names.set(name, id);
    records.set(id, record);
  };
  const host = {
    diagnostics: () => ({ getFormula: id => records.get(id) }),
    has: (...path) => names.has(key(path)),
    identify: (...path) => names.get(key(path)),
    list: () => [...names.keys()].filter(name => !name.includes('/')),
    makeDirectory: path => {
      serial += 1;
      bind(key(path), `directory-${serial}`, { type: 'directory' });
    },
    provideDirectory: path => {
      if (interleaveParent) {
        interleaveParent = false;
        bind('@pins/installations', 'concurrent-installations', {
          type: 'directory',
        });
        bind('@pins/installations/chat', 'chat-state', { type: 'directory' });
      }
      if (!names.has(key(path))) host.makeDirectory(path);
    },
    copy: (from, to) => {
      const id = names.get(key(from));
      if (!id) throw Error('missing source');
      names.set(key(to), id);
    },
    remove: (...path) => {
      if (failRemove) {
        failRemove = false;
        throw Error('injected interruption');
      }
      names.delete(key(path));
    },
    provideWorker: path => {
      if (names.has(key(path))) return;
      created.push({ type: 'worker', path });
      bind(key(path), 'new-worker', { type: 'worker' });
    },
    makeUnconfined: (path, specifier, options) => {
      created.push({ type: 'service', path, specifier, options });
      bind(key(options.resultName), 'new-service', {
        type: 'make-unconfined',
        properties: {
          worker: { kind: 'reference', identifier: names.get(key(path)) },
        },
      });
    },
  };
  const install = () => {
    bind(oldWorker, 'active-worker', { type: 'worker' });
    bind('iroh-worker', 'retired-worker', { type: 'worker' });
    bind('@nets/iroh', 'active-service', {
      type: 'make-unconfined',
      properties: {
        worker: { kind: 'reference', identifier: 'active-worker' },
      },
    });
  };
  return {
    host,
    names,
    records,
    created,
    bind,
    install,
    interleave: () => {
      interleaveParent = true;
    },
    interrupt: () => {
      failRemove = true;
    },
  };
};

test('fresh setup uses a nested worker and direct network service with stable specifier', async t => {
  t.true(
    import.meta
      .resolve('@endo/daemon/iroh.js')
      .endsWith('/src/networks/iroh.js'),
  );
  const f = fixture();
  await main(f.host);
  t.is(f.names.get(worker), 'new-worker');
  t.is(f.names.get('@nets/iroh'), 'new-service');
  t.deepEqual(f.created[1], {
    type: 'service',
    path: worker.split('/'),
    specifier: '@endo/daemon/iroh.js',
    options: { powersName: '@agent', resultName: ['@nets', 'iroh'] },
  });
  t.deepEqual(
    [...f.names.keys()].filter(name => !name.includes('/')),
    ['@pins', '@nets'],
  );
  const before = [...f.names];
  const restartedHost = { ...f.host };
  t.is(
    await main(restartedHost),
    'iroh network already installed at @nets/iroh',
  );
  t.deepEqual([...f.names], before);
  t.is(f.created.length, 2);
});

test('existing transport migrates only its exact live worker dependency before returning', async t => {
  const f = fixture();
  f.install();
  await main(f.host);
  t.is(f.names.get(worker), 'active-worker');
  t.is(f.names.get('@nets/iroh'), 'active-service');
  t.false(f.names.has(oldWorker));
  t.is(f.names.get('iroh-worker'), 'retired-worker');
  await main({ ...f.host });
  t.deepEqual(f.created, []);
});

test('interruption after copy resumes without replacing transport or worker', async t => {
  const f = fixture();
  f.install();
  f.interrupt();
  await t.throwsAsync(main(f.host), { message: 'injected interruption' });
  t.is(f.names.get(worker), 'active-worker');
  t.is(f.names.get(oldWorker), 'active-worker');
  await main(f.host);
  t.false(f.names.has(oldWorker));
  t.is(f.names.get('@nets/iroh'), 'active-service');
  t.deepEqual(f.created, []);
});

test('conflicting canonical worker and invalid parents fail before mutation', async t => {
  await null;
  for (const conflict of ['worker', 'parent', 'service', 'dependency']) {
    const f = fixture();
    f.install();
    if (conflict === 'worker') {
      f.bind('@pins/installations', 'installations', { type: 'directory' });
      f.bind('@pins/installations/iroh', 'iroh-dir', { type: 'directory' });
      f.bind(worker, 'other-worker', { type: 'worker' });
    } else if (conflict === 'parent') {
      f.bind('@pins/installations', 'impostor', { type: 'guest' });
    } else if (conflict === 'service') {
      f.bind('network-service-iroh', 'other-service', {
        type: 'make-unconfined',
      });
    } else {
      f.records.set('active-worker', { type: 'guest' });
    }
    const before = [...f.names];
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(main(f.host), { message: /Iroh/ });
    t.deepEqual([...f.names], before);
    t.deepEqual(f.created, []);
  }
});

test('legacy root service is retained and moved, never discarded', async t => {
  const f = fixture();
  f.install();
  f.names.set('network-service-iroh', 'active-service');
  f.names.delete('@nets/iroh');
  await main(f.host);
  t.is(f.names.get('@nets/iroh'), 'active-service');
  t.false(f.names.has('network-service-iroh'));
  t.deepEqual(f.created, []);
});

test('missing active worker alias fails rather than minting replacement state', async t => {
  const f = fixture();
  f.install();
  f.names.delete(oldWorker);
  const before = [...f.names];
  await t.throwsAsync(main(f.host), { message: /no known inventory alias/ });
  t.deepEqual([...f.names], before);
  t.deepEqual(f.created, []);
});

test('shared parent provision preserves storage created after preflight', async t => {
  const f = fixture();
  f.install();
  f.interleave();
  await main(f.host);
  t.is(f.names.get('@pins/installations'), 'concurrent-installations');
  t.is(f.names.get('@pins/installations/chat'), 'chat-state');
  t.is(f.names.get(worker), 'active-worker');
  t.is(f.names.get('@nets/iroh'), 'active-service');
});
