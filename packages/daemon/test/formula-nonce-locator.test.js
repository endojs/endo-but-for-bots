// @ts-nocheck
import test from '@endo/ses-ava/prepare-endo.js';

import { Far } from '@endo/pass-style';
import { makeFormulaNonceLocator } from '@endo/daemon/formula-nonce-locator.js';

const localNode = 'b'.repeat(64);
const agentNode = 'e'.repeat(64);
const foreignNode = 'c'.repeat(64);
const formulaNumber = 'a'.repeat(64);
const localId = `${formulaNumber}:${localNode}`;
const agentId = `${formulaNumber}:${agentNode}`;
const foreignId = `${formulaNumber}:${foreignNode}`;

// Mirrors the daemon's `isLocalKey`: its own node or a registered agent key.
const isLocal = node => node === localNode || node === agentNode;

/** A stand-in guest capability: an OCapN-exportable remotable. */
const makeGuest = () => Far('Guest', { greet: () => 'hi from guest' });

test('a local formula identifier returns exactly its incarnated capability', async t => {
  const guest = makeGuest();
  const calls = [];
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      calls.push(id);
      return guest;
    },
    isLocalNode: isLocal,
  });

  const value = await locator.get(localId);
  t.is(value, guest, 'returns the incarnated capability by identity');
  t.deepEqual(calls, [localId], 'provide called with the id');
});

test('an identifier under a registered agent node hits', async t => {
  await null;
  // Host and guest formula identifiers carry their agent's node number,
  // not the daemon's, so a locator that compared against the daemon's
  // node alone would miss every real host or guest identifier.
  const guest = makeGuest();
  const calls = [];
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      calls.push(id);
      return guest;
    },
    isLocalNode: isLocal,
  });

  t.is(await locator.get(agentId), guest, 'the agent-node identifier hits');
  t.deepEqual(calls, [agentId], 'provide called with the agent-node id');
});

test('a throwing isLocalNode stays a uniform miss', async t => {
  await null;
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async () => t.fail('provide should not run'),
    isLocalNode: () => {
      throw new Error('predicate blew up');
    },
    logger: { error: () => {} },
  });
  t.is(await locator.get(localId), undefined);
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
        isLocalNode: isLocal,
      }),
      'not-a-formula-identifier',
    ],
    [
      'raw non-ASCII bytes',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        isLocalNode: isLocal,
      }),
      bytesId,
    ],
    [
      'noncanonical (uppercase hex)',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        isLocalNode: isLocal,
      }),
      `${formulaNumber.toUpperCase()}:${localNode}`,
    ],
    [
      'noncanonical (wrong length)',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        isLocalNode: isLocal,
      }),
      `${'a'.repeat(63)}:${localNode}`,
    ],
    [
      'foreign node',
      makeFormulaNonceLocator({
        provideLocalFormula: async () =>
          t.fail('provide should not run for a foreign node'),
        isLocalNode: isLocal,
      }),
      foreignId,
    ],
    [
      'absent formula',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => {
          throw new ReferenceError('No formula exists for number ...');
        },
        isLocalNode: isLocal,
      }),
      localId,
    ],
    [
      'collected formula',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => {
          throw new Error('Unknown or collected mount formula ...');
        },
        isLocalNode: isLocal,
      }),
      localId,
    ],
    [
      'non-exportable value',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => nonExportable,
        isLocalNode: isLocal,
      }),
      localId,
    ],
    [
      'incarnation failure',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => {
          throw new TypeError('Invalid formula: ...');
        },
        isLocalNode: isLocal,
      }),
      localId,
    ],
    [
      'old fixed endo-bootstrap name',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        isLocalNode: isLocal,
      }),
      'endo-bootstrap',
    ],
    [
      'old fixed endo-peer-entry name',
      makeFormulaNonceLocator({
        provideLocalFormula: async () => t.fail('provide should not run'),
        isLocalNode: isLocal,
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

test('a throwing miss logger stays a uniform miss', async t => {
  // If a broken embedder `logger.error` threw where the miss path logs,
  // the rejection would escape `get` as a distinct error: an oracle.
  await null;
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async () => {
      throw new ReferenceError('absent');
    },
    isLocalNode: isLocal,
    logger: {
      error: () => {
        throw new Error('logger blew up');
      },
    },
  });
  t.is(
    await locator.get(localId),
    undefined,
    'a throwing logger stays a uniform miss',
  );
});

test('a caught value whose classification throws stays a uniform miss', async t => {
  // Classifying a caught value for the log is itself observable: a
  // `getPrototypeOf` trap fires under `instanceof`, and an accessor fires
  // on `.name`. Either throwing must not escape `get` as a distinct
  // rejection.
  await null;
  const hostileProxy = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error('getPrototypeOf trap');
      },
    },
  );
  const hostileError = new Error('absent');
  Object.defineProperty(hostileError, 'name', {
    get: () => {
      throw new Error('name accessor');
    },
  });
  for (const [label, thrown] of [
    ['a Proxy with a throwing getPrototypeOf trap', hostileProxy],
    ['an Error with a throwing name accessor', hostileError],
  ]) {
    const loggedClasses = [];
    const locator = makeFormulaNonceLocator({
      provideLocalFormula: async () => {
        throw thrown;
      },
      isLocalNode: isLocal,
      logger: {
        error: (_message, errorClass) => loggedClasses.push(errorClass),
      },
    });
    // eslint-disable-next-line no-await-in-loop
    t.is(await locator.get(localId), undefined, `${label}: uniform miss`);
    t.deepEqual(loggedClasses, ['Error'], `${label}: logged a generic class`);
  }
});

test('the miss logger receives the error class only, never the caught message', async t => {
  // The non-oracularity argument rests on the miss logger seeing only
  // `error.name`, never `error.message`. A live identifier that misses
  // transiently can carry the presented bearer nonce in its message; a
  // future swap to `error.message` would silently write that secret to
  // the daemon log. Assert the logged arguments carry the class name and
  // never the secret.
  await null;
  const secret = localId;
  const loggedArguments = [];
  const locator = makeFormulaNonceLocator({
    provideLocalFormula: async id => {
      // Reject with the presented secret embedded in the message — the
      // worst case the docstring guards against.
      throw new TypeError(`incarnation failed for ${id}`);
    },
    isLocalNode: isLocal,
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
