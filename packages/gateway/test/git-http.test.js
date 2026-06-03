// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

import { E, Far } from '@endo/far';

import { btoa } from '@endo/base64';

import {
  GIT_HTTP_PATH_PREFIX,
  GIT_SERVICES,
  isGitHttpPath,
  makeGateway,
  makeGitHttpHandler,
  parseAuthorizationHeader,
  parseGitHttpPath,
  parseServiceQuery,
  readerFromBuffer,
} from '../index.js';

import { makeNodeCryptoPowers } from '../src/node-crypto-powers.js';

const makeFakeClock = (initial = 0) => {
  let now = initial;
  return harden({
    now: () => now,
    advance: ms => {
      now += ms;
    },
  });
};

// -- Path matcher --------------------------------------------------

test('isGitHttpPath recognizes /git/<repo-id> and rejects bare /git', t => {
  const hex = 'a'.repeat(64);
  t.true(isGitHttpPath(`/git/${hex}`));
  t.true(isGitHttpPath(`/git/${hex}/info/refs`));
  t.true(isGitHttpPath(`/git/${hex}/git-upload-pack`));
  t.false(isGitHttpPath('/git'));
  t.false(isGitHttpPath('/git/'));
  t.false(isGitHttpPath('/'));
  t.false(isGitHttpPath('/gitfoo'));
  t.false(isGitHttpPath('/foo/git/bar'));
  t.false(isGitHttpPath(/** @type {any} */ (undefined)));
  t.false(isGitHttpPath(/** @type {any} */ (null)));
});

test('GIT_HTTP_PATH_PREFIX is /git/', t => {
  t.is(GIT_HTTP_PATH_PREFIX, '/git/');
});

test('GIT_SERVICES enumerates the two smart-HTTP commands', t => {
  t.deepEqual(GIT_SERVICES, harden(['git-upload-pack', 'git-receive-pack']));
});

// -- parseGitHttpPath ---------------------------------------------

const HEX64 = 'a'.repeat(64);
const HEX64_B = 'b'.repeat(64);

test('parseGitHttpPath extracts repo-id and operation from canonical paths', t => {
  t.deepEqual(
    parseGitHttpPath(`/git/${HEX64}/info/refs`),
    harden({ repoId: HEX64, operation: 'info/refs' }),
  );
  t.deepEqual(
    parseGitHttpPath(`/git/${HEX64}/git-upload-pack`),
    harden({ repoId: HEX64, operation: 'git-upload-pack' }),
  );
  t.deepEqual(
    parseGitHttpPath(`/git/${HEX64}/git-receive-pack`),
    harden({ repoId: HEX64, operation: 'git-receive-pack' }),
  );
});

test('parseGitHttpPath accepts <number>:<node> formula-id form', t => {
  const fullId = `${HEX64}:${HEX64_B}`;
  t.deepEqual(
    parseGitHttpPath(`/git/${fullId}/info/refs`),
    harden({ repoId: fullId, operation: 'info/refs' }),
  );
});

test('parseGitHttpPath rejects malformed repo-ids', t => {
  t.is(parseGitHttpPath('/git/xyz/info/refs'), undefined);
  // Uppercase hex is not accepted; lowercase only matches the formula-id pattern.
  const upper = 'A'.repeat(64);
  t.is(parseGitHttpPath(`/git/${upper}/info/refs`), undefined);
  t.is(parseGitHttpPath(`/git/${HEX64.slice(0, 63)}/info/refs`), undefined); // too short
});

test('parseGitHttpPath rejects unrecognized operations', t => {
  t.is(parseGitHttpPath(`/git/${HEX64}/refs`), undefined);
  t.is(parseGitHttpPath(`/git/${HEX64}/info/packs`), undefined);
  t.is(parseGitHttpPath(`/git/${HEX64}/git-archive`), undefined);
});

