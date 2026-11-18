// @ts-check
// M4 W4.6: the sign-in helper and the command-line value path
// (scripts/subscription-login.mjs; designs/m4-interfaces.md 7, 9.1 item 3)
// against the fake OAuth server (127.0.0.1) and a real M2 SecretWriter over
// a Secrets store under H/tmp, reached through a fake control client (the
// shape `provision.mjs` hands out: `client.call('lookup', name)`). Both
// paths write a sealed box, never the value in clear; the stored credential
// parses in the stored form; bad pastes, stale generations, oversize and
// non-text values are refused before anything is written. No supervisor.
import '../unit/_m1a-prelude.js';

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import test from '@endo/ses-ava/test.js';

import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import { makeSealKeys } from '../../resources/agent-host/impl/secrets/seal.js';
import { makeWrappingKey } from '../../resources/agent-host/impl/secrets/wrapping-key.js';
import { parseCredential } from '../../resources/agent-host/impl/subscriptions/credentials.js';
import {
  findSecret,
  readValueFile,
  signIn,
  writeValue,
} from '../../scripts/subscription-login.mjs';
import { startFakeOAuthServer } from '../fixtures/fake-oauth-server.mjs';
import { makeStoreDirs, openStore } from './_m4-renewal.js';

const { E, Far } = /** @type {any} */ (globalThis);

/**
 * A Secrets store with one Secret (`ka`, label `member a`), its M2 writer,
 * and a fake control client whose `SecretsAdmin.openWriter()` answers a
 * recording wrapper of that writer.
 * @param {import('ava').ExecutionContext} t
 */
const setup = async t => {
  const dirs = makeStoreDirs('w46-login');
  t.teardown(dirs.done);
  const store = openStore(dirs.files);
  await store.create('ka', 'member a', 'subscription credential');
  const secret = Far('Secret', {
    describe: async () => {
      const { label, description, generation, state, bytes } =
        await store.describe('ka');
      return harden({ label, description, generation, state, bytes });
    },
  });
  const ops = makeSecretsOps({
    store,
    seal: makeSealKeys({
      wrappingKey: makeWrappingKey({
        keyFile: dirs.files.keyFile,
        stateDir: dirs.files.stateDir,
      }),
    }),
    sink: Far('AgentHostSink', {
      resolveSecrets: (/** @type {any[]} */ handles) =>
        harden(handles.map(h => (h === secret ? 'ka' : null))),
    }),
  });
  const writer = await ops.secretWriter();
  /** @type {any[][]} */
  const replaced = [];
  const recording = Far('SecretWriter', {
    publicKey: () => E(writer).publicKey(),
    replace: (/** @type {any[]} */ ...args) => {
      replaced.push(args);
      return E(writer).replace(...args);
    },
  });
  const secretsAdmin = Far('SecretsAdmin', {
    openWriter: () => recording,
    list: () => harden({ secrets: [secret] }),
  });
  const admin = Far('AgentHostAdmin', { getSecrets: () => secretsAdmin });
  const client = harden({
    call: async (/** @type {string} */ op, /** @type {string} */ name) =>
      op === 'lookup' && name === 'agentHostAdmin' ? admin : undefined,
  });
  return { dirs, store, secret, client, replaced };
};

/**
 * The prompt a test gives `signIn`: fetch the fake consent page, paste its
 * `code#state`.
 * @param {string[]} [seen]
 */
const pasteFromPage =
  (seen = []) =>
  async (/** @type {string} */ page) => {
    seen.push(page);
    const answer = await (await fetch(page)).json();
    return `${answer.code}#${answer.state}`;
  };

