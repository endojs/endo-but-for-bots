// @ts-check
// M3 W3.2: gateway extensions by file (resources/agent-host/impl/gateway/
// extensions.js; designs/m3-interfaces.md 6.1). Node only.
import '../unit/_m1a-prelude.js';

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import test from '@endo/ses-ava/test.js';

import {
  extensionCsp,
  extensionRoutes,
  loadGatewayExtensions,
  makeExtensionServices,
  makeLargeCalls,
} from '../../resources/agent-host/impl/gateway/extensions.js';
import { makeBridge } from '../../resources/agent-host/impl/gateway/bridge.js';
import { makeBootstrapFactory } from '../../resources/agent-host/impl/gateway/powers.js';
import { harnessNames } from '../../resources/agent-host/impl/gateway/vocabulary.js';
import {
  gatewayTexts,
  WS_PATH,
} from '../../resources/agent-host/impl/gateway/contract-m3.js';
import { makeClient } from './_m3-captp-client.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, Far } = /** @type {GuestGlobals} */ (globalThis);

const fixtureDir = fileURLToPath(
  new URL('../fixtures/gateway-extension/', import.meta.url),
);

/** A fake `GatewayContext` with a manual attach. */
const makeContext = () => {
  /** @type {(() => void)[]} */
  const waiting = [];
  let attached = false;
  const writer = Far('SecretWriter', { replace: () => undefined });
  const context = harden({
    live: Far('Live', {}),
    composer: Far('Composer', {
      /**
       * @param {unknown} _s
       * @param {string} text
       */
      submit: (_s, text) => text.length,
    }),
    content: Far('Content', {}),
    history: () => Far('History', {}),
    /** @param {() => void} callback */
    whenAttached: callback => {
      if (attached) callback();
      else waiting.push(callback);
    },
    secretWriter: async () => {
      if (!attached) throw Error('not attached');
      return writer;
    },
    stateDir: 'state',
    /** @param {Record<string, unknown>} _event */
    log: _event => {},
  });
  const attach = () => {
    attached = true;
    for (const callback of waiting.splice(0)) callback();
  };
  return { context, attach, writer };
};

test('the fixture directory: one extension loaded, a throwing file skipped', t => {
  /** @type {any[]} */
  const logged = [];
  const extensions = loadGatewayExtensions({
    dir: fixtureDir,
    log: event => logged.push(event),
  });
  t.deepEqual(
    extensions.map(e => e.name),
    ['fixture'],
  );
  const skipped = logged.filter(e => e.event === 'gateway-extension-skip');
  t.deepEqual(
    skipped.map(e => e.file),
    ['throwing.js'],
  );
  t.regex(skipped[0].error, /failed to load/);
  t.deepEqual(extensionCsp(extensions), { 'img-src': ['blob:'] });
  t.deepEqual(
    extensionRoutes(extensions).map(r => [r.kind, r.path]),
    [['http', '/fixture']],
  );
});

test('invalid files are skipped with the reason, in name order', t => {
  const dir = mkdtempSync(join(tmpdir(), 'thix-m3-ext-'));
  t.teardown(() => rmSync(dir, { recursive: true, force: true }));
  const route = (/** @type {string} */ path) =>
    `export const gatewayExtension = { name: 'r', routes: [{ kind: 'http', path: '${path}', handle: () => {} }] };\n`;
  writeFileSync(join(dir, 'a-ok.js'), route('/one'));
  writeFileSync(join(dir, 'b-no-export.js'), 'export const other = 1;\n');
  writeFileSync(join(dir, 'c-ws.js'), route(WS_PATH));
  writeFileSync(join(dir, 'd-assets.js'), route('/assets/x.js'));
  writeFileSync(join(dir, 'e-taken.js'), route('/one'));
  writeFileSync(
    join(dir, 'f-csp.js'),
    "export const gatewayExtension = { name: 'c', csp: { 'img-src': ['a; script-src *'] } };\n",
  );
  writeFileSync(
    join(dir, 'g-tla.js'),
    "await Promise.resolve();\nexport const gatewayExtension = { name: 'tla' };\n",
  );
  writeFileSync(join(dir, 'notes.md'), 'not an extension\n');
  /** @type {any[]} */
  const logged = [];
  const extensions = loadGatewayExtensions({
    dir,
    log: event => logged.push(event),
  });
  t.deepEqual(
    extensions.map(e => e.routes?.[0]?.path),
    ['/one'],
  );
  t.deepEqual(
    logged.filter(e => e.event === 'gateway-extension-skip').map(e => e.file),
    [
      'b-no-export.js',
      'c-ws.js',
      'd-assets.js',
      'e-taken.js',
      'f-csp.js',
      'g-tla.js',
    ],
  );
  t.deepEqual(
    loadGatewayExtensions({ dir: join(dir, 'missing'), log: () => {} }),
    [],
  );
});

