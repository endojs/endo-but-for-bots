// @ts-check

/**
 * @file Relay-policy data model for the public CapTP relay (design
 *   Feature 6).
 *
 * Phase 4 landed the routing core: the `OcapnWebSocketHandler` reads
 * the first frame, extracts the 32-byte intended-responder Ed25519
 * public key from the prefixed-SYN's cleartext prefix, looks up the
 * registration that owns the key, and hands the byte stream off to
 * the registered daemon's `handleOcapnSession`. Phase 5 layers an
 * **inbound-session policy** on top: a `registerRelay` entry carries
 * a `relayPolicy` (`'closed'` by default, `'open'` opt-in) plus a
 * per-registration allowlist of caller public keys. For
 * `closed`-policy relay registrations, an inbound session whose
 * dialer's public key is not in the allowlist is dropped.
 *
 * This module owns the policy data structure and the admission
 * predicate; the bootstrap module wires it into the registration
 * table, the admin module surfaces management operations, and the
 * OCapN-WS handler consults it before handing off.
 *
 * ### Caller-identification under Noise IK
 *
 * The OCapN-Noise wire shape ([`packages/ocapn-noise/README.md`](../../ocapn-noise/README.md))
 * uses Noise IK. Message 1 of IK is a 132-byte payload that contains
 * the dialer's static public key **encrypted under the responder's
 * static** (identity hiding, Noise §7.8 property 8). The gateway
 * peeks at exactly one cleartext byte range (the 32-byte
 * intended-responder prefix that precedes the Noise IK message) and
 * otherwise forwards ciphertext blobs without inspecting them. The
 * gateway therefore **cannot read the dialer's public key from the
 * first frame** under Noise IK; that information is opaque until the
 * responder completes the handshake.
 *
 * The policy module supports caller-public-key allowlist semantics
 * as a data model so the registrant-side and admin-side surfaces are
 * complete, and so a future Noise variant (or a pre-handshake
 * extension that carries a cleartext caller-identity hint) can be
 * wired in by supplying an `extractDialerPublicKey` adapter to the
 * `OcapnWebSocketHandler`. Under today's Noise IK with no such
 * adapter, a `closed`-policy relay registration drops every inbound
 * session and surfaces the gap via a diagnostic log; the gateway
 * fails closed rather than silently relaying without authorization.
 *
 * The alternative we considered and rejected was to interpret
 * "closed-allowlist" as "the intended-responder registration is
 * itself the allowlist" (Phase 4 already gates by registration
 * lookup). That reading lets every inbound session for a registered
 * relay target through, which is the `'open'` policy in this
 * module's vocabulary; it leaves no room for a registrant to
 * say "only these specific peers may dial my relay target." We
 * preserve the data structure for the future-facing case and
 * document the today-facing gap rather than silently flattening.
 */

import { makeError, q, X } from '@endo/errors';
import { bytesFromImmutable } from '@endo/bytes/from-immutable.js';

/**
 * Default policy applied to `registerRelay` entries that do not
 * pass an explicit `relayPolicy` field. Closed-by-default matches
 * the design's *"The first implementation lands closed-allowlist
 * (registration-required) by default; public-relay configuration is
 * an explicit opt-in by the operator"* directive (Feature 6).
 *
 * Operators who want any-dialer relay (the design's `open` policy)
 * opt in per registration. There is no gateway-wide override; each
 * relay-target registration chooses its own policy.
 */
export const DEFAULT_RELAY_POLICY = 'closed';
harden(DEFAULT_RELAY_POLICY);

/**
 * The two recognized policy values. Kept as a constant set so the
 * validator can produce a helpful "got X, expected closed|open"
 * message and so a future third value (a hypothetical
 * `'rate-limited'` between closed and open) can land without a wide
 * grep.
 */
export const RELAY_POLICIES = harden(['closed', 'open']);

/**
 * @typedef {'closed' | 'open'} RelayPolicy The two recognized policy
 *   values. `'closed'` requires the dialer's public key to be in
 *   the registration's allowlist before the gateway forwards the
 *   session; `'open'` accepts any dialer that the gateway's outer
 *   filters (rate limits, CIDR allowlists) admit.
 */

/**
 * @typedef {object} RelayPolicyEntry The per-registration policy
 *   record. Stored on the bootstrap's `RegistrationEntry` under a
 *   property named `policy`; the bootstrap creates one of these on
 *   `registerRelay` and updates it via the registrant-side and
 *   admin-side mutators.
 * @property {RelayPolicy} policy The current policy. Default is
 *   `'closed'` (per {@link DEFAULT_RELAY_POLICY}).
 * @property {Set<string>} callerAllowlist The set of dialer public
 *   keys (hex-encoded, lowercase, 64 chars each) currently allowed
 *   to dial this relay under the closed policy. Adding the same
 *   key twice is a no-op; removing a key that is not in the set is
 *   also a no-op. The set is empty by default; a closed-policy
 *   registration with an empty allowlist accepts no dialers.
 */

