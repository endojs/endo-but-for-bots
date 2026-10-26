// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import {
  assertCreateAdmitted,
  intersectPolicy,
  makeRootPolicy,
} from '../src/policy.js';

const root = makeRootPolicy({
  maxChildren: 4,
  maxInstructionBytes: 100,
  endowmentNames: ['workspace', 'notes', 'notes'],
});

test('root policy requires every field and normalizes names', t => {
  t.deepEqual(root.endowmentNames, ['notes', 'workspace']);
  t.throws(() => makeRootPolicy({ maxChildren: 1, maxInstructionBytes: 1 }), {
    message: /endowmentNames/,
  });
  t.throws(
    () =>
      makeRootPolicy({
        maxChildren: 1,
        maxInstructionBytes: 1,
        endowmentNames: ['@pins'],
      }),
    { message: /ordinary pet name/ },
  );
});

test('intersection only reduces', t => {
  t.deepEqual(
    intersectPolicy(root, {
      maxChildren: 99,
      maxInstructionBytes: 10,
      endowmentNames: ['notes', 'secrets'],
    }),
    { maxChildren: 4, maxInstructionBytes: 10, endowmentNames: ['notes'] },
  );
  t.deepEqual(intersectPolicy(root), root, 'absent fields inherit');
  t.throws(() => intersectPolicy(root, { maxChildren: -1 }));
  t.throws(() => intersectPolicy(root, /** @type {any} */ ({ owner: 'x' })), {
    message: /Unknown policy fields/,
  });
});

test('create admission checks instruction bytes and endowment names', t => {
  const policy = intersectPolicy(root, { maxInstructionBytes: 4 });
  t.notThrows(() => assertCreateAdmitted(policy, 'abcd', ['notes']));
  t.throws(() => assertCreateAdmitted(policy, 'abcdé', []), {
    message: /4-byte bound/,
  });
  t.throws(() => assertCreateAdmitted(policy, '', ['secrets']), {
    message: /does not admit/,
  });
});
