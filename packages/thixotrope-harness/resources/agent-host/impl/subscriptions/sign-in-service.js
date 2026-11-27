// @ts-check
/**
 * The browser's subscription sign-in (the Subscriptions panel's "Add
 * account"; `gateway/extensions/subscription-signin.js` serves it to every
 * signed-in page, and only to those). It runs in the agent-host adapter
 * process, which owns the Secrets store, so the provider's tokens are
 * exchanged and written here and never reach the browser, the hub, a log
 * or a file other than the sealed store (D-6). The PKCE verifier, the
 * device code's id and every pending sign-in live in this process's memory
 * only; a restart forgets them (the page then starts again).
 *
 * `makeSubscriptionSignIn(powers)` answers the `SubscriptionSignIn` exo:
 *
 * - `begin(provider, label, pool?)`: a new account. `provider` is `claude`
 *   or `codex`; `label` names the subscription and its Secret; `pool` is
 *   the pool `Backend` to join (it must be of that provider and must not
 *   hold a subscription with that label); without one, a pool labelled
 *   `defaultPoolLabels[provider]` is made with the new member.
 * - `beginAgain(pool, member)`: sign an existing member in again (a
 *   refresh token that was consumed or refused): its Secret's value is
 *   replaced in place, conditioned on the generation read just before
 *   (`CHANGED` if a renewal wrote meanwhile); a ChatGPT sign-in into
 *   another account than the member's is refused (`OTHER_ACCOUNT`).
 *
 * Both answer a `PendingSignIn` exo at once (no network yet for Claude;
 * Codex asks for its device code in the background):
 *
 * - `describe()`: `{ rev, provider, label, state, expiresAt, again,
 *   authorizeUrl?, verificationUrl?, userCode?, error?: { code, text },
 *   result?: { generation, created } }`; `state` is `starting`, `waiting`,
 *   `finishing`, `done`, `failed`, `expired` or `cancelled`.
 * - `wait(rev)`: the description once its `rev` differs from `rev`, or
 *   after `waitMs` with the same one (the page loops; nothing is pushed
 *   more often than the state changes).
 * - `complete(codeAndState)`: Claude: the pasted `code#state`, checked
 *   against this sign-in's state, then exchanged and written.
 * - `useLoginFile(text)`: either provider: a pasted login file (Codex
 *   `auth.json`, a Claude credentials export) in place of the provider
 *   flow; it stops a device poll.
 * - `cancel()`.
 *
 * Bounds: a pending sign-in expires after `signInLimits.pendingMs` (or the
 * provider's earlier device-code expiry); at most `signInLimits.maxPending`
 * wait at once (`TOO_MANY`); a finished one is forgotten by the service
 * (the page's object keeps answering its last description). Provider
 * requests are bounded as `sign-in.js` says.
 *
 * Errors in plain words (`signInTexts`) with a fixed code; logged lines
 * carry the provider, the state and a code only.
 *
 * Node only (adapter).
 */
import { clearTimeout, setTimeout } from 'node:timers';

/* eslint-disable import/no-relative-packages -- guest/ is its own private package */
import { E } from '@endo/far';

import { limits } from '../../../../guest/lib/limits.js';
/* eslint-enable import/no-relative-packages */
import { jwtClaims, codexAccountOf, parseCredential } from './credentials.js';
import {
  checkEndpoints,
  claudeAuthorization,
  claudeExchange,
  codexAwaitApproval,
  codexRequestCode,
  credentialFromLoginFile,
  parseCodePaste,
  signInCodeOf,
  signInDefaults,
  signInError,
  signInLimits,
  signInTexts,
} from './sign-in.js';

const { M, makeExo } = /** @type {any} */ (globalThis);

/** The pool a first account of a provider makes (its label). */
export const defaultPoolLabels = harden({
  claude: 'Claude subscriptions',
  codex: 'ChatGPT subscriptions',
});

/** The pool kind of each provider. */
const kindOf = harden({ claude: 'claude-pool', codex: 'codex-pool' });

/** How long one `wait` holds an unchanged description. */
const WAIT_MS = 20_000;

/** The Secret description of a signed-in subscription (one line, <= 200). */
const descriptionOf = harden({
  claude: 'Claude subscription (signed in from the browser)',
  codex: 'ChatGPT subscription (signed in from the browser)',
});

