// @ts-check
// Whole-Floot voice/TTS preferences on the factory: one record shared by every
// session and device, kept in the factory host's petstore.
import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';

import { make } from '../agent.js';

/**
 * The factory host's petstore, reduced to the surface the factory reads at
 * construction and the preference store uses.
 *
 * @param {Map<string, unknown>} [store]
 */
const makeHost = (store = new Map()) => {
  const host = Far('TestHost', {
    list: () => harden([...store.keys()]),
    has: (/** @type {string} */ name) => store.has(name),
    lookup: (/** @type {string} */ name) => store.get(name),
    provideGuest: () => undefined,
    storeValue: (/** @type {unknown} */ value, /** @type {string} */ name) => {
      store.set(name, value);
    },
    remove: (/** @type {string} */ name) => {
      store.delete(name);
    },
  });
  return { host, store };
};

test('voice preferences are sanitized, merged, persisted, and revived', async t => {
  const { host, store } = makeHost();
  const factory = make(host);
  const initial = await E(factory).getVoicePreferences();
  t.deepEqual(initial, {});

  // Only the recognized keys survive, each coerced to its type; a malformed
  // client cannot poison the stored record.
  const merged = await E(factory).setVoicePreferences(
    harden({
      voice: 'en_GB-alba-medium',
      speed: '1.5',
      noiseScale: 'not a number',
      bogus: 'dropped',
    }),
  );
  t.deepEqual(merged, { voice: 'en_GB-alba-medium', speed: 1.5 });

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
