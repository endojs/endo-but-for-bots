// @ts-check

/**
 * The daemon's OCapN identity singleton (design cut 4, the `ocapn` formula;
 * see designs/sturdy-refs-cross-peer-bridge.md § "The daemon's OCapN identity
 * and self-location").
 *
 * The `ocapn` formula holds the daemon's OCapN identity: a distinct Ed25519
 * keypair generated at formulation and persisted in daemon key/value state, so
 * the identity is stable across restarts (a sturdy reference minted against it
 * still resolves). From that keypair the daemon derives its self peer-locator
 * (`designator` from the public key, `transport` from the configured netlayer),
 * and builds its OCapN client's SturdyRef EXPORT surface (the cut-3 exporter)
 * over the real self-location, replacing the placeholder location cut 3
 * stamped into mints.
 *
 * Two provisional defaults settle the design's cut-4 open questions until the
 * maintainer rules (both reversible; recorded in the PR description):
 *
 * - **Distinct-by-default identity.** The keypair here is freshly generated and
 *   never derived from the daemon's `endo://` node key. Reusing the node key
 *   would make the daemon's OCapN world and Endo-gateway world correlatable by
 *   key, an identification leak; a distinct identity costs only a second key to
 *   back up.
 * - **No production netlayer armed by default.** The daemon arms no live OCapN
 *   listener or dialer at this cut, so the default self-location advertises the
 *   neutral, non-dialable transport marker below rather than a production
 *   netlayer. Tests supply the `tcp-testing-only` transport explicitly to prove
 *   a real netlayer transport round-trips. Live dialing and serving arrive with
 *   foreign internalization (cut 5) and the three-party round-trip (cut 6).
 *
 * The identity value is closely held: the `ocapn` formula is a daemon
 * singleton reached only from daemon core, never vended through a host or guest
 * facet, so no worker or guest can reach the OCapN capability or a netlayer
 * handle (the no-location confinement invariant).
 */

/** @import { FormulaIdentifier, OcapnIdentity, SturdyRefStore } from './types.js' */
/** @import { OcapnLocation } from '@endo/ocapn' */

import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeSturdyRefExporter } from './sturdyref-store.js';

/**
 * The transport marker for a daemon that has armed no live OCapN netlayer (the
 * provisional cut-4 default). A self-location carrying this transport is not
 * dialable by a foreign peer; it names an identity without advertising a wire
 * endpoint. Distinct from any real netlayer transport (`tcp-testing-only`,
 * `websocket`) precisely so an unarmed daemon is never mistaken for a serving
 * one.
 */
export const UNARMED_OCAPN_TRANSPORT = 'ocapn-unarmed';

const HEX_BYTE = /[0-9a-fA-F]{2}/g;

/**
 * Decode a hex string (a `randomHex256` product, or a persisted private key)
 * into its bytes.
 *
 * @param {string} hex
 * @returns {Uint8Array}
 */
const bytesFromHex = hex => {
  const pairs = hex.match(HEX_BYTE) ?? [];
  const bytes = new Uint8Array(pairs.length);
  for (let index = 0; index < pairs.length; index += 1) {
    bytes[index] = parseInt(pairs[index], 16);
  }
  return bytes;
};

// The base32 alphabet OCapN peer-locator designators are encoded in, kept in
// sync with the websocket netlayer's own designator encoding
// (packages/ocapn/src/netlayers/websocket.js): a designator IS the peer's raw
// public key, base32-encoded, so a dialer can recover the key from the
// locator to verify the location signature.
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Base32-encode raw bytes into a peer-locator designator, matching the
 * websocket netlayer's `base32Encode`.
 *
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const base32Encode = bytes => {
  let value = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    value = value * 256 + byte;
    bits += 8;
    while (bits >= 5) {
      const divisor = 2 ** (bits - 5);
      const index = Math.floor(value / divisor);
      output += BASE32_ALPHABET[index];
      value -= index * divisor;
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[value * 2 ** (5 - bits)];
  }
  return output;
};

/**
 * Build the daemon's OCapN identity over a persistent keypair and a swiss-num
 * store. Generates (or loads) a distinct Ed25519 private key, derives the self
 * peer-locator, and constructs the SturdyRef exporter against that real
 * self-location.
 *
 * @param {object} powers
 * @param {(key: string) => string | undefined} powers.getState
 * @param {(key: string, value: string) => void} powers.setState
 * @param {string} powers.stateKey - where the identity's private key persists
 *   (the `ocapn` formula's number keys it), so the identity is stable across
 *   restarts.
 * @param {() => Promise<string>} powers.randomHex256 - the daemon's
 *   fresh-256-bit source, used both to generate the private key and (through
 *   the exporter) to draw swiss-nums.
 * @param {SturdyRefStore} powers.store - the daemon's swiss-num store, the
 *   read side the exporter's locator dials.
 * @param {(id: FormulaIdentifier) => Promise<unknown>} powers.provide - the
 *   daemon-core `provide`, turning a formula identifier into its value.
 * @param {string} [powers.transport] - the transport the self peer-locator
 *   advertises; defaults to the unarmed marker (no live netlayer). Tests pass
 *   a real netlayer transport (`tcp-testing-only`).
 * @returns {Promise<OcapnIdentity>}
 */
export const makeOcapnIdentity = async ({
  getState,
  setState,
  stateKey,
  randomHex256,
  store,
  provide,
  transport = UNARMED_OCAPN_TRANSPORT,
}) => {
  // Load-or-generate the daemon's distinct OCapN private key. A fresh key,
  // never the `endo://` node key: distinct-by-default (design open question,
  // provisional). Persisted so the identity survives restart.
  await null;
  const persisted = getState(stateKey);
  /** @type {string} */
  let privateKeyHex;
  if (persisted === undefined) {
    privateKeyHex = await randomHex256();
    setState(stateKey, JSON.stringify({ privateKeyHex }));
  } else {
    privateKeyHex = JSON.parse(persisted).privateKeyHex;
  }

  const cryptography = makeCryptography(syrupCodec);
  const keyPair = cryptography.makeOcapnKeyPairFromPrivateKey(
    bytesFromHex(privateKeyHex),
  );
  const publicKeyBytes = bytesFromImmutable(keyPair.publicKey.bytes);
  const designator = base32Encode(publicKeyBytes);

  /** @type {OcapnLocation} */
  const selfLocation = harden({
    type: 'ocapn-peer',
    designator,
    transport,
    hints: false,
  });

  // The daemon's OCapN client EXPORT surface (the cut-3 exporter), now built
  // over the real self-location so a self-minted SturdyRef reveals and enlivens
  // against the daemon's own identity rather than a placeholder.
  const exporter = makeSturdyRefExporter({
    store,
    randomHex256,
    selfLocation,
    provide,
  });

  return harden({
    getSelfLocation: () => selfLocation,
    exporter,
  });
};
harden(makeOcapnIdentity);
