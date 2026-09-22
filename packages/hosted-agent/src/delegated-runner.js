// @ts-check

import { createHash } from 'node:crypto';

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';

import {
  HostedBackendFactoryInterface,
  HostedTurnBackendAdminInterface,
  HostedTurnBackendInterface,
  assertHostedBackendDescriptor,
} from './hosted-backend.js';

/**
 * A delegated runner: a hosted backend factory attenuated by limits its
 * operator chose, to hand to somebody else so that they can spawn harnesses
 * on the operator's machine and work on a project of their own.
 *
 * It is a `HostedBackendFactory`, so a holder adds it to their own Floot by
 * pet name like any other backend; their Floot, its registry and its
 * transcripts stay on their machine. A holder is an untrusted party calling
 * over the network with any arguments it likes, so what it narrows is
 * enforced here and not left to the factory beneath:
 *
 * - **Sessions are its own.** Every session id a holder names is put under
 *   the runner's name before it reaches the factory beneath, in a form no
 *   other runner's ids can spell, so a holder can create, stop and destroy
 *   only sessions of this runner, never the operator's or another runner's.
 * - **A slot allowance.** At most `maxSessions` sessions exist at once; the
 *   set of them is durable, so a restart neither forgets them nor frees their
 *   slots.
 * - **Whose subscription.** Every session is pinned to the one subscription
 *   the operator named: a lane of the broker's pool that is a share. Through
 *   it the usage limits of that share apply, and a holder cannot name any
 *   other.
 * - **No network unless allowed.** A harness would otherwise reach the
 *   internet from the operator's address.
 * - **Nothing of the host.** A spec may not name a host path, a container
 *   mount or a working directory, and what goes wrong beneath reaches a
 *   holder as `Runner unavailable`, not in the operator's words.
 * - **Every turn asks again.** The turn facets a session hands back are the
 *   runner's own forwarders: a revoked or expired runner refuses turns on
 *   sessions it made earlier, and a turn cannot name a model the runner does
 *   not allow.
 * - **A storage bound, or the operator's explicit word that there is none.**
 *   Session directories have no quota today, so a runner refuses to be made
 *   without one or the other.
 *
 * Keeping a store on one's own machine is not confidentiality from the
 * operator, who can read everything a harness on their machine does.
 */

// No `-`: a session's name beneath is `r-<runner>-<session>`, and a runner's
// id that could contain the separator would let `a` + `b-x` and `a-b` + `x`
// spell the same session, which the factory beneath would hand from one
// holder to the other.
const RUNNER_ID = /^[A-Za-z0-9][A-Za-z0-9_]{0,31}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const SUBSCRIPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const EFFORT = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const NETWORK_POLICIES = harden(['off', 'public-internet']);
const MAX_SYSTEM_PROMPT_CHARS = 262_144;

/** How long the factory beneath gets for one call made on a holder's word. */
const BENEATH_DEADLINE_MS = 180_000;
/** How long one session gets to stop when the runner is withdrawn. */
const STOP_DEADLINE_MS = 30_000;
/** How stale the record in memory may be: a second kit may have written. */
const KEPT_FRESH_MS = 5000;

/**
 * @typedef {object} RunnerLimits
 * @property {string} subscription The pool member every session is pinned to.
 * @property {number} maxSessions
 * @property {string[]} networkPolicies `['off']` unless the operator says
 *   more; always includes `off`.
 * @property {string[]} [models]
 * @property {{ maxSessionBytes: number } | 'unbounded'} storage
 * @property {string} [expiresAt]
 */

/**
 * Validate and copy an operator's limits, as they are stored.
 *
 * @param {any} limits
 * @returns {RunnerLimits}
 */
