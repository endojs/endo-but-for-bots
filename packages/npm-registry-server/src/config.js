// @ts-check

import { q } from '@endo/errors';

/** @import { Grants, PublishGrant } from './grants.js' */

/**
 * Read the service configuration from the environment the minion.town unit
 * sets (`HOST`, `PORT`, `PUBLIC_REGISTRY_URL`, `UPSTREAM_REGISTRY_URL`,
 * `REGISTRY_STATE_DIRECTORY`). An empty `UPSTREAM_REGISTRY_URL` selects a
 * local-only registry.
 *
 * @param {Record<string, string | undefined>} env
 */
export const readServerEnv = env => {
  const stateDirectory = env.REGISTRY_STATE_DIRECTORY;
  const publicOrigin = env.PUBLIC_REGISTRY_URL;
  if (!stateDirectory || !publicOrigin) {
    throw Error(
      'REGISTRY_STATE_DIRECTORY and PUBLIC_REGISTRY_URL are required',
    );
  }
  const upstream =
    env.UPSTREAM_REGISTRY_URL === undefined
      ? 'https://registry.npmjs.org'
      : env.UPSTREAM_REGISTRY_URL;
  if (upstream && !upstream.startsWith('https://')) {
    throw Error(`UPSTREAM_REGISTRY_URL must be https, got ${q(upstream)}`);
  }
  const port = Number(env.PORT || 3003);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw Error(`PORT must be an integer from 0 to 65535, got ${q(env.PORT)}`);
  }
  const ttlSeconds = env.UPSTREAM_TTL_SECONDS
    ? Number(env.UPSTREAM_TTL_SECONDS)
    : undefined;
  if (
    ttlSeconds !== undefined &&
    !(Number.isFinite(ttlSeconds) && ttlSeconds >= 0)
  ) {
    throw Error(
      `UPSTREAM_TTL_SECONDS must be a non-negative number, got ${q(env.UPSTREAM_TTL_SECONDS)}`,
    );
  }
  return harden({
    stateDirectory,
    publicOrigin,
    upstreamOrigin: upstream || undefined,
    host: env.HOST || '127.0.0.1',
    port,
    upstreamTtlMs: ttlSeconds === undefined ? undefined : ttlSeconds * 1000,
  });
};
harden(readServerEnv);

/**
 * An ISO 8601 date (`YYYY-MM-DD`, read as UTC midnight) or date-time with
 * an explicit `Z` or `±HH:MM` offset, with optional seconds and optional
 * milliseconds of exactly three digits (ECMA-262 Date Time String Format).
 * `Date.parse` reads a date-time without an offset in the host's local time
 * zone, rolls out-of-range fields over, and accepts other formats by
 * engine-specific heuristics, so every field is checked and the instant is
 * computed here instead.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{3}))?)?(?:Z|([+-])(\d{2}):(\d{2})))?$/u;

/**
 * @param {string} text
 * @returns {number | undefined} milliseconds since the epoch
 */
export const parseIsoInstant = text => {
  const match = ISO_INSTANT.exec(text);
  if (!match) {
    return undefined;
  }
  const [year, month, day, hour, minute, second, millisecond] = match
    .slice(1, 8)
    .map(field => (field === undefined ? 0 : Number(field)));
  const offsetHours = Number(match[9] ?? 0);
  const offsetMinutes = Number(match[10] ?? 0);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHours > 23 ||
    offsetMinutes > 59
  ) {
    return undefined;
  }
  // `Date.UTC` rolls an impossible day over (2027-02-30 is March 2).
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return undefined;
  }
  const offset =
    (match[8] === '-' ? -1 : 1) * (offsetHours * 60 + offsetMinutes) * 60_000;
  const time =
    Date.UTC(year, month - 1, day, hour, minute, second, millisecond) - offset;
  return Number.isFinite(time) ? time : undefined;
};
harden(parseIsoInstant);

/**
 * The publisher grant the deployment's secret carries
 * (`REGISTRY_PUBLISHER_GRANT_ID`, `REGISTRY_PUBLISHER_SUBJECT`,
 * `REGISTRY_PUBLISHER_TOKEN`, `REGISTRY_PUBLISHER_PACKAGES` as a
 * comma-separated allowlist, `REGISTRY_PUBLISHER_EXPIRES` as an ISO date or a date-time with an explicit
 * offset). The allowlist is required whenever the token is set.
 * Returns undefined when no grant is configured.
 *
 * @param {Record<string, string | undefined>} env
 */
export const readPublisherGrantEnv = env => {
  const token = env.REGISTRY_PUBLISHER_TOKEN;
  if (!token) {
    return undefined;
  }
  const expiresAt = parseIsoInstant(env.REGISTRY_PUBLISHER_EXPIRES ?? '');
  if (expiresAt === undefined) {
    throw Error(
      'REGISTRY_PUBLISHER_EXPIRES must be an ISO date (YYYY-MM-DD) or date-time with Z or a ±HH:MM offset',
    );
  }
  // The allowlist bounds the grant's authority, so it has no default: a
  // missing allowlist is an error, never the widest scope.
  const packages = (env.REGISTRY_PUBLISHER_PACKAGES ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  if (packages.length === 0) {
    throw Error(
      'REGISTRY_PUBLISHER_PACKAGES is required when REGISTRY_PUBLISHER_TOKEN is set',
    );
  }
  return harden({
    id: env.REGISTRY_PUBLISHER_GRANT_ID || 'garden-llm-publisher-1',
    subject: env.REGISTRY_PUBLISHER_SUBJECT || 'garden-llm-publisher',
    packages,
    expiresAt,
    token,
  });
};
harden(readPublisherGrantEnv);

/**
 * Record the deployment's publisher grant at startup. A refused grant (for
 * example a revoked id still in a stale secret) is reported rather than
 * thrown: reads keep serving and a crash loop would not repair the secret.
 *
 * @param {Pick<Grants, 'putGrant'>} grants
 * @param {Omit<PublishGrant, 'tokenSha256'> & { token: string }} grant
 * @param {(line: string) => void} report
 * @returns {boolean} whether the grant was recorded
 */
export const installPublisherGrant = (grants, grant, report) => {
  try {
    grants.putGrant(grant);
    return true;
  } catch (error) {
    report(
      JSON.stringify({
        event: 'publisher-grant-refused',
        id: grant.id,
        reason: /** @type {Error} */ (error).message,
      }),
    );
    return false;
  }
};
harden(installPublisherGrant);