const TERMINAL = harden(['done', 'failed', 'expired', 'cancelled']);

/** The service's own words (`help()`). */
export const signInHelp = harden({
  service: [
    'SubscriptionSignIn: sign a Claude or ChatGPT subscription in from this page.',
    'begin(provider, label, pool?) -> PendingSignIn: a new account (provider "claude" or "codex"); without a pool, a new pool is made.',
    'beginAgain(pool, member) -> PendingSignIn: sign an existing member in again; its Secret is replaced in place.',
    `At most ${signInLimits.maxPending} sign-ins wait at once; each expires after ${signInLimits.pendingMs / 60_000} minutes. Tokens never leave the agent host.`,
  ].join('\n'),
  pending: [
    'PendingSignIn: one sign-in in progress.',
    'describe() -> { rev, provider, label, state, expiresAt, authorizeUrl?, verificationUrl?, userCode?, error?, result? }',
    'wait(rev) -> the description once it changes (or unchanged after a while).',
    'complete(codeAndState): Claude: the code#state the authorization page shows.',
    'useLoginFile(text): a ChatGPT auth.json or a Claude credentials export instead of the provider flow.',
    'cancel()',
  ].join('\n'),
});

/** @param {unknown} error */
const messageOf = error =>
  error instanceof Error ? error.message : String(error);

/**
 * A label as `S.Label` admits it: 1..labelUnits units, one line.
 * @param {unknown} label
 * @returns {string}
 */
const assertLabel = label => {
  const text = typeof label === 'string' ? label.trim() : '';
  if (
    text === '' ||
    text.length > limits.labelUnits ||
    // eslint-disable-next-line no-control-regex -- control characters refused
    /[\x00-\x1f\x7f]/u.test(text)
  )
    throw signInError('BAD_LABEL');
  return text;
};

/**
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
const abortableSleep = (ms, signal) =>
  new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * @typedef {object} MemberAccess what `beginAgain` writes through
 * @property {'claude' | 'codex'} provider
 * @property {string} label
 * @property {{ read: () => Promise<{ value: string, generation: number }>, replace: (value: string, expectedGeneration: number) => Promise<number> }} access
 */

/**
 * @typedef {object} SignInPowers
 * @property {() => Promise<any>} secretsAdmin the operator's `SecretsAdmin`
 *   (the gateway's `Operator.getSecrets()`)
 * @property {() => Promise<any>} secretWriter the gateway's in-process
 *   writer (`replace(secret, value, expectedGeneration)`)
 * @property {() => any} accounts the adapter's `Accounts` (its `addMember`
 *   uses the manager's own or keeps the addition, m4-interfaces 3.5)
 * @property {(pool: any, member: any) => Promise<MemberAccess>} memberAccess
 *   the store accessor of an active member of `pool` (`subscriptions/
 *   index.js` `memberAccess`)
 * @property {typeof globalThis.fetch} [fetch]
 * @property {() => number} [now]
 * @property {(event: Record<string, unknown>) => void} [log]
 * @property {{ claude?: typeof signInDefaults.claude, codex?: typeof signInDefaults.codex }} [endpoints]
 *   tests: the fake provider's
 * @property {Partial<typeof signInLimits> & { waitMs?: number }} [bounds]
 *   tests: shorter expiry and polls
 * @property {(ms: number, signal: AbortSignal) => Promise<void>} [sleep]
 * @property {(object: object) => void} [markLocal] the gateway marks each
 *   `PendingSignIn` as its own object (never passed toward a vat)
 */

/**
 * @param {SignInPowers} powers
 */
