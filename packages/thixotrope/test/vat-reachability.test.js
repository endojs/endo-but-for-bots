// @ts-check
import test from '@endo/ses-ava/test.js';
import harden from '@endo/harden';

import { inspectVatReachability } from '../src/vat-reachability.js';

const workers = harden(
  ['a', 'b', 'c'].map(workerId => ({ workerId, awake: false })),
);
/** @param {string} origin @param {string[]} holders */
const ref = (origin, holders) => ({
  origin,
  backing: 'export',
  flavor: 'object',
  position: '1',
  refcounts: Object.fromEntries(holders.map(holder => [holder, 1])),
});

test('publication paths traverse cross-vat references and unrooted cycles collect', t => {
  const hubState = {
    publications: { secret: 'a-ref' },
    refs: { 'a-ref': ref('a', ['b']), 'b-ref': ref('b', ['a']) },
  };
  const report = inspectVatReachability({
    workers,
    hubState,
    endpointExports: {},
  });
  t.deepEqual(report.collectible, ['c']);
  t.deepEqual(report.workers.find(node => node.workerId === 'b').path, [
    'a',
    'b',
  ]);
  t.false(JSON.stringify(report).includes('secret'));
  Reflect.deleteProperty(hubState.publications, 'secret');
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports: {} })
      .collectible,
    ['a', 'b', 'c'],
  );
});

test('host resource worker facades retain their target only through reachable holders', t => {
  const hubState = {
    publications: { secret: 'a-ref' },
    refs: { 'a-ref': ref('a', ['endpoint']), facade: ref('endpoint', ['a']) },
  };
  const endpointExports = {
    'o+1': {
      kind: 'resource',
      name: 'worker-facade',
      description: { workerId: 'b' },
    },
  };
  const report = inspectVatReachability({ workers, hubState, endpointExports });
  t.deepEqual(report.collectible, ['c']);
  t.deepEqual(report.references, [
    { holder: 'a', target: 'b', kind: 'worker-facade', retaining: true },
  ]);
  Reflect.deleteProperty(hubState.publications, 'secret');
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports }).collectible,
    ['a', 'b', 'c'],
  );
});

test('remote sessions explain connected and retained disconnected roots', t => {
  const hubState = {
    refs: { a: ref('a', ['peer']), b: ref('b', ['offline']) },
    sessions: { peer: { durable: false }, offline: { durable: true } },
  };
  const report = inspectVatReachability({
    workers,
    hubState,
    endpointExports: {},
    connectedSessions: ['peer'],
  });
  t.deepEqual(report.workers[0].roots, [
    {
      kind: 'remote-session',
      session: 'peer',
      connected: true,
      durable: false,
    },
  ]);
  t.deepEqual(report.workers[1].roots, [
    {
      kind: 'remote-session',
      session: 'offline',
      connected: false,
      durable: true,
    },
  ]);
  t.deepEqual(report.collectible, ['c']);
});

test('awake and explicit keep roots remain while tombstones and resolver plumbing do not', t => {
  const report = inspectVatReachability({
    workers: workers.map(worker => ({
      ...worker,
      awake: worker.workerId === 'a',
    })),
    keep: ['b'],
    endpointExports: {},
    hubState: {
      refs: {
        dead: { ...ref('c', ['peer']), dead: true },
        resolver: { ...ref('c', ['peer']), resolver: true },
        cached: ref('c', ['endpoint']),
      },
    },
  });
  t.deepEqual(report.collectible, ['c']);
  t.deepEqual(report.workers[0].roots, [{ kind: 'awake' }]);
  t.deepEqual(report.workers[1].roots, [{ kind: 'keep' }]);
  t.throws(
    () =>
      inspectVatReachability({
        workers,
        keep: ['unknown'],
        hubState: {},
        endpointExports: {},
      }),
    { message: /Unknown keep worker/ },
  );
});

