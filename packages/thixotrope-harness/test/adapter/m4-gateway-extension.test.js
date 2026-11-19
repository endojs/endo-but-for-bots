// @ts-check
// M4 W4.6: `AH/gateway/extensions/secrets.js` loads as a
// `GatewayExtension` (protocol.js; designs/m4-interfaces.md 9.1 item 3)
// whose one LargeCall targets the context's `secretWriter()` and exempts
// `replace` only. The context is a fake with the M3 shape whose
// `secretWriter()` answers a stand-in for the gateway's in-process writer
// (XA: the object a page finds in `GatewayPowers.extras`; the hub's
// `SecretsAdmin.openWriter()` writer takes sealed boxes only and is not a
// LargeCall). The real gateway's writer is exercised end to end in
// `m2-secret-writer-paths.test.js`; the browser test (frame guard,
// `browserSecretBytes`) is W4.8's acceptance 14.
// INT-M4: M3's real loader (`loadGatewayExtensions`, `makeLargeCalls`) and
// vocabulary (`harnessNames`) are exercised here at adapter level.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { gatewayExtension } from '../../resources/agent-host/impl/gateway/extensions/secrets.js';
import {
  loadGatewayExtensions,
  makeLargeCalls,
} from '../../resources/agent-host/impl/gateway/extensions.js';
import { harnessNames } from '../../resources/agent-host/impl/gateway/vocabulary.js';
// eslint-disable-next-line import/no-relative-packages -- guest/ is its own private package
import { m4MethodNames } from '../../guest/lib/interfaces-m4.js';
import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import { makeSealKeys } from '../../resources/agent-host/impl/secrets/seal.js';
import { makeWrappingKey } from '../../resources/agent-host/impl/secrets/wrapping-key.js';
import { makeStoreDirs, openStore } from './_m4-renewal.js';

const { Far } = /** @type {any} */ (globalThis);

/** Keys a `GatewayExtension` may carry (protocol.js). */
const EXTENSION_KEYS = ['name', 'services', 'routes', 'largeCalls', 'csp'];

test('m4-secrets is a GatewayExtension: hardened, named, one LargeCall on replace', t => {
  t.true(Object.isFrozen(gatewayExtension));
  t.is(gatewayExtension.name, 'm4-secrets');
  t.true(Object.keys(gatewayExtension).every(k => EXTENSION_KEYS.includes(k)));
  const { largeCalls = [] } = gatewayExtension;
  t.is(largeCalls.length, 1);
  t.deepEqual(largeCalls[0].methods, ['replace']);
  t.is(typeof largeCalls[0].target, 'function');
});

test("the LargeCall target answers the context's one writer (identity)", async t => {
  const dirs = makeStoreDirs('w46-gateway');
  t.teardown(dirs.done);
  const writer = Far('GatewaySecretWriter', {});
  let asked = 0;
  /** A fake `GatewayContext` with the fields M3's contract names. */
  const context = harden({
    live: undefined,
    composer: undefined,
    content: undefined,
    history: () => undefined,
    whenAttached: (/** @type {() => void} */ callback) => callback(),
    secretWriter: async () => {
      asked += 1;
      return writer;
    },
    stateDir: dirs.stateDir,
    log: () => {},
  });
  const [largeCall] = gatewayExtension.largeCalls ?? [];
  const target = await largeCall.target(/** @type {any} */ (context));
  t.is(target, writer, 'the incarnation writer, compared by identity');
  t.is(asked, 1);
  t.is(await largeCall.target(/** @type {any} */ (context)), writer);
});

test("INT-M4: M3's extension loader loads m4-secrets; makeLargeCalls exempts the writer's replace only", async t => {
  /** @type {Record<string, unknown>[]} */
  const events = [];
  const extensions = loadGatewayExtensions({ log: e => events.push(e) });
  t.deepEqual(
    events.filter(e => e.event === 'gateway-extension-skip'),
    [],
    'no extension file is skipped',
  );
  const loaded = extensions.find(e => e.name === 'm4-secrets');
  t.truthy(loaded, 'm4-secrets is among the loaded extensions');
  const dirs = makeStoreDirs('int-m4-gateway');
  t.teardown(dirs.done);
  const ops = makeSecretsOps({
    store: openStore(dirs.files),
    seal: makeSealKeys({
      wrappingKey: makeWrappingKey({
        keyFile: dirs.files.keyFile,
        stateDir: dirs.files.stateDir,
      }),
    }),
    sink: Far('AgentHostSink', {}),
  });
  const writer = Far('GatewaySecretWriter', {});
  const hubWriter = await ops.secretWriter();
  const context = harden({
    live: undefined,
    composer: undefined,
    content: undefined,
    history: () => undefined,
    whenAttached: (/** @type {() => void} */ callback) => callback(),
    secretWriter: async () => writer,
    stateDir: dirs.stateDir,
    log: () => {},
  });
  const { isLargeCall, ready } = makeLargeCalls({
    extensions: [/** @type {any} */ (loaded)],
    context: /** @type {any} */ (context),
    log: e => events.push(e),
  });
  await ready;
  t.true(isLargeCall(writer, 'replace'));
  t.false(isLargeCall(writer, 'close'));
  t.false(isLargeCall(hubWriter, 'replace'), 'the hub writer is not exempt');
  t.false(isLargeCall(Far('Other', {}), 'replace'));
  t.deepEqual(
    events.filter(e => e.event === 'gateway-large-call-skip'),
    [],
  );
});

test("INT-M4: the gateway's vocabulary admits M4's browser-reachable method names", t => {
  // A listed table that fails throws (HR-SYN-7), so this call is the load check.
  const { keys, methods } = harnessNames();
  for (const name of [
    'SecretsAdmin',
    'Secret',
    'SubscriptionsAdmin',
    'PoolMember',
    'PoolBackend',
    'AuditReader',
    'Accounts',
    'AccountsSubscription',
  ]) {
    for (const method of /** @type {Record<string, string[]>} */ (
      m4MethodNames
    )[name]) {
      t.true(methods.has(method), `${name}.${method} is admitted`);
    }
  }
  t.true(keys.size > 0);
});
