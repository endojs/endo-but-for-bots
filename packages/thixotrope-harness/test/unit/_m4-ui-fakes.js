// @ts-check
/**
 * Fake M4 daemon objects for the W4.7 component tests: a Secrets manager
 * (`SecretsAdmin` M4 version, `Secret`, the adapter-local `SecretWriter`
 * and `AuditReader`) and the adapter-local `Accounts` with its channel.
 * Plugged into M3's `makeFakePowers` through `operatorMethods: { getSecrets }`.
 * Records follow the shapes of `guest/lib/interfaces-m4.js`; values are kept
 * only so a test can look for them in the page.
 */
import { Far } from '@endo/far';
import { options as preactOptions } from 'preact';

/* eslint-disable import/no-relative-packages */
import { subscriptionTextOf } from '../../guest/lib/subscription-texts.js';

const encoder = new TextEncoder();

/**
 * Run Preact's effects (`useEffect`) on the next turn instead of after an
 * animation frame or its 35 ms fallback, so a test's `flush()` sees them.
 */
export const runEffectsPromptly = () => {
  /** @type {any} */ (preactOptions).requestAnimationFrame = (
    /** @type {() => void} */ callback,
  ) => setImmediate(callback);
};

/**
 * M2's `textOf.secretFailed` (`guest/lib/interfaces.js`).
 *
 * @param {string} code
 */
export const secretFailed = code => `Secret operation failed: "${code}"`;

/**
 * @param {{ pageEntries?: number, accounts?: any, poolBackends?: any[], poolProviders?: Map<any, string>, checks?: Map<string, { ok: boolean, code?: string }>, onAdded?: (pool: any, label: string) => void, oldManager?: boolean }} [options]
 *   `poolProviders`: each pool backend's provider (default `claude`);
 *   `checks`: the credential check's answer by Secret label (default ok);
 *   `onAdded`: told after each member that `addMember` or
 *   `addPoolMember` puts in a pool (to publish the new view);
 *   `oldManager`: a manager installed before `checkCredential`,
 *   `addPoolMember` and `addMember` (none of the three)
 */
