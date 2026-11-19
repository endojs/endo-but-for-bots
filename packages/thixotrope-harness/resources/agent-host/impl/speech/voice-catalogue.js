// @ts-check
/**
 * The voice catalogue of the `process` speech-out kind and the check of a
 * playback's options against a catalogue (`designs/m11-interfaces.md` 6.2,
 * D-M11-19; R5-40..R5-42, R5-54).
 *
 * - `readVoiceCatalogue(dir)`: the voices of a Piper voices directory: each
 *   `<id>.onnx` with a `<id>.onnx.json` beside it whose `audio.sample_rate`
 *   is a positive integer (R5-40). A broken voice (a half-downloaded model,
 *   metadata that does not parse, no sample rate, metadata over
 *   `voiceFiles.metadataBytes`) is skipped and counted, never allowed to
 *   take the others down; at most `voiceFiles.maxVoices` are listed, in
 *   name order. A directory that cannot be read lists no voice.
 * - `checkTtsOptions(options, catalogue)`: every option a finite number in
 *   `ttsRanges` and the voice one of the catalogue's; a missing option
 *   takes the catalogue's default. Throws `Error` with the R5-41 texts of
 *   `audio-protocol.js` `speechTextOf`. The speech host checks at `speak`
 *   and `replay` (the factory checked the shared preferences at write,
 *   D-M11-19: a catalogue may have changed since).
 *
 * Node only (adapter). Nothing here logs a path or a file's content.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { speechTextOf } from './audio-protocol.js';
import { voiceFiles } from './engine-protocol.js';
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import {
  ttsRanges,
  voiceLimits,
} from '../../../../guest/lib/voice-preferences.js';
/* eslint-enable import/no-relative-packages */

/** @import { CheckedTtsOptions, TtsCatalogue, TtsVoice } from './engine-types.js' */

/**
 * A voice id as a display name (Endo `voiceDisplayName`, R5-40):
 * `en_US-amy-medium` is `English (US) — amy (medium)`.
 * @param {string} id
 */
export const voiceDisplayName = id => {
  const match = /^(en_[A-Z]{2})-(.+)-(x_low|low|medium|high)$/.exec(id);
  if (!match) return id.replace(/[_-]+/g, ' ');
  const [, locale, speaker, quality] = match;
  let localeName = locale.replace('_', ' ');
  if (locale === 'en_US') localeName = 'English (US)';
  if (locale === 'en_GB') localeName = 'English (UK / Europe)';
  return `${localeName} — ${speaker.replace(/_/g, ' ')} (${quality})`;
};
harden(voiceDisplayName);

/**
 * @param {string} path
 * @returns {Promise<number | undefined>} the size of a regular file
 */
const fileSize = async path => {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The sample rate of one voice, or undefined when the voice is broken.
 * @param {string} dir
 * @param {string} id
 */
const sampleRateOf = async (dir, id) => {
  const model = join(dir, `${id}${voiceFiles.model}`);
  const metadata = join(dir, `${id}${voiceFiles.metadata}`);
  const [modelSize, metadataSize] = await Promise.all([
    fileSize(model),
    fileSize(metadata),
  ]);
  if (modelSize === undefined || metadataSize === undefined) return undefined;
  if (metadataSize > voiceFiles.metadataBytes) return undefined;
  try {
    const parsed = JSON.parse(await readFile(metadata, 'utf8'));
    const rate = parsed?.audio?.sample_rate;
    return typeof rate === 'number' && Number.isSafeInteger(rate) && rate > 0
      ? rate
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * @typedef {object} VoiceListing
 * @property {readonly TtsVoice[]} voices at most `voiceFiles.maxVoices`
 * @property {number} skipped broken voices left out
 */

/**
 * @param {string} dir the settings' `voicesDir`
 * @returns {Promise<VoiceListing>}
 */
export const readVoiceCatalogue = async dir => {
  /** @type {string[]} */
  let names = [];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return harden({ voices: [], skipped: 0 });
  }
  const ids = names
    .filter(name => name.endsWith(voiceFiles.model))
    .map(name => name.slice(0, -voiceFiles.model.length))
    .filter(id => id !== '');
  /** @type {TtsVoice[]} */
  const voices = [];
  let skipped = 0;
  for (const id of ids) {
    if (voices.length >= voiceFiles.maxVoices) break;
    // One voice at a time: a directory of many voices opens few files at once.
    // eslint-disable-next-line no-await-in-loop
    const sampleRate = await sampleRateOf(dir, id);
    if (id.length > voiceLimits.voiceUnits || sampleRate === undefined) {
      skipped += 1;
    } else {
      voices.push(harden({ id, name: voiceDisplayName(id), sampleRate }));
    }
  }
  return harden({ voices, skipped });
};
harden(readVoiceCatalogue);

/**
 * @param {Record<string, unknown>} options the page's `TtsOptions` (the
 *   gateway guard admits only the five fields)
 * @param {Pick<TtsCatalogue, 'voices' | 'defaults'>} catalogue
 * @returns {CheckedTtsOptions}
 */
export const checkTtsOptions = (options, catalogue) => {
  const { defaults } = catalogue;
  /** @param {keyof CheckedTtsOptions} name */
  const given = name =>
    options[name] === undefined ? defaults[name] : options[name];
  /** @type {Record<string, number>} */
  const numbers = {};
  for (const [name, range] of Object.entries(ttsRanges)) {
    const value = given(/** @type {keyof typeof ttsRanges} */ (name));
    if (
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < range.min ||
      value > range.max
    ) {
      throw Error(speechTextOf.outOfRange(name, range.min, range.max));
    }
    numbers[name] = value;
  }
  const voice = given('voice');
  if (
    typeof voice !== 'string' ||
    !catalogue.voices.some(entry => entry.id === voice)
  ) {
    throw Error(speechTextOf.unknownVoice(String(voice)));
  }
  return harden({
    voice,
    speed: numbers.speed,
    noiseScale: numbers.noiseScale,
    noiseW: numbers.noiseW,
    sentenceSilence: numbers.sentenceSilence,
  });
};
harden(checkTtsOptions);
