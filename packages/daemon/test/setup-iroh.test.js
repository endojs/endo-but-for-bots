// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { main } from '../src/networks/setup-iroh.js';

test('iroh setup stores a stable package specifier', async t => {
  t.true(
    import.meta
      .resolve('@endo/daemon/iroh.js')
      .endsWith('/src/networks/iroh.js'),
  );

  /** @type {unknown[]} */
  const calls = [];
  /** @type {any} */
  const powers = {
    has: () => false,
    provideWorker: workerName => calls.push(['provideWorker', workerName]),
    makeUnconfined: (workerName, specifier, options) =>
      calls.push(['makeUnconfined', workerName, specifier, options]),
    move: (from, to) => calls.push(['move', from, to]),
  };

  await main(powers);

  t.deepEqual(calls, [
    ['provideWorker', 'iroh-worker'],
    [
      'makeUnconfined',
      'iroh-worker',
      '@endo/daemon/iroh.js',
      {
        powersName: '@agent',
        resultName: 'network-service-iroh',
      },
    ],
    ['move', ['network-service-iroh'], ['@nets', 'iroh']],
  ]);
});

test('iroh setup is a no-op when already installed', async t => {
  /** @type {any} */
  const powers = {
    has: () => true,
    provideWorker: () => t.fail('must not provide a worker'),
    makeUnconfined: () => t.fail('must not formulate another service'),
    move: () => t.fail('must not replace the installed service'),
  };

  const result = await main(powers);
  t.is(result, 'iroh network already installed at @nets/iroh');
});
