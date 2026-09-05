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

test('a pipelined burst cannot clear the gate before the misses settle', async t => {
  // The central production property of the per-session gate: a peer that
  // fires many `fetch` frames concurrently — without awaiting one before
  // sending the next — must not clear the pre-lookup guard `missBound`
  // times before the first miss increments the counter. Every prior unit
  // and wire test awaits each `get` before the next, so nothing here
  // pipelines; this test fires `missBound + overshoot` presentations at once.
  //
  // On the unserialized body (each `get` independently reading the counter
  // with no in-flight term) all overshoot clear the guard and the bound never
  // bites: the session aborts more than once and a valid id after the
  // burst still resolves. On the in-flight-counted body it aborts exactly
  // once and the session latches closed.
  const guest = makeGuest();
  const missBound = 3;
  const overshoot = 3;
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id =>
      id === localId ? guest : t.fail('unexpected id'),
    localNodeNumber: localNode,
    missBound,
  });
  let aborts = 0;
  const session = locator.makeLocatorForSession({
    remoteDesignator: 'burst-peer',
    abortSession: () => {
      aborts += 1;
    },
  });

  // Fire missBound + K miss presentations synchronously, without awaiting
  // between them — the pipelined burst.
  const bursts = [];
  for (let i = 0; i < missBound + overshoot; i += 1) {
    bursts.push(session.get(`miss-${i}`));
  }
  const outcomes = await Promise.all(bursts);
  for (const outcome of outcomes) {
    t.is(outcome, undefined, 'every burst presentation is a miss');
  }
  t.is(aborts, 1, 'the burst aborts the session exactly once');

  // A valid identifier presented after the burst is refused: the session
  // has latched closed, so no capability can be redeemed on it even though
  // `provideLocalFormula` would return `guest` for `localId`.
  t.is(
    await session.get(localId),
    undefined,
    'a valid id after the bound is refused on the latched session',
  );
  t.is(aborts, 1, 'no re-abort after the burst');
});

test('overlapping hits resolve concurrently and a pending miss blocks neither', async t => {
  // The docstring's concurrency claim: hits run concurrently and one
  // never-settling lookup can no longer wedge the session (it holds a
  // single in-flight slot, it does not serialize every later presentation
  // behind one pending tail). Pin it directly: hold a miss lookup pending,
  // fire two hits while it is still in flight, and show both hits resolve
  // without waiting for the pending miss ahead of them.
  const guest = makeGuest();
  let releaseHits;
  const hitsGate = new Promise(resolve => {
    releaseHits = resolve;
  });
  let releaseMiss;
  const missGate = new Promise(resolve => {
    releaseMiss = resolve;
  });
  const missId = `${'e'.repeat(64)}:${localNode}`;
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      if (id === localId) {
        await hitsGate;
        return guest;
      }
      await missGate;
      throw new ReferenceError('absent');
    },
    localNodeNumber: localNode,
    missBound: 5,
  });
  const session = locator.makeLocatorForSession({
    remoteDesignator: 'peer',
    abortSession: () => t.fail('must not abort below the bound'),
  });
  await null;

  // A miss lookup is started and held pending (in flight, unsettled).
  const pendingMiss = session.get(missId);
  // Two hits start while that miss is still pending.
  const hitA = session.get(localId);
  const hitB = session.get(localId);

  // Nothing has settled: all three lookups are genuinely in flight.
  let anySettled = false;
  void Promise.race([hitA, hitB, pendingMiss]).then(() => {
    anySettled = true;
  });
  await new Promise(resolve => setTimeout(resolve, 0));
  t.false(anySettled, 'all three presentations are in flight together');

  // Release only the two hits: they resolve concurrently, ahead of the
  // still-pending miss — the miss never wedged them.
  releaseHits();
  t.is(await hitA, guest, 'the first overlapping hit resolves');
  t.is(await hitB, guest, 'the second overlapping hit resolves');

  // The miss was still pending the whole time; releasing it now yields the
  // uniform undefined miss.
  releaseMiss();
  t.is(await pendingMiss, undefined, 'the held miss finally settles as a miss');
});

test('the in-flight term gates admission before any lookup runs', async t => {
  // Pins the `misses + inFlight >= missBound` gate's *inFlight* half
  // (test:229 exercises the burst outcome but does not isolate this term):
  // with no miss yet settled, filling the bound with in-flight, still-parked
  // presentations must refuse the next one synchronously — running no lookup
  // — and that synchronous refusal must not itself count as a miss or abort.
  // A body that gated on settled misses alone (no in-flight term) would
  // admit it and run its lookup.
  const missBound = 3;
  // Valid *local* formula identifiers, so each presentation reaches
  // `provideLocalFormula` (and parks) rather than missing early at
  // `assertValidId`. They still resolve as misses because the parked
  // lookup ultimately throws.
  const validId = char => `${char.repeat(64)}:${localNode}`;
  let provideCalls = 0;
  let releaseAll;
  const gate = new Promise(resolve => {
    releaseAll = resolve;
  });
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async () => {
      provideCalls += 1;
      await gate; // park every admitted lookup in flight
      throw new ReferenceError('absent');
    },
    localNodeNumber: localNode,
    missBound,
  });
  let aborts = 0;
  const session = locator.makeLocatorForSession({
    remoteDesignator: 'peer',
    abortSession: () => {
      aborts += 1;
    },
  });
  await null;

  // Fill the bound with in-flight, still-parked presentations. The
  // synchronous admission gate increments `inFlight` for each before the
  // loop returns; the lookups themselves reach `provideLocalFormula` a
  // microtask later (`get`/`sessionGet` each `await null` first), so let a
  // turn pass before observing the call count.
  const chars = ['a', 'c', 'd'];
  const inflight = [];
  for (let i = 0; i < missBound; i += 1) {
    inflight.push(session.get(validId(chars[i])));
  }
  await new Promise(resolve => setTimeout(resolve, 0));
  t.is(provideCalls, missBound, 'each admitted presentation ran its lookup');

  // The next presentation is refused at the synchronous gate: inFlight
  // alone reaches the bound though no miss has settled. It runs no lookup
  // and does not abort.
  const refused = session.get(validId('e'));
  t.is(
    await refused,
    undefined,
    'the over-bound presentation is a synchronous miss',
  );
  t.is(provideCalls, missBound, 'the refused presentation ran no lookup');
  t.is(aborts, 0, 'a synchronous in-flight refusal does not abort the session');

  // Release the parked lookups: the settled misses now cross the bound and
  // abort exactly once.
  releaseAll();
  t.deepEqual(
    await Promise.all(inflight),
    inflight.map(() => undefined),
    'every parked presentation settles as a miss',
  );
  t.is(aborts, 1, 'the settled misses abort the session exactly once');
});

