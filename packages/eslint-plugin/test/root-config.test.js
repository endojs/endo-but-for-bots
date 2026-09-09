// @ts-check

import assert from 'node:assert';
import { dirname, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoDir = resolve(pluginDir, '..', '..');

describe('root flat config', () => {
  it('serializes the configured processor', async () => {
    const eslint = new ESLint({ cwd: repoDir });
    const config = await eslint.calculateConfigForFile(
      'packages/captp/src/captp.js',
    );
    assert.ok(config);
    assert.doesNotThrow(() => JSON.stringify(config));
    assert.deepEqual(config.processor?.meta, {
      name: '@jessie.js/use-jessie',
    });
  });

  it('keeps restored paths discoverable and applies per-file overrides', async () => {
    const eslint = new ESLint({ cwd: repoDir });
    const restoredPaths = [
      'browser-test/tests/chat-smoke.spec.js',
      'packages/compartment-mapper/demo/policy/index.mjs',
      'packages/compartment-mapper/test/fixtures-order/a.js',
      'packages/familiar/scripts/build.mjs',
      'packages/preact-container/vitest.config.mjs',
      'packages/ses/test/_check-intrinsics.js',
      'packages/daemon/src/bus-xs-host-globals.d.ts',
      'packages/chat/css-modules.types.d.ts',
      'packages/compartment-mapper/test/test.types.d.ts',
      'packages/immutable-arraybuffer/shim.types.d.ts',
      'packages/lal/agent.types.d.ts',
      'packages/module-source/src/external.types.d.ts',
      'packages/module-source/src/shim.types.d.ts',
      'packages/platform/src/fs/search.types.d.ts',
    ];
    const ignoredStates = await Promise.all(
      restoredPaths.map(filePath => eslint.isPathIgnored(filePath)),
    );
    assert.deepEqual(
      ignoredStates,
      restoredPaths.map(() => false),
    );

    const rootScript = await eslint.calculateConfigForFile(
      'scripts/pack-all.mjs',
    );
    const packageScript = await eslint.calculateConfigForFile(
      'packages/familiar/scripts/download-node.mjs',
    );
    assert.strictEqual(rootScript?.rules['no-await-in-loop'][0], 0);
    assert.strictEqual(packageScript?.rules['no-await-in-loop'][0], 2);
    assert.strictEqual(
      packageScript?.rules['@jessie.js/safe-await-separator'][0],
      1,
    );
  });
  it('rejects ambient platform authority in Thixotrope core', async () => {
    const eslint = new ESLint({ cwd: repoDir });
    const cases = [
      ["import { readFile } from 'node:fs/promises';", 'no-restricted-imports'],
      ["import { readFile } from 'fs/promises';", 'no-restricted-imports'],
      ["export * from 'node:fs';", 'no-restricted-imports'],
      [
        "export { makeNodePowers } from './platform/node-powers.js';",
        'no-restricted-imports',
      ],
      ["import('./platform/node-powers.js');", 'no-restricted-syntax'],
      ["import('node:fs');", 'no-restricted-syntax'],
      ['process.cwd();', 'no-restricted-globals'],
      [
        'globalThis.crypto.getRandomValues(new Uint8Array(1));',
        'no-restricted-globals',
      ],
      ['setTimeout(() => {}, 1);', 'no-restricted-globals'],
      ['Date.now();', 'no-restricted-globals'],
      ['Math.random();', 'no-restricted-properties'],
      ['const { random } = Math; random();', 'no-restricted-properties'],
      ['Math["random"]();', 'no-restricted-properties'],
      ['const math = Math; math.random();', 'no-restricted-syntax'],
      ['Math[key]();', 'no-restricted-syntax'],
    ];
    for (const [source, ruleId] of cases) {
      // Each probe verifies the effective root configuration, not a copied rule.
      // eslint-disable-next-line no-await-in-loop
      const [result] = await eslint.lintText(`// @ts-check\n${source}\n`, {
        filePath: 'packages/thixotrope/src/mailbox.js',
      });
      assert.ok(
        result.messages.some(message => message.ruleId === ruleId),
        source,
      );
    }
    const [allowed] = await eslint.lintText(
      '// @ts-check\nconst read = powers => powers.fs.readFileSync("state");\n',
      { filePath: 'packages/thixotrope/src/mailbox.js' },
    );
    assert.ok(
      !allowed.messages.some(
        message =>
          message.ruleId !== null &&
          [
            'no-restricted-imports',
            'no-restricted-globals',
            'no-restricted-syntax',
          ].includes(message.ruleId),
      ),
    );
  });
});
