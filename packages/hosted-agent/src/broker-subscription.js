// @ts-check

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';

import { makeLatestTopic } from './latest-topic.js';
import { standingOf } from './subscription-pool.js';
import { SubscriptionInterface } from './subscription-share.js';

/**
 * A provider broker as a `Subscription`: the public form of what a retained
 * broker is inside. It serves inference against the broker's credential, or
 * its pool's, through endpoints that carry no listener and no sandbox, and it
 * publishes whether it can serve.
 *
 * It is the operator's, whole and unmetered: whoever holds it spends the
 * subscription without limit. It is what a share is made over
 * (`subscription-share.js`), and a share is what is handed out.
 *
 * Its status is the short form a share may pass on: whether some account can
 * serve, until when none can, and how much the best of them has left. The
 * windows, plans and credits stay with the account oracles.
 *
 * @param {object} powers
 * @param {string} powers.providerId
 * @param {string} powers.label
 * @param {() => Promise<readonly string[]>} powers.readModels The ids every
 *   account an `auto` endpoint may be served from lists now, from the
 *   catalogs already held; for `describe()`.
 * @param {(spec: any) => Promise<any>} powers.openEndpoint The issuer's.
 * @param {() => Promise<Array<{ id: string, rateLimits: any }>>} powers.readings
 *   Each account's last raw reading, from memory. Calls no provider.
 * @param {() => number} [powers.now]
 */
export const makeBrokerSubscription = ({
  providerId,
  label,
  readModels,
  openEndpoint,
  readings,
  now = Date.now,
}) => {
  const topic = makeLatestTopic();
  // What was last told, as text. A reading that changes nothing a status
  // says is not news: without this, a share of this broker held in its own
  // pool would be told of its own echo for ever (its status follows this
  // one, and its reading is one of this one's).
  let told = '';
  /** @param {any} status */
  const tell = status => {
    const text = JSON.stringify(status);
    if (text === told) return;
    told = text;
    topic.publish(harden({ type: 'status', status }));
  };

  const readStatus = async () => {
    const nowMs = now();
    const standings = (await readings()).map(({ rateLimits }) =>
      standingOf(rateLimits, nowMs),
    );
    standings.length > 0 || Fail`Subscription has no account`;
    const usable = standings.filter(standing => !standing.blocked);
    const backs = standings
      .map(standing => standing.blockedUntilMs)
      .filter(ms => typeof ms === 'number');
    const left = usable
      .filter(standing => standing.longUsedFraction !== null)
      .map(standing => 1 - Number(standing.longUsedFraction));
    return harden({
      available: usable.length > 0,
      // When the first of them is expected back; '' while one can serve, or
      // when none says.
      blockedUntil:
        usable.length > 0 || backs.length === 0
          ? ''
          : new Date(Math.min(...backs.map(Number))).toISOString(),
      // The best of those that can serve. Null when no reading says.
      remainingFraction:
        left.length === 0 ? null : Math.max(0, Math.min(1, Math.max(...left))),
    });
  };

  const subscription = makeExo('Subscription', SubscriptionInterface, {
    describe: async () =>
      harden({
        providerId,
        id: providerId,
        label,
        kind: 'broker',
        models: [...(await readModels())],
      }),
    /** @param {any} spec */
    openEndpoint: async spec => openEndpoint(spec),
    getStatus: readStatus,
    async watchStatus() {
      const reader = topic.watch();
      // A new watcher is told now, whatever was told before.
      void readStatus().then(
        status => {
          told = JSON.stringify(status);
          topic.publish(harden({ type: 'status', status }));
        },
        () => {},
      );
      return reader;
    },
    /** @param {string} [methodName] */
    help(methodName) {
      const docs = {
        describe:
          'describe() — { providerId, id, label, kind: "broker", models }: the models the accounts behind this broker list, read from the provider again when what is held is past its lifetime.',
        openEndpoint:
          'openEndpoint({ sessionId, subscription?: "auto" | id, hops? }) — An inference endpoint for one session, with no listener: request(message), requestByteStream(message), attestation(), revoke(). Unmetered: make a share before handing anything out.',
        getStatus:
          'getStatus() — { available, blockedUntil, remainingFraction }: whether some account can serve, until when none can, and what the best of them has left of its long window. From readings already taken; calls no provider.',
        watchStatus:
          'watchStatus() — A disposable stream of { type: "status", status }: now, and as readings arrive, coalesced to the newest.',
      };
      if (methodName === undefined) {
        return 'Subscription (a provider broker): describe(), openEndpoint(spec), getStatus(), watchStatus(). The operator’s own, whole; shares are made over it.';
      }
      return (
        docs[/** @type {keyof typeof docs} */ (methodName)] ||
        `No documentation for method "${methodName}".`
      );
    },
  });

  return harden({
    subscription,
    /** A reading arrived: tell whoever watches. */
    changed: () => {
      if (topic.watcherCount() === 0) return;
      void readStatus().then(tell, () => {});
    },
    close: () => topic.close(),
  });
};
harden(makeBrokerSubscription);