test('a throwing miss logger stays a uniform miss and still counts the miss', async t => {
  // If a broken embedder `logger.error` threw where the miss path logs,
  // the rejection would escape `get` as a distinct error (an oracle) *and*
  // the miss would never be counted — the `misses += 1` sits below the
  // `await get(...)`, so a throwing `get` skips it and silently disarms the
  // session bound. A throwing logger must be swallowed: the presentation
  // stays a uniform undefined miss and the miss still advances the bound.
  const missBound = 2;
  let aborts = 0;
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async () => {
      throw new ReferenceError('absent');
    },
    localNodeNumber: localNode,
    missBound,
    logger: {
      error: () => {
        throw new Error('logger blew up');
      },
    },
  });
  await null;
  // The shared, unbounded `get` also stays a uniform miss, never a throw.
  t.is(
    await locator.get(localId),
    undefined,
    'the shared get swallows a throwing logger',
  );
  const session = locator.makeLocatorForSession({
    remoteDesignator: 'peer',
    abortSession: () => {
      aborts += 1;
    },
  });
  await null;
  t.is(
    await session.get('miss-1'),
    undefined,
    'a throwing logger stays a uniform miss',
  );
  t.is(aborts, 0, 'one miss, below the bound');
  // The throwing-logger miss was counted: a second miss crosses the bound.
  t.is(await session.get('miss-2'), undefined);
  t.is(aborts, 1, 'the throwing-logger miss still advanced the bound');
});

test('a throwing abortSession never becomes an oracle', async t => {
  // The README and endpoint wiring both invite an embedder to wrap
  // `abortSession`; such a wrapper can throw. If that throw escaped
  // `sessionGet`, the crossing presentation would reject with the
  // embedder's error instead of the uniform `undefined` miss — a
  // distinguishable oracle for "this is the presentation that crossed the
  // bound". With `missBound: 1` the very first miss crosses.
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async () => {
      throw new ReferenceError('absent');
    },
    localNodeNumber: localNode,
    missBound: 1,
    logger: { error: () => {} },
  });
  const session = locator.makeLocatorForSession({
    remoteDesignator: 'peer',
    abortSession: () => {
      throw new Error('embedder teardown blew up');
    },
  });
  await null;
  // The crossing presentation resolves to the uniform miss, not the
  // embedder's thrown error.
  t.is(
    await session.get('miss-1'),
    undefined,
    'the crossing miss stays a uniform undefined despite abortSession throwing',
  );
  // And the session still latched closed.
  t.is(await session.get('miss-2'), undefined, 'the session remains latched');
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

test('the miss logger receives the error class only, never the caught message', async t => {
  // The non-oracularity argument rests on the miss logger seeing only
  // `error.name`, never `error.message`. A live identifier that misses
  // transiently can carry the presented bearer nonce in its message; a
  // future swap to `error.message` would silently write that secret to
  // the daemon log. Assert the logged arguments carry the class name and
  // never the secret.
  const secret = localId;
  const loggedArguments = [];
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      // Reject with the presented secret embedded in the message — the
      // worst case the docstring guards against.
      throw new TypeError(`incarnation failed for ${id}`);
    },
    localNodeNumber: localNode,
    logger: {
      error: (...args) => {
        loggedArguments.push(args);
      },
    },
  });

  t.is(await locator.get(secret), undefined, 'the presentation still misses');
  t.is(loggedArguments.length, 1, 'the miss was logged exactly once');
  const [args] = loggedArguments;
  t.true(args.includes('TypeError'), 'the error class name is logged');
  for (const arg of args) {
    t.false(
      typeof arg === 'string' && arg.includes(secret),
      'no logged argument echoes the presented secret',
    );
  }
});

test('a NaN, non-positive, or non-integer missBound throws at construction', async t => {
  // The fail-closed guard: `misses >= NaN` and `misses >= -1` are never
  // true, so a nonsensical bound would silently disable the session bound
  // rather than tighten it. Every such bound must throw at construction.
  for (const missBound of [NaN, -1, 0, 1.5, Infinity]) {
    t.throws(
      () =>
        makeFormulaNonceLocator({
          provideLocalFormula: async () => t.fail('provide should not run'),
          localNodeNumber: localNode,
          missBound,
        }),
      { message: /missBound must be a positive integer/ },
      `missBound ${String(missBound)} is rejected`,
    );
  }
});
