// @ts-check
// M4 W4.6: `AH/gateway/extensions/m4-secrets.js` loads as a
// `GatewayExtension` (contract-m3.js; designs/m4-interfaces.md 9.1 item 3)
// whose one LargeCall targets the context's `secretWriter()` and exempts
// `replace` only. M3's gateway is not in this lane: the context is a fake
// with the M3 shape, and the writer a real M2 SecretWriter over a store
// under H/tmp, so the target answers the very object a page reaches
// through `SecretsAdmin.openWriter()`. The through-the-gateway test (frame
// guard, `browserSecretBytes`) is W4.8's acceptance 14, after M3's merge.
import '../unit/_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { gatewayExtension } from '../../resources/agent-host/impl/gateway/extensions/m4-secrets.js';
import { makeSecretsOps } from '../../resources/agent-host/impl/secrets/manager.js';
import { makeSealKeys } from '../../resources/agent-host/impl/secrets/seal.js';
import { makeStoreDirs, openStore } from './_m4-renewal.js';

const { Far } = /** @type {any} */ (globalThis);

/** Keys a `GatewayExtension` may carry (contract-m3.js). */
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

test("the LargeCall target answers the context's one SecretWriter (identity)", async t => {
  const dirs = makeStoreDirs('w46-gateway');
  t.teardown(dirs.done);
  const ops = makeSecretsOps({
    store: openStore(dirs.files),
    seal: makeSealKeys({
      file: dirs.files.keyFile,
      stateDir: dirs.files.stateDir,
    }),
    sink: Far('AgentHostSink', {}),
  });
  const writer = await ops.secretWriter();
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
      return ops.secretWriter();
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
