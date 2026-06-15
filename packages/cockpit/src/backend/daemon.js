// @ts-check
/* global process */
//
// Daemon backend: connect the cockpit to a running Endo daemon and hand back
// its host powers. This is the bridge that turns the cockpit from a mock-only
// harness into a real one — when a daemon is reachable, agentry threads run
// against live Endo capabilities resolved by pet name from the daemon's
// petstore (designs/garden-cockpit.md § "Per-thread engine").
//
// On any connect failure (no daemon running, bad socket) `connectDaemon`
// returns null so the cockpit falls back to OFFLINE (mock) mode rather than
// crashing. `close()` cancels the CapTP connection cleanly.

import os from 'node:os';

import { makeEndoClient } from '@endo/daemon';
import { makePromiseKit } from '@endo/promise-kit';
import { whereEndoSock } from '@endo/where';
import { E } from '@endo/far';

/**
 * @typedef {object} DaemonConnection
 * @property {unknown} bootstrap   the daemon bootstrap capability
 * @property {unknown} powers      the EndoHost — agentry's `powers` handle
 * @property {string} sockPath     the resolved daemon socket path
 * @property {() => void} close    cancel the CapTP connection
 */

/**
 * Resolve the daemon socket path the same way the CLI does: honor `ENDO_SOCK`
 * via `whereEndoSock`, otherwise derive it from the platform + user info.
 *
 * @param {object} [options]
 * @param {string} [options.sockPath]   explicit override (skips whereEndoSock)
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {string}
 */
export const resolveSockPath = ({ sockPath, env = process.env } = {}) => {
  if (typeof sockPath === 'string' && sockPath.length > 0) {
    return sockPath;
  }
  const { username, homedir } = os.userInfo();
  const info = harden({ user: username, home: homedir, temp: os.tmpdir() });
  return whereEndoSock(process.platform, env, info);
};
harden(resolveSockPath);

/**
 * Connect to a running Endo daemon and return its host powers. Returns null
 * when no daemon is reachable so the cockpit can run OFFLINE on the mock
 * engine. Unlike the CLI's `provideEndoClient`, this never *starts* a daemon —
 * the cockpit only attaches to one a human already brought up, so an absent
 * daemon is a clean fallback, not an error to paper over.
 *
 * @param {object} [options]
 * @param {string} [options.name]       CapTP client name (default 'cockpit')
 * @param {string} [options.sockPath]   explicit socket path override
 * @param {Record<string, string | undefined>} [options.env]
 * @returns {Promise<DaemonConnection | null>}
 */
export const connectDaemon = async ({
  name = 'cockpit',
  sockPath: sockPathOption,
  env = process.env,
} = {}) => {
  const sockPath = resolveSockPath({ sockPath: sockPathOption, env });
  // The cancellation promise is the CapTP connection's lifetime: rejecting it
  // tears the connection down. We swallow its rejection so an unhandled
  // rejection never escapes when close() fires.
  const { promise: cancelled, reject: cancel } = makePromiseKit();
  cancelled.catch(() => {});
  await null;
  try {
    const { getBootstrap, closed } = await makeEndoClient(
      name,
      sockPath,
      cancelled,
    );
    closed.catch(() => {});
    const bootstrap = await getBootstrap();
    const powers = await E(bootstrap).host();
    return harden({
      bootstrap,
      powers,
      sockPath,
      close: () => cancel(new Error('cockpit closed the daemon connection')),
    });
  } catch (err) {
    // No daemon, or it rejected the connection: fall back to OFFLINE mode.
    cancel(new Error('daemon connect failed'));
    return null;
  }
};
harden(connectDaemon);
