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

test('mail receipt tolerates a retained formula that fails to reincarnate', async t => {
  // The failure-tolerance property reincarnateMailboxPins documents: a single
  // retained pin that cannot incarnate (a stale pin, a worker that cannot
  // respawn) must not reject the delivery whose crank this runs on, and must
  // not stop the remaining pins from being re-warmed. Without the
  // Promise.allSettled isolation this rejects and a live message-received
  // notification is silently dropped for an already-committed message.
  const provided = [];
  const formulas = new Map([
    ['handle', { type: 'handle', agent: 'guest' }],
    [
      'guest',
      { type: 'guest', guestPins: 'guest-pins', hostPins: 'host-pins' },
    ],
  ]);
  const directoryEntries = new Map([
    ['guest-pins', ['ok-a', 'broken', 'ok-b']],
    ['host-pins', ['ok-c']],
  ]);
  const getFormulaForId = async id => formulas.get(id);
  const provide = async id => {
    const entries = directoryEntries.get(id);
    if (entries !== undefined) {
      return harden({ listIdentifiers: async () => entries });
    }
    provided.push(id);
    if (id === 'broken') {
      throw new Error('cannot incarnate a stale pin');
    }
    return harden({ id });
  };

  await t.notThrowsAsync(
    reincarnateMailboxPins(
      /** @type {any} */ ({
        selfId: 'handle',
        getFormulaForId,
        provide,
      }),
    ),
  );

  // Every retained pin was attempted despite the one failure — the failing pin
  // did not abort its own directory's siblings nor the other directory.
  t.deepEqual([...provided].sort(), ['broken', 'ok-a', 'ok-b', 'ok-c']);
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
