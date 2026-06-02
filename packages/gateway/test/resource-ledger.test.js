// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E } from '@endo/far';

import { bytesToImmutable } from '@endo/bytes/to-immutable.js';

import {
  ED25519_PUBLIC_KEY_LENGTH,
  RESOURCE_CLASSES,
  makeResourceLedger,
} from '../index.js';

/**
 * @param {number} length
 * @param {number} [fill]
 */
const immutableBytesOf = (length, fill = 0) => {
  const u = new Uint8Array(length);
  u.fill(fill);
  return bytesToImmutable(u);
};

/** A 32-byte public key (immutable) for tests. */
const ALICE_KEY = immutableBytesOf(ED25519_PUBLIC_KEY_LENGTH, 0xa1);
/** A second 32-byte public key (immutable) for tests. */
const BOB_KEY = immutableBytesOf(ED25519_PUBLIC_KEY_LENGTH, 0xb2);

const ALICE_HEX = 'a1'.repeat(ED25519_PUBLIC_KEY_LENGTH);
const BOB_HEX = 'b2'.repeat(ED25519_PUBLIC_KEY_LENGTH);

/**
 * Default verifier: trusts every proof. Used when the test is
 * exercising counter shape rather than verification semantics.
 */
const trustingVerifier = () => true;

// -- factory shape ------------------------------------------------

test('makeResourceLedger requires a verifyPaymentProof function', t => {
  t.throws(() => makeResourceLedger(/** @type {any} */ ({})), {
    message: /requires a verifyPaymentProof function/,
  });
  t.throws(
    () =>
      makeResourceLedger(
        /** @type {any} */ ({ verifyPaymentProof: 'not a function' }),
      ),
    {
      message: /requires a verifyPaymentProof function/,
    },
  );
});

test('ResourceLedger is a hardened exo with discoverable methods', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  t.true(Object.isFrozen(ledger));
  const introspect = /** @type {any} */ (E(ledger));
  // eslint-disable-next-line no-underscore-dangle
  const methods = await introspect.__getMethodNames__();
  t.true(methods.includes('getBalance'));
  t.true(methods.includes('chargeBalance'));
  t.true(methods.includes('purchaseTokens'));
  t.true(methods.includes('setQuota'));
  t.true(methods.includes('listBalances'));
});

test('RESOURCE_CLASSES is the hardened canonical class tuple', t => {
  t.deepEqual([...RESOURCE_CLASSES], ['compute', 'storage', 'network']);
  t.true(Object.isFrozen(RESOURCE_CLASSES));
});

// -- getBalance ---------------------------------------------------

test('getBalance returns all-zeros for an unknown account', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.account, ALICE_HEX);
  t.is(balance.compute, 0);
  t.is(balance.storage, 0);
  t.is(balance.network, 0);
});

test('byte-equal ArrayBuffers from different sources resolve to the same account', async t => {
  // Per the `@endo/bytes` wire shape, the exo's pattern matcher
  // accepts only immutable `ArrayBuffer` across the wire
  // (Uint8Arrays cannot be frozen and are rejected by the
  // wire-side check). Two byte-equal ArrayBuffers constructed
  // separately must still hit the same account; the ledger keys
  // by byte content (hex), not by object identity.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  const aliceA = bytesToImmutable(
    new Uint8Array(ED25519_PUBLIC_KEY_LENGTH).fill(0xa1),
  );
  const aliceB = bytesToImmutable(
    new Uint8Array(ED25519_PUBLIC_KEY_LENGTH).fill(0xa1),
  );
  t.not(aliceA, aliceB);
  await E(ledger).purchaseTokens(aliceA, { compute: 30 }, 'p1');
  const balance = await E(ledger).getBalance(aliceB);
  t.is(balance.account, ALICE_HEX);
  t.is(balance.compute, 30);
});

test('getBalance rejects a non-byte input', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(E(ledger).getBalance(/** @type {any} */ ('not bytes')), {
    message: /agentPublicKey must be an immutable ArrayBuffer or Uint8Array/,
  });
});

test('getBalance rejects a wrong-length publicKey', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(E(ledger).getBalance(immutableBytesOf(16)), {
    message: /agentPublicKey must be .* bytes, got/,
  });
});

