// endo-peer-bridge.mjs — redeem REAL Endo daemon invitations (endo://…?type=invitation, dialed over
// iroh+captp0) so the `objects` power can actually reach a peer like Kumavis.
//
// WHY a sidecar daemon. An Endo daemon invitation is a daemon-to-daemon protocol, not a swissnum fetch:
// redeeming it (E(host).accept(locator, name)) dials the invitation formula on the inviter's daemon over the
// netlayer and exchanges handles. So we run our OWN small @endo/daemon (its own NodeNumber = our peer identity,
// its own sock + state — NEVER the operator's default daemon) with the iroh netlayer installed, and drive it.
// Proven by a real two-daemon loopback over iroh QUIC (see endo-peer-redemption.test.mjs).
//
// Boot-safe: @endo/daemon is loaded LAZILY (dynamic import) on first use, so a resolution/SES hiccup can never
// crash the voice-agent at boot — it just makes the peer features report unavailable. The iroh dial has a known
// connection-lifecycle flake ("iroh stream closed" on the 2nd+ op per peer); every remote op is retried.
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const STATE_DIR =
  process.env.ENDO_PEER_STATE || path.join(os.homedir(), '.local', 'state', 'endo-field-peer');
const SOCK = process.env.ENDO_PEER_SOCK || path.join(STATE_DIR, 'peer.sock');

// One lazily-built connection to our sidecar daemon, shared for the process lifetime.
let lib = null; // the dynamically-imported @endo/daemon module + @endo/far E
let hostP = null; // promise of E(host)
let cancelled = null;

const loadLib = async () => {
  if (lib) return lib;
  // Resolve the daemon package + its iroh netlayer module by spec, so this works from any cwd.
  const daemonIndex = await import.meta.resolve('@endo/daemon');
  const daemon = await import(daemonIndex);
  const { E } = await import('@endo/far');
  const irohServicePath = url.fileURLToPath(new URL('src/networks/iroh.js', daemonIndex));
  lib = { daemon, E, irohServicePath };
  return lib;
};

const makeConfig = () => ({
  statePath: path.join(STATE_DIR, 'state'),
  ephemeralStatePath: path.join(STATE_DIR, 'run'),
  cachePath: path.join(STATE_DIR, 'cache'),
  sockPath: SOCK,
  address: '127.0.0.1:0',
  pets: new Map(),
  values: new Map(),
  gcEnabled: true,
});

// Retry a remote op through the known "iroh stream closed" connection-lifecycle race (the daemon re-dials peers
// on demand, so a fresh attempt rides a fresh connection). Only retries that specific transient class.
const TRANSIENT = /iroh stream closed|stream closed|connection .*(closed|reset|lost)|ECONNRESET/i;
const withRetry = async (fn, tries = 4) => {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await fn();
    } catch (err) {
      last = err;
      if (!TRANSIENT.test(String(err && err.message))) throw err;
      // eslint-disable-next-line no-await-in-loop
      await new Promise(r => setTimeout(r, 250 * (i + 1)));
    }
  }
  throw last;
};

