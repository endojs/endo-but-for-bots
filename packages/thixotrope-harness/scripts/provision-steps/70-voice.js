// @ts-check
/**
 * The voice provisioning step (`designs/m11-interfaces.md` section 12
 * W11.7, D-M11-21; spec R3-13, R4-89, R5-57, R8-17), a registered step file
 * (`scripts/provision-steps.js` header): skipped without `options.voice`.
 *
 * `options.voice` is `{ speech?, voiceBackend?, voiceModelId? }`, labels at
 * the configuration boundary (F.2 c):
 *
 * - `speech`: `{ speechIn, speechOut }` in the `SpeechSettings` shape
 *   (`guest/lib/guards/factory.js`), except that a provider direction names
 *   its key by `keyLabel` (the label of one API-key Secret, O-10) instead
 *   of holding a `ReadGrant`; a `process` speech-in without `command` runs
 *   the Moonshine daemon (`moonshineCommand`) for its `language` (default
 *   `en`, R8-17). The step writes it with `HarnessRoot.configureSpeech`,
 *   each key as a fresh `makeReadGrant()` of its Secret, unless the
 *   factory already holds the same settings (a grant compared by its
 *   Secret's label), so a run at every start changes nothing (P-28).
 * - `voiceBackend` and `voiceModelId`: the built-in `voice` preset's
 *   backend (a backend of `listBackends()` by its label) and model, saved
 *   with `Preset.save` unless the preset already names both (R4-89).
 *
 * No key value is ever read or written here.
 */
import path from 'node:path';

import { E } from '@endo/far';

import { agentHostDirectory, names } from '../provision-steps.js';
import { secretsByLabel } from './40-subscriptions.js';

/** R8-17: the speech-in language when the options name none. */
export const DEFAULT_SPEECH_LANGUAGE = 'en';

/**
 * The speech-in engine's command of the `process` kind (section 6.2):
 * Endo's Moonshine daemon run by `uv`.
 * @param {string} language
 */
export const moonshineCommand = language =>
  harden([
    'uv',
    'run',
    '--quiet',
    path.join(
      agentHostDirectory,
      'impl',
      'speech',
      'engines',
      'moonshine_daemon.py',
    ),
    '--lang',
    language,
  ]);

/**
 * A value with its record keys sorted, for comparing settings as JSON.
 * @param {unknown} value
 * @returns {unknown}
 */
const sorted = value => {
  if (Array.isArray(value)) return value.map(sorted);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sorted(/** @type {any} */ (value)[key])]),
  );
};

/**
 * One direction of the options with its defaults filled in, still naming
 * its key by label.
 * @param {any} given
 * @param {'speechIn' | 'speechOut'} which
 */
export const directionOf = (given, which) => {
  if (given === undefined) return harden({ kind: 'off' });
  if (given.key !== undefined)
    throw Error(`options.voice.speech.${which} names its key by keyLabel`);
  if (which === 'speechIn' && given.kind === 'process') {
    const language = given.language ?? DEFAULT_SPEECH_LANGUAGE;
    return harden({
      command: moonshineCommand(language),
      ...given,
      language,
    });
  }
  if (which === 'speechIn' && given.kind === 'openai-audio')
    return harden({ language: DEFAULT_SPEECH_LANGUAGE, ...given });
  return harden({ ...given });
};

/**
 * The factory's current direction with its key grant as the label of its
 * Secret (undefined when the grant's Secret is gone: then it differs).
 * @param {any} direction
 */
const labelledDirection = async direction => {
  if (direction.key === undefined) return direction;
  const { key, ...rest } = direction;
  const label = await E(key)
    .describe()
    .then(
      (/** @type {any} */ info) => info.label,
      () => undefined,
    );
  return harden({ ...rest, keyLabel: label });
};

/**
 * Replace `keyLabel` by a fresh grant of that Secret.
 * @param {any} direction
 * @param {() => Promise<Map<string, any>>} secrets by label, read once
 */
