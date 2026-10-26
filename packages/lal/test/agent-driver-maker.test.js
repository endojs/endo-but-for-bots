// @ts-check
// prefer-endo-primitives-exempt: Far instances are explicit remotable test doubles.

import test from '@endo/ses-ava/prepare-endo.js';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { makeLalAgentDriverMaker } from '../agent-driver-maker.js';

test('Lal maker installs the child only in its private driver guest', async t => {
  const agent = Far('Agent', {});
  const stored = new Map();
  const driverGuest = Far('DriverGuest', {
    storeValue: (value, name) => stored.set(name, value),
  });
  const maker = makeLalAgentDriverMaker({
    workerEnvironment: {
      LAL_HOST: 'https://inference.example',
      LAL_MODEL: 'test/model',
    },
    driverSpecifier: 'file:///lal-driver.js',
  });
  const descriptor = await E(maker).installDriver(
    harden({
      agent,
      driverGuest,
      lifecycle: Far('Lifecycle', {}),
    }),
  );
  t.deepEqual(descriptor, {
    specifier: 'file:///lal-driver.js',
    env: {
      LAL_HOST: 'https://inference.example',
      LAL_MODEL: 'test/model',
    },
  });
  t.deepEqual([...stored.entries()], [['agent', agent]]);
});
