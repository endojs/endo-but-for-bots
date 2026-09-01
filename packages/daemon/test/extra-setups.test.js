// @ts-check
// A setup listed in ENDO_EXTRA that throws must not stop the daemon, and must
// not vanish either: these cover both halves.

import test from '@endo/ses-ava/prepare-endo.js';

import { runExtraSetups } from '../src/extra-setups.js';

const now = () => '2026-09-01T00:00:00.000Z';

test('each setup runs in order and is recorded', async t => {
  const ran = [];
  const outcomes = await runExtraSetups({
    specifiers: ['a.js', 'b.js'],
    host: 'the-host',
    importModule: async specifier => ({
      main: host => {
        ran.push([specifier, host]);
      },
    }),
    now,
  });

  t.deepEqual(ran, [
    ['a.js', 'the-host'],
    ['b.js', 'the-host'],
  ]);
  t.deepEqual(outcomes, [
    { specifier: 'a.js', ok: true, at: now() },
    { specifier: 'b.js', ok: true, at: now() },
  ]);
});

test('a throwing setup is recorded with its message and the rest still run', async t => {
  const ran = [];
  const outcomes = await runExtraSetups({
    specifiers: ['bad.js', 'good.js'],
    host: {},
    importModule: async specifier => ({
      main: () => {
        if (specifier === 'bad.js') {
          throw new Error('no credential material');
        }
        ran.push(specifier);
      },
    }),
    now,
  });

  t.deepEqual(ran, ['good.js']);
  t.deepEqual(outcomes, [
    {
      specifier: 'bad.js',
      ok: false,
      at: now(),
      error: 'no credential material',
    },
    { specifier: 'good.js', ok: true, at: now() },
  ]);
});

test('a setup that fails to import is recorded, not swallowed', async t => {
  const outcomes = await runExtraSetups({
    specifiers: ['missing.js'],
    host: {},
    importModule: async () => {
      throw new Error('Cannot find module');
    },
    now,
  });

  t.is(outcomes.length, 1);
  t.false(outcomes[0].ok);
  t.is(outcomes[0].error, 'Cannot find module');
});

test('no specifiers produces an empty record rather than nothing', async t => {
  const outcomes = await runExtraSetups({
    specifiers: [],
    host: {},
    importModule: async () => {
      throw new Error('should not be called');
    },
    now,
  });
  t.deepEqual(outcomes, []);
});