test('parseGitHttpPath rejects non-Git paths', t => {
  t.is(parseGitHttpPath('/foo'), undefined);
  t.is(parseGitHttpPath('/git'), undefined);
  t.is(parseGitHttpPath('/git/'), undefined);
  t.is(parseGitHttpPath(/** @type {any} */ (undefined)), undefined);
});

// -- parseServiceQuery --------------------------------------------

test('parseServiceQuery extracts the service= parameter', t => {
  t.is(parseServiceQuery('service=git-upload-pack'), 'git-upload-pack');
  t.is(parseServiceQuery('service=git-receive-pack'), 'git-receive-pack');
});

test('parseServiceQuery finds service= anywhere in the query', t => {
  t.is(parseServiceQuery('foo=bar&service=git-upload-pack'), 'git-upload-pack');
  t.is(
    parseServiceQuery('service=git-receive-pack&extra=x'),
    'git-receive-pack',
  );
});

test('parseServiceQuery rejects unknown or missing service', t => {
  t.is(parseServiceQuery(''), undefined);
  t.is(parseServiceQuery('service=git-archive'), undefined);
  t.is(parseServiceQuery('foo=bar'), undefined);
  t.is(parseServiceQuery(/** @type {any} */ (undefined)), undefined);
});

// -- parseAuthorizationHeader -------------------------------------

test('parseAuthorizationHeader extracts Bearer token', t => {
  t.is(parseAuthorizationHeader(`Bearer ${HEX64}`), HEX64);
  t.is(parseAuthorizationHeader(`bearer ${HEX64}`), HEX64); // case-insensitive scheme
  t.is(parseAuthorizationHeader(`BEARER ${HEX64}`), HEX64);
});

test('parseAuthorizationHeader extracts Basic token with empty username', t => {
  // base64 of `:<token>` is the empty-user form.
  const basicCreds = btoa(`:${HEX64}`);
  t.is(parseAuthorizationHeader(`Basic ${basicCreds}`), HEX64);
  t.is(parseAuthorizationHeader(`basic ${basicCreds}`), HEX64);
});

test('parseAuthorizationHeader rejects Basic with non-empty username', t => {
  // git-cli convention is empty username; user:token would silently
  // ignore the username, which we refuse to do.
  const basicCreds = btoa(`user:${HEX64}`);
  t.is(parseAuthorizationHeader(`Basic ${basicCreds}`), undefined);
});

test('parseAuthorizationHeader rejects malformed inputs', t => {
  t.is(parseAuthorizationHeader(undefined), undefined);
  t.is(parseAuthorizationHeader(''), undefined);
  t.is(parseAuthorizationHeader('Bearer'), undefined); // no token
  t.is(parseAuthorizationHeader('Bearer '), undefined); // empty token
  t.is(parseAuthorizationHeader('Token foo'), undefined); // wrong scheme
  t.is(parseAuthorizationHeader('Basic !@#$%'), undefined); // not base64
  t.is(parseAuthorizationHeader(`Basic ${btoa('notoken')}`), undefined); // no colon
  t.is(parseAuthorizationHeader(`Basic ${btoa(':')}`), undefined); // empty token
});

// -- Factory shape ------------------------------------------------

test('makeGitHttpHandler requires a resolveRepo function', t => {
  t.throws(() => makeGitHttpHandler(/** @type {any} */ ({})), {
    message: /requires a resolveRepo function/,
  });
  t.throws(() => makeGitHttpHandler(/** @type {any} */ ({ resolveRepo: 42 })), {
    message: /requires a resolveRepo function/,
  });
});

// -- Request shape validation -------------------------------------

/**
 * Build a stub `resolveRepo` that returns the same repo capability
 * regardless of input. Used by tests that exercise the happy path.
 *
 * @param {object} responses
 * @param {(args: { service: string, headers: ReadonlyArray<readonly [string, string]> }) => Promise<any>} [responses.infoRefs]
 * @param {(args: { requestBody: Uint8Array, headers: ReadonlyArray<readonly [string, string]> }) => Promise<any>} [responses.gitUploadPack]
 * @param {(args: { requestBody: Uint8Array, headers: ReadonlyArray<readonly [string, string]> }) => Promise<any>} [responses.gitReceivePack]
 */
