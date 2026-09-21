// @ts-check

import { createHash } from 'node:crypto';

import { Fail, q } from '@endo/errors';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { iterateReader } from '@endo/exo-stream/iterate-reader.js';
import { M } from '@endo/patterns';

import { makeLatestTopic } from './latest-topic.js';
import { makeShareMeter } from './share-meter.js';

/**
 * A share: a subscription attenuated by limits its grantor chose, to hand to
 * somebody else.
 *
 * It has the `Subscription` interface, so whatever takes a subscription takes
 * a share, and a share of a share is a share: a holder who wants to narrow
 * one further wraps it again on their own daemon, and needs no help from the
 * grantor. `hops` counts the subscriptions a request has passed through, and
 * each share refuses past a small limit, which bounds nesting and stops two
 * parties' shares of each other's pools from going round for ever.
 *
 * Every request passes the share's checks before it reaches what is beneath:
 * not revoked, not expired, an allowed model, a free slot, what is beneath
 * available and above the grantor's floor, and a reservation that fits the
 * budget (`share-meter.js`). The response is the underlying one, untouched:
 * a share does not read or re-pump the stream, it charges from the `usage`
 * the innermost subscription settles.
 *
 * A refusal by the share is its own bare classification, `Provider share
 * exhausted`, so a holder sees a limit and not a fault, and a holder's pool
 * hands the request to its next member.
 *
 * **What it reveals**: its own id, limits and meter, and of what is beneath
 * only whether it is available and until when it is blocked. Never the
 * credential, the accounts, their windows, reset credits, other shares or the
 * grantor's sessions. It is nonetheless raw, metered inference: whoever holds
 * it can call it from any client, and the grantor sees every request body.
 */

export const SHARE_EXHAUSTED = 'Provider share exhausted';
export const MAX_HOPS = 4;
/**
 * How many endpoints a share keeps open. A holder opens one per session and
 * may never revoke them, so past this the oldest is closed, which costs that
 * session one reopening. It bounds what is retained, not what is served.
 */
const MAX_OPEN_ENDPOINTS = 256;

/** @param {unknown} error */
export const isShareExhaustion = error =>
  error instanceof Error &&
  (error.message === SHARE_EXHAUSTED ||
    error.message === 'Provider subscription exhausted');
harden(isShareExhaustion);

// What the innermost subscription accepts. A share accepts as much, so that
// shares nest: see `namespacedSessionId`.
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const SHARE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/**
 * A holder's session id, as what is beneath sees it: under the share's name,
 * apart from the grantor's own sessions. (Two shares' names can still spell
 * the same string, `a` + `b-c` and `a-b` + `c`; what is keyed by it beneath
 * is only which account last served a session, never an endpoint.)
 * Where that would be too long for what is beneath (a share of a share of a
 * share, or a long id), the holder's part is replaced by a digest of it: the
 * same session still gets the same name, which is what keeps a pool beneath
 * serving it from the account whose prompt cache is warm.
 *
 * @param {string} shareId
 * @param {string} sessionId
 */
export const namespacedSessionId = (shareId, sessionId) => {
  const plain = `share-${shareId}-${sessionId}`;
  if (plain.length <= 128) return plain;
  const digest = createHash('sha256').update(sessionId).digest('hex');
  return `share-${shareId}-h${digest.slice(0, 48)}`;
};
harden(namespacedSessionId);

/**
 * The bare words a share lets through from what is beneath, or says itself.
 * Anything else a holder would see (a store's error, a lookup that failed,
 * whatever another daemon chose to throw) reads as `Provider share
 * unavailable`, and is logged where the share lives.
 */
const BARE_ERRORS = harden([
  'Provider share exhausted',
  'Provider share revoked',
  'Provider share unavailable',
  'Provider request failed',
  'Provider response lost',
  'Provider concurrency limit reached',
  'Inference endpoint revoked',
  'Model denied',
  'Invalid inference JSON',
  'Inference route denied',
  'Request byte quota exceeded',
  'Invalid endpoint session id',
  'Invalid endpoint hops',
  'A share serves only "auto"',
  'Too many subscriptions between here and the provider',
]);

