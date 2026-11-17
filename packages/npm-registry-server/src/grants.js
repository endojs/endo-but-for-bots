// @ts-check

import { createHash, randomBytes } from 'node:crypto';
import { q } from '@endo/errors';
import { isAllowlistEntry } from './names.js';

/** @import { RegistryStore } from './store.js' */

/**
 * @typedef {object} PublishGrant
 * @property {string} id
 * @property {string} subject
 * @property {string[]} packages Exact names or `@scope/*` entries.
 * @property {number} expiresAt Milliseconds since the epoch.
 * @property {string} tokenSha256 The credential the grant was authenticated
 *   with, so a re-check after an `await` can tell a rotated token apart.
 */

/**
 * @param {string} token
 * @returns {string}
 */
export const hashToken = token =>
  createHash('sha256').update(token, 'utf8').digest('hex');
harden(hashToken);

/** @returns {string} a fresh 256-bit bearer token */
export const makeToken = () => randomBytes(32).toString('base64url');
harden(makeToken);

/**
 * Durable `PublishGrant` state. Only a token's SHA-256 is stored; the
 * bearer itself exists in the publisher's secret and nowhere in the
 * registry's state.
 *
 * @param {object} options
 * @param {RegistryStore} options.store
 * @param {() => number} [options.now]
 */
export const makeGrants = ({ store, now = Date.now }) => {
  const { statements } = store;

  /**
   * Record (or replace, while unrevoked) a grant by id.
   *
   * @param {Omit<PublishGrant, 'tokenSha256'> & { token: string }} grant
   */
  const putGrant = ({ id, subject, packages, expiresAt, token }) => {
    if (!/^[A-Za-z0-9._-]+$/u.test(id)) {
      throw Error(`Invalid grant id ${q(id)}`);
    }
    if (token.length < 32) {
      throw Error('Publish tokens must be at least 32 characters');
    }
    if (packages.length === 0) {
      throw Error('A grant must allow at least one package');
    }
    for (const entry of packages) {
      if (!isAllowlistEntry(entry)) {
        throw Error(`Invalid grant allowlist entry ${q(entry)}`);
      }
    }
    store.transaction(() => {
      const result = statements.upsertGrant.run(
        id,
        subject,
        hashToken(token),
        JSON.stringify(packages),
        expiresAt,
        now(),
      );
      if (result.changes === 0) {
        throw Error(`Grant ${q(id)} is revoked; issue a successor id`);
      }
      statements.audit.run(
        now(),
        subject,
        'grant-issue',
        null,
        null,
        null,
        'ok',
        null,
        id,
      );
    });
  };

  /** @param {string} id */
  const revokeGrant = id =>
    store.transaction(() => {
      const { changes } = statements.revokeGrant.run(now(), id);
      statements.audit.run(
        now(),
        null,
        'grant-revoke',
        null,
        null,
        null,
        changes ? 'ok' : 'absent',
        null,
        id,
      );
      return Number(changes) > 0;
    });

  /**
   * @param {string | undefined} token
   * @returns {PublishGrant | undefined} a live grant, or undefined
   */
  const authenticate = token => {
    if (!token) {
      return undefined;
    }
    const tokenSha256 = hashToken(token);
    const row = statements.getGrantByToken.get(tokenSha256);
    if (!row || row.revoked_at !== null || Number(row.expires_at) <= now()) {
      return undefined;
    }
    return harden({
      id: row.id,
      subject: row.subject,
      packages: JSON.parse(row.packages_json),
      expiresAt: row.expires_at,
      tokenSha256,
    });
  };

  const listGrants = () =>
    statements.listGrants.all().map(row => ({
      id: row.id,
      subject: row.subject,
      packages: JSON.parse(row.packages_json),
      expiresAt: new Date(row.expires_at).toISOString(),
      revokedAt: row.revoked_at && new Date(row.revoked_at).toISOString(),
    }));

  return harden({ putGrant, revokeGrant, authenticate, listGrants });
};
harden(makeGrants);

/** @typedef {ReturnType<typeof makeGrants>} Grants */