export const makeFakeSecrets = ({
  pageEntries = 64,
  accounts,
  poolBackends = [],
  poolProviders = new Map(),
  checks = new Map(),
  onAdded = () => {},
  oldManager = false,
} = {}) => {
  /** @type {any[][]} */
  const calls = [];
  let clock = 1_800_000_000_000;
  /**
   * @typedef {{ secret: any, label: string, description: string,
   *   generation: number, state: 'active' | 'revoked', bytes: number,
   *   value?: string, deleted?: boolean }} FakeSecret
   */
  /** @type {FakeSecret[]} */
  const records = [];
  /** @type {WeakMap<object, FakeSecret>} */
  const bySecret = new WeakMap();
  /** @type {Array<Record<string, any>>} */
  const events = [];

  /**
   * @param {FakeSecret} record
   * @param {string} op
   * @param {string} outcome
   * @param {Record<string, any>} [extra]
   */
  const audit = (record, op, outcome, extra = {}) => {
    clock += 1000;
    // Not hardened: `record` stays mutable.
    events.push({
      at: clock,
      label: record.label,
      op,
      outcome,
      ...extra,
      record,
    });
  };

  /** @param {any} secret */
  const recordOf = secret => {
    const record = bySecret.get(secret);
    if (!record || record.deleted) throw Error(secretFailed('UNKNOWN_SECRET'));
    return record;
  };

  /**
   * @param {string} label
   * @param {string} description
   */
  const makeSecret = (label, description) => {
    /** @type {FakeSecret} */
    const record = {
      secret: undefined,
      label,
      description,
      generation: 0,
      state: 'active',
      bytes: 0,
    };
    record.secret = Far('Secret', {
      describe: () => {
        calls.push(['Secret', 'describe', record.label]);
        const { label: l, description: d, generation, state, bytes } = record;
        return harden({ label: l, description: d, generation, state, bytes });
      },
      revoke: () => {
        calls.push(['Secret', 'revoke', record.label]);
        recordOf(record.secret);
        record.state = 'revoked';
        audit(record, 'revoke', 'succeeded');
      },
      delete: () => {
        calls.push(['Secret', 'delete', record.label]);
        recordOf(record.secret);
        if (record.state !== 'revoked') {
          audit(record, 'delete', 'failed', { code: 'NOT_REVOKED' });
          throw Error(secretFailed('NOT_REVOKED'));
        }
        record.deleted = true;
        records.splice(records.indexOf(record), 1);
        audit(record, 'delete', 'succeeded');
      },
      setDescription: (/** @type {string} */ text) => {
        calls.push(['Secret', 'setDescription', record.label, text]);
        record.description = text;
      },
    });
    bySecret.set(record.secret, record);
    records.push(record);
    audit(record, 'create', 'succeeded');
    return record;
  };

  const writer = Far('SecretWriter', {
    /**
     * @param {any} secret
     * @param {string} value
     * @param {number} [expectedGeneration]
     */
    replace: (secret, value, expectedGeneration) => {
      // The value is never logged in `calls`: only its length.
      calls.push([
        'SecretWriter',
        'replace',
        bySecret.get(secret)?.label,
        value.length,
        expectedGeneration,
      ]);
      const record = recordOf(secret);
      if (record.state === 'revoked') {
        audit(record, 'replace', 'failed', { code: 'REVOKED' });
        throw Error(secretFailed('REVOKED'));
      }
      if (
        expectedGeneration !== undefined &&
        expectedGeneration !== record.generation
      ) {
        audit(record, 'replace', 'failed', { code: 'GENERATION_CONFLICT' });
        throw Error(secretFailed('GENERATION_CONFLICT'));
      }
      record.generation += 1;
      record.value = value;
      record.bytes = encoder.encode(value).length;
      audit(record, 'replace', 'succeeded', { generation: record.generation });
      return harden({ generation: record.generation });
    },
    publicKey: () => 'ab'.repeat(32),
  });

  const reader = Far('AuditReader', {
    /** @param {{ secret?: any, limit?: number, before?: number }} [query] */
    page: ({ secret, limit = 100, before } = {}) => {
      calls.push(['AuditReader', 'page', { secret, limit, before }]);
      const target = secret === undefined ? undefined : bySecret.get(secret);
      const matching = events
        .filter(event => target === undefined || event.record === target)
        .filter(event => before === undefined || Number(event.at) < before)
        .sort((a, b) => b.at - a.at);
      const page = matching
        .slice(0, limit)
        .map(({ record: _r, ...rest }) => harden(rest));
      return harden({
        events: page,
        ...(matching.length > limit ? { next: page[page.length - 1].at } : {}),
      });
    },
  });

  /**
   * @typedef {{ member: any, label: string, provider: string,
   *   secret: any, state: 'active' | 'retired' }} FakeMember
   */
  /** @type {FakeMember[]} */
  const members = [];
  /** @type {Map<any, any[]>} */
  const poolMembers = new Map(poolBackends.map(pool => [pool, []]));
  const providerOf = (/** @type {any} */ pool) =>
    poolProviders.get(pool) ?? 'claude';
  /** @param {{ provider: string, label: string, credential: any }} spec */
  const makeMember = ({ provider, label, credential }) => {
    recordOf(credential);
    calls.push(['SubscriptionsAdmin', 'makeMember', { provider, label }]);
    const same = members.find(entry => entry.label === label);
    if (same) {
      if (same.secret !== credential) throw Error('member conflict');
      return same.member;
    }
    /** @type {FakeMember} */
    const entry = {
      member: undefined,
      label,
      provider,
      secret: credential,
      state: 'active',
    };
    entry.member = Far('PoolMember', {
      describe: () =>
        harden({ label, provider, weight: 1, state: entry.state }),
      retire: () => {
        calls.push(['PoolMember', 'retire', label]);
        entry.state = 'retired';
        // As the manager: a retired member leaves every pool.
        for (const list of poolMembers.values()) {
          const at = list.indexOf(entry.member);
          if (at >= 0) list.splice(at, 1);
        }
      },
    });
    members.push(entry);
    return entry.member;
  };
  const newMethods = {
    /**
     * @param {any} pool
     * @param {any} secret
     */
    checkCredential: (pool, secret) => {
      const record = recordOf(secret);
      calls.push(['SubscriptionsAdmin', 'checkCredential', record.label]);
      if (!poolMembers.has(pool)) throw Error('not a pool');
      if (record.state === 'revoked')
        return harden({ ok: false, code: 'REVOKED' });
      return harden(checks.get(record.label) ?? { ok: true });
    },
    /**
     * @param {any} pool
     * @param {any} member
     */
    addPoolMember: (pool, member) => {
      const entry = members.find(row => row.member === member);
      calls.push(['SubscriptionsAdmin', 'addPoolMember', entry?.label]);
      const list = poolMembers.get(pool);
      if (!list || !entry) throw Error('unknown');
      // As the manager: already a member answers done (a retried add).
      if (list.includes(member)) return;
      const check = checks.get(recordOf(entry.secret).label);
      if (check && !check.ok) throw Error(`check failed: ${check.code}`);
      list.push(member);
      onAdded(pool, entry.label);
    },
    /**
     * As the manager: the pool rules and the check first, then make and
     * add in one step; idempotent by label and Secret.
     * @param {any} pool
     * @param {{ label: string, credential: any }} spec
     */
    addMember: (pool, { label, credential }) => {
      const record = recordOf(credential);
      calls.push(['SubscriptionsAdmin', 'addMember', label]);
      const list = poolMembers.get(pool);
      if (!list) throw Error('unknown pool');
      const same = members.find(entry => entry.label === label);
      if (same && same.secret !== credential)
        throw Error(`A member labelled "${label}" holds another secret`);
      if (same && list.includes(same.member)) return same.member;
      const check = checks.get(record.label);
      if (check && !check.ok)
        throw Error(
          subscriptionTextOf.credentialCheckFailed(String(check.code)),
        );
      const member = makeMember({
        provider: providerOf(pool),
        label,
        credential,
      });
      list.push(member);
      onAdded(pool, label);
      return member;
    },
  };
  const subscriptions = Far('SubscriptionsAdmin', {
    ...(oldManager ? {} : newMethods),
    listPools: () => harden({ pools: poolBackends }),
    listMembers: () => {
      calls.push(['SubscriptionsAdmin', 'listMembers']);
      return harden({ members: members.map(entry => entry.member) });
    },
    /** @param {any} pool */
    describePool: pool =>
      harden({
        kind: `${providerOf(pool)}-pool`,
        label: 'pool',
        members: [...(poolMembers.get(pool) ?? [])],
        state: 'active',
      }),
    makeMember,
    accounts: () => {
      calls.push(['SubscriptionsAdmin', 'accounts']);
      if (!accounts) throw Error('no accounts in this fake');
      return accounts;
    },
  });

  const admin = Far('SecretsAdmin', {
    /** @param {string} [cursor] */
    catalog: cursor => {
      calls.push(['SecretsAdmin', 'catalog', cursor]);
      const start = cursor === undefined ? 0 : Number(cursor);
      const slice = records.slice(start, start + pageEntries);
      return harden({
        entries: slice.map(
          ({ secret, label, description, generation, state, bytes }) =>
            harden({ secret, label, description, generation, state, bytes }),
        ),
        ...(start + pageEntries < records.length
          ? { next: String(start + pageEntries) }
          : {}),
      });
    },
    /** @param {{ label: string, description: string }} spec */
    create: ({ label, description }) => {
      calls.push(['SecretsAdmin', 'create', { label, description }]);
      return makeSecret(label, description).secret;
    },
    openWriter: () => {
      calls.push(['SecretsAdmin', 'openWriter']);
      return writer;
    },
    auditReader: () => {
      calls.push(['SecretsAdmin', 'auditReader']);
      return reader;
    },
    subscriptions: () => subscriptions,
  });

  return {
    getSecrets: () => admin,
    admin,
    writer,
    calls,
    records,
    events,
    /**
     * @param {string} label
     * @param {string} [value]
     */
    add: (label, value) => {
      const record = makeSecret(label, `${label} description`);
      if (value !== undefined) writer.replace(record.secret, value);
      return record;
    },
    members,
    poolMembers,
    /** @param {string} op */
    callsOf: op => calls.filter(call => `${call[0]}.${call[1]}` === op),
  };
};

