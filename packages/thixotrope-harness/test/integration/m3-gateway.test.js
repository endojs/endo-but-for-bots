// @ts-check
/**
 * M3 acceptance 1, 2, 10, 11 and 16, kill points K1 and K2
 * (designs/m3-interfaces.md 7, 12; W3.7) through the daemon: the gateway is
 * served by `GatewayAdmin.serve` on a state copied from the m1a template,
 * and a Node CapTP client talks to it over a real loopback WebSocket, as a
 * page does (`_m3-gateway.js`).
 *
 * 1. HTTP: every non-upgrade GET answers the shell (or, before the UI is
 *    built, 503 with its text) with the CSP header; an upgrade on `/ws`
 *    with the configured Origin opens, another Origin is refused 403,
 *    another path 404; a query carrying `agent` or `gateway` is refused 400.
 * 2. Sign-in: the secret yields the powers; a wrong one is refused and the
 *    next attempt within 1,000 ms gets the R7-49 text; behind a trusted
 *    proxy, one forwarded address's failures do not delay another; an
 *    untrusted peer's X-Forwarded-For is ignored; 21 failures a minute trip
 *    the ceiling.
 * 10. Refusals before decode: a 100 KiB argument, 2,000 invented keys, a
 *    page-made object, a `createSession` whose `networkPolicy` has invented
 *    keys; the session and the factory keep working and no worker's
 *    journal grows for the refused calls.
 * 16. A fixture extension (copied into `GW/extensions/` before the daemon
 *    starts, removed at teardown) adds a service, a route and a CSP source;
 *    its `context.secretWriter()` is the gateway's in-process writer the
 *    page finds in its extras (`secretWriterLabel`), not the hub's
 *    SealedBox-only `SecretsAdmin.openWriter()` (A-11, XA); a throwing
 *    extension file is skipped.
 * 11. Rotation closes pages with `signInRotated`, the old secret fails and
 *    the new one (`scripts/gateway.mjs url`) works; after SIGKILL the
 *    gateway serves again on the same port with the same secret; K1: a
 *    SIGKILL after `serve`'s register crank, while the adapter binds,
 *    still serves after restart; K2: SIGKILLs inside `rotateSignIn` leave
 *    exactly one valid secret.
 *
 * Runs only with THIX_HARNESS_INTEGRATION=1, under the run lock:
 *
 *   corepack yarn test:integration test/integration/m3-gateway.test.js
 */
/* eslint-disable no-await-in-loop -- each step waits for the previous one */
import '../unit/_m1a-prelude.js';

import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import test from 'ava';

import { E, Far } from '@endo/far';

/* eslint-disable import/no-relative-packages */
import { m3Texts } from '../../guest/lib/interfaces-m3.js';
/* eslint-enable import/no-relative-packages */
import {
  closeCodes,
  gatewayTexts,
  secretWriterLabel,
} from '../../resources/agent-host/impl/gateway/protocol.js';
import { signInFile } from '../../resources/agent-host/impl/gateway/signin.js';
import { emit } from '../../perf/_harness.mjs';
import { sliceScript } from '../fixtures/scripts/m1a-slice.js';
import {
  harnessRoot,
  integrationEnabled,
  startFromTemplate,
  supervisorEnv,
  takeIntegrationLock,
} from '../template/index.js';
import { makeSlice, round1, sliceTemplate, waitFor } from './_m1a-slice.js';
import {
  connectGateway,
  freePort,
  gatewayAdminOf,
  readSignIn,
  secretOf,
  serveGateway,
  useTestWrappingKey,
} from './_m3-gateway.js';

takeIntegrationLock(test, 'm3 gateway test');

const run = integrationEnabled ? test.serial : test.skip;

const extensionsDir = path.join(
  harnessRoot,
  'resources/agent-host/impl/gateway/extensions',
);
const fixtureDir = path.join(harnessRoot, 'test/fixtures/gateway-extension');
/** The copies acceptance 16 puts in `GW/extensions/` (removed after). */
const copies = [
  ['fixture.js', 'm3-test-fixture.js'],
  ['throwing.js', 'm3-test-throwing.js'],
].map(([from, to]) => ({
  from: path.join(fixtureDir, from),
  to: path.join(extensionsDir, to),
}));

