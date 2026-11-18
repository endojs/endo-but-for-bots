// @ts-check
/**
 * The account readings file (W4.5; `designs/m4-interfaces.md` sections 3.4
 * and 6): `<state>/agent-host/subscriptions/readings.json`, the last reading
 * of each member's account, so a restarted adapter can show it as
 * `remembered` (R4-84) until the provider is read again.
 *
 * Format: `{ format: 'thixotrope-harness-readings-1', members: [{ key,
 * provider, reading }] }`. `key` is the credential's store key (`k<n>`): it
 * names the entry on disk and never leaves the adapter (M1b 17.3). A reading
 * holds windows, plan, credits and times only: no token, no header value,
 * no provider body (D-6). Whatever the file holds is re-checked on load and
 * cut to the M4 bounds, so a damaged or hand-edited file can only lose
 * readings, never put an unbounded value into a view.
 *
 * Writes are temp file + fsync + rename + directory fsync, at most once per
 * `flushMs` (5 s, `subscriptionDefaults.readingsFlushMs`); the newest state
 * wins and intermediate states are skipped (a SIGKILL loses at most the last
 * `flushMs` of readings, m4-interfaces 10).
 *
 * Node only.
 */
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { pid } from 'node:process';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */

/** @import { Reading, ReadingWindow } from './types.js' */

export const READINGS_FORMAT = 'thixotrope-harness-readings-1';
/** The file never holds more entries than the manager keeps members. */
const MAX_ENTRIES = subscriptionLimits.maxMembers;
/** A store key is `k<n>`; anything else in the file is dropped. */
const KEY_PATTERN = /^k[0-9]{1,15}$/;

/** @param {unknown} value */
const isTime = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * @param {unknown} value
 * @param {number} units
 */
const boundedText = (value, units) =>
  typeof value === 'string' ? value.slice(0, units) : undefined;

/**
 * One window, checked and bounded, or undefined.
 * @param {any} candidate
 * @returns {ReadingWindow | undefined}
 */
const windowOf = candidate => {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const { name, usedPercent, resetsAtMs, windowMinutes } = candidate;
  if (name !== 'primary' && name !== 'secondary' && name !== 'other')
    return undefined;
  if (!isTime(usedPercent)) return undefined;
  /** @type {ReadingWindow} */
  const window = { name, usedPercent: Math.min(100, usedPercent) };
  if (isTime(resetsAtMs)) window.resetsAtMs = resetsAtMs;
  if (isTime(windowMinutes)) window.windowMinutes = windowMinutes;
  return window;
};

/**
 * A reading as the file may hold it, checked and bounded (no unknown field
 * survives), or undefined. The `source` is set by the caller.
 *
 * @param {any} candidate
 * @param {'observed' | 'remembered'} source
 * @returns {Reading | undefined}
 */
export const checkReading = (candidate, source) => {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  if (!isTime(candidate.at)) return undefined;
  const windows = Array.isArray(candidate.windows)
    ? candidate.windows
        .slice(0, subscriptionLimits.maxWindows)
        .map(windowOf)
        .filter(window => window !== undefined)
    : [];
  /** @type {Reading} */
  const reading = {
    at: candidate.at,
    source,
    windows,
    limitReached: candidate.limitReached === true,
  };
  const plan = boundedText(candidate.plan, subscriptionLimits.planUnits);
  if (plan !== undefined && plan !== '') reading.plan = plan;
  const credits = boundedText(candidate.credits, subscriptionLimits.planUnits);
  if (credits !== undefined && credits !== '') reading.credits = credits;
  if (Array.isArray(candidate.banked)) {
    reading.banked = candidate.banked
      .slice(0, subscriptionLimits.maxBankedCredits)
      .filter(
        (/** @type {any} */ credit) =>
          credit !== null && typeof credit === 'object',
      )
      .map((/** @type {any} */ credit) => {
        /** @type {{ expiresAtMs?: number, label?: string }} */
        const out = {};
        if (isTime(credit.expiresAtMs)) out.expiresAtMs = credit.expiresAtMs;
        const label = boundedText(credit.label, limits.labelUnits);
        if (label !== undefined && label !== '') out.label = label;
        return out;
      });
  }
  return reading;
};
harden(checkReading);

