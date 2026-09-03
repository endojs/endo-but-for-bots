// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/pass-style';
import { makeFormulaNonceLocator } from '../src/networks/formula-nonce-locator.js';

const localNode = 'b'.repeat(64);
const foreignNode = 'c'.repeat(64);
const formulaNumber = 'a'.repeat(64);
const localId = `${formulaNumber}:${localNode}`;
const foreignId = `${formulaNumber}:${foreignNode}`;

/** A stand-in guest capability: an OCapN-exportable remotable. */
const makeGuest = () => Far('Guest', { greet: () => 'hi from guest' });

test('a local formula identifier returns exactly its incarnated capability', async t => {
  const guest = makeGuest();
  const calls = [];
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async (id, node) => {
      calls.push([id, node]);
      return guest;
    },
    localNodeNumber: localNode,
  });

  const value = await locator.get(localId);
  t.is(value, guest, 'returns the incarnated capability by identity');
  t.deepEqual(
    calls,
    [[localId, localNode]],
    'provide called with the id and local node',
  );
});

test('every miss class collapses to the identical undefined miss', async t => {
  await null;
  // provideLocalFormula rejects/returns per the miss class under test.
  const bytesId = new TextEncoder().encode(localId); // non-ASCII path: a Uint8Array secret
  const nonExportable = harden({ not: 'a remotable' });

  /**
   * Each case is a (label, locator, secret) tuple whose `get` must
   * produce the *same* miss. We assert equivalence, not merely "an
   * error each": differing return values or a thrown exception would
   * reintroduce the oracle.
   */
  const cases = [
    [
      'malformed ASCII',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        localNodeNumber: localNode,
      }),
      'not-a-formula-identifier',
    ],
    [
      'raw non-ASCII bytes',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        localNodeNumber: localNode,
      }),
      bytesId,
    ],
    [
      'noncanonical (uppercase hex)',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        localNodeNumber: localNode,
      }),
      `${formulaNumber.toUpperCase()}:${localNode}`,
    ],
    [
      'noncanonical (wrong length)',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        localNodeNumber: localNode,
      }),
      `${'a'.repeat(63)}:${localNode}`,
    ],
    [
      'foreign node',
      makeFormulaNonceLocator({
        provideLocalFormula: async () =>
          t.fail('provide should not run for a foreign node'),
        localNodeNumber: localNode,
      }),
      foreignId,
    ],
    [
      'absent formula',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => {
          throw new ReferenceError('No formula exists for number ...');
        },
        localNodeNumber: localNode,
      }),
      localId,
    ],
    [
      'collected formula',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => {
          throw new Error('Unknown or collected mount formula ...');
        },
        localNodeNumber: localNode,
      }),
      localId,
    ],
    [
      'non-exportable value',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => nonExportable,
        localNodeNumber: localNode,
      }),
      localId,
    ],
    [
      'incarnation failure',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => {
          throw new TypeError('Invalid formula: ...');
        },
        localNodeNumber: localNode,
      }),
      localId,
    ],
    [
      'old fixed endo-bootstrap name',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        localNodeNumber: localNode,
      }),
      'endo-bootstrap',
    ],
    [
      'old fixed endo-peer-entry name',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        localNodeNumber: localNode,
      }),
      'endo-peer-entry',
    ],
  ];

  const results = [];
  for (const [label, locator, secret] of cases) {
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop
      outcome = { returned: await locator.get(secret) };
    } catch (error) {
      outcome = { threw: error };
    }
    results.push([label, outcome]);
  }

  for (const [label, outcome] of results) {
    t.deepEqual(
      outcome,
      { returned: undefined },
      `${label} returns undefined and never throws`,
    );
  }
});

test('the per-session miss bound aborts one session without touching another', async t => {
  const guest = makeGuest();
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id =>
      id === localId ? guest : t.fail('unexpected id'),
    localNodeNumber: localNode,
    missBound: 3,
  });
  await null;

  // Peer A: a prober. Its session aborts once it crosses the bound.
  let aAborts = 0;
  const sessionA = locator.makeLocatorForSession({
    remoteDesignator: 'peer-a',
    abortSession: () => {
      aAborts += 1;
    },
  });
  // Peer B: holds a valid identifier; must be unaffected by A's probing.
  let bAborts = 0;
  const sessionB = locator.makeLocatorForSession({
    remoteDesignator: 'peer-b',
    abortSession: () => {
      bAborts += 1;
    },
  });

  // A misses up to but not across the bound.
  t.is(await sessionA.get('miss-1'), undefined);
  t.is(await sessionA.get('miss-2'), undefined);
  t.is(aAborts, 0, 'not yet at the bound');
  // The bound-crossing miss aborts A's session exactly once.
  t.is(await sessionA.get('miss-3'), undefined);
  t.is(aAborts, 1, 'session A aborted at the bound');
  // Further presentations keep returning the same miss; abort fires once.
  t.is(await sessionA.get('miss-4'), undefined);
  t.is(aAborts, 1, 'abort is idempotent');
  // Even a VALID identifier presented after the bound is refused: once
  // aborted, the session locator stops running the lookup entirely, so no
  // capability can be redeemed on it regardless of transport-teardown
  // timing. `provideLocalFormula` would return `guest` for `localId`, yet
  // the aborted session yields the same `undefined` miss.
  t.is(
    await sessionA.get(localId),
    undefined,
    'a valid id is refused once the session has crossed its bound',
  );
  t.is(aAborts, 1, 'a post-bound presentation does not re-abort');

  // Peer B, a different authenticated session, is entirely unaffected:
  // it fetches its valid capability and never aborts.
  t.is(
    await sessionB.get(localId),
    guest,
    'B still resolves its valid identifier',
  );
  t.is(await sessionB.get(localId), guest);
  t.is(await sessionB.get(localId), guest);
  t.is(await sessionB.get(localId), guest);
  t.is(bAborts, 0, 'B is untouched by A crossing its bound');
});

test('hits do not count toward the miss bound', async t => {
  const guest = makeGuest();
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id =>
      id === localId ? guest : t.fail('unexpected id'),
    localNodeNumber: localNode,
    missBound: 2,
  });
  let aborts = 0;
  const session = locator.makeLocatorForSession({
    remoteDesignator: 'peer',
    abortSession: () => {
      aborts += 1;
    },
  });
  // Interleave many hits with a single miss: the hits must not advance
  // the counter, so the lone miss cannot approach the bound.
  await null;
  t.is(await session.get(localId), guest);
  t.is(await session.get('a-miss'), undefined);
  t.is(await session.get(localId), guest);
  t.is(await session.get(localId), guest);
  t.is(aborts, 0, 'a single miss amid hits never crosses the bound');
});