test('getBalance is a pure read: an unknown-account query does not create an account', async t => {
  // Regression: a refactor that lazily allocates on getBalance
  // would inflate listBalances() with empty accounts that were
  // only ever queried, not credited. The admin facet's
  // snapshot would then leak query history.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).getBalance(ALICE_KEY);
  const all = await E(ledger).listBalances();
  t.deepEqual([...all], []);
});

// -- purchaseTokens -----------------------------------------------

test('purchaseTokens credits the account when the verifier returns true', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  const after = await E(ledger).purchaseTokens(
    ALICE_KEY,
    { compute: 100, storage: 1024, network: 2048 },
    'opaque-proof',
  );
  t.is(after.compute, 100);
  t.is(after.storage, 1024);
  t.is(after.network, 2048);
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.compute, 100);
  t.is(balance.storage, 1024);
  t.is(balance.network, 2048);
});

test('purchaseTokens throws when the verifier returns falsy', async t => {
  // Regression: an integration that mistakenly returned `false`
  // from the verifier must NOT credit the account; the design's
  // fail-closed framing requires a thrown error.
  const ledger = makeResourceLedger({
    verifyPaymentProof: () => false,
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'bad'),
    { message: /payment proof failed verification/ },
  );
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.compute, 0);
});

test('purchaseTokens propagates an error thrown by the verifier', async t => {
  // Regression: a verifier that throws a descriptive error must
  // surface that error to the caller, not a generic "invalid
  // proof" message.
  const ledger = makeResourceLedger({
    verifyPaymentProof: () => {
      throw new Error('processor returned 402 Payment Required');
    },
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'whatever'),
    { message: /processor returned 402 Payment Required/ },
  );
});

test('purchaseTokens lets the verifier override the credited tokens', async t => {
  // The payment-processor adapter may decide the actual token
  // grant (e.g., it rounds, applies fees, or splits across
  // classes). The verifier's returned `ResourceTokens` is what
  // the ledger credits, not the caller's stated `tokens`.
  const ledger = makeResourceLedger({
    verifyPaymentProof: () => ({ compute: 50, storage: 0, network: 0 }),
  });
  const after = await E(ledger).purchaseTokens(
    ALICE_KEY,
    { compute: 1000, storage: 1000, network: 1000 },
    'proof',
  );
  t.is(after.compute, 50);
  t.is(after.storage, 0);
  t.is(after.network, 0);
});

test('purchaseTokens passes the agentPublicKey, tokens, and proof to the verifier', async t => {
  // Regression: a refactor that forgot to pass any of the three
  // would silently neuter the verifier's ability to cross-check
  // the receipt.
  /** @type {Array<{ agentPublicKey: unknown, tokens: unknown, proof: unknown }>} */
  const calls = [];
  const ledger = makeResourceLedger({
    verifyPaymentProof: args => {
      calls.push(args);
      return true;
    },
  });
  await E(ledger).purchaseTokens(
    ALICE_KEY,
    { compute: 10 },
    { receipt: 'stripe-xyz' },
  );
  t.is(calls.length, 1);
  t.is(calls[0].proof, calls[0].proof);
  t.deepEqual(calls[0].proof, { receipt: 'stripe-xyz' });
  t.deepEqual(calls[0].tokens, { compute: 10, storage: 0, network: 0 });
  // The agentPublicKey is forwarded as-is (the ledger does not
  // copy or rewrap it).
  t.is(calls[0].agentPublicKey, ALICE_KEY);
});

test('purchaseTokens accumulates across multiple credits', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'p1');
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 50 }, 'p2');
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.compute, 150);
});

test('purchaseTokens with omitted classes defaults to zero', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 10 }, 'proof');
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.compute, 10);
  t.is(balance.storage, 0);
  t.is(balance.network, 0);
});

test('purchaseTokens rejects negative token values', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: -1 }, 'proof'),
    { message: /must be non-negative/ },
  );
});

test('purchaseTokens rejects fractional token values', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: 1.5 }, 'proof'),
    { message: /must be an integer/ },
  );
});

test('purchaseTokens rejects non-finite token values', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: Infinity }, 'proof'),
    { message: /must be a finite number/ },
  );
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: NaN }, 'proof'),
    { message: /must be a finite number/ },
  );
});

test('purchaseTokens rejects unrecognized class names', async t => {
  // Regression: a typo (`computes` instead of `compute`) would
  // silently land zero in every recognized class; we surface the
  // typo loudly so the caller fixes it.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(
      ALICE_KEY,
      /** @type {any} */ ({ computes: 100 }),
      'proof',
    ),
    { message: /unrecognized field/ },
  );
});