test('services: one per incarnation, a throwing make skipped, at most 32', t => {
  const { context } = makeContext();
  /** @type {any[]} */
  const logged = [];
  const extensions = [
    ...loadGatewayExtensions({ dir: fixtureDir, log: () => {} }),
    {
      name: 'bad',
      services: [
        {
          label: 'boom',
          make: () => {
            throw Error('make failed');
          },
        },
        { label: 'fixture', make: () => Far('Dup', {}) },
      ],
    },
    {
      name: 'many',
      services: Array.from({ length: 40 }, (_, i) => ({
        label: `s${i}`,
        make: () => Far('S', {}),
      })),
    },
  ];
  const extras = makeExtensionServices({
    extensions,
    context,
    log: event => logged.push(event),
  });
  t.is(extras.length, 32);
  t.is(extras[0].label, 'fixture');
  t.is(extras[0].service.ping(), 'pong');
  t.deepEqual(
    logged.slice(0, 2).map(e => [e.label, e.error]),
    [
      ['boom', 'make failed'],
      ['fixture', 'label taken'],
    ],
  );
  t.is(logged.filter(e => e.error === 'too many services').length, 9);
});

test('largeCalls: resolved after whenAttached, compared by identity', async t => {
  const { context, attach } = makeContext();
  const extensions = loadGatewayExtensions({ dir: fixtureDir, log: () => {} });
  const [{ service }] = makeExtensionServices({
    extensions,
    context,
    log: () => {},
  });
  const { isLargeCall, ready } = makeLargeCalls({
    extensions,
    context,
    builtIn: [{ target: context.composer, methods: ['submit', 'edit'] }],
    log: () => {},
  });
  t.true(isLargeCall(context.composer, 'submit'));
  t.false(isLargeCall(context.composer, 'other'));
  t.false(isLargeCall(service, 'echoLarge'), 'not before attach');
  attach();
  await ready;
  t.true(isLargeCall(service, 'echoLarge'));
  t.false(isLargeCall(service, 'ping'));
  t.false(isLargeCall(Far('FixtureService', {}), 'echoLarge'));
});

test('through the bridge: extras service, its large call, the writer identity', async t => {
  const { context, attach, writer } = makeContext();
  const extensions = loadGatewayExtensions({ dir: fixtureDir, log: () => {} });
  const extras = makeExtensionServices({ extensions, context, log: () => {} });
  const { isLargeCall, ready } = makeLargeCalls({
    extensions,
    context,
    builtIn: [{ target: context.composer, methods: ['submit', 'edit'] }],
    log: () => {},
  });
  attach();
  await ready;
  const secret = 'f'.repeat(64);
  // The operator hands out the writer as SecretsAdmin.openWriter() would.
  const operator = Far('Operator', { openWriter: () => writer });
  const names = harnessNames({ log: () => {} });
  const bridge = makeBridge({
    makeBootstrap: makeBootstrapFactory({
      signIn: { matches: candidate => candidate === secret },
      limiter: {
        check: () => ({ ok: true }),
        failed: () => {},
        succeeded: () => {},
      },
      operator,
      live: context.live,
      content: context.content,
      composer: context.composer,
      history: context.history,
      extras,
    }),
    vocabulary: names.keys,
    methods: names.methods,
    isLargeCall,
    log: () => {},
  });
  /** @type {(bytes: Uint8Array | string) => void} */
  let toServer = () => {};
  const client = makeClient({
    send: bytes => setImmediate(() => toServer(bytes)),
  });
  bridge.connect({
    address: '127.0.0.1',
    send: bytes => setImmediate(() => client.receive(bytes)),
    close: () => {},
    onMessage: handler => {
      toServer = handler;
    },
    onClose: () => {},
  });
  const powers = await E(client.bootstrap()).fetch(secret);
  const fixture = powers.extras.find(
    (/** @type {any} */ e) => e.label === 'fixture',
  ).service;
  t.is(await E(fixture).ping(), 'pong');
  const big = 'z'.repeat(100 * 1024);
  t.is(await E(fixture).echoLarge(big), big.length, 'exempt after attach');
  t.is(await E(powers.composer).submit(powers.operator, big), big.length);
  const pageWriter = await E(powers.operator).openWriter();
  t.true(await E(fixture).sameWriter(pageWriter));
  await t.throwsAsync(() => E(fixture).sameWriter(Far('SecretWriter', {})), {
    message: gatewayTexts.browserObject,
  });
});
