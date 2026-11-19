// @ts-check
// The voice catalogue of the `process` speech-out kind and the option
// check (`AH/speech/voice-catalogue.js`; designs/m11-interfaces.md 6.2,
// acceptance 5; R5-40..R5-42): usable voices listed with their sample
// rates and display names, broken ones skipped, the listing bound, and
// the R5-41 refusals.
import test from '@endo/ses-ava/test.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  checkTtsOptions,
  readVoiceCatalogue,
  voiceDisplayName,
} from '../../resources/agent-host/impl/speech/voice-catalogue.js';
import { speechTextOf } from '../../resources/agent-host/impl/speech/audio-protocol.js';
import { voiceFiles } from '../../resources/agent-host/impl/speech/engine-protocol.js';
/* eslint-disable-next-line import/no-relative-packages -- the guest tree is its own private package */
import { ttsDefaults } from '../../guest/lib/voice-preferences.js';

const VOICES = fileURLToPath(new URL('../fixtures/voices', import.meta.url));

test('usable voices are listed with their rates; broken ones are skipped', async t => {
  const { voices, skipped } = await readVoiceCatalogue(VOICES);
  t.deepEqual(
    voices.map(({ id, sampleRate }) => [id, sampleRate]),
    [
      ['en_GB-other-low', 16_000],
      ['en_US-test-medium', 22_050],
    ],
  );
  t.is(skipped, 2, 'the unparsable and the rate-less voice');
  t.is(voices[1].name, 'English (US) — test (medium)');
  t.true(Object.isFrozen(voices));
});

test('display names follow Endo', t => {
  t.is(
    voiceDisplayName('en_GB-alan-low'),
    'English (UK / Europe) — alan (low)',
  );
  t.is(voiceDisplayName('en_AU-some_one-x_low'), 'en AU — some one (x_low)');
  t.is(voiceDisplayName('de_DE-thorsten-high'), 'de DE thorsten high');
});

test('a missing directory lists no voice', async t => {
  const listing = await readVoiceCatalogue(join(VOICES, 'absent'));
  t.deepEqual(listing, { voices: [], skipped: 0 });
});

test('a model without metadata, oversized metadata and a zero rate are skipped; at most maxVoices are listed', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'thix-voices-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'lonely.onnx'), '');
  writeFileSync(join(dir, 'huge.onnx'), '');
  writeFileSync(
    join(dir, 'huge.onnx.json'),
    `{"audio":{"sample_rate":22050},"pad":"${'x'.repeat(voiceFiles.metadataBytes)}"}`,
  );
  writeFileSync(join(dir, 'empty-rate.onnx'), '');
  writeFileSync(
    join(dir, 'empty-rate.onnx.json'),
    '{"audio":{"sample_rate":0}}',
  );
  writeFileSync(join(dir, 'half.onnx.json'), '{"audio":{"sample_rate":1}}');
  for (let i = 0; i < voiceFiles.maxVoices + 3; i += 1) {
    const id = `v${String(i).padStart(3, '0')}`;
    writeFileSync(join(dir, `${id}.onnx`), '');
    writeFileSync(
      join(dir, `${id}.onnx.json`),
      '{"audio":{"sample_rate":8000}}',
    );
  }
  const { voices, skipped } = await readVoiceCatalogue(dir);
  t.is(voices.length, voiceFiles.maxVoices);
  t.is(voices[0].id, 'v000');
  t.is(skipped, 3);
});

const catalogue = harden({
  voices: harden([{ id: 'en_US-test-medium', name: 'x', sampleRate: 22_050 }]),
  defaults: harden({ ...ttsDefaults, voice: 'en_US-test-medium' }),
});

test('missing options take the catalogue defaults; only the five fields are kept', t => {
  const checked = checkTtsOptions(
    /** @type {any} */ ({ speed: 1.5, extra: 1 }),
    catalogue,
  );
  t.deepEqual(checked, {
    voice: 'en_US-test-medium',
    speed: 1.5,
    noiseScale: ttsDefaults.noiseScale,
    noiseW: ttsDefaults.noiseW,
    sentenceSilence: ttsDefaults.sentenceSilence,
  });
  t.true(Object.isFrozen(checked));
});

test('out of range, non-finite and non-number options are refused with the R5-41 texts', t => {
  for (const speed of [4.05, 0.2, NaN, Infinity, '1']) {
    t.throws(() => checkTtsOptions({ speed }, catalogue), {
      message: speechTextOf.outOfRange('speed', 0.25, 4),
    });
  }
  t.throws(() => checkTtsOptions({ sentenceSilence: 5.1 }, catalogue), {
    message: speechTextOf.outOfRange('sentenceSilence', 0, 5),
  });
  t.throws(() => checkTtsOptions({ voice: 'en_US-nobody-low' }, catalogue), {
    message: speechTextOf.unknownVoice('en_US-nobody-low'),
  });
  t.throws(() => checkTtsOptions({ voice: 3 }, catalogue), {
    message: speechTextOf.unknownVoice('3'),
  });
});
