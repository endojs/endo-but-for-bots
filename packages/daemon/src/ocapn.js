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
import { bytesFromText } from '@endo/bytes/from-string.js';
import { makeCryptography } from '@endo/ocapn/cryptography';
import { syrupCodec } from '@endo/ocapn/syrup';
import { makeOcapn, parseSturdyRefUri, formatSturdyRefUri } from '@endo/ocapn';
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
 * @param {any} [powers.makeNetwork] - the
 *   netlayer factory the daemon's OCapN client dials and serves through (cut
 *   5). When omitted the daemon is UNARMED: it holds an identity and can mint,
 *   but `provideSession`/`enliven` reject, so foreign internalization has no
 *   dial path (the provisional cut-4 default; production arming is the
 *   maintainer's cut-5 open question). Tests inject a `tcp-test-only`
 *   netlayer factory to prove the real dial+fetch path.
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
  makeNetwork = undefined,
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

  // The daemon's OCapN CLIENT (the dial+serve surface, cut 5): built only when
  // a netlayer is armed. Its `locator` is the swiss-num store's read side, so
  // the SAME store that `provideSturdyRef` writes to also serves a foreign
  // peer's `bootstrap.fetch` over a real session (the daemon as C), while the
  // client's `provideSession`/`enlivenSturdyRef` give the daemon-as-B dial
  // path foreign internalization needs. An unarmed daemon has no client.
  /** @type {any} */
  let client;
  if (makeNetwork !== undefined) {
    client = await makeOcapn({
      codec: syrupCodec,
      network: makeNetwork,
      locator: exporter.locator,
      debugLabel: `daemon-ocapn:${designator}`,
    });
  }

  /**
   * The closely-held reveal spanning both trackers: the exporter's (self-mints
   * and URI-materialized foreign refs) and, when armed, the client's session
   * manager (refs materialized from a live peer session). Answers `undefined`
   * for a forged look-alike or a mint from an instance this daemon never
   * talked to — the seam turns that into its rejection.
   *
   * @param {unknown} sturdyRef
   */
  const reveal = sturdyRef => {
    const details =
      exporter.reveal(/** @type {any} */ (sturdyRef)) ??
      (client === undefined
        ? undefined
        : client.reveal(/** @type {any} */ (sturdyRef)));
    if (details === undefined) {
      return undefined;
    }
    // Normalize the swiss-num to `string | Uint8Array`. A wire- or
    // URI-materialized SturdyRef holds its secret as an immutable-bytes
    // `SwissNum` (the OCapN branded type); downstream dedup hashing, formula
    // encoding, and re-fetch all speak plain `string | Uint8Array`, so convert
    // once here rather than teaching every consumer the branded shape.
    const { location, secret } = details;
    const normalized =
      typeof secret === 'string' || secret instanceof Uint8Array
        ? secret
        : bytesFromImmutable(secret);
    return harden({ location, secret: normalized });
  };

  /**
   * Dial a foreign peer and fetch by swiss-num — the value an `ocapn-sturdyref`
   * formula enlivens to (cut 5). Materialize-then-enliven reuses the client's
   * tested `(location, secret)` encoding and per-SturdyRef memo; a fresh
   * materialization each call is fine, the memo keys on value convergence.
   * Rejects secret-free when unarmed.
   *
   * @param {OcapnLocation} location
   * @param {string | Uint8Array} swissNum
   * @returns {Promise<unknown>}
   */
  const enliven = async (location, swissNum) => {
    if (client === undefined) {
      throw Error(
        'ocapn: no netlayer armed; this daemon cannot dial a foreign peer',
      );
    }
    const foreignRef = client.makeSturdyRef(location, swissNum);
    return client.enlivenSturdyRef(foreignRef);
  };

  /**
   * Provide (or reuse) the live session to a foreign peer — the value an
   * `ocapn-peer` formula holds (cut 5). Rejects secret-free when unarmed.
   *
   * @param {OcapnLocation} location
   */
  const provideSession = async location => {
    if (client === undefined) {
      throw Error(
        'ocapn: no netlayer armed; this daemon cannot dial a foreign peer',
      );
    }
    return client.provideSession(location);
  };

  return harden({
    getSelfLocation: () => selfLocation,
    exporter,
    isArmed: client !== undefined,
    reveal,
    enliven,
    provideSession,
    /**
     * Materialize a foreign SturdyRef from an out-of-band `ocapn://` URI
     * (design cut 5, `acceptSturdyRefUri`). Parses the URI, materializes the
     * `(location, swissNum)` through the exporter's tracker so `reveal`
     * answers, and returns the SturdyRef the seam then internalizes. The URI
     * string is secret-bearing; it is consumed here and never logged.
     *
     * @param {string} uri
     * @returns {import('@endo/pass-style').SturdyRef}
     */
    materializeFromUri: uri => {
      const { location, swissNum, kind } = parseSturdyRefUri(uri);
      if (kind !== 'sturdyref' || swissNum === undefined) {
        throw Error('ocapn: URI is a plain peer locator, not a sturdyref URI');
      }
      // The URI codec yields the swiss-num as an immutable-bytes `SwissNum`;
      // materialize (and the whole seam) speaks plain bytes.
      return exporter.materialize(location, bytesFromImmutable(swissNum));
    },
    /**
     * Format an `ocapn://` sturdyref URI for a self-minted SturdyRef (design
     * cut 5, the deliberate out-of-band export side). Reveals the SturdyRef's
     * off-band `(location, swissNum)` and renders it; rejects a SturdyRef this
     * daemon cannot reveal.
     *
     * @param {import('@endo/pass-style').SturdyRef} sturdyRef
     * @returns {string}
     */
    formatUri: sturdyRef => {
      const details = reveal(sturdyRef);
      if (details === undefined) {
        throw Error('ocapn: cannot format a URI for an unrevealable sturdyref');
      }
      // The URI carries the swiss-num as base64url bytes. A daemon self-mint's
      // secret is an ASCII hex string; encode its bytes so a peer parsing the
      // URI recovers those bytes and — via ASCII decode in the tracker's
      // `lookup` — the same hex string the exporter's locator keys on. A raw
      // byte secret (a foreign implementation's) rides through verbatim.
      const { location, secret } = details;
      const swissNum =
        typeof secret === 'string' ? bytesFromText(secret) : secret;
      return formatSturdyRefUri({ location, swissNum });
    },
    /**
     * Tear down the daemon's OCapN client and its armed netlayer, closing the
     * listening server and every live peer connection. A no-op for an unarmed
     * identity (no client, so nothing to close). The daemon calls this when the
     * `ocapn` formula's context is cancelled; a test that arms a real netlayer
     * calls it to release the TCP listener so the process can exit.
     */
    shutdown: () => {
      if (client !== undefined) {
        client.shutdown();
      }
    },
  });
};
harden(makeOcapnIdentity);