const makeStubRepo = responses => {
  return Far('Repo', {
    infoRefs:
      responses.infoRefs ||
      (async () =>
        harden({
          status: 200,
          headers: [
            /** @type {readonly [string, string]} */ ([
              'content-type',
              'application/x-git-upload-pack-advertisement',
            ]),
          ],
          body: new TextEncoder().encode('001e# service=git-upload-pack\n0000'),
        })),
    gitUploadPack:
      responses.gitUploadPack ||
      (async () =>
        harden({
          status: 200,
          headers: [
            /** @type {readonly [string, string]} */ ([
              'content-type',
              'application/x-git-upload-pack-result',
            ]),
          ],
          body: new TextEncoder().encode('packfile-bytes'),
        })),
    gitReceivePack:
      responses.gitReceivePack ||
      (async () =>
        harden({
          status: 200,
          headers: [
            /** @type {readonly [string, string]} */ ([
              'content-type',
              'application/x-git-receive-pack-result',
            ]),
          ],
          body: new TextEncoder().encode('unpack ok\n'),
        })),
  });
};

test('handleRequest rejects non-object input', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => undefined,
  });
  await t.throwsAsync(E(handler).handleRequest(/** @type {any} */ (null)), {
    message: /expects a request object/,
  });
});

test('handleRequest rejects missing method / path / headers / body', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => undefined,
  });
  await t.throwsAsync(
    E(handler).handleRequest(
      /** @type {any} */ ({
        path: '/git/x',
        headers: [],
        body: new Uint8Array(0),
      }),
    ),
    { message: /method must be a non-empty string/ },
  );
  await t.throwsAsync(
    E(handler).handleRequest(
      /** @type {any} */ ({
        method: 'GET',
        headers: [],
        body: new Uint8Array(0),
      }),
    ),
    { message: /path must be a non-empty string/ },
  );
  await t.throwsAsync(
    E(handler).handleRequest(
      /** @type {any} */ ({
        method: 'GET',
        path: '/git/x',
        headers: 'no',
        body: new Uint8Array(0),
      }),
    ),
    { message: /headers must be an array/ },
  );
  await t.throwsAsync(
    E(handler).handleRequest(
      /** @type {any} */ ({
        method: 'GET',
        path: '/git/x',
        headers: [],
        body: 'no',
      }),
    ),
    { message: /body must be a Uint8Array/ },
  );
});

// -- URL routing ---------------------------------------------------

test('handleRequest 400s on non-Git paths', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => makeStubRepo({}),
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: '/foo/bar',
      headers: [],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 400);
});

test('handleRequest 400s on malformed repo-id', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => makeStubRepo({}),
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: '/git/xyz/info/refs',
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 400);
});

