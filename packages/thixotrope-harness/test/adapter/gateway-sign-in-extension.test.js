// @ts-check
// The subscription sign-in gateway extension
// (`AH/gateway/extensions/subscription-signin.js`): the loader loads it with
// no skip; only a context given `signInPowers` (by the extension object, in
// `extensionPowers`) makes the service; through a real gateway and a real
// WebSocket a signed-in page finds `subscriptionSignIn` in its extras and
// drives a Claude sign-in with positional arguments past the bridge's key
// and method guards, against a fake provider; the page sees the URL and
// the state, never a token. The extension adds no HTTP route. No
// supervisor.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { gatewayExtension as signInExtension } from '../../resources/agent-host/impl/gateway/extensions/subscription-signin.js';
import { loadGatewayExtensions } from '../../resources/agent-host/impl/gateway/extensions.js';
import { makeGatewayService } from '../../resources/agent-host/impl/gateway/index.js';
import { subscriptionSignInLabel } from '../../resources/agent-host/impl/gateway/protocol.js';
import { makeSignInStore } from '../../resources/agent-host/impl/gateway/signin.js';
import { SECRETS_KEY_VARIABLE } from '../../resources/agent-host/impl/secrets/store.js';
import { connectGateway } from '../integration/_m3-gateway.js';
import { harnessRoot } from '../_helpers.js';
import { startFakeSignInProvider } from '../fixtures/fake-signin-provider.mjs';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const makeStateDir = () => {
  mkdirSync(join(harnessRoot, 'tmp'), { recursive: true });
  const top = mkdtempSync(join(harnessRoot, 'tmp', 'gsi-'));
  const root = join(top, 'state');
  mkdirSync(join(root, 'agent-host'), { recursive: true });
  const keyFile = join(top, 'keys', 'secrets.key');
  return { top, root, env: { [SECRETS_KEY_VARIABLE]: keyFile } };
};

test('the loader loads the sign-in extension: one service, no route, no large call', t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const loaded = loadGatewayExtensions({ log: e => events.push(e) });
  t.deepEqual(
    events.filter(e => e.event === 'gateway-extension-skip'),
    [],
  );
  t.is(
    loaded.find(e => e.name === 'subscription-signin'),
    signInExtension,
  );
  t.deepEqual(
    signInExtension.services?.map(service => service.label),
    [subscriptionSignInLabel],
  );
  t.is(signInExtension.routes, undefined, 'no HTTP or upgrade route');
  t.is(signInExtension.largeCalls, undefined);
});

test('through a real gateway: the page signs a Claude account in; only the URL and the state reach it', async t => {
  const provider = await startFakeSignInProvider();
  t.teardown(provider.close);
  const { top, root, env } = makeStateDir();
  /** @type {Record<string, unknown>[]} */
  const logged = [];
  /** @type {{ secret: any, value: string }[]} */
  const written = [];
  /** @type {any[]} */
  const added = [];
  const secretObject = Far('Secret', {});
  const pool = Far('Backend', {
    describe: () => harden({ kind: 'claude-pool', label: 'Claude pool' }),
  });
  // The page reaches the pool as it does: from the manager, a presence the
  // gateway holds (a page's own object would be refused).
  const subscriptionsAdmin = Far('SubscriptionsAdmin', {
    listPools: () => harden({ pools: [pool] }),
  });
  const secretsAdmin = Far('SecretsAdmin', {
    create: () => secretObject,
    subscriptions: () => subscriptionsAdmin,
  });
  const operator = Far('Operator', { getSecrets: () => secretsAdmin });
  const accounts = Far('Accounts', {
    poolMembers: () => harden([]),
    addMember: (/** @type {any} */ backend, /** @type {any} */ request) => {
      added.push([backend, request]);
      return Far('PoolMember', {});
    },
  });
  // The service's endpoints are the module's defaults; the fake provider
  // answers in their place through the adapter's fetch.
  const fakeFetch = /** @type {typeof fetch} */ (
    (url, init) => {
      const target = new URL(String(url));
      const local =
        target.pathname === '/v1/oauth/token'
          ? provider.claude.tokenUrl
          : String(url);
      return fetch(local, init);
    }
  );
  const service = makeGatewayService({
    live: Far('Live', {}),
    composer: Far('Composer', {}),
    content: Far('Content', {}),
    history: () => Far('History', {}),
    secretWriter: async () =>
      harden({
        replaceLocal: async (
          /** @type {any} */ secret,
          /** @type {string} */ value,
        ) => {
          written.push({ secret, value });
          return { generation: 1 };
        },
        publicKey: async () => '',
      }),
    stateDir: root,
    env,
    log: event => logged.push(event),
    extensionPowers: [
      {
        extension: signInExtension,
        powers: {
          signInPowers: harden({
            accounts: () => accounts,
            memberAccess: async () => {
              throw Error('no members here');
            },
            fetch: fakeFetch,
          }),
        },
      },
    ],
  });
  t.teardown(async () => {
    await service.close();
    rmSync(top, { recursive: true, force: true });
  });
  await service.binding.bind(
    harden({
      config: { port: 0, operator },
      sink: Far('GatewaySink', { attach: () => undefined }),
    }),
  );
  service.attached();
  const port = /** @type {number} */ (service.port());
  const fragment = await makeSignInStore({ stateDir: root, env }).fragment('h');
  const agent = new URLSearchParams(fragment.slice(1)).get('agent') ?? '';
  const origin = `http://127.0.0.1:${port}`;

  // No HTTP route answers for the sign-in: the static handler's 404 or the
  // page, never a sign-in answer.
  const probe = await fetch(`${origin}/subscriptionSignIn`, { method: 'POST' });
  t.true([404, 405].includes(probe.status), String(probe.status));
  await probe.body?.cancel();

  const page = await connectGateway({ port, origin, secret: agent });
  t.teardown(() => page.close());
  const powers = await page.signIn();
  const signIn = powers.extras.find(
    (/** @type {any} */ extra) => extra.label === subscriptionSignInLabel,
  )?.service;
  t.truthy(signIn, 'a signed-in page finds the service');
  const {
    pools: [poolSeen],
  } = await E(E(E(powers.operator).getSecrets()).subscriptions()).listPools();
  const pending = await E(signIn).begin('claude', 'Claude Account 1', poolSeen);
  const view = await E(pending).describe();
  t.is(view.state, 'waiting');
  const authorize = new URL(view.authorizeUrl);
  t.is(authorize.origin, 'https://claude.com');
  // The browser's step: the fake consent page with this URL's parameters.
  const consent = await (
    await fetch(`${provider.claude.authorizeUrl}${authorize.search}`)
  ).json();
  const done = await E(pending).complete(`${consent.code}#${consent.state}`);
  t.is(done.state, 'done', JSON.stringify(done.error));
  t.is(written.length, 1);
  t.is(written[0].secret, secretObject);
  const { accessToken, refreshToken } = JSON.parse(written[0].value);
  const seen = JSON.stringify([view, done, logged]);
  t.false(
    seen.includes(accessToken),
    'no access token reaches the page or a log',
  );
  t.false(seen.includes(refreshToken));
  t.is(added.length, 1);
  t.is(added[0][0], pool);
  t.true(
    logged.some(e => e.event === 'subscription-sign-in' && e.state === 'done'),
  );
});
