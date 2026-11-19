// @ts-check
// The shared guard entries that must agree with another table
// (m6-interfaces.md 15.1, 15.2): the factory's `runnerRequired` is the
// environments table's words, kept equal by this test; the shell tools'
// closed argument names are the properties their descriptions offer.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { texts as factoryTexts } from '../../guest/lib/guards/factory.js';
import { environmentTexts } from '../../guest/lib/guards/environments.js';
import {
  shellToolArgumentNames,
  shellToolDescriptions,
} from '../../guest/lib/guards/session.js';
/* eslint-enable import/no-relative-packages */

test('runnerRequired: the factory text is the environments text (15.2)', t => {
  t.is(factoryTexts.runnerRequired, environmentTexts.runnerRequired);
});

test('the shell tools: names, closed parameters, argument names (15.1)', t => {
  t.deepEqual(Object.keys(shellToolDescriptions), [
    'runCommand',
    'inspectShell',
  ]);
  for (const [key, description] of Object.entries(shellToolDescriptions)) {
    t.is(description.name, key);
    t.true(description.description.length > 0, key);
  }
  const run = JSON.parse(shellToolDescriptions.runCommand.parameters);
  t.false(run.additionalProperties);
  t.deepEqual(run.required, ['command', 'args']);
  t.deepEqual(Object.keys(run.properties), shellToolArgumentNames.runCommand);
  t.deepEqual(
    Object.keys(run.properties.options.properties),
    shellToolArgumentNames.options,
  );
  const inspect = JSON.parse(shellToolDescriptions.inspectShell.parameters);
  t.false(inspect.additionalProperties);
  t.deepEqual(
    Object.keys(inspect.properties),
    shellToolArgumentNames.inspectShell,
  );
});