const grantedDirection = async (direction, secrets) => {
  if (direction.keyLabel === undefined) return direction;
  const { keyLabel, ...rest } = direction;
  const secret = (await secrets()).get(keyLabel);
  if (secret === undefined)
    throw Error(`No single Secret labelled ${JSON.stringify(keyLabel)}`);
  return harden({ ...rest, key: await E(secret).makeReadGrant() });
};

/**
 * @param {any} client
 * @param {any} harness
 * @param {any} voice
 * @param {any} speech `options.voice.speech`
 */
const configureSpeech = async (client, harness, voice, speech) => {
  const wanted = {
    speechIn: directionOf(speech.speechIn, 'speechIn'),
    speechOut: directionOf(speech.speechOut, 'speechOut'),
  };
  const current = await E(voice).speechSettings();
  const held = {
    speechIn: await labelledDirection(current.speechIn),
    speechOut: await labelledDirection(current.speechOut),
  };
  if (JSON.stringify(sorted(held)) === JSON.stringify(sorted(wanted)))
    return { changed: false, revision: current.revision };
  /** @type {Promise<Map<string, any>> | undefined} */
  let byLabel;
  const secrets = async () => {
    byLabel ??= (async () => {
      const admin = await client.call('lookup', names.agentHost);
      return secretsByLabel(await E(admin).getSecrets());
    })();
    return byLabel;
  };
  const written = await E(harness).configureSpeech(
    harden({
      speechIn: await grantedDirection(wanted.speechIn, secrets),
      speechOut: await grantedDirection(wanted.speechOut, secrets),
    }),
  );
  return { changed: true, revision: written.revision };
};

/**
 * R4-89: the built-in `voice` preset's backend and model.
 * @param {any} operator
 * @param {string} backendLabel
 * @param {string} modelId
 */
const pinVoicePreset = async (operator, backendLabel, modelId) => {
  const factory = await E(operator).getFactory();
  /** @type {any[]} */
  const backends = await E(factory).listBackends();
  const labels = await Promise.all(
    backends.map(backend => E(backend).describe()),
  );
  const matching = backends.filter((_, i) => labels[i].label === backendLabel);
  if (matching.length !== 1)
    throw Error(`No single backend labelled ${JSON.stringify(backendLabel)}`);
  const [backend] = matching;
  const catalog = await E(operator).getPresets();
  const { revision, presets } = await E(catalog).configuration();
  const views = await Promise.all(
    presets.map((/** @type {any} */ preset) => E(preset).describe()),
  );
  const index = views.findIndex(view => view.builtIn && view.label === 'voice');
  if (index < 0) throw Error('The catalogue has no built-in voice preset');
  const view = views[index];
  if (view.backend === backend && view.modelId === modelId)
    return { changed: false };
  const {
    builtIn: _builtIn,
    revision: _revision,
    available: _available,
    unavailableReason: _reason,
    ...record
  } = view;
  await E(presets[index]).save(
    harden({ ...record, backend, modelId }),
    revision,
  );
  return { changed: true };
};

/** @type {import('../provision-steps.js').ProvisionStep} */
export const voiceStep = harden({
  name: 'voice',
  run: async ({ client, options }) => {
    const voiceOptions = /** @type {any} */ (options).voice;
    if (voiceOptions === undefined) return { skipped: true };
    const { speech, voiceBackend, voiceModelId } = voiceOptions;
    if ((voiceBackend === undefined) !== (voiceModelId === undefined))
      throw Error('options.voice names voiceBackend and voiceModelId together');
    const harness = await client.call('lookup', names.harness);
    const operator = await E(harness).getOperator();
    /** @type {Record<string, any>} */
    const detail = {};
    if (speech !== undefined) {
      const voice = await E(operator).getVoice();
      detail.speech = await configureSpeech(client, harness, voice, speech);
    }
    if (voiceBackend !== undefined)
      detail.preset = await pinVoicePreset(
        operator,
        voiceBackend,
        voiceModelId,
      );
    const changed = Object.values(detail).some(part => part.changed);
    return { skipped: !changed, detail };
  },
});

/** @type {import('../provision-steps.js').ProvisionStep[]} */
export const steps = harden([voiceStep]);