for (const routeKind of ['ref', 'local']) {
  test(`an answer route (${routeKind}) retains its target without wire refcounts`, t => {
    const hubState = {
      publications: { secret: 'root' },
      refs: { root: ref('a', []), answer: ref('b', []) },
      sessions: { a: { answersOwed: { 1: { [routeKind]: 'answer' } } } },
    };
    const report = inspectVatReachability({
      workers,
      hubState,
      endpointExports: {},
    });
    t.deepEqual(report.collectible, ['c']);
    t.deepEqual(report.workers.find(node => node.workerId === 'b').path, [
      'a',
      'b',
    ]);
    Reflect.deleteProperty(hubState.publications, 'secret');
    t.deepEqual(
      inspectVatReachability({ workers, hubState, endpointExports: {} })
        .collectible,
      ['a', 'b', 'c'],
    );
  });
}

test('an outstanding host answer roots its target independently of cached imports', t => {
  const hubState = {
    refs: { answer: ref('b', []) },
    sessions: { endpoint: { answersOwed: { 1: { ref: 'answer' } } } },
  };
  t.deepEqual(
    inspectVatReachability({
      workers,
      hubState,
      endpointExports: {},
      endpointPendingAnswers: ['1'],
    }).collectible,
    ['a', 'c'],
  );
  // The cached route remains after the host operation settles.
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports: {} })
      .collectible,
    ['a', 'b', 'c'],
  );
});

test('a deposited gift roots its target until withdrawal without revealing gift identifiers', t => {
  const hubState = {
    refs: { gift: ref('b', []) },
    gifts: { 'secret-gift-id': 'gift' },
  };
  const report = inspectVatReachability({
    workers,
    hubState,
    endpointExports: {},
  });
  t.deepEqual(report.collectible, ['a', 'c']);
  t.false(JSON.stringify(report).includes('secret-gift-id'));
  Reflect.deleteProperty(hubState.gifts, 'secret-gift-id');
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports: {} })
      .collectible,
    ['a', 'b', 'c'],
  );
});

test('gift and answer routes through worker facades retain the actual worker', t => {
  const endpointExports = {
    'o+1': {
      kind: 'resource',
      name: 'worker-facade',
      description: { workerId: 'b' },
    },
  };
  const refs = { root: ref('a', []), facade: ref('endpoint', []) };
  t.deepEqual(
    inspectVatReachability({
      workers,
      endpointExports,
      hubState: { refs, gifts: { secret: 'facade' } },
    }).collectible,
    ['a', 'c'],
  );
  for (const routeKind of ['ref', 'local']) {
    t.deepEqual(
      inspectVatReachability({
        workers,
        endpointExports,
        hubState: {
          refs,
          publications: { secret: 'root' },
          sessions: { a: { answersOwed: { 1: { [routeKind]: 'facade' } } } },
        },
      }).collectible,
      ['c'],
    );
  }
});

test('a rooted producer retains its pending callback owner but an unrooted listener cycle collects', t => {
  const hubState = {
    publications: { secret: 'producer' },
    refs: {
      producer: { ...ref('a', []), listeners: ['callback'] },
      callback: { ...ref('b', ['a']), resolver: true },
    },
  };
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports: {} })
      .collectible,
    ['c'],
  );
  Reflect.deleteProperty(hubState.publications, 'secret');
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports: {} })
      .collectible,
    ['a', 'b', 'c'],
  );
});

test('a pending gift waiter retains its callback owner until the hub releases the obligation', t => {
  const hubState = {
    refs: { callback: { ...ref('b', []), resolver: true } },
    giftWaiters: { 'secret-gift-id': ['callback'] },
  };
  const report = inspectVatReachability({
    workers,
    hubState,
    endpointExports: {},
  });
  t.deepEqual(report.collectible, ['a', 'c']);
  t.false(JSON.stringify(report).includes('secret-gift-id'));
  Reflect.deleteProperty(hubState.giftWaiters, 'secret-gift-id');
  t.deepEqual(
    inspectVatReachability({ workers, hubState, endpointExports: {} })
      .collectible,
    ['a', 'b', 'c'],
  );
});