/**
 * @typedef {object} ShareLimits
 * @property {string} createdAt ISO instant; anchors the budget's periods.
 * @property {{ tokens: number, periodSeconds: number }} [budget]
 *   Rate-card-weighted tokens per fixed period.
 * @property {number} [reserve] Refuse while what is beneath has less than
 *   this fraction (0 to 1) of its window left. From readings, so advisory
 *   between them.
 * @property {string[]} [models] A subset of what is beneath; all if absent.
 * @property {number} [maxConcurrentRequests]
 * @property {string} [expiresAt] ISO instant.
 * @property {number} [outputEstimate] Tokens reserved for a response whose
 *   request does not bound its output.
 */

/**
 * Validate and copy a grantor's limits, as they are stored.
 *
 * @param {any} limits
 * @returns {ShareLimits}
 */
export const normalizeShareLimits = limits => {
  (limits !== null && typeof limits === 'object') ||
    Fail`Share limits must be a record`;
  const {
    createdAt,
    budget,
    reserve,
    models,
    maxConcurrentRequests,
    expiresAt,
    outputEstimate,
  } = limits;
  Number.isFinite(Date.parse(createdAt)) || Fail`Invalid share creation time`;
  if (budget !== undefined) {
    (budget !== null &&
      typeof budget === 'object' &&
      Number.isSafeInteger(budget.tokens) &&
      Number(budget.tokens) > 0 &&
      Number.isSafeInteger(budget.periodSeconds) &&
      Number(budget.periodSeconds) >= 60) ||
      Fail`Invalid share budget`;
  }
  reserve === undefined ||
    (typeof reserve === 'number' && reserve >= 0 && reserve < 1) ||
    Fail`Invalid share reserve`;
  models === undefined ||
    (Array.isArray(models) &&
      models.length > 0 &&
      models.length <= 256 &&
      models.every(
        model => typeof model === 'string' && MODEL_ID.test(model),
      )) ||
    Fail`Invalid share models`;
  maxConcurrentRequests === undefined ||
    (Number.isSafeInteger(maxConcurrentRequests) &&
      Number(maxConcurrentRequests) > 0 &&
      Number(maxConcurrentRequests) <= 1024) ||
    Fail`Invalid share concurrency`;
  expiresAt === undefined ||
    Number.isFinite(Date.parse(expiresAt)) ||
    Fail`Invalid share expiry`;
  outputEstimate === undefined ||
    (Number.isSafeInteger(outputEstimate) && Number(outputEstimate) > 0) ||
    Fail`Invalid share output estimate`;
  return harden({
    createdAt: new Date(Date.parse(createdAt)).toISOString(),
    ...(budget === undefined
      ? {}
      : {
          budget: {
            tokens: budget.tokens,
            periodSeconds: budget.periodSeconds,
          },
        }),
    ...(reserve === undefined ? {} : { reserve }),
    ...(models === undefined ? {} : { models: [...models] }),
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    ...(expiresAt === undefined
      ? {}
      : { expiresAt: new Date(Date.parse(expiresAt)).toISOString() }),
    ...(outputEstimate === undefined ? {} : { outputEstimate }),
  });
};
harden(normalizeShareLimits);

const DEFAULT_OUTPUT_ESTIMATE = 8192;

/**
 * What a request is reserved at: its size in tokens (a quarter of its bytes,
 * which overstates prose and understates little) plus the output it may ask
 * for, where it says, or the share's estimate.
 *
 * @param {string} body
 * @param {any} data The parsed body.
 * @param {number} outputEstimate
 */
export const estimateRequest = (body, data, outputEstimate) => {
  const declared = [
    data?.max_output_tokens,
    data?.max_completion_tokens,
    data?.max_tokens,
  ].find(value => Number.isSafeInteger(value) && Number(value) > 0);
  return Math.ceil(body.length / 4) + (declared ?? outputEstimate);
};
harden(estimateRequest);

