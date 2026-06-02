// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { bytesToImmutable } from '@endo/bytes/to-immutable.js';

import {
  DEFAULT_RELAY_POLICY,
  RELAY_POLICIES,
  addCallerPublicKey,
  checkRelayPolicy,
  isInboundSessionAllowed,
  listCallerAllowlist,
  makeRelayPolicyEntry,
  publicKeyToHex,
  removeCallerPublicKey,
  setRelayPolicy,
} from '../src/relay-policy.js';

/**
 * @param {number} fill
 * @returns {ArrayBuffer}
 */
const immutableKey = fill => bytesToImmutable(new Uint8Array(32).fill(fill));

/**
 * @param {number} fill
 * @returns {Uint8Array}
 */
const mutableKey = fill => new Uint8Array(32).fill(fill);

// -- Constants ----------------------------------------------------

test('DEFAULT_RELAY_POLICY is "closed" per design Feature 6', t => {
  t.is(DEFAULT_RELAY_POLICY, 'closed');
});

test('RELAY_POLICIES enumerates the two recognized values', t => {
  t.deepEqual([...RELAY_POLICIES], ['closed', 'open']);
});

// -- checkRelayPolicy ---------------------------------------------

test('checkRelayPolicy accepts "closed" and "open"', t => {
  t.is(checkRelayPolicy('closed'), 'closed');
  t.is(checkRelayPolicy('open'), 'open');
});

test('checkRelayPolicy rejects other strings', t => {
  t.throws(() => checkRelayPolicy('rate-limited'), {
    message: /relayPolicy must be "closed" or "open"/,
  });
  t.throws(() => checkRelayPolicy(''), {
    message: /relayPolicy must be "closed" or "open"/,
  });
});

test('checkRelayPolicy rejects non-strings', t => {
  t.throws(() => checkRelayPolicy(/** @type {any} */ (null)), {
    message: /relayPolicy/,
  });
  t.throws(() => checkRelayPolicy(/** @type {any} */ (true)), {
    message: /relayPolicy/,
  });
  t.throws(() => checkRelayPolicy(/** @type {any} */ (42)), {
    message: /relayPolicy/,
  });
});

// -- makeRelayPolicyEntry -----------------------------------------

test('makeRelayPolicyEntry defaults to closed with empty allowlist', t => {
  const entry = makeRelayPolicyEntry();
  t.is(entry.policy, 'closed');
  t.is(entry.callerAllowlist.size, 0);
});

test('makeRelayPolicyEntry honors an explicit open policy', t => {
  const entry = makeRelayPolicyEntry('open');
  t.is(entry.policy, 'open');
});

test('makeRelayPolicyEntry validates the policy argument', t => {
  t.throws(() => makeRelayPolicyEntry(/** @type {any} */ ('public')), {
    message: /relayPolicy must be "closed" or "open"/,
  });
});

// -- publicKeyToHex shape parity ----------------------------------

test('publicKeyToHex renders 32 bytes as 64 lowercase hex characters', t => {
  const hex = publicKeyToHex(immutableKey(0xab));
  t.is(hex.length, 64);
  t.is(hex, 'ab'.repeat(32));
});

test('publicKeyToHex accepts both immutable ArrayBuffer and Uint8Array', t => {
  const immutable = immutableKey(0xcd);
  const mutable = mutableKey(0xcd);
  t.is(publicKeyToHex(immutable), publicKeyToHex(mutable));
});

// -- addCallerPublicKey -------------------------------------------

test('addCallerPublicKey adds a key and returns true', t => {
  const entry = makeRelayPolicyEntry();
  t.true(addCallerPublicKey(entry, immutableKey(1)));
  t.is(entry.callerAllowlist.size, 1);
});

test('addCallerPublicKey is idempotent and returns false on re-add', t => {
  const entry = makeRelayPolicyEntry();
  t.true(addCallerPublicKey(entry, immutableKey(2)));
  t.false(addCallerPublicKey(entry, immutableKey(2)));
  t.is(entry.callerAllowlist.size, 1);
});

test('addCallerPublicKey rejects non-bytes', t => {
  const entry = makeRelayPolicyEntry();
  t.throws(() => addCallerPublicKey(entry, /** @type {any} */ ('not-bytes')), {
    message: /must be an immutable ArrayBuffer or Uint8Array/,
  });
});

test('addCallerPublicKey rejects wrong-length keys', t => {
  const entry = makeRelayPolicyEntry();
  t.throws(() => addCallerPublicKey(entry, new Uint8Array(16)), {
    message: /must be 32 bytes/,
  });
});

test('addCallerPublicKey treats immutable + mutable forms of the same key as equal', t => {
  // Regression: the policy keys by hex; if the hex render diverged
  // between the two byte shapes, this test would observe a doubled
  // allowlist for the same logical caller.
  const entry = makeRelayPolicyEntry();
  t.true(addCallerPublicKey(entry, immutableKey(7)));
  t.false(addCallerPublicKey(entry, mutableKey(7)));
});

// -- removeCallerPublicKey ----------------------------------------

test('removeCallerPublicKey removes a present key and returns true', t => {
  const entry = makeRelayPolicyEntry();
  addCallerPublicKey(entry, immutableKey(3));
  t.true(removeCallerPublicKey(entry, immutableKey(3)));
  t.is(entry.callerAllowlist.size, 0);
});

test('removeCallerPublicKey returns false when the key is not present', t => {
  const entry = makeRelayPolicyEntry();
  t.false(removeCallerPublicKey(entry, immutableKey(4)));
});