test('writeValue seals the value to the adapter key; the store holds it; a stale generation is refused', async t => {
  const s = await setup(t);
  const value = ['a', 'value', 'for', 'the', 'login', 'test'].join(' ');
  const { generation } = await writeValue({
    client: s.client,
    secret: s.secret,
    value,
  });
  t.is((await s.store.read('ka')).value, value);
  t.is(s.replaced.length, 1);
  const [, box] = s.replaced[0];
  t.is(typeof box, 'object', 'a sealed box, not the text');
  t.false(JSON.stringify(s.replaced).includes(value), 'never in clear');
  await t.throwsAsync(
    writeValue({
      client: s.client,
      secret: s.secret,
      value: 'another',
      expectedGeneration: generation - 1,
    }),
    { message: /GENERATION_CONFLICT/ },
  );
  t.is((await s.store.read('ka')).value, value, 'unchanged');
  await t.throwsAsync(
    writeValue({
      client: s.client,
      secret: s.secret,
      value: 'x'.repeat(1_048_577),
    }),
    { message: /at most 1048576 bytes/ },
  );
  t.is(s.replaced.length, 2, 'the oversize value was never sent');
});

test('readValueFile and findSecret: the CLI path reads UTF-8 text only and finds the Secret by label', async t => {
  const s = await setup(t);
  const text = join(s.dirs.root, 'value.txt');
  writeFileSync(text, 'line one\nline two\n');
  t.is(await readValueFile(text), 'line one\nline two\n');
  const binary = join(s.dirs.root, 'value.bin');
  writeFileSync(binary, Buffer.from([0xff, 0xfe, 0x00, 0x80]));
  await t.throwsAsync(readValueFile(binary), { message: /not text/ });
  t.is(await findSecret(s.client, 'member a'), s.secret);
  await t.throwsAsync(findSecret(s.client, 'nobody'), {
    message: /No single Secret/,
  });
});

test('signIn: PKCE code exchange at the token endpoint writes a stored-form credential, sealed', async t => {
  const s = await setup(t);
  const oauth = await startFakeOAuthServer();
  t.teardown(oauth.close);
  /** @type {string[]} */
  const pages = [];
  /** @type {any[]} */
  const tokenBodies = [];
  await signIn({
    client: s.client,
    secret: s.secret,
    provider: 'claude',
    authorizeUrl: oauth.authorizeUrl,
    tokenUrl: oauth.tokenUrl,
    prompt: pasteFromPage(pages),
    fetch: async (url, init) => {
      tokenBodies.push(JSON.parse(String(init?.body)));
      return fetch(url, init);
    },
  });
  const page = new URL(pages[0]);
  t.is(page.searchParams.get('code_challenge_method'), 'S256');
  t.truthy(page.searchParams.get('code_challenge'));
  // M4-FIX: the state is independent of the PKCE verifier, which never
  // appears in the authorization URL.
  t.is(tokenBodies.length, 1);
  const { code_verifier: verifier, state } = tokenBodies[0];
  t.is(typeof verifier, 'string');
  t.is(state, page.searchParams.get('state'));
  t.not(state, verifier);
  t.false(pages[0].includes(verifier), 'no verifier in the URL');
  const stored = (await s.store.read('ka')).value;
  const credential = parseCredential(stored, 'claude');
  t.truthy(credential.accessToken);
  t.truthy(credential.refreshToken);
  t.true(credential.expiresAtMs > Date.now());
  t.true(/** @type {any} */ (credential).scopes.includes('user:inference'));
  t.false(
    JSON.stringify(s.replaced).includes(credential.accessToken),
    'sealed',
  );
  const grants = oauth.requests().filter(r => r.path === '/token');
  t.deepEqual(
    grants.map(r => [r.grant, r.status]),
    [['authorization_code', 200]],
  );
});

test('signIn refuses a paste whose state is not this sign-in, and a Codex sign-in without its pages', async t => {
  const s = await setup(t);
  const oauth = await startFakeOAuthServer();
  t.teardown(oauth.close);
  await t.throwsAsync(
    signIn({
      client: s.client,
      secret: s.secret,
      provider: 'claude',
      authorizeUrl: oauth.authorizeUrl,
      tokenUrl: oauth.tokenUrl,
      prompt: async () => 'somecode#notthestate',
    }),
    { message: /Invalid authorization code or state/ },
  );
  await t.throwsAsync(
    signIn({
      client: s.client,
      secret: s.secret,
      provider: 'codex',
      tokenUrl: oauth.tokenUrl,
      prompt: pasteFromPage(),
    }),
    { message: /needs --authorize-url/ },
  );
  t.is(oauth.requests().filter(r => r.path === '/token').length, 0);
  t.is(s.replaced.length, 0, 'nothing written');
});