test('handleRequest 400s when method mismatches operation', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => makeStubRepo({}),
  });
  // info/refs requires GET
  const r1 = await E(handler).handleRequest(
    harden({
      method: 'POST',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [],
      body: new Uint8Array(0),
    }),
  );
  t.is(r1.status, 400);
  // git-upload-pack requires POST
  const r2 = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/git-upload-pack`,
      headers: [],
      body: new Uint8Array(0),
    }),
  );
  t.is(r2.status, 400);
});

test('handleRequest 400s on info/refs without service query', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => makeStubRepo({}),
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      headers: [],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 400);
});

// -- Authorization parsing ----------------------------------------

test('handleRequest 401s on missing Authorization header', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => makeStubRepo({}),
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 401);
  // The challenge header should name both schemes the handler accepts.
  const wwwAuth = resp.headers.find(([k]) => k === 'www-authenticate');
  t.truthy(wwwAuth);
  if (wwwAuth) {
    t.regex(wwwAuth[1], /Bearer/);
    t.regex(wwwAuth[1], /Basic/);
  }
});

test('handleRequest 401s on malformed token (not a formula id)', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => makeStubRepo({}),
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          'Bearer not-a-formula-id',
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 401);
});

test('handleRequest 401s when resolveRepo returns undefined', async t => {
  let calls = 0;
  const handler = makeGitHttpHandler({
    resolveRepo: async () => {
      calls += 1;
      return undefined;
    },
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64_B}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 401);
  t.is(calls, 1);
});

test('handleRequest 500s when resolveRepo throws', async t => {
  const handler = makeGitHttpHandler({
    resolveRepo: async () => {
      throw new Error('boom');
    },
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64_B}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 500);
});

// -- Happy paths --------------------------------------------------

test('handleRequest forwards info/refs to the repo capability', async t => {
  /** @type {Array<{ service: string }>} */
  const seen = [];
  const repo = makeStubRepo({
    infoRefs: async args => {
      seen.push({ service: args.service });
      return harden({
        status: 200,
        headers: [
          /** @type {readonly [string, string]} */ ([
            'content-type',
            'application/x-git-upload-pack-advertisement',
          ]),
        ],
        body: new TextEncoder().encode('refs-advertisement'),
      });
    },
  });
  /** @type {Array<{ token: string, repoId: string }>} */
  const resolveCalls = [];
  const handler = makeGitHttpHandler({
    resolveRepo: async args => {
      resolveCalls.push({ token: args.token, repoId: args.repoId });
      return repo;
    },
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64_B}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 200);
  t.is(resolveCalls.length, 1);
  t.is(resolveCalls[0].token, HEX64_B);
  t.is(resolveCalls[0].repoId, HEX64);
  t.is(seen.length, 1);
  t.is(seen[0].service, 'git-upload-pack');
});

test('handleRequest forwards git-upload-pack POST body to the repo capability', async t => {
  const requestBody = new TextEncoder().encode('want abc\nhave def\n');
  /** @type {Uint8Array | undefined} */
  let seenBody;
  const repo = makeStubRepo({
    gitUploadPack: async args => {
      seenBody = args.requestBody;
      return harden({
        status: 200,
        headers: [],
        body: new TextEncoder().encode('packfile'),
      });
    },
  });
  const handler = makeGitHttpHandler({
    resolveRepo: async () => repo,
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'POST',
      path: `/git/${HEX64}/git-upload-pack`,
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64_B}`,
        ]),
        /** @type {readonly [string, string]} */ ([
          'content-type',
          'application/x-git-upload-pack-request',
        ]),
      ],
      body: requestBody,
    }),
  );
  t.is(resp.status, 200);
  t.deepEqual(seenBody, requestBody);
});

