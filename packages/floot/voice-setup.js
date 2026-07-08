// @ts-check
/* global process */
// endo run --UNCONFINED voice-setup.js --powers @agent \
//   -E FLOOT_TTS_MODEL=/abs/path/to/voice.onnx   (optionally -E FLOOT_DIR=floot)
//
// Provisions the two voice halves as separate unconfined caplets under the
// `floot/` inventory directory: the STT object ("floot/stt", moonshine via uv)
// and the TTS object ("floot/tts", piper). They stay distinct daemon objects
// (each its own formula) so either can be swapped for an alternative
// implementation. A Floot Chat Space auto-detects them at floot/stt, floot/tts.
//
// Requires on this machine: `uv` (for the self-contained moonshine STT script)
// and a `piper` binary plus a voice model (FLOOT_TTS_MODEL points at the .onnx;
// its companion .onnx.json must sit next to it).
//
// When run via ENDO_EXTRA on a daemon, only ENDO_-prefixed env vars survive the
// daemon's env filter (packages/daemon/index.js `allowEnvPass`), so this script
// also accepts ENDO_-prefixed equivalents: ENDO_FLOOT_TTS_MODEL,
// ENDO_FLOOT_TTS_BINARY, ENDO_FLOOT_TTS_SPEED, ENDO_FLOOT_STT_UV,
// ENDO_FLOOT_STT_LANG, ENDO_FLOOT_STT_ENABLE, ENDO_FLOOT_DIR.
//
// Auto-provisioning is best-effort and independent per half: TTS is stood up
// first (so it lands even when STT can't), and STT is optional (disable with
// FLOOT_STT_ENABLE=0) and wrapped so a missing `uv`/model or a moonshine warmup
// failure only skips STT rather than aborting TTS.

import { E } from '@endo/eventual-send';

const audioCapletSpecifier = new URL(
  'voice/audio-server-caplet.js',
  import.meta.url,
).href;
const ttsCapletSpecifier = new URL(
  'voice/tts-server-caplet.js',
  import.meta.url,
).href;
const moonshineScript = new URL('voice/moonshine_daemon.py', import.meta.url)
  .pathname;
const voiceDir = new URL('voice/', import.meta.url).pathname;

// First non-empty of the given env var names (so a plain FLOOT_* wins over its
// ENDO_-prefixed fallback when both happen to be set).
const pickEnv = (...names) => {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
};

// Interpret an env flag as a boolean; unset (undefined) is decided by the
// caller's default.
const isTruthy = value =>
  !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());

/**
 * Stand up (or replace) the floot-tts and (optionally) floot-stt caplets.
 *
 * @param {import('@endo/eventual-send').ERef<object>} agent
 */
export const main = async agent => {
  const dir = pickEnv('FLOOT_DIR', 'ENDO_FLOOT_DIR') || 'floot';
  const sttPath = [dir, 'stt'];
  const ttsPath = [dir, 'tts'];

  const ttsModel = pickEnv('FLOOT_TTS_MODEL', 'ENDO_FLOOT_TTS_MODEL');
  const sttFlag = pickEnv('FLOOT_STT_ENABLE', 'ENDO_FLOOT_STT_ENABLE');
  // STT is on by default; set FLOOT_STT_ENABLE=0 for a TTS-only deployment.
  const sttEnabled = sttFlag === undefined ? true : isTruthy(sttFlag);

  // Ensure the floot/ directory exists (idempotent; shared with the factory).
  if (!(await E(agent).has(dir))) {
    await E(agent).makeDirectory(dir);
  }

  // TTS first: piper is self-contained (a binary + a model file), so it stands
  // up reliably and should not be held hostage to STT's heavier moonshine/uv
  // stack. Skip (don't throw) when no model is configured, so a partial voice
  // deployment — and any co-scheduled ENDO_EXTRA setups — still proceed.
  if (!ttsModel) {
    console.warn(
      'Floot voice: no FLOOT_TTS_MODEL (or ENDO_FLOOT_TTS_MODEL); skipping TTS.',
    );
  } else {
    if (await E(agent).has(dir, 'tts')) {
      await E(agent).remove(dir, 'tts');
    }
    console.log(`Standing up TTS caplet as "${dir}/tts" (piper)...`);
    await E(agent).makeUnconfined(undefined, ttsCapletSpecifier, {
      resultName: ttsPath,
      env: harden({
        FLOOT_TTS_BINARY:
          pickEnv('FLOOT_TTS_BINARY', 'ENDO_FLOOT_TTS_BINARY') || 'piper',
        FLOOT_TTS_MODEL: ttsModel,
        FLOOT_TTS_SPEED:
          pickEnv('FLOOT_TTS_SPEED', 'ENDO_FLOOT_TTS_SPEED') || '1.0',
      }),
    });
    console.log(`Floot voice: "${dir}/tts" ready.`);
  }

  // STT is best-effort: its caplet awaits a moonshine warmup at stand-up, which
  // needs `uv`, Python, and (first run) network to fetch model weights — any of
  // which may be unavailable on a headless host. Contain a failure to STT so it
  // never takes down the already-provisioned TTS half.
  if (!sttEnabled) {
    console.log('Floot voice: STT disabled (FLOOT_STT_ENABLE=0); skipping.');
  } else {
    try {
      if (await E(agent).has(dir, 'stt')) {
        await E(agent).remove(dir, 'stt');
      }
      console.log(`Standing up STT caplet as "${dir}/stt" (loads moonshine)...`);
      await E(agent).makeUnconfined(undefined, audioCapletSpecifier, {
        resultName: sttPath,
        env: harden({
          FLOOT_STT_SCRIPT: moonshineScript,
          FLOOT_PROJECT_DIR: voiceDir,
          FLOOT_STT_UV: pickEnv('FLOOT_STT_UV', 'ENDO_FLOOT_STT_UV') || 'uv',
          FLOOT_STT_LANG:
            pickEnv('FLOOT_STT_LANG', 'ENDO_FLOOT_STT_LANG') || 'en',
        }),
      });
      console.log(`Floot voice: "${dir}/stt" ready.`);
    } catch (error) {
      console.warn(
        `Floot voice: STT provisioning failed (uv/moonshine unavailable?): ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  console.log(
    `Floot voice done. A Floot Chat Space auto-detects "${dir}/tts"` +
      `${sttEnabled ? ` and "${dir}/stt"` : ''}.`,
  );
};
harden(main);
