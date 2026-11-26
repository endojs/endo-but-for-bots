// @ts-check
import test from '@endo/ses-ava/test.js';

import { makeNodePowers } from '../src/platform/node/powers.js';

const { paths } = makeNodePowers();

test('Node path powers name the last segment of a path', t => {
  t.is(paths.basename('/opt/worker/host-abi.mjs'), 'host-abi.mjs');
  t.is(paths.basename('relative/module.wasm'), 'module.wasm');
  t.is(paths.basename('/'), '');
  t.true(paths.isAbsolute('/opt/worker/host-abi.mjs'));
  t.false(paths.isAbsolute('worker/host-abi.mjs'));
});
