// @ts-check

import { q } from '@endo/errors';

/** @import { Grants, PublishGrant } from './grants.js' */

/**
 * Read the service configuration from the environment the minion.town unit
 * sets (`HOST`, `PORT`, `PUBLIC_REGISTRY_URL`, `UPSTREAM_REGISTRY_URL`,
 * `REGISTRY_STATE_DIR`). An empty `UPSTREAM_REGISTRY_URL` selects a
 * local-only registry.
 *
 * @param {Record<string, string | undefined>} env
 */
export const readServerEnv = env => {
  const stateDir = env.REGISTRY_STATE_DIR;
  const publicOrigin = env.PUBLIC_REGISTRY_URL;
  if (!stateDir || !publicOrigin) {
    throw Error('REGISTRY_STATE_DIR and PUBLIC_REGISTRY_URL are required');
  }
  const upstream =
    env.UPSTREAM_REGISTRY_URL === undefined
      ? 'https://registry.npmjs.org'
      : env.UPSTREAM_REGISTRY_URL;
  if (upstream && !upstream.startsWith('https://')) {
    throw Error(`UPSTREAM_REGISTRY_URL must be https, got ${q(upstream)}`);
  }
  return {
    stateDir,
    publicOrigin,
    upstreamOrigin: upstream || undefined,
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3003),
    upstreamTtlMs: env.UPSTREAM_TTL_SECONDS
      ? Number(env.UPSTREAM_TTL_SECONDS) * 1000
      : undefined,
  };
};
harden(readServerEnv);

/**
 * The publisher grant the deployment's secret carries
 * (`REGISTRY_PUBLISHER_GRANT_ID`, `REGISTRY_PUBLISHER_SUBJECT`,
 * `REGISTRY_PUBLISHER_TOKEN`, `REGISTRY_PUBLISHER_PACKAGES` as a
 * comma-separated allowlist, `REGISTRY_PUBLISHER_EXPIRES` as an ISO date).
 * Returns undefined when no grant is configured.
 *
 * @param {Record<string, string | undefined>} env
 */
export const readPublisherGrantEnv = env => {
  const token = env.REGISTRY_PUBLISHER_TOKEN;
  if (!token) {
    return undefined;
  }
  const expiresAt = Date.parse(env.REGISTRY_PUBLISHER_EXPIRES ?? '');
  if (Number.isNaN(expiresAt)) {
    throw Error('REGISTRY_PUBLISHER_EXPIRES must be an ISO date');
  }
  return {
    id: env.REGISTRY_PUBLISHER_GRANT_ID || 'garden-llm-publisher-1',
    subject: env.REGISTRY_PUBLISHER_SUBJECT || 'garden-llm-publisher',
    packages: (env.REGISTRY_PUBLISHER_PACKAGES || '@endo/*')
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
    expiresAt,
    token,
  };
};
harden(readPublisherGrantEnv);

/**
 * Record the deployment's publisher grant at startup. A refused grant (for
 * example a revoked id still in a stale secret) is reported rather than
 * thrown: reads keep serving and a crash loop would not repair the secret.
 *
 * @param {Pick<Grants, 'putGrant'>} grants
 * @param {PublishGrant & { token: string }} grant
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
