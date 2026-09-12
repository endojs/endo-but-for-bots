import test from '@endo/ses-ava/prepare-endo.js';

import { reincarnateMailboxPins } from '../src/mail.js';

test('mail receipt reincarnates both guest pin directories', async t => {
  const events = [];
  const formulas = new Map([
    ['handle', { type: 'handle', agent: 'guest' }],
    [
      'guest',
      { type: 'guest', guestPins: 'guest-pins', hostPins: 'host-pins' },
    ],
  ]);
  const directoryEntries = new Map([
    ['guest-pins', ['guest-retained-a', 'guest-retained-b']],
    ['host-pins', ['host-retained']],
  ]);
  const getFormulaForId = async id => formulas.get(id);
  const provide = async id => {
    events.push(id);
    const entries = directoryEntries.get(id);
    if (entries !== undefined) {
      return harden({ listIdentifiers: async () => entries });
    }
    return harden({ id });
  };

  await reincarnateMailboxPins(
    /** @type {any} */ ({
      selfId: 'handle',
      getFormulaForId,
      provide,
    }),
  );

  t.deepEqual(events, [
    'guest-pins',
    'host-pins',
    'guest-retained-a',
    'guest-retained-b',
    'host-retained',
  ]);
});

test('mail receipt reincarnates host pins', async t => {
  const events = [];
  const getFormulaForId = async id =>
    id === 'handle'
      ? { type: 'handle', agent: 'host' }
      : { type: 'host', pins: 'host-pins' };
  const provide = async id => {
    events.push(id);
    if (id === 'host-pins') {
      return harden({ listIdentifiers: async () => ['retained'] });
    }
    return harden({ id });
  };

  await reincarnateMailboxPins(
    /** @type {any} */ ({
      selfId: 'handle',
      getFormulaForId,
      provide,
    }),
  );

  t.deepEqual(events, ['host-pins', 'retained']);
});

test('mail receipt tolerates deployed guests without pin directories', async t => {
  const getFormulaForId = async id =>
    id === 'handle' ? { type: 'handle', agent: 'guest' } : { type: 'guest' };

  await t.notThrowsAsync(
    reincarnateMailboxPins(
      /** @type {any} */ ({
        selfId: 'handle',
        getFormulaForId,
        provide: async () => {
          throw new Error('unexpected provide');
        },
      }),
    ),
  );
});
