// Boot the full Endo Pet Daemon with the OCapN-Noise transport installed at
// `@nets/ocapn`, listening for daemon-to-daemon peer connections over a
// loopback WebSocket port.
//
// This is the container entrypoint. Unlike the standalone `ocapn-ws-server.mjs`
// demo (which stands up only the `@endo/ocapn` session layer), this boots the
// real `@endo/daemon`: the pet store, agent, gateway, and lifecycle, then
// installs `src/networks/ocapn.js` exactly as `test/_multiplayer-suite.js`
// does — `storeValue(<host:port>, 'ws-listen-addr')` to gate the WS transport,
// `makeUnconfined` the network module, and `move` it to `@nets/ocapn`. The
// daemon then publishes its `EndoOcapnBootstrap` at swissnum `endo-bootstrap`
// and advertises an `ocapn+noise+ws://…?loc=…` address. We extract that
// address's `loc` (the OCapN location: designator + `ws:url` hint) and write it
// as JSON so a peer can dial the bootstrap over `wss://` through Caddy.
//
// Env knobs (all optional; defaults suit the minion.town container):
//   ENDO_STATE_PATH / ENDO_EPHEMERAL_STATE_PATH / ENDO_SOCK_PATH /
//   ENDO_CACHE_PATH        daemon data + control-socket paths (default /data/*)
//   ENDO_ADDR              daemon CapTP control address   (default 127.0.0.1:8920)
//   OCAPN_WS_LISTEN        WS listen host:port            (default 0.0.0.0:8930)
//   OCAPN_LOCATION_OUT     where to write the location    (default /data/ocapn-daemon-location.json)
import '@endo/init';
import fs from 'node:fs';
import path from 'node:path';
import { E } from '@endo/far';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, makeEndoClient } from '../index.js';

const dataDir = process.env.ENDO_DATA_DIR || '/data';
const config = {
  statePath: process.env.ENDO_STATE_PATH || path.join(dataDir, 'state'),
  ephemeralStatePath:
    process.env.ENDO_EPHEMERAL_STATE_PATH || path.join(dataDir, 'run'),
  sockPath: process.env.ENDO_SOCK_PATH || path.join(dataDir, 'endo.sock'),
  cachePath: process.env.ENDO_CACHE_PATH || path.join(dataDir, 'cache'),
  address: process.env.ENDO_ADDR || '127.0.0.1:8920',
};

const wsListen = process.env.OCAPN_WS_LISTEN || '0.0.0.0:8930';
const locationOut =
  process.env.OCAPN_LOCATION_OUT ||
  path.join(dataDir, 'ocapn-daemon-location.json');

// Ensure the data dir exists (the image ships no `RUN mkdir`; a mounted volume
// creates it, but an unmounted run or a custom ENDO_DATA_DIR may not).
fs.mkdirSync(dataDir, { recursive: true });

// This module lives inside the daemon package, so its OCapN network module is
// resolved by file URL exactly as the multiplayer suite resolves it.
const ocapnModuleUrl = new URL(
  '../src/networks/ocapn.js',
  import.meta.url,
).href;

const log = (...args) => console.error('[boot]', ...args);

const { promise: cancelled, reject: cancel } = makePromiseKit();
cancelled.catch(() => {});

log(`starting daemon; state=${config.statePath} sock=${config.sockPath}`);
await start(config);

const { getBootstrap, closed } = await makeEndoClient(
  'ocapn-boot',
  config.sockPath,
  cancelled,
);
closed.catch(() => {});
const bootstrap = getBootstrap();
const host = E(bootstrap).host();

// Gate the WS transport on `ws-listen-addr` and install the OCapN-Noise
// network module as `@nets/ocapn`, mirroring `prepareHostWithGcAndNetwork`.
log(`installing @nets/ocapn with ws-listen-addr=${wsListen}`);
await E(host).storeValue(wsListen, 'ws-listen-addr');
const service = await E(host).makeUnconfined('@main', ocapnModuleUrl, {
  powersName: '@agent',
  resultName: 'network-service-ocapn',
});
await E(host).move(['network-service-ocapn'], ['@nets', 'ocapn']);

// Extract the daemon's advertised OCapN-Noise-WS address and unpack its `loc`
// (the location the peer needs: designator + `ws:url` hint). `makeUnconfined`
// returns the installed `OcapnNoiseService` directly, so we call `addresses()`
// on it rather than re-looking it up (`host.lookup` takes a single path array).
const addresses = /** @type {string[]} */ (await E(service).addresses());
const wsAddress = addresses.find(a => a.startsWith('ocapn+noise+ws:'));
if (!wsAddress) {
  throw new Error(
    `no ocapn+noise+ws address advertised; got ${JSON.stringify(addresses)}`,
  );
}
const parsed = new URL(wsAddress);
const locParam = parsed.searchParams.get('loc');
if (!locParam) {
  throw new Error(`advertised address has no loc param: ${wsAddress}`);
}
const location = JSON.parse(locParam);
fs.writeFileSync(locationOut, `${JSON.stringify(location, null, 2)}\n`);

log(`@nets/ocapn installed; bootstrap swissnum=endo-bootstrap`);
log(`advertised address = ${wsAddress}`);
log(`location written to ${locationOut}`);
log(`location = ${JSON.stringify(location)}`);
log('daemon is up; holding container alive (SIGTERM to stop cleanly)');

// PID 1 must stay alive: `start()` forks a detached daemon child and unrefs it,
// so if this process exits the container stops and takes the daemon with it.
let shuttingDown = false;
const shutdown = async signal => {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`received ${signal}; stopping daemon`);
  cancel(new Error(`shutdown on ${signal}`));
  try {
    await stop(config);
  } catch (err) {
    log(`stop failed: ${err && err.message}`);
  }
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await new Promise(() => {});