const MessageShape = M.splitRecord(
  { method: M.string(), path: M.string(), body: M.string() },
  { headers: M.recordOf(M.string(), M.string()) },
);

export const SubscriptionInterface = M.interface('Subscription', {
  describe: M.callWhen().returns(M.record()),
  openEndpoint: M.callWhen(M.record()).returns(M.remotable()),
  getStatus: M.callWhen().returns(M.record()),
  watchStatus: M.callWhen().returns(M.remotable()),
  help: M.call().optional(M.string()).returns(M.string()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(SubscriptionInterface);

export const InferenceEndpointInterface = M.interface('InferenceEndpoint', {
  request: M.callWhen(MessageShape).returns(M.record()),
  requestByteStream: M.callWhen(MessageShape).returns(M.record()),
  attestation: M.callWhen().returns(M.record()),
  revoke: M.callWhen().returns(M.undefined()),
});
// eslint-disable-next-line @endo/no-harden-pattern-maker
harden(InferenceEndpointInterface);

const ShareAdminInterface = M.interface('ShareAdmin', {
  revoke: M.callWhen().returns(M.undefined()),
  getStatus: M.callWhen().returns(M.record()),
  help: M.call().optional(M.string()).returns(M.string()),
});

/**
 * @param {object} powers
 * @param {string} powers.shareId The grantor's name for it; what a holder and
 *   a status see.
 * @param {() => Promise<any>} powers.provideUnderlying The subscription
 *   beneath, resolved on every use: a deploy re-mints the broker and setup
 *   re-points the name.
 * @param {() => Promise<any>} powers.provideLimits The grantor's limits as
 *   stored, read for every endpoint and request, so an edit applies.
 * @param {{ read(): Promise<any>, write(record: any): Promise<void> }} powers.journal
 *   The share formula's own store: `{ revoked, meter }`. Single writer.
 * @param {() => number} [powers.now]
 * @param {(...args: unknown[]) => void} [powers.log]
 */
export const makeSubscriptionShare = ({
  shareId,
  provideUnderlying,
  provideLimits,
  journal,
  now = Date.now,
  log = (...args) => console.error(...args),
}) => {
  SHARE_ID.test(shareId) || Fail`Invalid share id ${q(shareId)}`;
  /** @type {{ revoked: boolean, meter?: any } | undefined} */
  let kept;
  /** @type {ReturnType<typeof makeShareMeter> | undefined} */
  let meter;
  /** @type {ShareLimits | undefined} */
  let limitsNow;
  /** @type {Promise<void> | undefined} */
  let loading;
  let activeRequests = 0;
  /** @type {Map<any, () => void>} inner endpoints open, and how to close each */
  const open = new Map();
  const topic = makeLatestTopic();
  let following = false;
  /** @type {Promise<unknown>} */
  let writing = Promise.resolve();

  /**
   * One write at a time, each built from what the one before it kept: the
   * meter and a revocation write the same record, and a meter write queued
   * behind a revocation must not put `revoked: false` back.
   *
   * @param {(before: { revoked: boolean, meter?: any }) => { revoked: boolean, meter?: any }} update
   */
  const keep = update => {
    const result = writing.then(async () => {
      const next = update(kept ?? { revoked: false });
      await journal.write(harden(next));
      kept = next;
    });
    writing = result.catch(() => {});
    return result;
  };

  const readLimits = async () => {
    limitsNow = normalizeShareLimits(await provideLimits());
    return limitsNow;
  };

  /** @type {Promise<void> | undefined} */
  let loadingKept;
  /**
   * What the store holds, read once. Apart from the limits, so that a share
   * whose limits cannot be read can still be revoked.
   */
  const loadKept = async () => {
    if (kept !== undefined) return;
    loadingKept ??= (async () => {
      const stored = await journal.read();
      // A write may have landed while the store was being read.
      kept ??= {
        revoked: stored?.revoked === true,
        ...(stored?.meter === undefined ? {} : { meter: stored.meter }),
      };
    })();
    try {
      await loadingKept;
    } finally {
      loadingKept = undefined;
    }
  };

  const load = async () => {
    if (meter !== undefined) return;
    loading ??= (async () => {
      await loadKept();
      const limits = await readLimits();
      meter ??= makeShareMeter({
        budget: () => limitsNow?.budget,
        anchorMs: Date.parse(limits.createdAt),
        now,
        initial: kept?.meter,
        keep: record => keep(before => ({ ...before, meter: record })),
      });
    })();
    try {
      await loading;
    } finally {
      loading = undefined;
    }
  };

  /**
   * What a holder is told when something goes wrong: one of a fixed set of
   * bare words, and for everything else that the share is unavailable. The
   * rest is said here, where the share lives.
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
      if (BARE_ERRORS.includes(message)) throw Error(message);
      log(`share ${shareId}: ${what} failed:`, message || String(error));
      throw Error('Provider share unavailable');
    }
  };

  /** @param {ShareLimits} limits */
  const expired = limits =>
    limits.expiresAt !== undefined && Date.parse(limits.expiresAt) <= now();

  /** @param {ShareLimits} limits */
  const checkLive = limits => {
    // One word for every reason the share is over: a holder is not told
    // whether the grantor withdrew it or it ran out.
    (kept?.revoked !== true && !expired(limits)) ||
      Fail`Provider share revoked`;
  };

  /** @param {unknown} value */
  const instant = value =>
    typeof value === 'string' && Number.isFinite(Date.parse(value))
      ? new Date(Date.parse(value)).toISOString()
      : '';

  const underlyingStatus = async () => {
    try {
      const status = await E(await provideUnderlying()).getStatus();
      const fraction = status?.remainingFraction;
      return {
        available: status?.available !== false,
        // A time, or nothing: not whatever text is beneath.
        blockedUntil: instant(status?.blockedUntil),
        remainingFraction:
          typeof fraction === 'number' && fraction >= 0 && fraction <= 1
            ? fraction
            : null,
      };
    } catch (_error) {
      // What is beneath cannot say. That is not a limit; a request finds out.
      return { available: true, blockedUntil: '', remainingFraction: null };
    }
  };

  /**
   * @param {ShareLimits} limits
   * @param {{ available: boolean, blockedUntil: string, remainingFraction: number | null }} beneath
   */
  const belowFloor = (limits, beneath) =>
    limits.reserve !== undefined &&
    beneath.remainingFraction !== null &&
    beneath.remainingFraction < limits.reserve;

  /** @param {boolean} forGrantor */
  const readStatus = async forGrantor => {
    await load();
    const limits = await readLimits();
    const beneath = await underlyingStatus();
    const budget = /** @type {NonNullable<typeof meter>} */ (meter).read();
    const over = kept?.revoked === true || expired(limits);
    const spentOut = budget !== undefined && budget.remaining <= 0;
    const floored = belowFloor(limits, beneath);
    let blockedUntil = '';
    if (!over) {
      if (!beneath.available) blockedUntil = beneath.blockedUntil;
      else if (spentOut) blockedUntil = budget.periodEndsAt;
    }
    return harden({
      shareId,
      available: !over && beneath.available && !spentOut && !floored,
      blockedUntil,
      over,
      ...(limits.expiresAt === undefined
        ? {}
        : { expiresAt: limits.expiresAt }),
      budget: budget ?? null,
      ...(limits.models === undefined ? {} : { models: limits.models }),
      // The grantor sees why; a holder sees only that.
      ...(forGrantor
        ? {
            revoked: kept?.revoked === true,
            activeRequests,
            openEndpoints: open.size,
            reserve: limits.reserve ?? null,
            beneath,
          }
        : {}),
    });
  };

  // What was last told, as text: a change beneath that changes nothing this
  // status says is not passed on. (A share held in the pool of the very
  // broker it is made over would otherwise hear its own echo for ever.)
  let told = '';
  const publish = () => {
    if (topic.watcherCount() === 0) return;
    void readStatus(false).then(
      status => {
        const text = JSON.stringify(status);
        if (text === told) return;
        told = text;
        topic.publish(harden({ type: 'status', status }));
      },
      () => {},
    );
  };

  /**
   * A pause that does not keep the worker alive on its own.
   * @param ms
   */
  const pauseFor = (/** @type {number} */ ms) =>
    new Promise(resolve => {
      const timer = globalThis.setTimeout(resolve, ms);
      /** @type {any} */ (timer).unref?.();
    });

  // While somebody watches, what is beneath is watched too, so a holder
  // learns that the share is blocked, or back, without asking.
  const follow = async () => {
    if (following) return;
    following = true;
    try {
      for (
        let pause = 5000;
        topic.watcherCount() > 0;
        pause = Math.min(pause * 2, 60_000)
      ) {
        /** @type {any} */
        let events;
        try {
          // eslint-disable-next-line no-await-in-loop
          const reader = await E(await provideUnderlying()).watchStatus();
          events = iterateReader(reader);
          // eslint-disable-next-line no-await-in-loop
          for await (const event of events) {
            if (event === undefined || topic.watcherCount() === 0) break;
            pause = 5000;
            publish();
          }
        } catch (_error) {
          // Looked for again below.
        } finally {
          // Nobody watches any more, or it ended: what is beneath is told.
          // eslint-disable-next-line no-await-in-loop
          await Promise.resolve(events?.return?.(undefined)).catch(() => {});
        }
        if (topic.watcherCount() === 0) break;
        // eslint-disable-next-line no-await-in-loop
        await pauseFor(pause);
      }
    } finally {
      following = false;
    }
  };

  /**
   * @param {{ sessionId: string, hops: number }} spec
   * @param {any} inner The endpoint beneath.
   */
  const makeEndpoint = (spec, inner) => {
    let closed = false;
    /**
     * @param {{ method: string, path: string, body: string, headers?: Record<string, string> }} message
     * @param {'request' | 'requestByteStream'} verb
     */
    const serve = async (message, verb) => {
      !closed || Fail`Inference endpoint revoked`;
      await load();
      const limits = await readLimits();
      checkLive(limits);
      let data;
      try {
        data = JSON.parse(message.body);
      } catch (_error) {
        throw Fail`Invalid inference JSON`;
      }
      limits.models === undefined ||
        (typeof data?.model === 'string' &&
          limits.models.includes(data.model)) ||
        Fail`Model denied`;
      activeRequests < (limits.maxConcurrentRequests ?? Infinity) ||
        Fail`Provider share exhausted`;
      // The slot is taken in the turn it was found free: requests that arrive
      // together cannot each see the same free slot.
      activeRequests += 1;
      // In use: the last to be closed if too many endpoints are open.
      if (open.has(inner)) {
        const close = /** @type {() => void} */ (open.get(inner));
        open.delete(inner);
        open.set(inner, close);
      }
      const requestTokens = Math.ceil(message.body.length / 4);
      /** @type {{ settle(settlement: any, floor?: number): void } | undefined} */
      let reservation;
      let done = false;
      /** @param {any} settlement */
      const finish = settlement => {
        if (done) return;
        done = true;
        activeRequests -= 1;
        // A response that was cut short, or never said what it cost, costs
        // at least what its size implies.
        const bytes = Number(settlement?.responseBytes);
        reservation?.settle(
          settlement,
          requestTokens + (Number.isFinite(bytes) && bytes > 0 ? bytes / 4 : 0),
        );
        publish();
      };
      try {
        const beneath = await underlyingStatus();
        (beneath.available && !belowFloor(limits, beneath)) ||
          Fail`Provider share exhausted`;
        reservation = await /** @type {NonNullable<typeof meter>} */ (
          meter
        ).reserve(
          estimateRequest(
            message.body,
            data,
            limits.outputEstimate ?? DEFAULT_OUTPUT_ESTIMATE,
          ),
        );
        // Revoked while the reservation was being made durable.
        checkLive(limits);
        !closed || Fail`Inference endpoint revoked`;
      } catch (error) {
        // Nothing was sent.
        finish({ usage: null, began: false });
        throw error;
      }
      let result;
      try {
        result = await E(inner)[verb](message);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === 'Provider response lost'
        ) {
          // Nothing came back, but the provider had the whole deadline, or
          // had begun to answer: charged as a response cut short. The holder
          // sees a failed request.
          finish({ usage: null, began: true, complete: false });
          // The word goes on up, so that a share made over this one charges
          // for it too.
          throw error;
        }
        // Nothing came back, and nothing was spent.
        finish({ usage: null, began: false });
        if (isShareExhaustion(error)) throw Error(SHARE_EXHAUSTED);
        throw error;
      }
      const usage = result?.usage;
      if (usage === undefined) {
        // An endpoint that settles nothing: the reservation is the charge.
        finish(undefined);
      } else {
        // A promise for a stream, a record for a whole body. It never rejects
        // at its source; across a lost connection it can.
        void Promise.resolve(usage).then(finish, () => finish(undefined));
      }
      // Untouched: the reader is the subscription's own, not a copy.
      return result;
    };
    const endpoint = makeExo('InferenceEndpoint', InferenceEndpointInterface, {
      request: message => bare('a request', () => serve(message, 'request')),
      requestByteStream: message =>
        bare('a request', () => serve(message, 'requestByteStream')),
      attestation: () =>
        bare('an attestation', async () => {
          const beneath = await E(inner).attestation();
          // The origin, the share's own narrowing of models (null where it
          // has none: what is beneath admits by its accounts' catalogs), and
          // the share in place of whatever set of accounts is beneath it.
          const origin = `${beneath?.providerOrigin ?? ''}`;
          return harden({
            version: 'InferenceEndpointV1',
            sessionId: spec.sessionId,
            providerOrigin: /^https:\/\/[A-Za-z0-9.-]{1,253}(:\d{1,5})?$/.test(
              origin,
            )
              ? origin
              : '',
            models:
              limitsNow?.models === undefined
                ? null
                : limitsNow.models
                    .filter(
                      (/** @type {unknown} */ model) =>
                        typeof model === 'string' && MODEL_ID.test(model),
                    )
                    .slice(0, 256),
            modelAdmission: 'account-catalog',
            subscription: shareId,
            hops: spec.hops,
          });
        }),
      async revoke() {
        if (closed) return;
        closed = true;
        open.delete(inner);
        await E(inner)
          .revoke()
          .catch(() => {});
      },
    });
    open.set(inner, () => {
      closed = true;
    });
    while (open.size > MAX_OPEN_ENDPOINTS) {
      // The one used least recently; a session that comes back to it opens
      // another.
      const [[oldest, close]] = open;
      open.delete(oldest);
      close();
      void E(oldest)
        .revoke()
        .catch(() => {});
    }
    return endpoint;
  };

  const share = makeExo('Subscription', SubscriptionInterface, {
    describe: () =>
      bare('describe', async () => {
        await load();
        const limits = await readLimits();
        const beneath = await E(await provideUnderlying()).describe();
        const allowed = (
          Array.isArray(beneath?.models) ? beneath.models : []
        ).filter(
          (/** @type {unknown} */ model) =>
            typeof model === 'string' && MODEL_ID.test(model),
        );
        const providerId = `${beneath?.providerId ?? ''}`;
        return harden({
          providerId: /^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId)
            ? providerId
            : '',
          id: shareId,
          label: shareId,
          kind: 'share',
          models: (limits.models === undefined
            ? allowed
            : limits.models.filter(model => allowed.includes(model))
          ).slice(0, 256),
        });
      }),
    /** @param {any} requested */
    openEndpoint: requested =>
      bare('opening an endpoint', async () => {
        await load();
        const limits = await readLimits();
        checkLive(limits);
        const { sessionId, subscription = 'auto', hops = 0 } = requested ?? {};
        (typeof sessionId === 'string' && SESSION_ID.test(sessionId)) ||
          Fail`Invalid endpoint session id`;
        // A holder cannot name or pin the grantor's members.
        subscription === 'auto' || Fail`A share serves only "auto"`;
        (Number.isSafeInteger(hops) && Number(hops) >= 0) ||
          Fail`Invalid endpoint hops`;
        Number(hops) + 1 <= MAX_HOPS ||
          Fail`Too many subscriptions between here and the provider`;
        const spec = harden({ sessionId, hops: Number(hops) + 1 });
        const inner = await E(await provideUnderlying()).openEndpoint(
          harden({
            sessionId: namespacedSessionId(shareId, sessionId),
            subscription: 'auto',
            hops: spec.hops,
          }),
        );
        if (kept?.revoked === true) {
          // Revoked while it was being opened.
          await E(inner)
            .revoke()
            .catch(() => {});
          throw Fail`Provider share revoked`;
        }
        return makeEndpoint(spec, inner);
      }),
    getStatus: () => bare('a status read', () => readStatus(false)),
    async watchStatus() {
      const reader = topic.watch();
      // A new watcher is told now, whatever was told before.
      void readStatus(false).then(
        status => {
          told = JSON.stringify(status);
          topic.publish(harden({ type: 'status', status }));
        },
        () => {},
      );
      void follow();
      return reader;
    },
    /** @param {string} [methodName] */
    help(methodName) {
      const docs = {
        describe:
          'describe() — { providerId, id, label, kind: "share", models }.',
        openEndpoint:
          'openEndpoint({ sessionId, subscription?: "auto", hops? }) — An inference endpoint for one session: request(message), requestByteStream(message), attestation(), revoke(). message is { method, path, body, headers? } in the provider’s own API shape. A response carries usage, what it cost, settled at the end of the stream. A refusal by the share’s limits is the error "Provider share exhausted".',
        getStatus:
          'getStatus() — { shareId, available, blockedUntil, over, expiresAt?, budget: { tokens, periodSeconds, spent, reserved, remaining, periodEndsAt } | null, models? }. Of what is beneath, only whether it is available and until when it is blocked.',
        watchStatus:
          'watchStatus() — A disposable stream of { type: "status", status }: now, and when it changes, coalesced to the newest.',
      };
      if (methodName === undefined) {
        return 'Subscription (a share): describe(), openEndpoint(spec), getStatus(), watchStatus(). Metered inference against somebody’s subscription, within limits they chose. It cannot reach the credential, and they can read every request sent through it.';
      }
      return (
        docs[/** @type {keyof typeof docs} */ (methodName)] ||
        `No documentation for method "${methodName}".`
      );
    },
  });

  const admin = makeExo('ShareAdmin', ShareAdminInterface, {
    /**
     * Withdraw the share, durably, and cancel what it has in flight. The
     * flag is in the store before this answers, so a restart revives it
     * revoked. It needs the store and nothing else: a share whose limits
     * cannot be read can still be withdrawn.
     */
    async revoke() {
      await loadKept();
      await keep(before => ({ ...before, revoked: true }));
      const closing = [...open];
      open.clear();
      await Promise.all(
        closing.map(([inner, close]) => {
          close();
          return E(inner)
            .revoke()
            .catch(error =>
              log(
                `share ${shareId}: an endpoint could not be revoked:`,
                error instanceof Error ? error.message : String(error),
              ),
            );
        }),
      );
      publish();
    },
    getStatus: () => readStatus(true),
    /** @param {string} [methodName] */
    help(methodName) {
      if (methodName === 'revoke') {
        return 'revoke() — Withdraw the share for good and cancel its in-flight responses. Durable: it revives revoked.';
      }
      if (methodName === 'getStatus') {
        return 'getStatus() — The share’s status as its grantor sees it: also revoked, activeRequests, openEndpoints, reserve and what is beneath.';
      }
      return 'Share admin: revoke(), getStatus(). The grantor’s; never handed out with the share.';
    },
  });

  return harden({ share, admin, close: () => topic.close() });
};
harden(makeSubscriptionShare);
