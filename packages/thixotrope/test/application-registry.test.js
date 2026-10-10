// @ts-check
import { E, Far } from '@endo/far';
import test from '@endo/ses-ava/test.js';

import { makeApplicationRegistry } from '../src/application-registry.js';

test('concurrent installs share one result and capture only named powers', async t => {
  let created = 0n;
  const root = Far('Application', {});
  const capability = Far('Granted', {});
  const inventory = new Map([
    ['selected', capability],
    ['other', Far('Other', {})],
  ]);
  const controller = Far('Controller', {
    createWorker: () => {
      created += 1n;
      return Far('Worker', {
        getEvaluator: () =>
          Far('Evaluator', {
            evaluate: (source, { powers }) => {
              t.deepEqual(Object.keys(powers), ['service', 'alias']);
              t.is(powers.service, capability);
              return root;
            },
          }),
      });
    },
  });
  const apps = makeApplicationRegistry(controller, inventory);
  const first = E(apps).install('app', 'bundle', 'hash', [
    ['service', 'selected'],
    ['alias', 'selected'],
  ]);
  const second = E(apps).install('app', 'bundle', 'hash', [
    ['alias', 'selected'],
    ['service', 'selected'],
  ]);
  t.is(await first, root);
  t.is(await second, root);
  t.is(created, 1n);
  t.is(await E(apps).get('app'), root);
  t.is((await E(apps).list())[0].status, 'ready');
  await t.throwsAsync(
    () =>
      E(apps).install('app', 'bundle', 'different', [['service', 'selected']]),
    { message: /different installation/ },
  );
  t.true(await E(apps).remove('app'));
  await t.throwsAsync(() => E(apps).get('app'), {
    message: /Unknown application/,
  });
});

test('failed installation remains inspectable and does not retry its factory', async t => {
  let created = 0n;
  const apps = makeApplicationRegistry(
    Far('Controller', {
      createWorker: () => {
        created += 1n;
        throw Error('factory failed');
      },
    }),
    new Map(),
  );
  await t.throwsAsync(() => E(apps).install('bad', 'bundle', 'hash', []), {
    message: /factory failed/,
  });
  await t.throwsAsync(() => E(apps).install('bad', 'bundle', 'hash', []), {
    message: /factory failed/,
  });
  t.is(created, 1n);
  t.is((await E(apps).list())[0].status, 'failed');
});