/**
 * Status of an upgrade request (101 when it opened).
 * @param {{ port: number, path: string, origin: string }} options
 * @returns {Promise<{ status: number, body: string }>}
 */
const upgradeStatus = ({ port, path: target, origin }) =>
  new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: target,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': Buffer.from('0123456789abcdef').toString('base64'),
        Origin: origin,
      },
    });
    req.on('upgrade', (_response, socket) => {
      socket.destroy();
      resolve({ status: 101, body: '' });
    });
    req.on('response', response => {
      let body = '';
      response.on('data', chunk => {
        body += chunk;
      });
      response.on('end', () =>
        resolve({ status: response.statusCode ?? 0, body }),
      );
    });
    req.on('error', reject);
    req.end();
  });

/**
 * A wrong secret built at run time (never a real one).
 * @param {string} tag
 */
const wrongSecret = tag => ['wrong', tag].join('-');

/** @type {Awaited<ReturnType<typeof startFromTemplate>> | undefined} */
let state;
/** @type {Awaited<ReturnType<typeof serveGateway>> | undefined} */
let gateway;

/**
 * Serve again (port 0 unless given): a fresh limiter, since every bind
 * makes its own.
 * @param {Parameters<typeof serveGateway>[1]} [options]
 */
const reserve = async options => {
  if (state === undefined) throw Error('no state');
  gateway = await serveGateway(state, {
    ...options,
    secretsKeyFile: wrappingKey?.file,
  });
  return gateway;
};

/** @type {ReturnType<typeof useTestWrappingKey> | undefined} */
let wrappingKey;
test.after.always(async () => {
  await state?.cleanup();
  for (const { to } of copies) rmSync(to, { force: true });
  wrappingKey?.remove();
});

run('setup: fixture extension, wrapping key, served state', async t => {
  const t0 = performance.now();
  // Before the daemon starts: the adapter loads extensions when it is made.
  for (const { from, to } of copies) copyFileSync(from, to);
  wrappingKey = useTestWrappingKey('m3gw');
  const template = await sliceTemplate();
  state = await startFromTemplate(template, {
    secretsKeyFile: wrappingKey.file,
  });
  const served = await reserve();
  t.is(served.status.state, 'serving');
  t.regex(served.secret, /^[0-9a-f]{64}$/);
  emit({
    metric: 'm3.gateway.setup',
    templateBuilt: template.built,
    buildMs: template.buildMs,
    startMs: state.timings.totalMs,
    totalMs: round1(performance.now() - t0),
  });
});