/**
 * @typedef {object} ReadingsEntry
 * @property {string} key the credential's store key
 * @property {'claude' | 'codex'} provider
 * @property {Reading} reading `source: 'remembered'` when loaded
 */

/**
 * Load the readings file. A missing, unreadable or malformed file is no
 * readings (it is rewritten at the next flush); entries that fail the check
 * are dropped one by one. Synchronous: the file is at most 64 small entries
 * and is read once per incarnation, at the first accounts use.
 *
 * @param {string} file
 * @returns {ReadingsEntry[]}
 */
export const loadReadings = file => {
  /** @type {any} */
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.format !== READINGS_FORMAT ||
    !Array.isArray(parsed.members)
  )
    return [];
  /** @type {ReadingsEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const candidate of parsed.members.slice(0, MAX_ENTRIES)) {
    const { key, provider } =
      candidate !== null && typeof candidate === 'object' ? candidate : {};
    const reading =
      typeof key === 'string' &&
      KEY_PATTERN.test(key) &&
      !seen.has(key) &&
      (provider === 'claude' || provider === 'codex')
        ? checkReading(candidate.reading, 'remembered')
        : undefined;
    if (reading !== undefined) {
      seen.add(key);
      entries.push({ key, provider, reading });
    }
  }
  return entries;
};
harden(loadReadings);

/**
 * The file's text for these entries (the `source` is not written: whatever
 * is loaded is `remembered`).
 * @param {readonly ReadingsEntry[]} entries
 */
export const formatReadings = entries =>
  `${JSON.stringify({
    format: READINGS_FORMAT,
    members: entries.slice(0, MAX_ENTRIES).map(({ key, provider, reading }) => {
      const { source: _source, ...kept } = reading;
      return { key, provider, reading: kept };
    }),
  })}\n`;
harden(formatReadings);

/**
 * Write `text` to `file` atomically: temp file, fsync, rename, directory
 * fsync (the directory fsync is best effort where the platform refuses it).
 * @param {string} file
 * @param {string} text
 */
const writeAtomic = async (file, text) => {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true });
  const temp = `${file}.tmp-${pid}`;
  const handle = await open(temp, 'w', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  try {
    const dirHandle = await open(dir, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    // Some platforms refuse fsync on a directory; the rename is still atomic.
  }
};

/**
 * @typedef {object} ReadingsWriter
 * @property {(entries: () => readonly ReadingsEntry[]) => void} update
 *   the entries changed; `entries` is called when the write happens, so a
 *   burst of updates within `flushMs` costs one write of the newest state
 * @property {() => Promise<void>} flush write a pending update now
 * @property {() => Promise<void>} close flush, then refuse later updates
 * @property {() => number} writes completed writes (tests, perf)
 */

/**
 * @param {object} options
 * @param {string | (() => string)} options.file
 * @param {{ after: (ms: number, fn: () => void) => () => void }} options.timers
 * @param {number} [options.flushMs] default 5,000
 * @param {(error: unknown) => void} [options.onError] a failed write (the
 *   next update tries again); never given a reading's content
 * @returns {ReadingsWriter}
 */
export const makeReadingsWriter = ({
  file,
  timers,
  flushMs = 5000,
  onError = () => {},
}) => {
  const fileOf = typeof file === 'function' ? file : () => file;
  /** @type {(() => readonly ReadingsEntry[]) | undefined} */
  let pending;
  /** @type {(() => void) | undefined} */
  let cancelTimer;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  let closed = false;
  let writes = 0;

  const writeNow = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    const source = pending;
    pending = undefined;
    if (source === undefined) return chain;
    chain = chain.then(async () => {
      try {
        await writeAtomic(fileOf(), formatReadings(source()));
        writes += 1;
      } catch (error) {
        onError(error);
      }
    });
    return chain;
  };

  return harden({
    update: entries => {
      if (closed) return;
      pending = entries;
      if (cancelTimer === undefined)
        cancelTimer = timers.after(flushMs, () => {
          cancelTimer = undefined;
          void writeNow();
        });
    },
    flush: () => writeNow(),
    close: async () => {
      await writeNow();
      closed = true;
    },
    writes: () => writes,
  });
};
harden(makeReadingsWriter);
