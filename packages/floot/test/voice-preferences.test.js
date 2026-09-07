// @ts-check
// Whole-Floot voice/TTS preferences on the factory: one record shared by every
// session and device, kept in the factory host's petstore.
import test from '@endo/ses-ava/prepare-endo.js';
import { setTimeout as delay } from 'node:timers/promises';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make } from '../agent.js';

/**
 * The factory host's petstore, reduced to the surface the factory reads at
 * construction and the preference store uses. `storeValue` overwrites, as the
 * daemon's does; `failNextStore` makes the next one reject after a delay, and
 * `storeDelayMs` slows every one, so writes can be made to overlap.
 *
 * @param {Map<string, unknown>} [store]
 * @param {{ storeDelayMs?: number }} [options]
 */
const makeHost = (store = new Map(), { storeDelayMs = 0 } = {}) => {
  let failNextStore = false;
  const host = Far('TestHost', {
    list: () => harden([...store.keys()]),
    has: (/** @type {string} */ name) => store.has(name),
    lookup: (/** @type {string} */ name) => store.get(name),
    provideGuest: () => undefined,
    storeValue: async (
      /** @type {unknown} */ value,
      /** @type {string} */ name,
    ) => {
      if (storeDelayMs) await delay(storeDelayMs);
      if (failNextStore) {
        failNextStore = false;
        throw Error('petstore write failed');
      }
      store.set(name, value);
    },
    remove: (/** @type {string} */ name) => {
      store.delete(name);
    },
  });
  return {
    host,
    store,
    failNextStore: () => {
      failNextStore = true;
    },
  };
};

test('voice preferences are sanitized, merged, persisted, and revived', async t => {
  const { host, store } = makeHost();
  const factory = make(host);
  const initial = await E(factory).getVoicePreferences();
  t.deepEqual(initial, {});

  // Only the recognized keys survive, each held to its type; a malformed
  // client cannot poison the stored record.
  const merged = await E(factory).setVoicePreferences(
    harden({
      voice: 'en_GB-alba-medium',
      speed: '1.5',
      noiseScale: 'not a number',
      noiseW: true,
      sentenceSilence: [3],
      bogus: 'dropped',
    }),
  );
  t.deepEqual(merged, { voice: 'en_GB-alba-medium', speed: 1.5 });
  // Nothing Number() would coerce: '' and null are not 0, a registered
  // symbol does not throw, an overlong voice id is not a voice id.
  t.deepEqual(
    await E(factory).setVoicePreferences(
      harden({
        speed: '',
        noiseScale: null,
        noiseW: Symbol.for('nope'),
        voice: 'x'.repeat(200),
      }),
    ),
    { voice: 'en_GB-alba-medium', speed: 1.5 },
  );

  // A partial update changes only the keys it names.
  t.deepEqual(
    await E(factory).setVoicePreferences(harden({ sentenceSilence: 0.4 })),
    { voice: 'en_GB-alba-medium', speed: 1.5, sentenceSilence: 0.4 },
  );
  t.deepEqual(store.get('floot-voice-preferences'), {
    voice: 'en_GB-alba-medium',
    speed: 1.5,
    sentenceSilence: 0.4,
  });

  // The next incarnation of the factory reads them back from the petstore.
  const revived = make(makeHost(store).host);
  t.deepEqual(await E(revived).getVoicePreferences(), {
    voice: 'en_GB-alba-medium',
    speed: 1.5,
    sentenceSilence: 0.4,
  });
});

test('concurrent updates from different devices both land', async t => {
  const store = new Map();
  store.set('floot-voice-preferences', harden({ voice: 'en_GB-alba-medium' }));
  const { host } = makeHost(store, { storeDelayMs: 5 });
  const factory = make(host);
  // Cold cache: both calls race the load as well as each other.
  const [first, second] = await Promise.all([
    E(factory).setVoicePreferences(harden({ speed: 1.5 })),
    E(factory).setVoicePreferences(harden({ noiseW: 0.5 })),
  ]);
  t.deepEqual(first, { voice: 'en_GB-alba-medium', speed: 1.5 });
  t.deepEqual(second, {
    voice: 'en_GB-alba-medium',
    speed: 1.5,
    noiseW: 0.5,
  });
  t.deepEqual(store.get('floot-voice-preferences'), second);
  t.deepEqual(await E(factory).getVoicePreferences(), second);
});

test('a failed write leaves the persisted record, and what the factory reports, intact', async t => {
  const store = new Map();
  const persisted = harden({ voice: 'en_GB-alba-medium', speed: 2 });
  store.set('floot-voice-preferences', persisted);
  const { host, failNextStore } = makeHost(store);
  const factory = make(host);
  failNextStore();
  await t.throwsAsync(
    () => E(factory).setVoicePreferences(harden({ speed: 1.5 })),
    { message: /petstore write failed/ },
  );
  t.deepEqual(store.get('floot-voice-preferences'), persisted);
  t.deepEqual(await E(factory).getVoicePreferences(), persisted);
  // Later writes still go through, without the failed change.
  t.deepEqual(await E(factory).setVoicePreferences(harden({ noiseW: 0.5 })), {
    voice: 'en_GB-alba-medium',
    speed: 2,
    noiseW: 0.5,
  });
});
