// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { intersectPolicy, isOrdinaryName, makeRootPolicy } from '../index.js';
import { assertCreateAdmitted } from '../src/policy.js';

const root = makeRootPolicy({
  maxChildren: 4,
  maxInstructionBytes: 100,
  endowmentNames: ['workspace', 'notes', 'notes'],
});

test('root policy requires every field and normalizes names', t => {
  t.deepEqual(root.endowmentNames, ['notes', 'workspace']);
  t.throws(
    () =>
      makeRootPolicy(
        /** @type {any} */ ({ maxChildren: 1, maxInstructionBytes: 1 }),
      ),
    { message: /endowmentNames/ },
  );
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

test('instruction bytes are measured in UTF-8 at the bound', t => {
  const four = intersectPolicy(root, { maxInstructionBytes: 4 });
  // A supplementary code point is four bytes: exactly at the bound, then over.
  t.notThrows(() => assertCreateAdmitted(four, '😀', []));
  t.throws(() => assertCreateAdmitted(four, '😀a', []), {
    message: /4-byte bound/,
  });
  // A lone surrogate encodes as U+FFFD, three bytes.
  const three = intersectPolicy(root, { maxInstructionBytes: 3 });
  t.notThrows(() => assertCreateAdmitted(three, '\uD800', []));
  const two = intersectPolicy(root, { maxInstructionBytes: 2 });
  t.throws(() => assertCreateAdmitted(two, '\uD800', []), {
    message: /2-byte bound/,
  });
  const zero = intersectPolicy(root, { maxInstructionBytes: 0 });
  t.notThrows(() => assertCreateAdmitted(zero, '', []));
  t.throws(() => assertCreateAdmitted(zero, 'a', []), {
    message: /0-byte bound/,
  });
});

test('policy counts must be non-negative safe integers', t => {
  for (const field of ['maxChildren', 'maxInstructionBytes']) {
    for (const value of [0, -0, Number.MAX_SAFE_INTEGER]) {
      t.notThrows(() => intersectPolicy(root, { [field]: value }), `${value}`);
      t.notThrows(() =>
        makeRootPolicy({
          maxChildren: 1,
          maxInstructionBytes: 1,
          endowmentNames: [],
          [field]: value,
        }),
      );
    }
    for (const value of [
      -1,
      0.5,
      NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
    ]) {
      t.throws(
        () => intersectPolicy(root, /** @type {any} */ ({ [field]: value })),
        { message: /non-negative safe integer/ },
        `${String(value)}`,
      );
    }
  }
  t.is(intersectPolicy(root, { maxChildren: 0 }).maxChildren, 0);
});

test('ordinary names exclude special, path, and oversized names', t => {
  const ordinary = ['a', 'x'.repeat(255), '😀', '...', 'a.b'];
  const special = [
    '',
    'x'.repeat(256),
    '.',
    '..',
    'a/b',
    'a\0b',
    '@self',
    '@pins',
    'a@b',
    undefined,
    1,
  ];
  for (const name of ordinary) t.true(isOrdinaryName(name), name);
  for (const name of special) t.false(isOrdinaryName(name), String(name));
  for (const name of special) {
    t.throws(
      () =>
        intersectPolicy(root, {
          endowmentNames: [/** @type {any} */ (name)],
        }),
      { message: /ordinary pet name/ },
    );
  }
});
