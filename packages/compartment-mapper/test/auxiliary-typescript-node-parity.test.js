/**
 * Node.js parity test for auxiliary-`package.json` TypeScript-extension scoping.
 *
 * This is the Node.js companion to `auxiliary-typescript.test.js`: it loads an
 * equivalent `ts-pkg` tree under plain Node.js and calls the same
 * `assertTypeScriptClassification` from `_auxiliary-typescript-assertions.js`.
 * If both tests pass, the Compartment Mapper classifies `.ts`/`.mts`/`.cts`
 * exactly as Node.js does, so parity is verified by construction rather than
 * asserted in prose.
 *
 * Node.js refuses to load TypeScript under `node_modules`
 * (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so this fixture lives outside
 * `node_modules` and mirrors the `ts-pkg` subtree of
 * `fixtures-auxiliary-typescript` file-for-file. Node.js (>= 22.18 / 24) strips
 * the (absent) types natively and selects each module's system from the nearest
 * enclosing `package.json` `type`, which is the behavior under test.
 */
import test from 'ava';
import { assertTypeScriptClassification } from './_auxiliary-typescript-assertions.js';

const fixture = new URL(
  'fixtures-auxiliary-typescript-node-parity/ts-pkg/index.mts',
  import.meta.url,
).href;

test('auxiliary package.json ts/mts/cts scoping - node parity', async t => {
  const namespace = await import(fixture);
  assertTypeScriptClassification(t, namespace.default);
});
