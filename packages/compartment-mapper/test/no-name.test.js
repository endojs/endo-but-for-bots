// @ts-check
// Regression test for endojs/endo#1845: when an entry-point package's
// package.json has no `name` field, the compartment mapper used to throw
// an uninformative downstream diagnostic (e.g. "Cannot find dependency"
// or a TypeError on `undefined`). It now throws a focused error that
// names the offending package.json and suggests using the parent
// directory name.
import 'ses';
import test from 'ava';
import fs from 'node:fs';
import url from 'node:url';

import { mapNodeModules } from '../src/node-modules.js';
import { makeReadPowers } from '../src/node-powers.js';

const readPowers = makeReadPowers({ fs, url });

test('mapNodeModules: clear diagnostic when application package.json has no name', async t => {
  const fixtureLocation = new URL(
    'fixtures-no-name/',
    import.meta.url,
  ).toString();
  await t.throwsAsync(mapNodeModules(readPowers, fixtureLocation), {
    message:
      /Application package.json at .*fixtures-no-name.* must have a "name" field/,
  });
});
