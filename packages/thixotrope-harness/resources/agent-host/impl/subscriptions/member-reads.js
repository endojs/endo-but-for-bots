// @ts-check
/**
 * The member reads file (`designs/m4-interfaces.md` 3.4 and 6):
 * `<state>/agent-host/subscriptions/member-reads.json`, next to the
 * readings file, so a restarted adapter keeps what a member's reads
 * showed: its last good model list (the pool catalogue answers from it
 * while it is under the catalogue's 24-hour bound, R4-104) and the code,
 * HTTP status and time of its last failed catalogue read and usage read,
 * so a dead member stays visibly dead.
 *
 * Format: `{ format: 'thixotrope-harness-member-reads-1', members: [{ key,
 * provider, models?: { readAt, list }, catalogFailure?, usageFailure? }]
 * }`; a failure is `{ code, status?, atMs }`. `key` is the credential's
 * store key (`k<n>`) and never leaves the adapter. It holds model
 * identifiers, titles, descriptions and efforts as the provider listed
 * them (already cut to the M2 row bounds), codes and times: no token, no
 * header value, no body (D-6). Everything is re-checked on load; a list
 * past 24 hours, or one that fails a check, is dropped whole.
 *
 * Written with the readings writer (`account-file.js`: temp file, fsync,
 * rename, at most once per `flushMs`).
 *
 * Node only.
 */
import { readFileSync } from 'node:fs';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { limits } from '../../../../guest/lib/limits.js';
import { subscriptionLimits } from '../../../../guest/lib/subscription-limits.js';
/* eslint-enable import/no-relative-packages */
import { CATALOG_MAX_AGE_MS, isHttpStatus } from '../providers/catalog-core.js';

export const MEMBER_READS_FORMAT = 'thixotrope-harness-member-reads-1';
/** At most one entry per member the manager keeps. */
const MAX_ENTRIES = subscriptionLimits.maxMembers;
/**
 * A list longer than this is kept in memory only (a provider lists tens):
 * the file stays small (64 members x 128 models) and loads synchronously.
 */
export const MAX_REMEMBERED_MODELS = 128;
const KEY_PATTERN = /^k[0-9]{1,15}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
/** A model id as the readers admit them: printable, at most 256 units. */
const MODEL_ID = /^[^\s\p{Cc}]{1,256}$/u;
const EFFORT = /^[a-z][a-z0-9_-]{0,63}$/;
const MAX_MODEL_EFFORTS = 64;

/**
 * @typedef {object} ReadFailureRecord
 * @property {string} code a fixed code
 * @property {number} [status] an HTTP status
 * @property {number} atMs
 */

/**
 * @typedef {object} RememberedModels
 * @property {number} readAt
 * @property {any[]} list `PoolModel`s (`subscriptions/catalog.js`)
 */

/**
 * @typedef {object} MemberReadsEntry
 * @property {string} key
 * @property {'claude' | 'codex'} provider
 * @property {RememberedModels} [models]
 * @property {ReadFailureRecord} [catalogFailure]
 * @property {ReadFailureRecord} [usageFailure]
 */

/**
 * @param {unknown} value
 * @returns {value is number}
 */
const isTime = value =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** @param {unknown} value */
const isCount = value =>
  value === undefined ||
  (typeof value === 'number' &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff);

/**
 * @param {unknown} value
 * @param {number} units
 */
const isText = (value, units) =>
  typeof value === 'string' && value.length <= units;

/**
 * A failure record, or undefined.
 * @param {any} candidate
 * @returns {ReadFailureRecord | undefined}
 */
export const checkFailure = candidate => {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const { code, status, atMs } = candidate;
  if (typeof code !== 'string' || !CODE_PATTERN.test(code) || !isTime(atMs))
    return undefined;
  return harden({ code, ...(isHttpStatus(status) ? { status } : {}), atMs });
};
harden(checkFailure);

/**
 * One remembered model, or undefined.
 * @param {any} model
 */
