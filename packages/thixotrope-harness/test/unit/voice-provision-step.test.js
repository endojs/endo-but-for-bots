// @ts-check
// The voice provisioning step `scripts/provision-steps/70-voice.js`
// (designs/m11-interfaces.md 12 W11.7, D-M11-21; R4-89, R8-17) against
// the real factory kit and harness root in Node: a control client fake
// whose `lookup` answers the root and an agent host with Secrets built
// from the real guards. The step must be idempotent (it runs at every
// start, P-28).
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

/* eslint-disable import/no-relative-packages */
import { interfaces } from '../../guest/lib/interfaces.js';
import { makeFactoryKit } from '../../guest/factory/factory.js';
import {
  makeHarnessRoot,
  makeHarnessSettings,
  makeProgramStore,
} from '../../guest/factory/root.js';
import { makeRowTable } from '../../guest/factory/rows.js';
import { makeStartCount } from '../../guest/factory/starts.js';
/* eslint-enable import/no-relative-packages */
import { names } from '../../scripts/provision-steps.js';
import {
  DEFAULT_SPEECH_LANGUAGE,
  moonshineCommand,
  voiceStep,
} from '../../scripts/provision-steps/70-voice.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far, makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * A Secret from the real guard; counts its grants.
 * @param {string} label
 */
const makeSecret = label => {
  let grants = 0;
  const grant = () =>
    makeExo('ReadGrant', interfaces.ReadGrant, {
      describe: () => harden({ label, description: '' }),
    });
  const secret = makeExo('Secret', interfaces.Secret, {
    describe: async () =>
      harden({
        label,
        description: '',
        generation: 1,
        state: 'active',
        bytes: 8,
      }),
    makeReadGrant: () => {
      grants += 1;
      return grant();
    },
    revoke: async () => undefined,
    delete: async () => undefined,
    audit: async () => harden([]),
  });
  return { secret, grants: () => grants };
};

const setup = () => {
  const rows = makeRowTable();
  const programs = makeProgramStore();
  const harnessSettings = makeHarnessSettings();
  const kit = makeFactoryKit({
    admin: Far('AgentHostAdmin', {}),
    vats: Far('ThixotropeWorkerController', {}),
    programs,
    rows,
    harnessSettings,
    starts: makeStartCount(),
  });
  const root = makeHarnessRoot({
    operator: kit.operator,
    rows,
    programs,
    settings: harnessSettings,
    configureSpeech: kit.configureSpeech,
  });
  const key = makeSecret('speech key');
  const secrets = makeExo('SecretsAdmin', interfaces.SecretsAdmin, {
    list: () => harden({ secrets: [key.secret] }),
    create: async () => key.secret,
    openWriter: async () => Far('SecretWriter', {}),
    audit: async () => harden([]),
  });
  const agentHost = Far('AgentHostAdmin', { getSecrets: async () => secrets });
  const client = {
    /**
     * @param {string} method
     * @param {string} name
     */
    call: async (method, name) => {
      if (method !== 'lookup') throw Error(`unexpected ${method}`);
      if (name === names.harness) return root;
      if (name === names.agentHost) return agentHost;
      throw Error(`unexpected name ${name}`);
    },
  };
  /** @param {any} voice */
  const run = voice =>
    voiceStep.run({
      client,
      options: /** @type {any} */ (harden({ voice })),
    });
  return { kit, root, harnessSettings, key, run };
};

test('without options.voice the step is skipped', async t => {
  const { kit } = setup();
  const client = { call: async () => t.fail('no call') };
  t.deepEqual(
    await voiceStep.run(/** @type {any} */ ({ client, options: {} })),
    { skipped: true },
  );
  t.truthy(kit);
});

test('speech settings: the Moonshine default, a key by label as a grant, a second run changes nothing', async t => {
  const { kit, key, run } = setup();
  const voice = await E(kit.operator).getVoice();
  const speech = {
    speechIn: { kind: 'process' },
    speechOut: {
      kind: 'openai-audio',
      baseUrl: 'http://127.0.0.1:9/v1',
      model: 'tts-1',
      voices: ['alloy'],
      keyLabel: 'speech key',
    },
  };
  const first = await run({ speech });
  t.false(first.skipped);
  const held = await E(voice).speechSettings();
  t.is(held.revision, 1);
  t.deepEqual(held.speechIn, {
    kind: 'process',
    command: moonshineCommand(DEFAULT_SPEECH_LANGUAGE),
    language: 'en',
  });
  t.deepEqual(await E(held.speechOut.key).describe(), {
    label: 'speech key',
    description: '',
  });
  t.is(key.grants(), 1);

  const second = await run({ speech });
  t.true(second.skipped);
  t.is((await E(voice).speechSettings()).revision, 1);
  t.is(key.grants(), 1, 'no new grant for unchanged settings');

  const changed = await run({
    speech: { ...speech, speechIn: { kind: 'process', language: 'de' } },
  });
  t.false(changed.skipped);
  const now = await E(voice).speechSettings();
  t.is(now.revision, 2);
  t.deepEqual(now.speechIn.command, moonshineCommand('de'));
});

test('a key given as a value, an unknown key label and a half-named pin are refused', async t => {
  const { run } = setup();
  await t.throwsAsync(
    () =>
      run({
        speech: {
          speechIn: {
            kind: 'openai-audio',
            baseUrl: 'http://127.0.0.1:9/v1',
            model: 'm',
            key: 'value',
          },
        },
      }),
    { message: /keyLabel/ },
  );
  await t.throwsAsync(
    () =>
      run({
        speech: {
          speechIn: {
            kind: 'openai-audio',
            baseUrl: 'http://127.0.0.1:9/v1',
            model: 'm',
            keyLabel: 'missing',
          },
        },
      }),
    { message: /No single Secret labelled "missing"/ },
  );
  await t.throwsAsync(() => run({ voiceBackend: 'Fake' }), {
    message: /together/,
  });
});

test('the voice preset pin: the backend by label and the model saved once (R4-89)', async t => {
  const { kit, harnessSettings, run } = setup();
  const backend = makeExo('Backend', interfaces.Backend, {
    describe: () => harden({ kind: 'scripted', label: 'Fake' }),
    open: async () => harden({}),
    listModels: async () => harden({ rows: [], state: 'ok' }),
    /** @param {string} [modelId] */
    resolveModel: async modelId => harden({ modelId: modelId ?? 'm' }),
  });
  harnessSettings.set(harden({ backends: [backend] }));
  const builtIn = kit.catalog.builtIn('voice');
  const before = await E(builtIn).describe();
  const first = await run({
    voiceBackend: 'Fake',
    voiceModelId: 'voice-model',
  });
  t.false(first.skipped);
  const view = await E(builtIn).describe();
  t.is(view.backend, backend);
  t.is(view.modelId, 'voice-model');
  t.is(view.revision, before.revision + 1);
  t.deepEqual(view.objects, before.objects);
  t.is(view.description, before.description);
  const second = await run({
    voiceBackend: 'Fake',
    voiceModelId: 'voice-model',
  });
  t.true(second.skipped);
  t.is((await E(builtIn).describe()).revision, view.revision);
  await t.throwsAsync(
    () => run({ voiceBackend: 'Other', voiceModelId: 'voice-model' }),
    { message: /No single backend labelled "Other"/ },
  );
});
