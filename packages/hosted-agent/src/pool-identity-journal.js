// @ts-check

import { Fail } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { M, matches } from '@endo/patterns';

const PREFIX = 'pool-identities-v1-';
const NAME = /^pool-identities-v1-[0-9]{20}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Authoritative capability bindings, separate from disposable capacity/cache
 * observations. The namespace must be durable and exclusively written by its
 * owning formula. This queue excludes calls only in this module instance; it
 * is not a cross-worker credential-ownership mechanism.
 *
 * storeValue marshals actual formula-backed capabilities, never their secret
 * bytes or a mutable pet-name wrapper. Any uncertain read/write fences this
 * instance; a replacement must reconstruct from the authoritative namespace.
 * @param {{ namespace: any, providerId: string, origin: string, accountRef: string }} options
 */
export const makePoolIdentityJournal = ({
  namespace,
  providerId,
  origin,
  accountRef,
}) => {
  (typeof providerId === 'string' &&
    ID.test(providerId) &&
    typeof origin === 'string' &&
    new URL(origin).origin === origin &&
    origin.startsWith('https://') &&
    typeof accountRef === 'string' &&
    /^[A-Za-z0-9_-]{1,256}$/.test(accountRef)) ||
    Fail`Invalid pool provider identity`;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  let failed = false;
  /** Whether this incarnation started with an authoritative snapshot. */
  let established;

  /** @param {any} value */
  const validate = value => {
    (value &&
      Object.keys(value).sort().join(',') ===
        'bindings,origin,providerId,version' &&
      value.version === 1 &&
      value.providerId === providerId &&
      value.origin === origin &&
      Array.isArray(value.bindings) &&
      Number(value.bindings.length) <= 4096) ||
      Fail`Invalid authoritative pool identity journal`;
    const ids = new Set();
    const authorities = new Set();
    for (const binding of value.bindings) {
      (binding &&
        Object.keys(binding).sort().join(',') ===
          'accountRef,authority,id,kind,name,retired' &&
        typeof binding.id === 'string' &&
        ID.test(binding.id) &&
        !ids.has(binding.id) &&
        ['secret', 'subscription'].includes(binding.kind) &&
        typeof binding.name === 'string' &&
        ID.test(binding.name) &&
        typeof binding.accountRef === 'string' &&
        /^[A-Za-z0-9_-]{1,256}$/.test(binding.accountRef) &&
        typeof binding.retired === 'boolean' &&
        matches(binding.authority, M.remotable()) &&
        !authorities.has(binding.authority)) ||
        Fail`Invalid authoritative pool identity binding`;
      ids.add(binding.id);
      authorities.add(binding.authority);
    }
    return value;
  };

  /** @param {readonly any[]} members */
  const bind = members => {
    const result = chain.then(async () => {
      !failed || Fail`Pool identity journal is fenced after uncertain storage`;
      try {
        const listed = await E(namespace).list();
        (Array.isArray(listed) &&
          listed.every(name => typeof name === 'string')) ||
          Fail`Pool identity namespace cannot be read`;
        const names = listed.filter(name => name.startsWith(PREFIX)).sort();
        names.every(name => NAME.test(name)) ||
          Fail`Malformed pool identity journal entry`;
        const last = names.at(-1);
        established ??= last !== undefined;
        const previous =
          last === undefined
            ? { version: 1, providerId, origin, bindings: [] }
            : validate(await E(namespace).lookup(last));
        const old = new Map(
          previous.bindings.map(binding => [binding.id, binding]),
        );
        const requested = new Set();
        const active = [];
        for (const member of members) {
          const kind =
            member.subscriptionName === undefined ? 'secret' : 'subscription';
          const name = member.subscriptionName ?? member.secretName;
          const boundAccount = member.accountRef ?? accountRef;
          (typeof member.id === 'string' &&
            ID.test(member.id) &&
            !requested.has(member.id) &&
            typeof name === 'string' &&
            ID.test(name)) ||
            Fail`Invalid pool identity request`;
          requested.add(member.id);
          const prior = /** @type {any} */ (old.get(member.id));
          !prior ||
            (!prior.retired &&
              prior.kind === kind &&
              prior.name === name &&
              prior.accountRef === boundAccount) ||
            Fail`Subscription member identity is retired or changed; use a new member ID`;
          // Resolve once. Nothing returned to credential consumers will look up
          // this mutable name again; later load checks detect a rebound name.
          // eslint-disable-next-line no-await-in-loop
          const authority = await E(namespace).lookup(name);
          matches(authority, M.remotable()) ||
            Fail`Pool member authority is not a capability`;
          !prior ||
            prior.authority === authority ||
            Fail`Subscription member capability changed; use a new member ID`;
          previous.bindings.every(
            binding =>
              binding.id === member.id || binding.authority !== authority,
          ) ||
            Fail`Authority capability was already bound to another member ID`;
          active.push({
            id: member.id,
            kind,
            name,
            accountRef: boundAccount,
            authority,
            retired: false,
          });
        }
        // Different names must not make the same capability two renewal owners.
        new Set(active.map(binding => binding.authority)).size ===
          active.length ||
          Fail`Pool members cannot share an authority capability`;
        const byId = new Map(active.map(binding => [binding.id, binding]));
        const bindings = previous.bindings.map(
          binding => byId.get(binding.id) || { ...binding, retired: true },
        );
        bindings.push(...active.filter(binding => !old.has(binding.id)));
        const next = harden(
          validate({ version: 1, providerId, origin, bindings }),
        );
        const changed =
          bindings.length !== previous.bindings.length ||
          bindings.some(
            (binding, index) =>
              binding.retired !== previous.bindings[index]?.retired,
          );
        if (changed) {
          const sequence = last ? BigInt(last.slice(PREFIX.length)) + 1n : 0n;
          const suffix = String(sequence).padStart(20, '0');
          suffix.length === 20 || Fail`Pool identity journal exhausted`;
          const name = `${PREFIX}${suffix}`;
          !(await E(namespace).has(name)) ||
            Fail`Pool identity journal entry already exists`;
          // No trimming: tombstones/capability identity remain authoritative.
          await E(namespace).storeValue(next, name);
        }
        return harden(
          active.map(binding =>
            harden({ id: binding.id, authority: binding.authority }),
          ),
        );
      } catch (_error) {
        failed = true;
        throw Fail`Pool identity binding failed; journal is fenced`;
      }
    });
    chain = result.catch(() => {});
    return result;
  };
  return harden({ bind, wasEstablished: () => established === true });
};
harden(makePoolIdentityJournal);