/**
 * A `MemberAccount`.
 *
 * @param {Partial<Record<string, any>>} [fields]
 */
export const memberAccount = (fields = {}) =>
  harden({
    label: 'member-a',
    provider: 'claude',
    provenance: 'observed',
    state: 'ok',
    windows: [],
    limitReached: false,
    ...fields,
  });

/**
 * A fake adapter-local `Accounts` with its channel. `publish(pools)`
 * pushes the whole view with `rev + 1` to every waiting `next()`;
 * `evict(index)` closes that subscriber (its waiting or next `next()`
 * answers `{ closed: true, reason: 'idle' }`, as the adapter's does).
 *
 * @param {{ pools?: any[], sessions?: Map<any, any>, histories?: Map<any, any>, coldPools?: any[], beforeRefresh?: () => Promise<void> }} [options]
 *   `histories`: by pool backend, for `history(pool, offset?)`: one
 *   `PoolHistory`, an array of pages (by page index, offsets 0, 4, 8...),
 *   an `Error` to reject with, or a function of the offset
 */
export const makeFakeAccounts = ({
  pools = [],
  sessions = new Map(),
  histories = new Map(),
  coldPools = [],
  beforeRefresh,
} = {}) => {
  /** @type {any[][]} */
  const calls = [];
  let view = harden({ rev: 1, pools: harden([...pools]) });
  /**
   * @typedef {{ facet: any, closed: boolean, seen: number,
   *   waiting?: { resolve: (v: any) => void, reject: (e: any) => void } }} Sub
   */
  /** @type {Sub[]} */
  const subs = [];
  /**
   * What a closed watch answers (HR-SYN-34), as the adapter's accounts.js.
   * @param {'idle' | 'client'} reason
   */
  const closedBatch = reason =>
    harden({ rev: view.rev, pools: [], closed: true, reason });

  /** @param {Sub} sub */
  const answer = sub => {
    if (sub.waiting && view.rev > sub.seen) {
      const { resolve } = sub.waiting;
      sub.waiting = undefined;
      sub.seen = view.rev;
      resolve(view);
    }
  };

  /** @param {any[]} next */
  const publish = next => {
    view = harden({ rev: view.rev + 1, pools: harden([...next]) });
    for (const sub of subs) if (!sub.closed) answer(sub);
  };

  const accounts = Far('Accounts', {
    list: () => {
      calls.push(['Accounts', 'list']);
      return view;
    },
    /** @param {any} backend */
    forBackend: backend => {
      calls.push(['Accounts', 'forBackend', backend]);
      const pool = view.pools.find(row => row.backend === backend);
      if (pool) return pool;
      const cold = coldPools.find(row => row.backend === backend);
      if (cold) publish([...view.pools, cold]);
      return cold;
    },
    /** @param {any} session */
    forSession: session => {
      calls.push(['Accounts', 'forSession', session]);
      const backend = sessions.get(session);
      return view.pools.find(pool => pool.backend === backend) ?? undefined;
    },
    /**
     * @param {any} backend `PoolHistory` from `histories`, by backend
     * @param {number} [offset]
     */
    history: (backend, offset = 0) => {
      calls.push(['Accounts', 'history', backend, offset]);
      const held = histories.get(backend);
      if (typeof held === 'function') return held(offset);
      if (held instanceof Error) throw held;
      if (Array.isArray(held)) return held[offset / 4];
      return offset === 0 ? held : undefined;
    },
    /** @param {any} [backend] */
    refresh: async backend => {
      calls.push(['Accounts', 'refresh', backend]);
      await beforeRefresh?.();
      return view;
    },
    /** @param {number} [rev] */
    watch: rev => {
      calls.push(['Accounts', 'watch', rev]);
      /** @type {Sub} */
      const sub = { facet: undefined, closed: false, seen: rev ?? 0 };
      sub.facet = Far('AccountsSubscription', {
        next: () => {
          calls.push(['AccountsSubscription', 'next', subs.indexOf(sub)]);
          if (sub.closed) return Promise.resolve(closedBatch('idle'));
          return new Promise((resolve, reject) => {
            sub.waiting = { resolve, reject };
            answer(sub);
          });
        },
        close: () => {
          calls.push(['AccountsSubscription', 'close', subs.indexOf(sub)]);
          sub.closed = true;
          if (sub.waiting) {
            sub.waiting.resolve(closedBatch('client'));
            sub.waiting = undefined;
          }
        },
      });
      subs.push(sub);
      return sub.facet;
    },
  });

  return {
    accounts,
    calls,
    subs,
    publish,
    /** @param {number} index */
    evict: index => {
      const sub = subs[index];
      sub.closed = true;
      if (sub.waiting) {
        sub.waiting.resolve(closedBatch('idle'));
        sub.waiting = undefined;
      }
    },
    view: () => view,
    /** @param {string} name */
    callsOf: name => calls.filter(call => `${call[0]}.${call[1]}` === name),
    live: () => subs.filter(sub => !sub.closed).length,
  };
};