run('acceptance 1: shell, CSP, upgrade rules, query refusal', async t => {
  if (!gateway) throw Error('setup failed');
  const base = `http://127.0.0.1:${gateway.port}`;
  for (const target of ['/', '/some/page', '/sessions/x']) {
    const response = await fetch(`${base}${target}`);
    const csp = response.headers.get('content-security-policy') ?? '';
    t.true(csp.includes("default-src 'none'"), `CSP on ${target}`);
    t.is(response.headers.get('x-content-type-options'), 'nosniff');
    if (response.status === 200) {
      t.is(response.headers.get('cache-control'), 'no-cache');
      const html = await response.text();
      const asset = /\/assets\/[^"'\s]+/.exec(html)?.[0];
      if (asset !== undefined) {
        const file = await fetch(`${base}${asset}`);
        t.is(file.status, 200);
        t.is(
          file.headers.get('cache-control'),
          'public, max-age=31536000, immutable',
        );
        t.truthy(file.headers.get('content-type'));
      }
    } else {
      // W3.4's build output is not in GW/assets/: the shell's stand-in.
      t.is(response.status, 503);
      t.is(await response.text(), gatewayTexts.uiNotBuilt);
      t.log('UI not built: shell and asset rows checked as 503');
    }
  }
  const query = await fetch(`${base}/?agent=${wrongSecret('q')}`);
  t.is(query.status, 400);
  t.is(await query.text(), gatewayTexts.queryConfig);
  const query2 = await fetch(`${base}/x?gateway=h`);
  t.is(query2.status, 400);

  const good = await upgradeStatus({
    port: gateway.port,
    path: '/ws',
    origin: gateway.origin,
  });
  t.is(good.status, 101);
  const foreign = await upgradeStatus({
    port: gateway.port,
    path: '/ws',
    origin: 'http://127.0.0.2:1',
  });
  t.is(foreign.status, 403);
  t.is(foreign.body, gatewayTexts.originRefused);
  const elsewhere = await upgradeStatus({
    port: gateway.port,
    path: '/other',
    origin: gateway.origin,
  });
  t.is(elsewhere.status, 404);
});

run('acceptance 2: sign-in, penalty, proxies, ceiling', async t => {
  if (!gateway) throw Error('setup failed');
  // The powers.
  const page = await gateway.connect();
  const { powers } = page;
  t.deepEqual(Object.keys(powers).sort(), [
    'composer',
    'content',
    'extras',
    'history',
    'live',
    'operator',
  ]);
  const factory = await E(powers.operator).getFactory();
  t.truthy(await E(factory).listSessions(harden({ limit: 5 })));
  page.close();

  // A wrong secret, then an attempt within 1,000 ms.
  const t0 = performance.now();
  const stranger = await gateway.connect({ signIn: false });
  await t.throwsAsync(() => stranger.signIn(wrongSecret('a')), {
    message: m3Texts.signInRefused,
  });
  await t.throwsAsync(() => stranger.signIn(gateway?.secret), {
    message: /^Rate limit exceeded, try in \d+ms$/,
  });
  t.true(performance.now() - t0 < 1000, 'both attempts inside the penalty');
  stranger.close();

  // Without trusted proxies, X-Forwarded-For is ignored: the peer is one
  // address.
  const spoofA = await gateway.connect({
    signIn: false,
    headers: { 'X-Forwarded-For': '127.0.0.5' },
  });
  await delay(1100);
  await t.throwsAsync(() => spoofA.signIn(wrongSecret('b')), {
    message: m3Texts.signInRefused,
  });
  const spoofB = await gateway.connect({
    signIn: false,
    headers: { 'X-Forwarded-For': '127.0.0.6' },
  });
  await t.throwsAsync(() => spoofB.signIn(wrongSecret('c')), {
    message: /^Rate limit exceeded/,
  });
  spoofA.close();
  spoofB.close();

  // Behind a trusted proxy (the loopback peer), each forwarded client is
  // its own address.
  const proxied = await reserve({ trustedProxies: ['127.0.0.1'] });
  /** @param {string} address */
  const from = address =>
    proxied.connect({
      signIn: false,
      headers: { 'X-Forwarded-For': address },
    });
  const a = await from('127.0.0.7');
  const b = await from('127.0.0.8');
  await t.throwsAsync(() => a.signIn(wrongSecret('d')), {
    message: m3Texts.signInRefused,
  });
  await t.throwsAsync(() => b.signIn(wrongSecret('e')), {
    message: m3Texts.signInRefused,
  });
  await t.throwsAsync(() => a.signIn(proxied.secret), {
    message: /^Rate limit exceeded/,
  });
  a.close();
  b.close();

  // The global ceiling: 21 failures in a minute from 21 addresses, then
  // even the right secret from a new address is refused.
  const ceiling = await reserve({ trustedProxies: ['127.0.0.1'] });
  for (let i = 0; i < 21; i += 1) {
    const client = await connectGateway({
      port: ceiling.port,
      origin: ceiling.origin,
      headers: { 'X-Forwarded-For': `127.0.1.${i + 1}` },
    });
    await t.throwsAsync(() => client.signIn(wrongSecret(`f${i}`)), {
      message: m3Texts.signInRefused,
    });
    client.close();
  }
  const late = await connectGateway({
    port: ceiling.port,
    origin: ceiling.origin,
    headers: { 'X-Forwarded-For': '127.0.2.1' },
  });
  await t.throwsAsync(() => late.signIn(ceiling.secret), {
    message: m3Texts.signInCeiling,
  });
  late.close();
  await reserve();
});

run(
  'acceptance 16: fixture extension service, route, CSP, secretWriter',
  async t => {
    if (!gateway) throw Error('setup failed');
    const { powers } = await gateway.connect();
    const labels = powers.extras.map((/** @type {any} */ x) => x.label);
    t.deepEqual(
      labels,
      [secretWriterLabel, 'fixture', 'speech'],
      'built-in first',
    );
    const fixture = powers.extras.find(
      (/** @type {any} */ x) => x.label === 'fixture',
    ).service;
    t.is(await E(fixture).ping(), 'pong');
    // Its large-call exemption (resolved after the attach).
    t.is(await E(fixture).echoLarge('L'.repeat(100_000)), 100_000);
    const writer = powers.extras.find(
      (/** @type {any} */ x) => x.label === secretWriterLabel,
    ).service;
    t.true(await E(fixture).sameWriter(writer), "the gateway's own writer");
    const secrets = await E(powers.operator).getSecrets();
    const hubWriter = await E(secrets).openWriter();
    t.false(
      await E(fixture).sameWriter(hubWriter),
      "not the hub's SealedBox-only writer",
    );
    const route = await fetch(`http://127.0.0.1:${gateway.port}/fixture`);
    t.is(route.status, 200);
    t.is(await route.text(), 'fixture route');
    const csp = route.headers.get('content-security-policy') ?? '';
    t.regex(csp, /img-src [^;]*blob:/);
    // The throwing file was skipped; the gateway serves (this test ran).
  },
);

run('acceptance 10: refusals before decode; vats untouched', async t => {
  if (!gateway || !state) throw Error('setup failed');
  const slice = await makeSlice(state);
  const made = await slice.makeBackend(harden(sliceScript));
  // The page must reach the backend through its own factory: a presence
  // of the control client would be a page-made object to the gateway.
  await E(slice.harness).configure(harden({ backends: [made.backend] }));
  const { powers } = await gateway.connect();
  const factory = await E(powers.operator).getFactory();
  const [preset] = await E(factory).listPresets();
  const [backend] = await E(factory).listBackends();
  const session = await E(factory).createSession(
    harden({ title: 'refusals', preset, backend, at: Date.now() }),
  );
  await E(session).getInfo();
  const frontier = async () =>
    (await slice.workers())
      .map((/** @type {any} */ w) => Number(w.journalLength ?? 0))
      .reduce((sum, n) => sum + n, 0);
  const before = await frontier();

  await t.throwsAsync(() => E(session).rename('x'.repeat(100 * 1024)), {
    message: gatewayTexts.messageTooLarge,
  });
  /** @type {Record<string, number>} */
  const invented = {};
  for (let i = 0; i < 2000; i += 1) invented[`k${i}`] = i;
  await t.throwsAsync(() => E(session).rename(harden(invented)), {
    message: gatewayTexts.unexpectedField,
  });
  await t.throwsAsync(() => E(session).rename(Far('PageThing', {})), {
    message: gatewayTexts.browserObject,
  });
  await t.throwsAsync(
    () =>
      E(factory).createSession(
        harden({
          title: 'policy',
          preset,
          backend,
          at: Date.now(),
          networkPolicy: { inventedPolicyKey: true },
        }),
      ),
    { message: gatewayTexts.unexpectedField },
  );
  const after = await frontier();
  t.is(after, before, 'no worker journal grew for the refused calls');

  await E(session).rename('still works');
  t.is((await E(session).getInfo()).title, 'still works');
  const page = await E(factory).listSessions(harden({ limit: 10 }));
  t.true(Number(page.rows.length) >= 1);
});

run('acceptance 11, K1, K2: rotation, SIGKILL, restore', async t => {
  t.timeout(5 * 60_000);
  if (!state) throw Error('setup failed');
  const served = state;
  const port = await freePort();
  const current = await reserve({ port });
  t.is(current.port, port);

  // Rotation closes open pages; old fails, new (from the CLI) works.
  const open = await current.connect();
  await E(current.admin).rotateSignIn();
  t.is((await open.closed).code, closeCodes.signInRotated);
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [path.join(harnessRoot, 'scripts/gateway.mjs'), 'url', served.root],
    { env: supervisorEnv({ secretsKeyFile: wrappingKey?.file }) },
  );
  const rotated = secretOf(stdout.trim());
  t.not(rotated, current.secret);
  t.true(stdout.startsWith(`${current.origin}/#gateway=127.0.0.1:${port}&`));
  const oldPage = await current.connect({ signIn: false });
  await t.throwsAsync(() => oldPage.signIn(current.secret), {
    message: m3Texts.signInRefused,
  });
  oldPage.close();
  await delay(1100);
  const newPage = await current.connect({ secret: rotated });
  t.truthy(newPage.powers.operator);
  newPage.close();

  /** After a restart: wait until the restored gateway serves `port`. */
  const untilServing = async () => {
    const t0 = performance.now();
    const { admin } = await gatewayAdminOf(served);
    const status = await waitFor(
      async () => {
        const s = await E(admin).status();
        return s.state === 'serving' ? s : undefined;
      },
      60_000,
      'the restored gateway',
      100,
    );
    return { status, admin, ms: round1(performance.now() - t0) };
  };
  /** @param {string} secret */
  const signsIn = async secret => {
    const page = await connectGateway({
      port,
      origin: `http://127.0.0.1:${port}`,
    }).catch(() => undefined);
    if (page === undefined) return false;
    try {
      await page.signIn(secret);
      return true;
    } catch {
      return false;
    } finally {
      page.close();
    }
  };

  // SIGKILL and restart: same port, same secret.
  await served.kill();
  const restart1 = await served.restart();
  const back = await untilServing();
  t.is(back.status.port, port);
  t.true(await signsIn(rotated), 'the rotated secret survives SIGKILL');
  emit({
    metric: 'm3.gateway.sigkillRestore',
    servedMs: restart1.servedMs,
    servingMs: back.ms,
  });

  // K1: stop, then SIGKILL while the adapter binds the new registration.
  await E(back.admin).stop();
  const marker = '"event":"gateway-binding"';
  const seen = () => served.stderrTail().split(marker).length - 1;
  const seenBefore = seen();
  const serving = E(back.admin)
    .serve(harden({ port, operator: (await gatewayAdminOf(served)).operator }))
    .catch(() => 'lost');
  await waitFor(() => seen() > seenBefore, 30_000, 'the bind to start', 2);
  await served.kill();
  t.is(await serving, 'lost', 'the serve answer was lost with the daemon');
  await served.restart();
  const k1 = await untilServing();
  t.is(k1.status.port, port, 'K1: the registration is restored and serves');
  t.true(await signsIn(rotated));

  // K2: SIGKILL inside rotateSignIn, at two delays.
  let known = rotated;
  /** @type {Record<string, unknown>[]} */
  const k2 = [];
  for (const killAfterMs of [0, 15]) {
    const { admin } = await gatewayAdminOf(served);
    const rotation = E(admin)
      .rotateSignIn()
      .then(
        () => 'done',
        () => 'lost',
      );
    if (killAfterMs > 0) await delay(killAfterMs);
    await served.kill();
    const answer = await rotation;
    await served.restart();
    const { status } = await untilServing();
    const now = await readSignIn(served.root, status.origin, wrappingKey?.file);
    t.true(await signsIn(now.secret), 'the file secret signs in');
    if (now.secret !== known) {
      await delay(1100);
      t.false(await signsIn(known), 'the replaced secret does not');
    }
    t.false(
      existsSync(`${signInFile(served.root)}.tmp`),
      'no temporary file is left after the restart',
    );
    k2.push({ killAfterMs, answer, rotated: now.secret !== known });
    known = now.secret;
    await delay(1100);
  }
  emit({ metric: 'm3.gateway.k2', outcomes: k2 });
  await E((await gatewayAdminOf(served)).admin).stop();
});