export const normalizeRunnerLimits = limits => {
  (limits !== null && typeof limits === 'object') ||
    Fail`Runner limits must be a record`;
  const {
    subscription,
    maxSessions,
    networkPolicies = ['off'],
    models,
    storage,
    expiresAt,
  } = limits;
  (typeof subscription === 'string' &&
    SUBSCRIPTION_ID.test(subscription) &&
    subscription !== 'auto') ||
    Fail`A runner names the subscription its sessions spend`;
  (Number.isSafeInteger(maxSessions) &&
    Number(maxSessions) > 0 &&
    Number(maxSessions) <= 256) ||
    Fail`Invalid runner session allowance`;
  // `off` is what a session gets when it asks for nothing, so it is always
  // allowed; the operator adds to it.
  (Array.isArray(networkPolicies) &&
    networkPolicies.includes('off') &&
    networkPolicies.every(policy => NETWORK_POLICIES.includes(policy))) ||
    Fail`Invalid runner network policies`;
  models === undefined ||
    (Array.isArray(models) &&
      models.length > 0 &&
      models.length <= 256 &&
      models.every(
        model => typeof model === 'string' && MODEL_ID.test(model),
      )) ||
    Fail`Invalid runner models`;
  // Said one way or the other, never left out: an unbounded session
  // directory on somebody else's behalf is a decision, not a default.
  storage === 'unbounded' ||
    (storage !== null &&
      typeof storage === 'object' &&
      Number.isSafeInteger(storage.maxSessionBytes) &&
      Number(storage.maxSessionBytes) > 0) ||
    Fail`A runner needs a storage bound per session, or storage: "unbounded"`;
  expiresAt === undefined ||
    Number.isFinite(Date.parse(expiresAt)) ||
    Fail`Invalid runner expiry`;
  return harden({
    subscription,
    maxSessions,
    networkPolicies: [...new Set(networkPolicies)],
    ...(models === undefined ? {} : { models: [...models] }),
    storage:
      storage === 'unbounded'
        ? 'unbounded'
        : { maxSessionBytes: storage.maxSessionBytes },
    ...(expiresAt === undefined
      ? {}
      : { expiresAt: new Date(Date.parse(expiresAt)).toISOString() }),
  });
};
harden(normalizeRunnerLimits);

/**
 * A holder's session id under the runner's name. A runner's id has no `-`,
 * so the runner's part ends at the first one after `r-` and no two runners'
 * names coincide. Where the name would be too long for the factory beneath,
 * the holder's part is replaced by a digest of it, so the same session is
 * always the same name. (A holder can make two of its own ids coincide that
 * way; that costs only the holder.)
 *
 * @param {string} runnerId
 * @param {string} sessionId
 */
export const runnerSessionId = (runnerId, sessionId) => {
  RUNNER_ID.test(runnerId) || Fail`Invalid runner id ${q(runnerId)}`;
  const plain = `r-${runnerId}-${sessionId}`;
  if (plain.length <= 128) return plain;
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `r-${runnerId}-h${digest.slice(0, 48)}`;
};
harden(runnerSessionId);

/** What a holder may put in a turn's options. Everything else is refused. */
const TURN_KEYS = harden([
  'model',
  'reasoningEffort',
  'systemPrompt',
  'acknowledgedCheckpoint',
  'transcript',
]);

/** What a holder may put in a session's spec. Everything else is refused. */
const SPEC_KEYS = harden([
  'sessionId',
  'model',
  'reasoningEffort',
  'systemPrompt',
  'networkPolicy',
  'subscription',
  'cwd',
]);

/** The runner's own refusals, which a holder is told as they are. */
const RUNNER_WORDS = harden([
  'Runner revoked',
  'Runner unavailable',
  'Invalid runner session identity',
  'Not a session of this runner',
  'This runner has no free session slot',
  'This runner does not allow that model',
  'This runner needs a model named',
  'This runner does not allow that network policy',
  'A delegated runner does not take that in a session',
  'A delegated runner does not take that in a turn',
  'A delegated runner’s sessions work in /workspace',
  'A delegated runner chooses the subscription',
  'Invalid session model',
  'Invalid session reasoning effort',
  'Invalid session system prompt',
  'The backend beneath cannot bound a session’s storage',
]);