/**
 * @typedef {object} RelayAdmissionInput The shape passed to
 *   {@link isInboundSessionAllowed}. The handler injects whatever
 *   it can read from the prefixed-SYN; under Noise IK today, the
 *   dialer's public key is opaque so the field is `undefined`.
 * @property {RelayPolicyEntry} policy The registration's policy
 *   record.
 * @property {ArrayBuffer | Uint8Array | undefined} dialerPublicKey
 *   The dialer's 32-byte Ed25519 public key when an
 *   `extractDialerPublicKey` adapter supplied it, `undefined`
 *   otherwise. `undefined` is the today-case under Noise IK; the
 *   adapter is the future-extension hook for a pre-handshake
 *   carrier of caller identity.
 */

/**
 * Validate a `RelayPolicy` candidate. Throws on anything other than
 * `'closed'` or `'open'`. Used by the bootstrap's `registerRelay`
 * and `setRelayPolicy` validators, and by the admin facet's
 * `setRelayPolicy` validator.
 *
 * @param {unknown} candidate
 * @returns {RelayPolicy}
 */
export const checkRelayPolicy = candidate => {
  if (candidate !== 'closed' && candidate !== 'open') {
    throw makeError(
      X`relayPolicy must be "closed" or "open", got ${q(candidate)}`,
    );
  }
  return /** @type {RelayPolicy} */ (candidate);
};
harden(checkRelayPolicy);

/**
 * Render a 32-byte Ed25519 public key as lowercase hex; matches the
 * encoding used by the bootstrap's `publicKeyToHex` so the policy
 * module's set-keying interoperates with the bootstrap's lookup
 * table. Accepts either an immutable `ArrayBuffer` (wire shape) or
 * a `Uint8Array` (internal use).
 *
 * @param {ArrayBuffer | Uint8Array} bytes
 * @returns {string}
 */
export const publicKeyToHex = bytes => {
  const view = bytes instanceof Uint8Array ? bytes : bytesFromImmutable(bytes);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
};
harden(publicKeyToHex);

/**
 * Build a fresh policy record for a new relay registration. The
 * caller-supplied `relayPolicy` (when present) wins over the
 * default; an `undefined` value falls back to {@link DEFAULT_RELAY_POLICY}.
 *
 * The set is initialized empty even for `open` policies; a future
 * caller-allowlist seeding step lands on the registrant-side path
 * (`Registration.addCallerPublicKey`) rather than at registration
 * time, so the registrar wire shape stays compact.
 *
 * @param {RelayPolicy} [policy]
 * @returns {RelayPolicyEntry}
 */
export const makeRelayPolicyEntry = policy => {
  const resolved = policy === undefined ? DEFAULT_RELAY_POLICY : policy;
  return {
    policy: checkRelayPolicy(resolved),
    callerAllowlist: new Set(),
  };
};
harden(makeRelayPolicyEntry);

/**
 * Decide whether to admit an inbound relay session under the policy
 * recorded on the matched registration. Returns a `{ allowed,
 * reason }` shape so the handler can log a precise diagnostic on
 * the close path; the reason is part of the contract (tests assert
 * on it).
 *
 * The decision matrix:
 *
 *   policy=open                                  -> allow
 *   policy=closed, dialerPublicKey undefined     -> deny
 *     (under Noise IK the gateway cannot identify the caller;
 *      closed-policy fails closed rather than silently relaying)
 *   policy=closed, dialerPublicKey in allowlist  -> allow
 *   policy=closed, dialerPublicKey not in allowlist -> deny
 *
 * @param {RelayAdmissionInput} input
 * @returns {{ allowed: boolean, reason: string }}
 */