test('removeCallerPublicKey rejects wrong-length keys', t => {
  const entry = makeRelayPolicyEntry();
  t.throws(() => removeCallerPublicKey(entry, new Uint8Array(16)), {
    message: /must be 32 bytes/,
  });
});

// -- listCallerAllowlist ------------------------------------------

test('listCallerAllowlist returns a sorted snapshot of hex keys', t => {
  const entry = makeRelayPolicyEntry();
  addCallerPublicKey(entry, immutableKey(0xff));
  addCallerPublicKey(entry, immutableKey(0x01));
  addCallerPublicKey(entry, immutableKey(0x80));
  const list = listCallerAllowlist(entry);
  t.is(list.length, 3);
  t.deepEqual([...list], ['01'.repeat(32), '80'.repeat(32), 'ff'.repeat(32)]);
});

test('listCallerAllowlist returns an empty array for a new entry', t => {
  const entry = makeRelayPolicyEntry();
  t.deepEqual([...listCallerAllowlist(entry)], []);
});

// -- setRelayPolicy -----------------------------------------------

test('setRelayPolicy returns the previous policy and updates the entry', t => {
  const entry = makeRelayPolicyEntry('closed');
  t.is(setRelayPolicy(entry, 'open'), 'closed');
  t.is(entry.policy, 'open');
  t.is(setRelayPolicy(entry, 'closed'), 'open');
  t.is(entry.policy, 'closed');
});

test('setRelayPolicy preserves the allowlist across transitions', t => {
  // Regression: if a future refactor cleared the allowlist on
  // open->closed (or closed->open), a registrant who briefly
  // flipped to open would lose their seeded callers.
  const entry = makeRelayPolicyEntry('closed');
  addCallerPublicKey(entry, immutableKey(0x10));
  setRelayPolicy(entry, 'open');
  setRelayPolicy(entry, 'closed');
  t.is(entry.callerAllowlist.size, 1);
});

test('setRelayPolicy rejects invalid policies', t => {
  const entry = makeRelayPolicyEntry();
  t.throws(() => setRelayPolicy(entry, /** @type {any} */ ('unknown')), {
    message: /relayPolicy must be "closed" or "open"/,
  });
});

// -- isInboundSessionAllowed --------------------------------------

test('isInboundSessionAllowed allows any dialer under open policy', t => {
  const entry = makeRelayPolicyEntry('open');
  const result = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: undefined,
  });
  t.true(result.allowed);
  t.is(result.reason, 'open-policy');
});

test('isInboundSessionAllowed denies undefined dialer under closed policy', t => {
  // Regression: under Noise IK the dialer's identity is encrypted,
  // so `extractDialerPublicKey` returns undefined. The policy must
  // fail closed rather than silently relay; a refactor that
  // defaulted "undefined dialer" to "allow" would put the gateway
  // into a default-open relay shape.
  const entry = makeRelayPolicyEntry('closed');
  const result = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: undefined,
  });
  t.false(result.allowed);
  t.is(result.reason, 'closed-policy-no-dialer-identification');
});

test('isInboundSessionAllowed allows an allowlisted dialer under closed policy', t => {
  const entry = makeRelayPolicyEntry('closed');
  const dialerKey = immutableKey(0x20);
  addCallerPublicKey(entry, dialerKey);
  const result = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: dialerKey,
  });
  t.true(result.allowed);
  t.is(result.reason, 'closed-policy-allowlist-hit');
});

test('isInboundSessionAllowed denies a non-allowlisted dialer under closed policy', t => {
  const entry = makeRelayPolicyEntry('closed');
  addCallerPublicKey(entry, immutableKey(0x20));
  const result = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: immutableKey(0x21),
  });
  t.false(result.allowed);
  t.is(result.reason, 'closed-policy-allowlist-miss');
});

test('isInboundSessionAllowed denies a malformed dialer key under closed policy', t => {
  const entry = makeRelayPolicyEntry('closed');
  const result = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: /** @type {any} */ ('not-bytes'),
  });
  t.false(result.allowed);
  t.is(result.reason, 'closed-policy-malformed-dialer-key');
});

test('isInboundSessionAllowed denies a wrong-length dialer key under closed policy', t => {
  const entry = makeRelayPolicyEntry('closed');
  const result = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: new Uint8Array(16),
  });
  t.false(result.allowed);
  t.is(result.reason, 'closed-policy-wrong-length-dialer-key');
});

test('isInboundSessionAllowed sees a live allowlist after add/remove', t => {
  // Regression: the handler holds the `RelayPolicyEntry` by
  // reference (not a snapshot), so add/remove between lookup and
  // admission must be visible. A refactor that snapshotted the set
  // at lookup time would silently delay admin / registrant
  // mutations until the next session.
  const entry = makeRelayPolicyEntry('closed');
  const dialerKey = immutableKey(0x33);
  const denied = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: dialerKey,
  });
  t.false(denied.allowed);
  addCallerPublicKey(entry, dialerKey);
  const allowed = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: dialerKey,
  });
  t.true(allowed.allowed);
  removeCallerPublicKey(entry, dialerKey);
  const denied2 = isInboundSessionAllowed({
    policy: entry,
    dialerPublicKey: dialerKey,
  });
  t.false(denied2.allowed);
});

test('isInboundSessionAllowed rejects malformed inputs', t => {
  t.throws(() => isInboundSessionAllowed(/** @type {any} */ (null)), {
    message: /expects an input object/,
  });
  t.throws(
    () =>
      isInboundSessionAllowed(
        /** @type {any} */ ({ policy: null, dialerPublicKey: undefined }),
      ),
    { message: /expects a policy entry/ },
  );
});
