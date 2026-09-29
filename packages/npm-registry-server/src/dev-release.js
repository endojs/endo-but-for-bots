// @ts-check

import { q } from '@endo/errors';
import { RegistryHttpError } from './errors.js';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/u;

/**
 * The development coordinate from `designs/npm-dev-registry-serving.md`
 * § Release identity:
 * `<major>.<minor>.<patch>-dev.<UTC commit time YYYYMMDDHHMMSS>.g<sha7>`.
 */
const DEV_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.((\d{4})(\d{2})(\d{2})\d{6})\.g([0-9a-f]{7,40})$/u;

const DATE_TAG = /^dev-(\d{4})-(\d{2})-(\d{2})$/u;
const DEV_TAG = /^dev-[a-z0-9][a-z0-9.-]*$/u;

/**
 * @typedef {object} ParsedSemver
 * @property {number} major
 * @property {number} minor
 * @property {number} patch
 * @property {string[]} prerelease
 */

/**
 * @param {string} version
 * @returns {ParsedSemver | undefined}
 */
export const parseSemver = version => {
  const match = SEMVER.exec(version);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] === undefined ? [] : match[4].split('.'),
  };
};
harden(parseSemver);

/**
 * SemVer 2.0.0 precedence. Build metadata is ignored.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} negative, zero, or positive
 */
export const compareSemver = (a, b) => {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    throw Error(`Cannot compare non-SemVer versions ${q(a)} and ${q(b)}`);
  }
  for (const key of /** @type {const} */ (['major', 'minor', 'patch'])) {
    if (pa[key] !== pb[key]) {
      return pa[key] - pb[key];
    }
  }
  if (pa.prerelease.length === 0 || pb.prerelease.length === 0) {
    return pb.prerelease.length - pa.prerelease.length;
  }
  const length = Math.min(pa.prerelease.length, pb.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = pa.prerelease[i];
    const y = pb.prerelease[i];
    if (x !== y) {
      const xn = /^\d+$/u.test(x);
      const yn = /^\d+$/u.test(y);
      if (xn && yn) {
        return Number(x) - Number(y);
      }
      if (xn !== yn) {
        return xn ? -1 : 1;
      }
      return x < y ? -1 : 1;
    }
  }
  return pa.prerelease.length - pb.prerelease.length;
};
harden(compareSemver);

/**
 * Validate a development version and return the one publish-time date tag
 * it must carry.
 *
 * @param {string} version
 * @returns {string} the `dev-YYYY-MM-DD` tag matching the commit date
 */
export const devDateTagForVersion = version => {
  const match = DEV_VERSION.exec(version);
  if (!match) {
    throw RegistryHttpError(
      400,
      `Version ${q(version)} is not a development coordinate <major>.<minor>.<patch>-dev.<YYYYMMDDHHMMSS>.g<sha>`,
    );
  }
  const [, , , , , year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (
    Number.isNaN(date.getTime()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  ) {
    throw RegistryHttpError(400, `Version ${q(version)} has an invalid date`);
  }
  return `dev-${year}-${month}-${day}`;
};
harden(devDateTagForVersion);

/**
 * @param {string} tag
 * @returns {boolean}
 */
export const isDateTag = tag => DATE_TAG.test(tag);
harden(isDateTag);

/**
 * Whether the tag is one this service may create or move: a date channel,
 * or one of the reserved moving `dev-*` pointers.
 *
 * @param {string} tag
 * @param {readonly string[]} reservedTags
 * @returns {boolean}
 */
export const isWritableDevTag = (tag, reservedTags) =>
  DEV_TAG.test(tag) && (isDateTag(tag) || reservedTags.includes(tag));
harden(isWritableDevTag);