const RunnerAdminInterface = M.interface('RunnerAdmin', {
  revoke: M.callWhen().returns(M.record()),
  getStatus: M.callWhen().returns(M.record()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * A promise that loses to a deadline.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 */
/** Errors that are a deadline passing, not an answer. */
const deadlines = new WeakSet();

const within = (promise, ms) =>
  new Promise((resolve, reject) => {
    const timer = globalThis.setTimeout(() => {
      const error = Error('Runner unavailable');
      deadlines.add(error);
      reject(error);
    }, ms);
    /** @type {any} */ (timer).unref?.();
    promise.then(
      value => {
        globalThis.clearTimeout(timer);
        resolve(value);
      },
      error => {
        globalThis.clearTimeout(timer);
        reject(error);
      },
    );
  });

/**
 * @param {object} powers
 * @param {string} powers.runnerId
 * @param {() => Promise<any>} powers.provideFactory The factory beneath,
 *   resolved on every use: a deploy re-mints a backend.
 * @param {() => Promise<any>} powers.provideLimits The operator's limits as
 *   stored, read for every call.
 * @param {{ read(): Promise<any>, write(record: any): Promise<void> }} powers.journal
 *   The runner formula's own store: `{ revoked, sessions }`.
 * @param {() => number} [powers.now]
 * @param {(...args: unknown[]) => void} [powers.log]
 * @param {number} [powers.beneathDeadlineMs]
 * @param {number} [powers.stopDeadlineMs]
 */
export const makeDelegatedRunner = ({
  runnerId,
  provideFactory,
  provideLimits,
  journal,
  now = Date.now,
  log = (...args) => console.error(...args),
  beneathDeadlineMs = BENEATH_DEADLINE_MS,
  stopDeadlineMs = STOP_DEADLINE_MS,
}) => {
  RUNNER_ID.test(runnerId) || Fail`Invalid runner id ${q(runnerId)}`;
  /** @type {{ revoked: boolean, sessions: string[] }} */
  let kept = { revoked: false, sessions: [] };
  let keptAt = -Infinity;
  // Set the moment the operator withdraws the runner, before anything is
  // written or stopped: nothing a holder has in flight can delay it.
  let revokedNow = false;
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let expiryTimer;
  /** The `expiresAt` the timer is armed for; '' when none is. */
  let armedFor = '';
  let closed = false;
  /** @type {Map<string, Promise<unknown>>} */
  const perSession = new Map();

  /**
   * One call at a time for one session of this runner: a `create` from the
   * slot it takes through its cleanup, a `destroy` from its check through
   * the slot it gives back. Without it a `destroy` and a `create` of one id,
   * sent together, end with the slot given back and the session live and
   * uncounted: beyond the allowance, out of reach of a revocation, and not
   * even its holder's to stop. It holds up only that holder's own id, within
   * the deadlines below; a revocation never takes it.
   *
   * @template T
   * @param {string} beneathId
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const oneAtATime = (beneathId, operation) => {
    const before = perSession.get(beneathId) ?? Promise.resolve();
    const result = before.then(operation);
    const settled = result.catch(() => {});
    perSession.set(beneathId, settled);
    void settled.then(() => {
      if (perSession.get(beneathId) === settled) perSession.delete(beneathId);
    });
    return result;
  };

  /**
   * The record as the store has it. Read again when it may be stale: the
   * operator may have made a second kit over this namespace, and its
   * revocation must reach this one.
   *
   * @param {boolean} [force]
   */
  const refresh = async (force = false) => {
    if (!force && now() - keptAt < KEPT_FRESH_MS) return;
    const stored = await journal.read();
    kept = {
      revoked: stored?.revoked === true || revokedNow,
      sessions: Array.isArray(stored?.sessions)
        ? stored.sessions.filter(
            (/** @type {unknown} */ id) =>
              typeof id === 'string' && SESSION_ID.test(id),
          )
        : [],
    };
    keptAt = now();
  };

  /**
   * The allowance only: taking a slot and giving one back. Calls beneath are
   * never made in here, so a holder whose tool set never answers holds up
   * its own `create` and nothing else, least of all a revocation.
   *
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const accounting = operation => {
    const result = chain.then(operation);
    chain = result.catch(() => {});
    return result;
  };

  /** @param {(before: typeof kept) => typeof kept} update */
  const keep = update =>
    accounting(async () => {
      await refresh(true);
      const next = update(kept);
      await journal.write(
        harden({
          revoked: next.revoked || revokedNow,
          sessions: [...next.sessions],
        }),
      );
      kept = next;
      keptAt = now();
    });

  const readLimits = async () => normalizeRunnerLimits(await provideLimits());

  /** @param {RunnerLimits} limits */
  const isOver = limits =>
    revokedNow ||
    kept.revoked ||
    (limits.expiresAt !== undefined && Date.parse(limits.expiresAt) <= now());

  /** Refuse unless the runner still stands. Asked on every call. */
  const checkLive = async () => {
    !revokedNow || Fail`Runner revoked`;
    await refresh();
    const limits = await readLimits();
    // The operator may have moved the expiry: the timer follows it.
    if ((limits.expiresAt ?? '') !== armedFor) armExpiry(limits);
    !isOver(limits) || Fail`Runner revoked`;
    return limits;
  };

  /**
   * What a holder is told when something goes wrong: the runner's own
   * refusals as they are, and for anything from beneath (a path, an account,
   * the operator's names) that the runner is unavailable.
   *
   * @template T
   * @param {string} what
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  const bare = async (what, operation) => {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (RUNNER_WORDS.includes(message)) throw Error(message);
      log(`runner ${runnerId}: ${what} failed:`, message || String(error));
      throw Error('Runner unavailable');
    }
  };

  /** @param {any} spec */
  const ownId = spec => {
    const sessionId = spec?.sessionId;
    (typeof sessionId === 'string' && SESSION_ID.test(sessionId)) ||
      Fail`Invalid runner session identity`;
    return runnerSessionId(runnerId, sessionId);
  };

  /** Stop every session of this runner, each within a deadline. */
  const stopAll = async () => {
    const beneath = await provideFactory();
    const results = await Promise.all(
      kept.sessions.map(async sessionId => {
        try {
          await within(E(beneath).stop(harden({ sessionId })), stopDeadlineMs);
          return { sessionId, stopped: true };
        } catch (error) {
          log(
            `runner ${runnerId}: session ${sessionId} could not be stopped:`,
            error instanceof Error ? error.message : String(error),
          );
          return { sessionId, stopped: false };
        }
      }),
    );
    return harden({
      stopped: results.filter(r => r.stopped).map(r => r.sessionId),
      notStopped: results.filter(r => !r.stopped).map(r => r.sessionId),
    });
  };

  /**
   * Stop what runs when the runner expires, without anybody asking.
   * @param limits
   */
  const armExpiry = (/** @type {RunnerLimits} */ limits) => {
    if (expiryTimer !== undefined) globalThis.clearTimeout(expiryTimer);
    expiryTimer = undefined;
    armedFor = limits.expiresAt ?? '';
    if (limits.expiresAt === undefined || closed) return;
    const wait = Date.parse(limits.expiresAt) - now();
    // A timer takes at most a little under 25 days; a later expiry is looked
    // at again then.
    const timer = globalThis.setTimeout(
      () => {
        expiryTimer = undefined;
        void (async () => {
          const current = await readLimits();
          if (isOver(current)) {
            await refresh(true);
            await stopAll();
          } else armExpiry(current);
        })().catch(() => {});
      },
      Math.max(0, Math.min(wait, 2_000_000_000)),
    );
    /** @type {any} */ (timer).unref?.();
    expiryTimer = timer;
  };

  /**
   * The turn facets a session hands back, as the runner's own: every call
   * asks again whether the runner stands, and a turn names no model the
   * runner does not allow.
   *
   * @param {any} session `{ run, admin }` from the factory beneath.
   */
  const guard = session => {
    const { run, admin } = session ?? {};
    (run !== undefined && admin !== undefined) || Fail`Runner unavailable`;
    /**
     * @param {any} options
     * @param limits
     */
    const allowed = (options, limits) => {
      if (options === undefined) return undefined;
      Object.keys(options).every(key => TURN_KEYS.includes(key)) ||
        Fail`A delegated runner does not take that in a turn`;
      const { model, reasoningEffort, systemPrompt } = options;
      model === undefined ||
        model === '' ||
        (typeof model === 'string' && MODEL_ID.test(model)) ||
        Fail`Invalid session model`;
      !model ||
        limits.models === undefined ||
        limits.models.includes(model) ||
        Fail`This runner does not allow that model`;
      reasoningEffort === undefined ||
        reasoningEffort === '' ||
        (typeof reasoningEffort === 'string' && EFFORT.test(reasoningEffort)) ||
        Fail`Invalid session reasoning effort`;
      systemPrompt === undefined ||
        (typeof systemPrompt === 'string' &&
          systemPrompt.length <= MAX_SYSTEM_PROMPT_CHARS) ||
        Fail`Invalid session system prompt`;
      return options;
    };
    return harden({
      run: makeExo('HostedTurnBackend', HostedTurnBackendInterface, {
        send: (prompt, options) =>
          bare('a turn', async () => {
            const limits = await checkLive();
            const checked = allowed(options, limits);
            return checked === undefined
              ? E(run).send(prompt)
              : E(run).send(prompt, checked);
          }),
        models: () =>
          bare('listing models', async () => {
            const limits = await checkLive();
            const catalog = await E(run).models();
            return harden(
              (Array.isArray(catalog) ? catalog : []).filter(
                (/** @type {any} */ entry) =>
                  limits.models === undefined ||
                  limits.models.includes(entry?.id),
              ),
            );
          }),
        // Stopping a turn is never refused: it spends nothing.
        interrupt: () => bare('an interrupt', () => E(run).interrupt()),
        acknowledge: checkpoint =>
          bare('an acknowledgement', async () => {
            await checkLive();
            return E(run).acknowledge(checkpoint);
          }),
        status: () => bare('a status read', () => E(run).status()),
        help: () =>
          'Turns of one session of a delegated runner. Every call asks whether the runner still stands.',
      }),
      admin: makeExo(
        'HostedTurnBackendAdmin',
        HostedTurnBackendAdminInterface,
        {
          terminate: () => bare('a terminate', () => E(admin).terminate()),
          help: () => 'Stops this session’s native work; keeps its state.',
        },
      ),
    });
  };

  /**
   * @param {Record<string, any>} spec
   * @param {RunnerLimits} limits
   */
  const checkSpec = (spec, limits) => {
    const foreign = Object.keys(spec).filter(key => !SPEC_KEYS.includes(key));
    // A host path, a container mount, anything this does not know: a holder
    // names nothing of the operator's machine.
    foreign.length === 0 ||
      Fail`A delegated runner does not take that in a session`;
    spec.cwd === undefined ||
      spec.cwd === '/workspace' ||
      Fail`A delegated runner’s sessions work in /workspace`;
    spec.subscription === undefined ||
      spec.subscription === 'auto' ||
      Fail`A delegated runner chooses the subscription`;
    const networkPolicy = spec.networkPolicy ?? 'off';
    (typeof networkPolicy === 'string' &&
      limits.networkPolicies.includes(networkPolicy)) ||
      Fail`This runner does not allow that network policy`;
    const { model, reasoningEffort, systemPrompt } = spec;
    model === undefined ||
      model === '' ||
      (typeof model === 'string' && MODEL_ID.test(model)) ||
      Fail`Invalid session model`;
    !model ||
      limits.models === undefined ||
      limits.models.includes(model) ||
      Fail`This runner does not allow that model`;
    // The factory beneath would choose its own default, which may not be one
    // this runner allows.
    limits.models === undefined ||
      model ||
      Fail`This runner needs a model named`;
    reasoningEffort === undefined ||
      reasoningEffort === '' ||
      (typeof reasoningEffort === 'string' && EFFORT.test(reasoningEffort)) ||
      Fail`Invalid session reasoning effort`;
    // It is written into the operator's session records, outside any bound
    // on the session's own directory.
    systemPrompt === undefined ||
      (typeof systemPrompt === 'string' &&
        systemPrompt.length <= MAX_SYSTEM_PROMPT_CHARS) ||
      Fail`Invalid session system prompt`;
    return harden({
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(systemPrompt === undefined ? {} : { systemPrompt }),
      networkPolicy,
      subscription: limits.subscription,
      ...(limits.storage === 'unbounded'
        ? {}
        : { storageBoundBytes: limits.storage.maxSessionBytes }),
    });
  };

  const factory = makeExo('DelegatedRunner', HostedBackendFactoryInterface, {
    // Operator formula identities and account authority are not delegated.
    async inspectBindings() {
      throw Fail`Delegated runners do not expose operator bindings`;
    },
    // Answered whether or not the runner still stands: a holder's Floot asks
    // every backend it knows at once, and one that refused would cost it the
    // others. It says nothing a holder did not already have.
    describe: () =>
      bare('describe', async () => {
        const limits = await readLimits();
        const beneath = assertHostedBackendDescriptor(
          await E(await provideFactory()).describe(),
        );
        // Field by field: what a backend may come to say of itself later is
        // not a holder's to read. No subscriptions: a holder cannot pin.
        return harden({
          // Its own id, so that a holder's Floot can hold it beside a
          // backend of the same kind, or another runner.
          id: `${beneath.id}-${runnerId}`.slice(0, 64),
          title: `${beneath.title} (${runnerId})`,
          kind: beneath.kind,
          continuity: beneath.continuity,
          toolOwnership: beneath.toolOwnership,
          supportedNetworkPolicies: (
            beneath.supportedNetworkPolicies ?? ['off']
          ).filter((/** @type {string} */ policy) =>
            limits.networkPolicies.includes(policy),
          ),
          ...(beneath.promptEnvironment === undefined
            ? {}
            : { promptEnvironment: beneath.promptEnvironment }),
        });
      }),
    modelCatalog: () =>
      bare('listing models', async () => {
        await refresh();
        const limits = await readLimits();
        // What a holder is offered is its lane's account, under a name of
        // its own: a holder cannot pin, and learns no operator's
        // subscription id. A runner that is over offers nothing to start.
        const nothing = harden({
          subscriptionId: 'default',
          state: 'unavailable',
          observedAt: null,
          models: [],
        });
        if (isOver(limits)) return harden({ accounts: [nothing] });
        const answered = await E(await provideFactory()).modelCatalog(
          limits.subscription,
        );
        const account = (
          Array.isArray(answered?.accounts) ? answered.accounts : []
        ).find(
          (/** @type {any} */ entry) =>
            entry?.subscriptionId === limits.subscription,
        );
        if (account === undefined) return harden({ accounts: [nothing] });
        return harden({
          accounts: [
            {
              subscriptionId: 'default',
              state: account.state,
              observedAt: account.observedAt,
              models: (Array.isArray(account.models)
                ? account.models
                : []
              ).filter(
                (/** @type {any} */ entry) =>
                  limits.models === undefined ||
                  limits.models.includes(entry?.id),
              ),
            },
          ],
        });
      }),
    /**
     * @param {Record<string, any>} spec
     * @param {any} toolSet The holder's own: a harness here calls tools on
     *   the holder's daemon.
     */
    create: (spec, toolSet) =>
      bare('creating a session', async () => {
        const limits = await checkLive();
        const allowed = checkSpec(spec, limits);
        const beneathId = ownId(spec);
        if (limits.storage !== 'unbounded') {
          const descriptor = await E(await provideFactory()).describe();
          descriptor?.enforcesStorageBound === true ||
            Fail`The backend beneath cannot bound a session’s storage`;
        }
        return oneAtATime(beneathId, async () => {
          // The slot is taken, durably, before the session exists: a crash
          // in between costs a slot a destroy gives back, never a session
          // nobody counts. Only this is serialized with other sessions'
          // accounting, not the call beneath.
          let taken = false;
          await keep(before => {
            if (before.sessions.includes(beneathId)) return before;
            before.sessions.length < limits.maxSessions ||
              Fail`This runner has no free session slot`;
            taken = true;
            return { ...before, sessions: [...before.sessions, beneathId] };
          });
          try {
            const session = await within(
              E(await provideFactory()).create(
                harden({ sessionId: beneathId, ...allowed }),
                toolSet,
              ),
              beneathDeadlineMs,
            );
            // Withdrawn, or expired, while it was being made: it is
            // stopped, not handed over.
            await refresh(true);
            if (isOver(await readLimits())) {
              void E(await provideFactory())
                .stop(harden({ sessionId: beneathId }))
                .catch(() => {});
              throw Fail`Runner revoked`;
            }
            return guard(session);
          } catch (error) {
            // A deadline is not an answer: the create may yet complete
            // beneath, so its slot stays taken until a destroy succeeds.
            if (taken && !deadlines.has(/** @type {object} */ (error))) {
              // Whatever was made of it beneath is removed, and only then is
              // the slot given back; if it cannot be, the slot stays taken.
              try {
                await within(
                  E(await provideFactory()).destroy(
                    harden({ sessionId: beneathId }),
                  ),
                  stopDeadlineMs,
                );
                await keep(before => ({
                  ...before,
                  sessions: before.sessions.filter(id => id !== beneathId),
                }));
              } catch (_cleanupError) {
                // Left for destroy.
              }
            }
            throw error;
          }
        });
      }),
    // Stopping and destroying its own are never refused, revoked or not: a
    // holder can always clear away what is its own.
    stop: spec =>
      bare('stopping a session', async () => {
        const beneathId = ownId(spec);
        return oneAtATime(beneathId, async () => {
          await refresh(true);
          kept.sessions.includes(beneathId) ||
            Fail`Not a session of this runner`;
          return within(
            E(await provideFactory()).stop(harden({ sessionId: beneathId })),
            beneathDeadlineMs,
          );
        });
      }),
    destroy: spec =>
      bare('destroying a session', async () => {
        const beneathId = ownId(spec);
        return oneAtATime(beneathId, async () => {
          await refresh(true);
          kept.sessions.includes(beneathId) ||
            Fail`Not a session of this runner`;
          await within(
            E(await provideFactory()).destroy(harden({ sessionId: beneathId })),
            beneathDeadlineMs,
          );
          // Only once it is gone beneath is its slot given back.
          await keep(before => ({
            ...before,
            sessions: before.sessions.filter(id => id !== beneathId),
          }));
        });
      }),
    help: () =>
      `Delegated runner "${runnerId}": a hosted backend factory within its operator's limits. describe, modelCatalog, create({ sessionId, model, reasoningEffort?, systemPrompt?, networkPolicy? }, toolSet), stop, destroy. Sessions are this runner's own; the subscription, the network, the models and the number of sessions are its operator's choice, and a spec names nothing of the host.`,
  });

  const admin = makeExo('RunnerAdmin', RunnerAdminInterface, {
    /**
     * Withdraw the runner, durably, and stop what it is running. It takes
     * effect at once, whatever a holder has in flight: every turn facet asks
     * again and is refused. Sessions are stopped, not destroyed: their state
     * is the operator's to remove. Answers which sessions were stopped and
     * which could not be within the deadline.
     */
    async revoke() {
      revokedNow = true;
      // Whatever becomes of the write, what is running is stopped.
      /** @type {unknown} */
      let writeFailure;
      try {
        await within(
          keep(before => ({ ...before, revoked: true })),
          stopDeadlineMs,
        );
      } catch (error) {
        writeFailure = error;
        await refresh(true).catch(() => {});
      }
      const outcome = await stopAll();
      if (writeFailure !== undefined) {
        log(
          `runner ${runnerId}: the revocation could not be kept; it holds until this worker restarts:`,
          writeFailure instanceof Error
            ? writeFailure.message
            : String(writeFailure),
        );
        throw Error(
          'Runner revoked for now, but the revocation could not be written: revoke again',
        );
      }
      return outcome;
    },
    async getStatus() {
      await refresh(true);
      const limits = await readLimits();
      return harden({
        runnerId,
        revoked: kept.revoked || revokedNow,
        over: isOver(limits),
        sessions: [...kept.sessions],
        limits,
      });
    },
    /** @param {string} [methodName] */
    help(methodName) {
      if (methodName === 'revoke') {
        return 'revoke() — Withdraw the runner for good and stop its sessions: { stopped, notStopped }. Durable: it revives revoked. It takes effect at once; a session that could not be stopped within the deadline still refuses every turn. Sessions are stopped, not destroyed.';
      }
      return 'Runner admin: revoke(), getStatus(). The operator’s; never handed out with the runner.';
    },
  });

  // A revived runner may have sessions running and an expiry ahead of it:
  // the timer is armed without waiting for a holder to call.
  void readLimits().then(armExpiry, () => {});

  return harden({
    factory,
    admin,
    close: () => {
      closed = true;
      if (expiryTimer !== undefined) globalThis.clearTimeout(expiryTimer);
      expiryTimer = undefined;
    },
  });
};
harden(makeDelegatedRunner);