export const isInboundSessionAllowed = input => {
  if (input === null || typeof input !== 'object') {
    throw makeError(X`isInboundSessionAllowed expects an input object`);
  }
  const { policy: entry, dialerPublicKey } = input;
  if (entry === null || typeof entry !== 'object') {
    throw makeError(X`isInboundSessionAllowed expects a policy entry`);
  }
  if (entry.policy === 'open') {
    return harden({ allowed: true, reason: 'open-policy' });
  }
  // Closed policy from here on.
  if (dialerPublicKey === undefined) {
    return harden({
      allowed: false,
      reason: 'closed-policy-no-dialer-identification',
    });
  }
  if (
    !(dialerPublicKey instanceof ArrayBuffer) &&
    !(dialerPublicKey instanceof Uint8Array)
  ) {
    return harden({
      allowed: false,
      reason: 'closed-policy-malformed-dialer-key',
    });
  }
  const length =
    dialerPublicKey instanceof Uint8Array
      ? dialerPublicKey.length
      : dialerPublicKey.byteLength;
  if (length !== 32) {
    return harden({
      allowed: false,
      reason: 'closed-policy-wrong-length-dialer-key',
    });
  }
  const hex = publicKeyToHex(dialerPublicKey);
  if (entry.callerAllowlist.has(hex)) {
    return harden({ allowed: true, reason: 'closed-policy-allowlist-hit' });
  }
  return harden({ allowed: false, reason: 'closed-policy-allowlist-miss' });
};
harden(isInboundSessionAllowed);

/**
 * Add a caller public key to a policy entry's allowlist. Returns
 * `true` if the key was newly added, `false` if it was already
 * present. Idempotent.
 *
 * @param {RelayPolicyEntry} entry
 * @param {ArrayBuffer | Uint8Array} callerPublicKey
 * @returns {boolean}
 */
export const addCallerPublicKey = (entry, callerPublicKey) => {
  if (entry === null || typeof entry !== 'object') {
    throw makeError(X`addCallerPublicKey expects a policy entry`);
  }
  if (
    !(callerPublicKey instanceof ArrayBuffer) &&
    !(callerPublicKey instanceof Uint8Array)
  ) {
    throw makeError(
      X`callerPublicKey must be an immutable ArrayBuffer or Uint8Array`,
    );
  }
  const length =
    callerPublicKey instanceof Uint8Array
      ? callerPublicKey.length
      : callerPublicKey.byteLength;
  if (length !== 32) {
    throw makeError(X`callerPublicKey must be 32 bytes, got ${q(length)}`);
  }
  const hex = publicKeyToHex(callerPublicKey);
  if (entry.callerAllowlist.has(hex)) {
    return false;
  }
  entry.callerAllowlist.add(hex);
  return true;
};
harden(addCallerPublicKey);

/**
 * Remove a caller public key from a policy entry's allowlist.
 * Returns `true` if the key was present and removed, `false`
 * otherwise. Idempotent.
 *
 * @param {RelayPolicyEntry} entry
 * @param {ArrayBuffer | Uint8Array} callerPublicKey
 * @returns {boolean}
 */
export const removeCallerPublicKey = (entry, callerPublicKey) => {
  if (entry === null || typeof entry !== 'object') {
    throw makeError(X`removeCallerPublicKey expects a policy entry`);
  }
  if (
    !(callerPublicKey instanceof ArrayBuffer) &&
    !(callerPublicKey instanceof Uint8Array)
  ) {
    throw makeError(
      X`callerPublicKey must be an immutable ArrayBuffer or Uint8Array`,
    );
  }
  const length =
    callerPublicKey instanceof Uint8Array
      ? callerPublicKey.length
      : callerPublicKey.byteLength;
  if (length !== 32) {
    throw makeError(X`callerPublicKey must be 32 bytes, got ${q(length)}`);
  }
  const hex = publicKeyToHex(callerPublicKey);
  if (!entry.callerAllowlist.has(hex)) {
    return false;
  }
  entry.callerAllowlist.delete(hex);
  return true;
};
harden(removeCallerPublicKey);

/**
 * Snapshot the caller-allowlist on a policy entry, sorted for
 * stable iteration order in tests and admin dumps.
 *
 * @param {RelayPolicyEntry} entry
 * @returns {ReadonlyArray<string>}
 */
export const listCallerAllowlist = entry => {
  if (entry === null || typeof entry !== 'object') {
    throw makeError(X`listCallerAllowlist expects a policy entry`);
  }
  return harden([...entry.callerAllowlist].sort());
};
harden(listCallerAllowlist);

/**
 * Mutate the policy on an entry. Returns the previous policy so
 * the caller can detect a no-op transition. The allowlist is
 * preserved across the transition (open->closed retains whatever
 * the registrant had seeded, closed->open keeps it for if-and-when
 * the registrant flips back).
 *
 * @param {RelayPolicyEntry} entry
 * @param {RelayPolicy} policy
 * @returns {RelayPolicy}
 */
export const setRelayPolicy = (entry, policy) => {
  if (entry === null || typeof entry !== 'object') {
    throw makeError(X`setRelayPolicy expects a policy entry`);
  }
  const next = checkRelayPolicy(policy);
  const prev = entry.policy;
  entry.policy = next;
  return prev;
};
harden(setRelayPolicy);
