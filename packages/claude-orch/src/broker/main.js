// @ts-check
/* global globalThis, setTimeout, clearTimeout */
/**
 * @import { Credentials } from '../../protocol.types.js'
 */

import net from 'node:net';
import { readFile, unlink, chmod } from 'node:fs/promises';

/**
 * Credential broker daemon (DESIGN.md §5.5).
 *
 * **Subscribe/push protocol.** The broker is the source of truth
 * for credential expiries and refresh policy. Consumers (the
 * orchestrator, one connection per session) open a subscription:
 *
 *   client → broker:  {"type": "subscribe", "sessionId": "..."}
 *   broker → client:  {"type": "creds", "sessionId": "...",
 *                      "credentials": <Credentials>}      // immediate
 *   broker → client:  {"type": "creds", ...}              // on every refresh
 *   broker → client:  {"type": "error", "sessionId": "...",
 *                      "message": "..."}                  // refresh failed
 *   client → broker:  {"type": "unsubscribe", "sessionId": "..."}
 *
 * The connection stays open for the lifetime of the subscription.
 * `subscribe` always immediately yields the current credentials so
 * a consumer can use the same call to mint a session's BootConfig
 * AND register for future rotations — no separate `issue` step.
 *
 * **API-key mode (default)**: `refresher` is undefined, so the
 * scheduler never fires and subscribers see exactly one `{type:
 * 'creds'}` reply for the lifetime of their subscription.
 *
 * **OAuth mode**: pass a `refresher() → Promise<Credentials>`
 * along with `initialCredentials` that carries an `oauthToken`
 * with an `expiresAt`. The broker schedules `setTimeout` to fire
 * `refreshWindowMs` before that expiry, calls the refresher, and
 * broadcasts the new credentials to every active subscription.
 * Errors during refresh are surfaced as `{type: 'error'}` messages
 * to subscribers; the broker schedules a retry after
 * `refreshRetryMs` so a transient IdP outage doesn't permanently
 * stall rotation.
 *
 * @param {{
 *   socketPath: string,
 *   initialCredentials: Credentials,
 *   refresher?: () => Promise<Credentials>,
 *   refreshWindowMs?: number,
 *   refreshRetryMs?: number,
 *   log?: (level: 'info'|'warn'|'error', msg: string) => void,
 * }} opts
 */
