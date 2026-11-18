// @ts-check
/**
 * The ports of the current adapter incarnation (contract 6.1, 7; J-9151):
 * part of the turn runner. The session holds one `TurnPorts` and its tool
 * set across turns, opened once when the session is made and again only
 * after a retired break showed that incarnation gone.
 *
 * - `open()`: `Backend.open(host)`, one at a time (an open in flight is
 *   not repeated). Its answer: ports no newer than the latest broken
 *   `since` came from the dead incarnation and are asked for again, at
 *   most 3 opens in a row (then the open failed); other ports become the
 *   held set and `onFresh(set, since)` runs; a rejection runs
 *   `onFailed(error)`. Either answer's crank ends with `flush()`.
 * - `drop(ports)`: ports whose incarnation is gone are no longer held;
 *   live publishing forgets their publisher.
 * - `broke(ports)`: a lease broke before Dispatched: remember the dead
 *   `since` and open fresh ports.
 * - `publisherBroke(publisher, inUse)`: an outside publish broke: the held
 *   ports with that publisher are dead unless the current turn uses them
 *   (it learns that from its own lease).
 *
 * Guest rules. Sends `Backend.open` only.
 */

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { LivePublishing } from './live.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/**
 * @typedef {{ ports: any, tools: any }} HeldPorts
 */

/**
 * @param {object} options
 * @param {{ backend: any, host: any }} options.services
 * @param {LivePublishing} options.live
 * @param {(ports: any) => any} options.toolsFor the tool set for these ports
 * @param {(set: HeldPorts, since: number) => void} options.onFresh fresh
 *   ports are held
 * @param {(error: unknown) => void} options.onFailed no ports came
 * @param {() => void} options.flush the end of an answer's crank
 */
export const makePorts = ({
  services,
  live,
  toolsFor,
  onFresh,
  onFailed,
  flush,
}) => {
  /**
   * The held ports and their tool set; undefined until the first open
   * answers and after a retired break showed them dead.
   * @type {HeldPorts | undefined}
   */
  let held;
  /** an open is in flight */
  let opening = false;
  /** opens asked for since the last break (bounded; see opened) */
  let reopens = 0;
  /**
   * The latest `since` of ports whose lease broke: an open answered with
   * ports no newer than that came from the dead incarnation.
   */
  let brokenSince = -1;

  /** @param {unknown} error */
  const failed = error => {
    reopens = 0;
    onFailed(error);
  };

  const open = () => {
    if (opening) return;
    opening = true;
    reopens += 1;
    E(services.backend)
      .open(services.host)
      .then(
        ports => {
          opening = false;
          opened(ports);
          flush();
        },
        error => {
          opening = false;
          failed(error);
          flush();
        },
      );
  };

  /** @param {any} ports */
  const opened = ports => {
    const since = /** @type {number} */ (ports.since);
    if (since <= brokenSince) {
      // Answered from the incarnation whose lease broke (the open was sent
      // before the break): ask again, a bounded number of times.
      if (reopens < 3) {
        open();
        return;
      }
      failed(Error('the backend answered with ports that are gone'));
      return;
    }
    reopens = 0;
    held = harden({ ports, tools: toolsFor(ports) });
    onFresh(held, since);
  };

  return harden({
    /** The held set, or undefined. */
    held: () => held,
    open,
    /**
     * Ports whose incarnation is gone: stop holding them.
     * @param {any} ports
     */
    drop: ports => {
      if (held !== undefined && held.ports === ports) held = undefined;
      live.forget(ports.publisher);
    },
    /**
     * A lease on these ports broke before Dispatched (a restart): fresh
     * ports tell whether the turn was in flight.
     * @param {any} ports
     */
    broke: ports => {
      const since = /** @type {number} */ (ports.since);
      if (since > brokenSince) brokenSince = since;
      reopens = 0;
      open();
    },
    /**
     * @param {any} publisher
     * @param {any} inUse the current turn's ports, or undefined
     */
    publisherBroke: (publisher, inUse) => {
      if (held === undefined || held.ports.publisher !== publisher) return;
      if (inUse === held.ports) return;
      held = undefined;
    },
  });
};
harden(makePorts);