const checkModel = model => {
  if (model === null || typeof model !== 'object') return undefined;
  const {
    id,
    title,
    description,
    reasoningEfforts,
    defaultReasoningEffort,
    contextLength,
    maxOutputTokens,
  } = model;
  if (
    typeof id !== 'string' ||
    !MODEL_ID.test(id) ||
    !isText(title, limits.labelUnits) ||
    !isText(description, limits.modelDescriptionUnits) ||
    !Array.isArray(reasoningEfforts) ||
    reasoningEfforts.length > MAX_MODEL_EFFORTS ||
    !reasoningEfforts.every(
      effort => typeof effort === 'string' && EFFORT.test(effort),
    ) ||
    (defaultReasoningEffort !== undefined &&
      !(
        typeof defaultReasoningEffort === 'string' &&
        EFFORT.test(defaultReasoningEffort)
      )) ||
    !isCount(contextLength) ||
    !isCount(maxOutputTokens)
  )
    return undefined;
  return harden({
    id,
    title,
    description,
    reasoningEfforts: harden([...reasoningEfforts]),
    ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }),
    ...(contextLength === undefined ? {} : { contextLength }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  });
};

/**
 * A remembered model list still under the catalogue's 24-hour bound, or
 * undefined (any bad model drops the whole list: never a partial one).
 * @param {any} candidate
 * @param {number} nowMs
 * @returns {RememberedModels | undefined}
 */
export const checkModels = (candidate, nowMs) => {
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const { readAt, list } = candidate;
  if (
    !isTime(readAt) ||
    readAt > nowMs ||
    nowMs - readAt >= CATALOG_MAX_AGE_MS ||
    !Array.isArray(list) ||
    list.length > MAX_REMEMBERED_MODELS
  )
    return undefined;
  const models = list.map(checkModel);
  const ids = new Set(models.map(model => model?.id));
  if (models.includes(undefined) || ids.size !== models.length)
    return undefined;
  return harden({ readAt, list: harden(models) });
};
harden(checkModels);

/**
 * Load the member reads file; anything missing, malformed or past its bound
 * is no entry.
 * @param {string} file
 * @param {number} nowMs
 * @returns {MemberReadsEntry[]}
 */
export const loadMemberReads = (file, nowMs) => {
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
    parsed.format !== MEMBER_READS_FORMAT ||
    !Array.isArray(parsed.members)
  )
    return [];
  /** @type {MemberReadsEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const candidate of parsed.members.slice(0, MAX_ENTRIES)) {
    const { key, provider } =
      candidate !== null && typeof candidate === 'object' ? candidate : {};
    const usable =
      typeof key === 'string' &&
      KEY_PATTERN.test(key) &&
      !seen.has(key) &&
      (provider === 'claude' || provider === 'codex');
    const models = usable ? checkModels(candidate.models, nowMs) : undefined;
    const catalogFailure = usable
      ? checkFailure(candidate.catalogFailure)
      : undefined;
    const usageFailure = usable
      ? checkFailure(candidate.usageFailure)
      : undefined;
    if (usable) seen.add(key);
    if (models || catalogFailure || usageFailure)
      entries.push({
        key,
        provider,
        ...(models ? { models } : {}),
        ...(catalogFailure ? { catalogFailure } : {}),
        ...(usageFailure ? { usageFailure } : {}),
      });
  }
  return entries;
};
harden(loadMemberReads);

/**
 * The file's text for these entries.
 * @param {readonly MemberReadsEntry[]} entries
 */
export const formatMemberReads = entries =>
  `${JSON.stringify({
    format: MEMBER_READS_FORMAT,
    members: entries
      .slice(0, MAX_ENTRIES)
      .map(({ key, provider, models, catalogFailure, usageFailure }) => ({
        key,
        provider,
        ...(models ? { models } : {}),
        ...(catalogFailure ? { catalogFailure } : {}),
        ...(usageFailure ? { usageFailure } : {}),
      })),
  })}\n`;
harden(formatMemberReads);