export const makeBroker = ({
  socketPath,
  initialCredentials,
  refresher,
  refreshWindowMs = 5 * 60 * 1000,
  refreshRetryMs = 30 * 1000,
  log = () => {},
}) => {
  /** @type {Credentials} */
  let current = initialCredentials;

  // Per-session set of subscriber sockets. Most callers (the
  // orchestrator's per-session subscription) open exactly one
  // connection per sessionId, but the set tolerates duplicates so
  // a reconnecting client can layer atop a stale entry.
  /** @type {Map<string, Set<net.Socket>>} */
  const subscribers = new Map();

  /** @type {NodeJS.Timeout | null} */
  let refreshTimer = null;

  /**
   * Broadcast `current` to every active subscriber.
   */
  const broadcast = () => {
    for (const [sid, conns] of subscribers.entries()) {
      const line = `${JSON.stringify({
        type: 'creds',
        sessionId: sid,
        credentials: current,
      })}\n`;
      for (const conn of conns) {
        // Best-effort. Per-connection error handlers drop dead
        // sockets out of the set; we don't crash the broker on a
        // disconnected subscriber.
        try {
          conn.write(line);
        } catch {
          // ignore
        }
      }
    }
  };

  const broadcastError = msg => {
    for (const [sid, conns] of subscribers.entries()) {
      const line = `${JSON.stringify({
        type: 'error',
        sessionId: sid,
        message: msg,
      })}\n`;
      for (const conn of conns) {
        try {
          conn.write(line);
        } catch {
          // ignore
        }
      }
    }
  };

  /** Extract an `expiresAt` epoch-ms from `current`, or null. */
  const extractExpiry = () => {
    if (!current.oauthToken?.expiresAt) return null;
    const t = Date.parse(current.oauthToken.expiresAt);
    return Number.isFinite(t) ? t : null;
  };

  // Floor on the scheduled delay. Prevents a tight loop if the
  // operator misconfigures `refreshWindowMs > tokenLifetime` (the
  // resulting `delay` would be 0, each refresh would immediately
  // schedule another at 0, burning CPU). 50 ms is short enough to
  // keep test fixtures snappy and long enough to bound runaway.
  const MIN_REFRESH_DELAY_MS = 50;

  const scheduleNextRefresh = () => {
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (!refresher) return; // api-key mode: no rotation
    const expiry = extractExpiry();
    if (expiry === null) return; // no expiry → no schedule
    const delay = Math.max(
      MIN_REFRESH_DELAY_MS,
      expiry - Date.now() - refreshWindowMs,
    );
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      try {
        const next = await refresher();
        if (next && typeof next === 'object') {
          current = next;
          broadcast();
        }
      } catch (e) {
        const msg = /** @type {Error} */ (e).message;
        log('error', `refresh failed: ${msg}`);
        broadcastError(`refresh failed: ${msg}`);
        // Retry on a shorter interval rather than waiting for the
        // (now-likely-stale) expiry to come around.
        refreshTimer = setTimeout(() => {
          refreshTimer = null;
          scheduleNextRefresh();
        }, refreshRetryMs);
        if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
        return;
      }
      scheduleNextRefresh();
    }, delay);
    if (typeof refreshTimer.unref === 'function') refreshTimer.unref();
  };

  // Kick off the first refresh schedule from `initialCredentials`.
  scheduleNextRefresh();

  const handleMessage = (conn, msg) => {
    if (msg.type === 'subscribe') {
      const sid = msg.sessionId;
      if (typeof sid !== 'string' || sid.length === 0) {
        conn.write(
          `${JSON.stringify({
            type: 'error',
            message: 'subscribe: sessionId required',
          })}\n`,
        );
        return;
      }
      let set = subscribers.get(sid);
      if (!set) {
        set = new Set();
        subscribers.set(sid, set);
      }
      set.add(conn);
      // Immediately deliver the current credentials.
      conn.write(
        `${JSON.stringify({
          type: 'creds',
          sessionId: sid,
          credentials: current,
        })}\n`,
      );
      return;
    }
    if (msg.type === 'unsubscribe') {
      const sid = msg.sessionId;
      const set = subscribers.get(sid);
      if (set) {
        set.delete(conn);
        if (set.size === 0) subscribers.delete(sid);
      }
      return;
    }
    conn.write(
      `${JSON.stringify({
        type: 'error',
        message: `unknown broker request type: ${msg.type}`,
      })}\n`,
    );
  };

  /** Drop `conn` from every subscriber set. */
  const removeConn = conn => {
    for (const [sid, set] of subscribers.entries()) {
      set.delete(conn);
      if (set.size === 0) subscribers.delete(sid);
    }
  };

  return harden({
    async listen() {
      await unlink(socketPath).catch(() => {});
      const server = net.createServer(conn => {
        let buf = '';
        let connClosed = false;

        conn.on('error', () => {
          connClosed = true;
          removeConn(conn);
        });
        conn.on('close', () => {
          connClosed = true;
          removeConn(conn);
        });

        conn.on('data', chunk => {
          if (connClosed) return;
          buf += chunk.toString('utf8');
          for (;;) {
            const i = buf.indexOf('\n');
            if (i < 0) break;
            const line = buf.slice(0, i);
            buf = buf.slice(i + 1);
            try {
              const msg = JSON.parse(line);
              handleMessage(conn, msg);
            } catch (e) {
              const m = /** @type {Error} */ (e).message;
              try {
                conn.write(
                  `${JSON.stringify({ type: 'error', message: m })}\n`,
                );
              } catch {
                // peer gone; close handler will clean up
              }
            }
          }
        });
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve(undefined));
      });
      // 0600 — only the orchestrator UID may connect.
      await chmod(socketPath, 0o600);
      return server;
    },
    /** Force a refresh now (test / operator hook). */
    async forceRefresh() {
      if (!refresher) return false;
      const next = await refresher();
      if (next && typeof next === 'object') {
        current = next;
        broadcast();
        scheduleNextRefresh();
        return true;
      }
      return false;
    },
  });
};
harden(makeBroker);

/**
 * Load the API key from a config file (mode 0600 expected) or env var.
 *
 * @param {{ configPath?: string, envVar?: string }} opts
 * @returns {Promise<string>}
 */
export const loadApiKey = async ({
  configPath,
  envVar = 'ANTHROPIC_API_KEY',
}) => {
  // eslint-disable-next-line no-restricted-globals
  const fromEnv = /** @type {any} */ (globalThis).process?.env?.[envVar];
  if (fromEnv) return fromEnv;
  if (configPath) {
    const data = await readFile(configPath, 'utf8');
    const trimmed = data.trim();
    if (trimmed.length === 0)
      throw new Error(`Empty broker config: ${configPath}`);
    return trimmed;
  }
  throw new Error(
    `No API key available. Set ${envVar} or supply a config file path.`,
  );
};
harden(loadApiKey);
