// @ts-check
/**
 * The adapter-local audit reader (M4 W4.4; `designs/m4-interfaces.md` 4.1;
 * R7-63): pages of up to 1,000 audit events, newest first, of every secret
 * or of one. It never enters a vat: the gateway calls it in process and the
 * CLI through the hub, so a 1,000-event page (about 120 KB) costs no vat
 * delivery (perf `secrets.auditReader`).
 *
 * Paging: `page({ secret?, limit = 100, before? })` answers the events
 * older than `before` (an event time, ms); a full page carries `next`, the
 * time of its oldest event, which the caller passes as `before` to read the
 * page after it. The store stamps events with strictly increasing times
 * (M4 H-5), so paging neither repeats nor skips an event. A full page with
 * nothing after it is followed by one empty page.
 *
 * A `secret` filter is a `Secret` presence; its store key is found by
 * amplification through the manager sink (`resolveSecrets`, cached per
 * incarnation by the caller's `resolveSecret`), never by a name.
 *
 * Events carry no value and no byte count (R7-24); failures are
 * `textOf.secretFailed(code)`.
 *
 * Node only (adapter).
 */
/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { m4Interfaces } from '../../../../guest/lib/interfaces-m4.js';
import { m4Limits } from '../../../../guest/lib/limits-m4.js';
/* eslint-enable import/no-relative-packages */
import { secretError } from './store.js';

const { makeExo } = /** @type {any} */ (globalThis);

/**
 * @param {object} options
 * @param {import('./store.js').SecretStore} options.store
 * @param {(secret: any) => Promise<string | null>} options.resolveSecret
 *   Secret presence -> store key (`makeSecretsOps`'s amplification)
 */
export const makeAuditReader = ({ store, resolveSecret }) =>
  makeExo('AuditReader', m4Interfaces.AuditReader, {
    /**
     * @param {{ secret?: any, limit?: number, before?: number }} [query]
     */
    page: async (query = {}) => {
      await null;
      const { secret, limit = m4Limits.auditReaderDefault, before } = query;
      /** @type {string | undefined} */
      let key;
      if (secret !== undefined) {
        const found = await resolveSecret(secret);
        if (found === null) throw secretError('UNKNOWN_SECRET');
        key = found;
      }
      const events = await store.auditPage(
        harden({
          limit,
          ...(key === undefined ? {} : { key }),
          ...(before === undefined ? {} : { before }),
        }),
      );
      const full = limit > 0 && events.length === limit;
      return harden({
        events,
        ...(full ? { next: events[events.length - 1].at } : {}),
      });
    },
  });
harden(makeAuditReader);