export const makeSubscriptionSignIn = ({
  secretsAdmin,
  secretWriter,
  accounts,
  memberAccess,
  fetch = globalThis.fetch,
  now = () => Date.now(),
  log = () => {},
  endpoints = {},
  bounds = {},
  sleep = abortableSleep,
  markLocal = () => {},
}) => {
  const claudeEndpoints = checkEndpoints(
    endpoints.claude ?? signInDefaults.claude,
  );
  const codexEndpoints = checkEndpoints(
    endpoints.codex ?? signInDefaults.codex,
  );
  const pendingMs = bounds.pendingMs ?? signInLimits.pendingMs;
  const maxPending = bounds.maxPending ?? signInLimits.maxPending;
  const waitMs = bounds.waitMs ?? WAIT_MS;
  const timeouts =
    bounds.exchangeTimeoutMs === undefined
      ? {}
      : { timeoutMs: bounds.exchangeTimeoutMs };

  /** Sign-ins not yet finished (bounded by `maxPending`). @type {Set<object>} */
  const active = new Set();

  /**
   * Where a sign-in's credential goes.
   * @typedef {{ again: false, provider: 'claude' | 'codex', label: string, pool?: any }
   *   | { again: true, provider: 'claude' | 'codex', label: string, pool: any, member: any, access: MemberAccess['access'] }} Target
   */

  /**
   * The pool's provider, refused when it is not a pool.
   * @param {any} pool
   */
  const providerOfPool = async pool => {
    const info = await E(pool).describe();
    if (info?.kind === 'claude-pool') return 'claude';
    if (info?.kind === 'codex-pool') return 'codex';
    throw signInError('WRONG_POOL');
  };

  /**
   * Refuse a label the pool already has (an active member of it).
   * @param {any} pool
   * @param {string} label
   */
  const assertLabelFree = async (pool, label) => {
    const members = await E(accounts()).poolMembers(pool);
    const infos = await Promise.all(
      members.map((/** @type {any} */ member) => E(member).describe()),
    );
    if (infos.some(info => info.state === 'active' && info.label === label))
      throw signInError('LABEL_TAKEN');
  };

  /**
   * Write the credential where the target says; answers what was made.
   * @param {Target} target
   * @param {string} value the stored form
   * @returns {Promise<{ generation: number, created: 'member' | 'pool' | 'replaced' }>}
   */
  const save = async (target, value) => {
    if (target.again) {
      const { value: before, generation } = await target.access.read();
      if (target.provider === 'codex') {
        // The same ChatGPT account, or none recorded (an unreadable value).
        /** @type {string | undefined} */
        let previous;
        try {
          previous = parseCredential(before, 'codex').accountId;
        } catch {
          previous = undefined;
        }
        const next = parseCredential(value, 'codex').accountId;
        if (previous !== undefined && previous !== next)
          throw signInError('OTHER_ACCOUNT');
      }
      try {
        const written = await target.access.replace(value, generation);
        return harden({ generation: written, created: 'replaced' });
      } catch (error) {
        if (/GENERATION_CONFLICT/u.test(messageOf(error)))
          throw signInError('CHANGED');
        throw signInError('SAVE_FAILED');
      }
    }
    const admin = await secretsAdmin();
    if (admin === undefined) throw signInError('NOT_READY');
    const secret = await E(admin).create(
      harden({
        label: target.label,
        description: descriptionOf[target.provider],
      }),
    );
    try {
      const writer = await secretWriter();
      const written = await E(writer).replace(secret, value, 0);
      if (target.pool !== undefined) {
        await E(accounts()).addMember(
          target.pool,
          harden({ label: target.label, credential: secret }),
        );
        return harden({ generation: written.generation, created: 'member' });
      }
      const subscriptions = await E(admin).subscriptions();
      const member = await E(subscriptions).makeMember(
        harden({
          provider: target.provider,
          label: target.label,
          credential: secret,
        }),
      );
      await E(subscriptions).makePool(
        harden({
          kind: kindOf[target.provider],
          label: defaultPoolLabels[target.provider],
          members: [member],
        }),
      );
      return harden({ generation: written.generation, created: 'pool' });
    } catch (error) {
      // Nothing half-made keeps live tokens: the new Secret goes.
      await E(secret)
        .revoke()
        .then(() => E(secret).delete())
        .catch(() => {});
      log({
        event: 'subscription-sign-in-add-failed',
        provider: target.provider,
      });
      throw signInError('ADD_FAILED', { detail: messageOf(error) });
    }
  };

  /**
   * One sign-in.
   * @param {Target} target
   */
  const makePending = target => {
    const { provider } = target;
    const controller = new AbortController();
    const startedAt = now();
    let expiresAtMs = startedAt + pendingMs;
    let rev = 1;
    /** @type {string} */
    let state = provider === 'claude' ? 'waiting' : 'starting';
    /** @type {{ code: string, text: string } | undefined} */
    let error;
    /** @type {{ generation: number, created: string } | undefined} */
    let result;
    /** @type {string | undefined} */
    let authorizeUrl;
    /** @type {{ verificationUrl: string, userCode: string } | undefined} */
    let device;
    /** Claude's state and verifier: this process's memory only. */
    /** @type {{ state: string, verifier: string } | undefined} */
    let claude;
    /** @type {Set<() => void>} */
    const waiters = new Set();

    const changed = () => {
      rev += 1;
      for (const wake of [...waiters]) wake();
    };

    const describe = () =>
      harden({
        rev,
        provider,
        label: target.label,
        again: target.again,
        state,
        expiresAt: new Date(expiresAtMs).toISOString(),
        ...(authorizeUrl === undefined ? {} : { authorizeUrl }),
        ...(device === undefined ? {} : device),
        ...(error === undefined ? {} : { error }),
        ...(result === undefined ? {} : { result }),
      });

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let expiry;

    /**
     * Leave the waiting states for good.
     * @param {'done' | 'failed' | 'expired' | 'cancelled'} final
     * @param {unknown} [failure]
     */
    const finish = (final, failure) => {
      if (TERMINAL.includes(state)) return;
      state = final;
      if (failure !== undefined) {
        const fallback = final === 'expired' ? 'EXPIRED' : 'REFUSED';
        const code = signInCodeOf(failure, fallback);
        const own =
          failure instanceof Error &&
          typeof (/** @type {any} */ (failure).code) === 'string' &&
          /** @type {any} */ (failure).code in signInTexts;
        error = harden({
          code,
          text: own ? failure.message : signInTexts[code],
        });
      }
      claude = undefined;
      if (expiry !== undefined) clearTimeout(expiry);
      controller.abort();
      active.delete(pending);
      log({
        event: 'subscription-sign-in',
        provider,
        state: final,
        ...(error === undefined ? {} : { code: error.code }),
      });
      changed();
    };

    /** @param {number} at */
    const expireAt = at => {
      expiresAtMs = at;
      if (expiry !== undefined) clearTimeout(expiry);
      expiry = setTimeout(
        () => finish('expired', signInError('EXPIRED')),
        Math.max(0, at - now()),
      );
      // Never holds the adapter open.
      /** @type {any} */ (expiry).unref?.();
    };

    /**
     * Turn the credential into the saved subscription; the one way to
     * `done`.
     * @param {() => Promise<string>} obtain the stored form
     */
    const conclude = async obtain => {
      try {
        const value = await obtain();
        if (TERMINAL.includes(state)) return;
        state = 'finishing';
        changed();
        result = await save(target, value);
        finish('done');
      } catch (failure) {
        if (controller.signal.aborted && TERMINAL.includes(state)) return;
        finish('failed', failure);
      }
    };

    const assertOpen = () => {
      if (state === 'finishing') throw signInError('BUSY');
      if (state === 'expired') throw signInError('EXPIRED');
      if (state === 'cancelled') throw signInError('CANCELLED');
      if (TERMINAL.includes(state)) throw signInError('BUSY');
    };

    const pending = makeExo(
      'PendingSignIn',
      M.interface('PendingSignIn', {
        help: M.call().returns(M.string()),
        describe: M.call().returns(M.record()),
        wait: M.callWhen().optional(M.number()).returns(M.record()),
        complete: M.callWhen(M.string()).returns(M.record()),
        useLoginFile: M.callWhen(M.string()).returns(M.record()),
        cancel: M.call().returns(M.record()),
      }),
      {
        help: () => signInHelp.pending,
        describe,
        /** @param {number} [seen] */
        wait: async seen => {
          if (seen !== rev || TERMINAL.includes(state)) return describe();
          await new Promise(resolve => {
            const wake = () => {
              clearTimeout(timer);
              waiters.delete(wake);
              resolve(undefined);
            };
            const timer = setTimeout(wake, waitMs);
            /** @type {any} */ (timer).unref?.();
            waiters.add(wake);
          });
          return describe();
        },
        /** @param {string} pasted */
        complete: async pasted => {
          assertOpen();
          if (claude === undefined) throw signInError('BAD_CODE');
          const kept = claude;
          // Checked before anything is sent: a wrong paste can be retried.
          const code = parseCodePaste(pasted, kept.state);
          await conclude(() =>
            claudeExchange({
              code,
              state: kept.state,
              verifier: kept.verifier,
              fetch,
              now,
              signal: controller.signal,
              endpoints: claudeEndpoints,
              ...timeouts,
            }),
          );
          return describe();
        },
        /** @param {string} text */
        useLoginFile: async text => {
          assertOpen();
          // Checked before the device poll stops: a wrong paste can be
          // retried while the code still waits.
          const value = credentialFromLoginFile(text, provider);
          await conclude(async () => value);
          return describe();
        },
        cancel: () => {
          if (state !== 'finishing') finish('cancelled');
          return describe();
        },
      },
    );

    markLocal(pending);
    active.add(pending);
    expireAt(expiresAtMs);
    if (provider === 'claude') {
      const made = claudeAuthorization({ endpoints: claudeEndpoints });
      authorizeUrl = made.url;
      claude = { state: made.state, verifier: made.verifier };
    } else {
      void (async () => {
        try {
          const code = await codexRequestCode({
            fetch,
            now,
            signal: controller.signal,
            endpoints: codexEndpoints,
            ...timeouts,
          });
          if (TERMINAL.includes(state)) return;
          device = harden({
            verificationUrl: code.verificationUrl,
            userCode: code.userCode,
          });
          if (code.expiresAtMs !== undefined && code.expiresAtMs < expiresAtMs)
            expireAt(code.expiresAtMs);
          state = 'waiting';
          changed();
          await conclude(() =>
            codexAwaitApproval({
              code,
              fetch,
              now,
              signal: controller.signal,
              sleep,
              endpoints: codexEndpoints,
              ...timeouts,
            }),
          );
        } catch (failure) {
          if (!TERMINAL.includes(state)) finish('failed', failure);
        }
      })();
    }
    log({ event: 'subscription-sign-in', provider, state });
    return pending;
  };

  const assertRoom = () => {
    if (active.size >= maxPending) throw signInError('TOO_MANY');
  };

  /** @param {unknown} provider */
  const assertProvider = provider => {
    if (provider !== 'claude' && provider !== 'codex')
      throw signInError('UNKNOWN_PROVIDER');
    return provider;
  };

  return makeExo(
    'SubscriptionSignIn',
    M.interface('SubscriptionSignIn', {
      help: M.call().returns(M.string()),
      begin: M.callWhen(M.string(), M.string())
        .optional(M.remotable('Backend'))
        .returns(M.remotable('PendingSignIn')),
      beginAgain: M.callWhen(
        M.remotable('Backend'),
        M.remotable('PoolMember'),
      ).returns(M.remotable('PendingSignIn')),
    }),
    {
      help: () => signInHelp.service,
      /**
       * @param {string} provider
       * @param {string} label
       * @param {any} [pool]
       */
      begin: async (provider, label, pool) => {
        const chosen = assertProvider(provider);
        const name = assertLabel(label);
        assertRoom();
        if (pool !== undefined) {
          if ((await providerOfPool(pool)) !== chosen)
            throw signInError('WRONG_POOL');
          await assertLabelFree(pool, name);
        }
        assertRoom();
        return makePending(
          harden({
            again: false,
            provider: chosen,
            label: name,
            ...(pool === undefined ? {} : { pool }),
          }),
        );
      },
      /**
       * @param {any} pool
       * @param {any} member
       */
      beginAgain: async (pool, member) => {
        assertRoom();
        /** @type {MemberAccess} */
        let found;
        try {
          found = await memberAccess(pool, member);
        } catch {
          throw signInError('NOT_A_MEMBER');
        }
        assertRoom();
        return makePending(
          harden({
            again: true,
            provider: found.provider,
            label: found.label,
            pool,
            member,
            access: found.access,
          }),
        );
      },
    },
  );
};
harden(makeSubscriptionSignIn);

/**
 * The account id a Codex access token names (tests and the CLI).
 * @param {string} accessToken
 */
export const codexAccountOfToken = accessToken => {
  const claims = jwtClaims(accessToken);
  return claims && codexAccountOf(claims);
};
harden(codexAccountOfToken);