// Ensure our dedicated iroh-enabled daemon is running and reachable, returning E(host). Idempotent: connects to
// an already-running sidecar; only start()s one if the connect probe fails; only installs the iroh netlayer if
// the daemon isn't already advertising an iroh+captp0 address.
const ensureHost = async () => {
  if (hostP) return hostP;
  hostP = (async () => {
    const { daemon, E, irohServicePath } = await loadLib();
    const { start, makeEndoClient } = daemon;
    const config = makeConfig();
    if (!cancelled) {
      const { promise } = (await import('@endo/promise-kit')).makePromiseKit();
      cancelled = promise;
      cancelled.catch(() => {});
    }
    const connect = async () => {
      const { getBootstrap, closed } = await makeEndoClient('field-peer', config.sockPath, cancelled);
      closed.catch(() => {});
      return E(getBootstrap()).host();
    };
    let host;
    try {
      host = await connect();
      await E(host).getPeerInfo(); // probe a live, responsive daemon
    } catch {
      await start(config);
      host = await connect();
    }
    // Install the iroh netlayer if it isn't live yet (mirrors setup-iroh.js: makeUnconfined + move to @nets/iroh).
    const info = await E(host).getPeerInfo().catch(() => ({ addresses: [] }));
    const irohLive = (info.addresses || []).some(a => String(a).startsWith('iroh+captp0:'));
    if (!irohLive) {
      const serviceLocation = url.pathToFileURL(irohServicePath).href;
      await E(host).makeUnconfined('@main', serviceLocation, {
        powersName: '@agent',
        resultName: 'iroh-network',
      });
      await E(host).move(['iroh-network'], ['@nets', 'iroh']).catch(() => {}); // tolerate already-present
    }
    return host;
  })().catch(err => {
    hostP = null; // let a later call retry the bring-up
    throw err;
  });
  return hostP;
};

/** Bring the sidecar up and report our peer identity + advertised addresses. */
export const ensurePeerDaemon = async () => {
  const { E } = await loadLib();
  const host = await ensureHost();
  const info = await E(host).getPeerInfo();
  const irohReady = (info.addresses || []).some(a => String(a).startsWith('iroh+captp0:'));
  return { ok: true, node: info.node, addresses: info.addresses || [], irohReady };
};

/** Redeem an Endo daemon invitation. `locator` is the endo://…?type=invitation link; `name` is the pet name
 *  we file the resulting peer under. Returns the peer's node id on success. */
export const acceptInvitation = async (locator, name) => {
  const { E } = await loadLib();
  const host = await ensureHost();
  // Endo invitations are ONE-SHOT (the inviter cancels the formula on the first successful accept). So retry
  // SPARINGLY — a couple of tries to ride a transient connection flake, but not so many that we keep hammering
  // a peer/invite that's genuinely gone. On failure, give an ACTIONABLE message (the cryptic "iroh stream
  // closed" alone reads as a bug; usually it's a spent invite or an offline peer).
  try {
    await withRetry(() => E(host).accept(String(locator), String(name)), 2);
  } catch (e) {
    throw new Error(`couldn't complete the redemption (${e.message}). Endo invitations are ONE-SHOT: if an earlier accept already went through, this invite is spent — ask the peer for a fresh invite. Otherwise the peer may be offline or unreachable right now.`);
  }
  const info = await E(host).getPeerInfo().catch(() => ({}));
  return { ok: true, name: String(name), selfNode: info.node };
};

/** Send a text message to a redeemed peer's inbox (the Endo mailbox model). */
export const sendToPeer = async (name, text) => {
  const { E } = await loadLib();
  const host = await ensureHost();
  await withRetry(() => E(host).send(String(name), [String(text)], [], []));
  return { ok: true };
};

/** Read our inbox (replies/messages from peers), newest-relevant first, capped. */
export const peerInbox = async ({ limit = 20 } = {}) => {
  const { E } = await loadLib();
  const host = await ensureHost();
  const msgs = await withRetry(() => E(host).listMessages());
  const messages = (msgs || []).slice(-limit).map(m => ({
    number: m.number,
    from: m.from,
    type: m.type,
    strings: m.strings || [],
    names: m.names || [],
    date: m.date,
  }));
  return { ok: true, messages };
};

/** List the pet names we've filed peers under (best-effort; remote handles live in the host's namespace). */
export const listPeers = async () => {
  const { E } = await loadLib();
  const host = await ensureHost();
  const names = await withRetry(() => E(host).list()).catch(() => []);
  return { ok: true, peers: names || [] };
};

/** Mint OUR invitation locator to hand to a peer so they can reach us back (bidirectional). */
export const mintInvite = async name => {
  const { E } = await loadLib();
  const host = await ensureHost();
  const invitation = await E(host).invite(String(name));
  const locator = await E(invitation).locate();
  return { ok: true, locator };
};
