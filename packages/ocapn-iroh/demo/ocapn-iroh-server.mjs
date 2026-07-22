// A standalone OCapN-over-iroh (CBOR/QUIC) validation listener.
//
//   node packages/ocapn-iroh/demo/ocapn-iroh-server.mjs [location-out.json]
//
// It stands up a single `@endo/ocapn` instance over the iroh netlayer
// (`@endo/ocapn-iroh`), publishing the box's stable iroh `EndpointId` as
// the OCapN designator and serving one demo bootstrap object (`Greeter`).
// This is the server half of the `ocapn-cbor-quic-iroh` validation lane
// described in minion.town's `designs/ocapn-iroh-validation-lane.md`
// (Gate 2): the boot entry the `endo-ocapn-iroh.service` systemd unit runs.
//
// Why iroh and not a `wss://` URL: iroh dials by key, not by IP. The
// listener maintains an *outbound* connection to iroh's relay/discovery
// mesh, so a remote peer reaches it by dialing the published EndpointId —
// no inbound port and no Caddy route are required. That is the property
// the lane exists to validate (design § 1.1).
//
// Contrast the two Noise-over-WebSocket lanes already on the box
// (`deploy/aws/daemon/`): those bind a loopback TCP port and are fronted
// by Caddy on 443. This lane deliberately has neither.

// Real SES: `@endo/ocapn`'s CapTP layer hands out `Far` references and
// resolves remote SturdyRefs through eventual-send, both of which need the
// genuine `harden`/`HandledPromise` that `@endo/init` installs. Load it
// before anything that touches the object graph.
import '@endo/init';

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

import { Far } from '@endo/marshal';
import { makeOcapn } from '@endo/ocapn';
import { cborCodec } from '@endo/ocapn/cbor';

import { makeIrohNetLayer } from '../index.js';

/* global process, console */

/**
 * Load a persistent 32-byte iroh secret key, generating and persisting one
 * on first run. Persistence is what keeps the `EndpointId` — and therefore
 * the OCapN designator a dialer was told out-of-band — stable across
 * restarts; a fresh key each boot would strand every published reference.
 *
 * The key is stored as 64 hex characters (human-inspectable, editor-safe)
 * with `0600` permissions, since it is the endpoint's private identity.
 *
 * @param {string | undefined} keyFile - Path from `ENDO_IROH_SECRET_KEY_FILE`.
 * @returns {Uint8Array} the 32-byte secret.
 */
const loadOrCreateSecretKey = keyFile => {
  if (!keyFile) {
    // No persistence configured: a random per-run key. Fine for a
    // throwaway same-host test, wrong for the box lane (the designator
    // would churn on every restart), so warn loudly.
    console.error(
      'ocapn-iroh-server: ENDO_IROH_SECRET_KEY_FILE is unset — using an ' +
        'ephemeral key; the EndpointId will change on every restart.',
    );
    return new Uint8Array(randomBytes(32));
  }
  if (existsSync(keyFile)) {
    const hex = readFileSync(keyFile, 'utf8').trim();
    const bytes = Uint8Array.from(Buffer.from(hex, 'hex'));
    if (bytes.length !== 32) {
      throw new Error(
        `ocapn-iroh-server: ${keyFile} must hold 32 bytes (64 hex chars), got ${bytes.length}`,
      );
    }
    return bytes;
  }
  const bytes = new Uint8Array(randomBytes(32));
  // `0600`: the secret is the endpoint's private identity.
  writeFileSync(keyFile, Buffer.from(bytes).toString('hex'), { mode: 0o600 });
  console.error(`ocapn-iroh-server: generated a new secret key at ${keyFile}`);
  return bytes;
};

const secretKey = loadOrCreateSecretKey(process.env.ENDO_IROH_SECRET_KEY_FILE);

// Same-host validation runs (Gate 5 driven from a peer on the box) need the
// loopback/private direct addresses published as dialing hints so the dial
// does not wait on discovery. For the real box lane, leave this off: private
// hints are useless to a remote dialer, and honoring third-party-supplied
// private hints is an SSRF-style vector (see the netlayer's option docs).
const publishPrivateAddresses = process.env.ENDO_IROH_PUBLISH_PRIVATE === '1';

// The demo bootstrap object a remote peer enlivens after dialing our
// designator. Mirrors the netlayer integration test's `Greeter` so the two
// exercise the same capability shape.
const greeter = Far('Greeter', {
  hello: (who = 'world') => `hello, ${who}`,
});

const locator = new Map();
locator.set('Greeter', greeter);

// `makeOcapn` accepts an async network factory and awaits it; we use the
// factory closure to capture the built netlayer so we can read its computed
// location (designator + hints) after the endpoint binds.
let netlayer;
const client = await makeOcapn({
  codec: cborCodec,
  network: (handlers, logger) =>
    makeIrohNetLayer({
      handlers,
      logger,
      secretKey,
      publishPrivateAddresses,
    }).then(built => {
      netlayer = built;
      return built;
    }),
  locator,
  debugLabel: 'ocapn-iroh-server',
});

if (!netlayer) {
  throw new Error('ocapn-iroh-server: netlayer failed to initialize');
}

// The published designator: an opaque iroh EndpointId, not a URL. A dialer
// must be handed this out-of-band (recorded in the deploy record and,
// optionally, emitted to a location file below).
const { location } = netlayer;
const locationJson = `${JSON.stringify(location, null, 2)}\n`;

// Emit the location to a file when asked (argv or ENDO_IROH_LOCATION_FILE),
// mirroring the Noise demo's `ocapn-demo-location.json`, and always print it.
const locationFile = process.argv[2] || process.env.ENDO_IROH_LOCATION_FILE;
if (locationFile) {
  writeFileSync(locationFile, locationJson);
  console.error(`ocapn-iroh-server: wrote location to ${locationFile}`);
}

console.log(locationJson);
console.error(
  `ocapn-iroh-server: serving 'Greeter' as designator ${location.designator}; ` +
    'dial this EndpointId from an off-box peer to validate the lane.',
);

// Keep serving. `makeOcapn` holds the iroh endpoint (and its accept loop)
// open, so the process stays alive; shut the endpoint down cleanly on a
// termination signal so the persisted key and mesh registration are released.
const shutdown = signal => {
  console.error(`ocapn-iroh-server: ${signal} — shutting down`);
  try {
    client.shutdown();
  } finally {
    process.exit(0);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