test('purchaseTokens rejects a non-object tokens argument', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, /** @type {any} */ (null), 'proof'),
    { message: /tokens must be an object/ },
  );
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, /** @type {any} */ ([]), 'proof'),
    { message: /tokens must be an object/ },
  );
});

test('purchaseTokens does NOT credit when the verifier rejects (state unchanged)', async t => {
  // Regression: a refactor that credited before verifying would
  // leak tokens on a failed proof.
  let attempts = 0;
  const ledger = makeResourceLedger({
    verifyPaymentProof: () => {
      attempts += 1;
      return attempts > 1;
    },
  });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'first'),
    { message: /payment proof failed verification/ },
  );
  const balanceAfterReject = await E(ledger).getBalance(ALICE_KEY);
  t.is(balanceAfterReject.compute, 0);
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'second');
  const balanceAfterAccept = await E(ledger).getBalance(ALICE_KEY);
  t.is(balanceAfterAccept.compute, 100);
});

// -- chargeBalance ------------------------------------------------

test('chargeBalance debits an existing account', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(
    ALICE_KEY,
    { compute: 100, storage: 1024, network: 2048 },
    'proof',
  );
  const after = await E(ledger).chargeBalance(ALICE_KEY, {
    compute: 25,
    storage: 256,
    network: 512,
  });
  t.is(after.compute, 75);
  t.is(after.storage, 768);
  t.is(after.network, 1536);
});

test('chargeBalance throws on underflow and leaves state unchanged', async t => {
  // Regression: a partial-charge implementation that debited one
  // class then threw on the next would leave the account in a
  // half-charged state. The design's atomic-or-fail framing
  // requires no mutation on a failed charge.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(
    ALICE_KEY,
    { compute: 100, storage: 1024, network: 2048 },
    'proof',
  );
  await t.throwsAsync(
    E(ledger).chargeBalance(ALICE_KEY, {
      compute: 50, // OK alone
      storage: 5000, // would underflow
    }),
    { message: /insufficient.*storage.*tokens/ },
  );
  const balance = await E(ledger).getBalance(ALICE_KEY);
  // No mutation happened.
  t.is(balance.compute, 100);
  t.is(balance.storage, 1024);
  t.is(balance.network, 2048);
});

test('chargeBalance throws against an unknown account', async t => {
  // Regression: a refactor that defaulted unknown accounts to
  // infinite balance would silently allow uncharged consumption.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(E(ledger).chargeBalance(ALICE_KEY, { compute: 1 }), {
    message: /insufficient.*compute.*tokens/,
  });
});

test('chargeBalance accepts a zero-token charge as a no-op', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'proof');
  const after = await E(ledger).chargeBalance(ALICE_KEY, {});
  t.is(after.compute, 100);
});

test('chargeBalance rejects negative or fractional debits', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'proof');
  await t.throwsAsync(E(ledger).chargeBalance(ALICE_KEY, { compute: -1 }), {
    message: /must be non-negative/,
  });
  await t.throwsAsync(E(ledger).chargeBalance(ALICE_KEY, { compute: 1.5 }), {
    message: /must be an integer/,
  });
});

// -- setQuota -----------------------------------------------------

test('setQuota bounds future purchases', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).setQuota(ALICE_KEY, { compute: 100 });
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: 101 }, 'proof'),
    { message: /credit would exceed quota/ },
  );
});

test('setQuota over-quota purchase leaves state unchanged', async t => {
  // Regression: a partial-credit implementation that landed
  // sub-quota fields and then threw on the over-quota class
  // would silently credit the safe classes.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).setQuota(ALICE_KEY, { compute: 100 });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 50 }, 'p1');
  await t.throwsAsync(
    E(ledger).purchaseTokens(ALICE_KEY, { compute: 60, storage: 256 }, 'p2'),
    { message: /compute.*exceed quota/ },
  );
  const balance = await E(ledger).getBalance(ALICE_KEY);
  // compute stays at 50 (the second purchase failed atomically);
  // storage stays at 0 (no partial-credit on the safe class).
  t.is(balance.compute, 50);
  t.is(balance.storage, 0);
});

test('setQuota with Infinity is unbounded', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).setQuota(ALICE_KEY, { compute: Infinity });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 1_000_000 }, 'proof');
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.compute, 1_000_000);
});

