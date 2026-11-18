// @ts-check
/**
 * The gateway-local `Live` service (M1a W1a.3; architecture D-8, D-12;
 * designs/m1a-interfaces.md sections 3.2 and 5). Tests reach it through
 * `AgentHostAdmin.live()`; in M3 the gateway hands it to browsers.
 *
 * `subscribe(session, rev?)` finds the session's channel by the Session
 * presence it is given (never by a key) and returns a new subscription whose
 * first delivery is the current-turn snapshot. Client rule: `watch()` first,
 * then `subscribe(session, rev)`; re-watch on a rev gap (section 5).
 *
 * Node module (adapter); the guest prelude is on `globalThis`.
 */
/* eslint-disable import/no-relative-packages -- the guest tree is its own private package */
import { interfaces } from '../../../guest/lib/interfaces.js';
/* eslint-enable import/no-relative-packages */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { makeExo } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @param {object} options
 * @param {{ channelFor(session: any): { subscribe(rev?: number): any } }} options.channels
 *   the registry from `makeChannelRegistry`
 * @param {{ subscribe(rev?: number): any }} [options.listChannel] M1b: the
 *   session list channel (`list-channel.js`); `subscribeList` refuses
 *   without one
 */
export const makeLive = ({ channels, listChannel }) =>
  makeExo('Live', interfaces.Live, {
    /**
     * @param {any} session
     * @param {number} [rev]
     */
    async subscribe(session, rev) {
      return channels.channelFor(session).subscribe(rev);
    },
    /**
     * M1b (W1b.1 wiring; m1b-interfaces.md 3.6, 10.2): a subscription to
     * the session list; first delivery `list-snapshot` with the latest rev.
     * @param {number} [rev]
     */
    async subscribeList(rev) {
      if (listChannel === undefined)
        throw Error('this agent host has no session list feed');
      return listChannel.subscribe(rev);
    },
  });
harden(makeLive);