test('handleRequest forwards git-receive-pack POST body to the repo capability', async t => {
  const requestBody = new TextEncoder().encode('push commands + pack\n');
  /** @type {Uint8Array | undefined} */
  let seenBody;
  const repo = makeStubRepo({
    gitReceivePack: async args => {
      seenBody = args.requestBody;
      return harden({
        status: 200,
        headers: [],
        body: new TextEncoder().encode('unpack ok\n'),
      });
    },
  });
  const handler = makeGitHttpHandler({
    resolveRepo: async () => repo,
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'POST',
      path: `/git/${HEX64}/git-receive-pack`,
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64_B}`,
        ]),
      ],
      body: requestBody,
    }),
  );
  t.is(resp.status, 200);
  t.deepEqual(seenBody, requestBody);
});

test('handleRequest accepts Basic auth with empty user', async t => {
  /** @type {string | undefined} */
  let seenToken;
  const handler = makeGitHttpHandler({
    resolveRepo: async args => {
      seenToken = args.token;
      return makeStubRepo({});
    },
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Basic ${btoa(`:${HEX64_B}`)}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 200);
  t.is(seenToken, HEX64_B);
});

test('handleRequest 500s when the repo capability throws', async t => {
  const repo = Far('Repo', {
    infoRefs: async () => {
      throw new Error('repo broke');
    },
    gitUploadPack: async () => {
      throw new Error('repo broke');
    },
    gitReceivePack: async () => {
      throw new Error('repo broke');
    },
  });
  const handler = makeGitHttpHandler({
    resolveRepo: async () => repo,
  });
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${HEX64_B}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  t.is(resp.status, 500);
});

// -- readerFromBuffer ---------------------------------------------

test('readerFromBuffer yields the buffer once then signals done', async t => {
  const view = new Uint8Array([1, 2, 3, 4]);
  const buf = view;
  const reader = readerFromBuffer(buf);
  const r1 = await E(reader).next();
  t.false(r1.done);
  t.deepEqual(r1.value, view);
  const r2 = await E(reader).next();
  t.true(r2.done);
});

test('readerFromBuffer rejects non-Uint8Array input', t => {
  t.throws(() => readerFromBuffer(/** @type {any} */ ('not bytes')), {
    message: /expects a Uint8Array/,
  });
});

// -- makeGateway wiring -------------------------------------------

test('makeGateway exposes getGitHttpHandler when gitHttp is enabled', async t => {
  // gitHttp is on by default but requires the resolveRepo power.
  // Test the both-on path; the toggle-off path is covered separately.
  const gateway = makeGateway({
    powers: harden({
      env: {},
      crypto: makeNodeCryptoPowers(),
      clock: makeFakeClock(),
      resolveRepo: async () => undefined,
    }),
  });
  const handler = await E(gateway).getGitHttpHandler();
  t.truthy(handler);
});

test('makeGateway throws when gitHttp is on but resolveRepo is missing', t => {
  t.throws(
    () =>
      makeGateway({
        powers: harden({
          env: {},
          crypto: makeNodeCryptoPowers(),
          clock: makeFakeClock(),
        }),
      }),
    { message: /gitHttp requires powers.resolveRepo/ },
  );
});

test('makeGateway getGitHttpHandler throws when gitHttp is off', async t => {
  const gateway = makeGateway({
    powers: harden({
      env: {},
      crypto: makeNodeCryptoPowers(),
      clock: makeFakeClock(),
    }),
    config: harden({
      enableFeatures: harden({
        ...{
          chatHosting: true,
          virtualHosting: true,
          gitHttp: false,
          sockBootstrap: true,
          captpRelay: false,
          adminDaemon: true,
          ocapnWebSocket: true,
        },
      }),
    }),
  });
  await t.throwsAsync(E(gateway).getGitHttpHandler(), {
    message: /Git smart-HTTP handler is disabled/,
  });
});

// -- Regression coverage: token discrimination --------------------

test('handleRequest does not confuse Bearer hex with Basic hex', async t => {
  // The Bearer/Basic dispatch is on the scheme keyword, not the
  // shape of the credentials. A literal `Bearer abc` whose `abc`
  // happens to base64-decode to `:hex` must still be parsed as
  // Bearer (and reject the malformed-hex token), not as Basic.
  /** @type {string | undefined} */
  let seenToken;
  const handler = makeGitHttpHandler({
    resolveRepo: async args => {
      seenToken = args.token;
      return makeStubRepo({});
    },
  });
  // The bearer credentials are not a formula id, so we expect 401.
  const looksLikeBase64 = btoa(`:${HEX64}`);
  const resp = await E(handler).handleRequest(
    harden({
      method: 'GET',
      path: `/git/${HEX64}/info/refs`,
      query: 'service=git-upload-pack',
      headers: [
        /** @type {readonly [string, string]} */ ([
          'authorization',
          `Bearer ${looksLikeBase64}`,
        ]),
      ],
      body: new Uint8Array(0),
    }),
  );
  // Bearer takes the credentials verbatim; that's not a 64-hex
  // formula id (it's base64), so the handler 401s before calling
  // resolveRepo. seenToken stays undefined.
  t.is(resp.status, 401);
  t.is(seenToken, undefined);
});