test('setQuota does NOT retroactively reduce existing balance', async t => {
  // Per design: the quota bounds future credits, not the current
  // balance. A retroactive cap would silently confiscate tokens
  // the account legitimately holds.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 1000 }, 'proof');
  await E(ledger).setQuota(ALICE_KEY, { compute: 100 });
  const balance = await E(ledger).getBalance(ALICE_KEY);
  t.is(balance.compute, 1000);
});

test('setQuota rejects negative or non-integer values', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(E(ledger).setQuota(ALICE_KEY, { compute: -1 }), {
    message: /must be non-negative/,
  });
  await t.throwsAsync(E(ledger).setQuota(ALICE_KEY, { compute: 1.5 }), {
    message: /must be an integer or Infinity/,
  });
  await t.throwsAsync(E(ledger).setQuota(ALICE_KEY, { compute: NaN }), {
    message: /must not be NaN/,
  });
});

test('setQuota rejects unrecognized class names', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await t.throwsAsync(
    E(ledger).setQuota(ALICE_KEY, /** @type {any} */ ({ storages: 100 })),
    { message: /unrecognized field/ },
  );
});

// -- listBalances -------------------------------------------------

test('listBalances is empty before any credit', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  const all = await E(ledger).listBalances();
  t.deepEqual([...all], []);
});

test('listBalances returns every credited account', async t => {
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 100 }, 'pa');
  await E(ledger).purchaseTokens(BOB_KEY, { storage: 1024 }, 'pb');
  const all = await E(ledger).listBalances();
  t.is(all.length, 2);
  // Sorted by hex; ALICE (a1...) sorts before BOB (b2...).
  t.is(all[0].account, ALICE_HEX);
  t.is(all[0].compute, 100);
  t.is(all[1].account, BOB_HEX);
  t.is(all[1].storage, 1024);
});

test('listBalances order is stable across snapshots', async t => {
  // Regression: a refactor that switched to insertion-order
  // iteration would leak the order accounts were touched.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  // Credit Bob first, then Alice; the sort order must still be
  // Alice-then-Bob (hex-sorted).
  await E(ledger).purchaseTokens(BOB_KEY, { compute: 1 }, 'pb');
  await E(ledger).purchaseTokens(ALICE_KEY, { compute: 1 }, 'pa');
  const all = await E(ledger).listBalances();
  t.deepEqual(
    all.map(b => b.account),
    [ALICE_HEX, BOB_HEX],
  );
});

// -- byte-shape parity --------------------------------------------

test('two purchases against the same ArrayBuffer accumulate on one account', async t => {
  // Regression: a refactor that keyed by object identity (rather
  // than by byte content) would treat each call as a separate
  // account, doubling rows in the admin snapshot.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  const aliceA = bytesToImmutable(
    new Uint8Array(ED25519_PUBLIC_KEY_LENGTH).fill(0xa1),
  );
  const aliceB = bytesToImmutable(
    new Uint8Array(ED25519_PUBLIC_KEY_LENGTH).fill(0xa1),
  );
  await E(ledger).purchaseTokens(aliceA, { compute: 100 }, 'p1');
  await E(ledger).purchaseTokens(aliceB, { compute: 50 }, 'p2');
  const all = await E(ledger).listBalances();
  t.is(all.length, 1);
  t.is(all[0].compute, 150);
});

// -- admin facet wiring -------------------------------------------

test('ResourceLedger.listBalances satisfies the admin ResourceLedger shape', async t => {
  // Regression: the admin facet (`admin.js`) consumes a ledger
  // through the narrow `ResourceLedger` interface
  // (`listBalances() => ReadonlyArray<ResourceBalance>`). The
  // concrete ledger this module ships must satisfy that shape,
  // or the admin will throw at first call.
  const ledger = makeResourceLedger({
    verifyPaymentProof: trustingVerifier,
  });
  await E(ledger).purchaseTokens(
    ALICE_KEY,
    { compute: 100, storage: 1024, network: 2048 },
    'proof',
  );
  const balances = await E(ledger).listBalances();
  t.is(balances.length, 1);
  // The admin facet's `ResourceBalance` typedef is { account,
  // compute, storage, network }.
  t.deepEqual(Object.keys(balances[0]).sort(), [
    'account',
    'compute',
    'network',
    'storage',
  ]);
});
