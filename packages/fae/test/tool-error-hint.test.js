// @ts-check

/**
 * Unit tests for the tool-error adoption hint.
 *
 *   yarn test test/tool-error-hint.test.js
 */

import '@endo/init/debug.js';

import test from 'ava';

import { addAdoptionHintToError } from '../src/tool-error-hint.js';

test('appends a hint when the error names a missing pet name', t => {
  const wrapped = addAdoptionHintToError(
    'Unknown pet name: "endo-scratchpad-fs-mount"',
  );
  t.true(wrapped.startsWith('Unknown pet name: "endo-scratchpad-fs-mount"'));
  t.true(
    wrapped.includes(
      'adopt(messageNumber, "endo-scratchpad-fs-mount", "endo-scratchpad-fs-mount")',
    ),
    'should suggest plain adopt with the missing name',
  );
  t.true(
    wrapped.includes(
      'adoptTool(messageNumber, "endo-scratchpad-fs-mount", "endo-scratchpad-fs-mount")',
    ),
    'should also suggest adoptTool for the same name',
  );
});

test('is a no-op for unrelated errors', t => {
  const original = 'target has no method "listDir", has []';
  t.is(addAdoptionHintToError(original), original);
});
