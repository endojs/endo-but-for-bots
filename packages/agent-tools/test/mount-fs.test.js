// @ts-check

// Establish a SES perimeter (provides the `harden` global).
// eslint-disable-next-line import/order
import '@endo/init/debug.js';

/** @import { ExecutionContext } from 'ava' */
/** @import { ERef } from '@endo/eventual-send' */
/** @import { Filesystem } from '@endo/platform/fs/extended' */

import test from 'ava';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { Buffer } from 'buffer';
import { E } from '@endo/eventual-send';
import { Far } from '@endo/pass-style';

import {
  makeNodeFilesystem,
  readOnly,
  chroot,
} from '@endo/platform/fs/extended';

import { makeMountReadTool } from '../src/json-tools/fs.js';
import { toPiAgentTool } from '../src/adapters/pi.js';

/**
 * @typedef {object} TestFilesystemLike
 * @property {() => unknown} root
 */

/**
 * @typedef {object} TestDirectoryLike
 * @property {(name: string, opts: object) => unknown} create
 */

/**
 * @param {ExecutionContext} t
 * @returns {string}
 */
const makeTempRoot = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tools-mount-'));
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/**
 * @param {Uint8Array} bytes
 */
const makeFakeBytesReader = bytes =>
  Far('FakeBytesReader', {
    streamBase64() {
      return harden({
        value: Buffer.from(bytes).toString('base64'),
        promise: Promise.resolve(harden({ value: undefined, promise: null })),
      });
    },
  });

test('reads a text file inside the filesystem', async t => {
  const rootPath = makeTempRoot(t);
  fs.writeFileSync(path.join(rootPath, 'a.txt'), 'hello mount');
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  await null;
  t.is(await tool.invoke({ path: 'a.txt' }), 'hello mount');
});

test('reads a file in a subdirectory by relative path', async t => {
  await null;
  const rootPath = makeTempRoot(t);
  fs.mkdirSync(path.join(rootPath, 'sub'));
  fs.writeFileSync(path.join(rootPath, 'sub', 'b.txt'), 'nested');
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  t.is(await tool.invoke({ path: 'sub/b.txt' }), 'nested');
});

test('reads through a chroot subtree view as the new root', async t => {
  await null;
  const rootPath = makeTempRoot(t);
  fs.mkdirSync(path.join(rootPath, 'sub'));
  fs.writeFileSync(path.join(rootPath, 'sub', 'c.txt'), 'in subtree');
  fs.writeFileSync(path.join(rootPath, 'top.txt'), 'above subtree');
  const filesystem = chroot(readOnly(makeNodeFilesystem({ rootPath })), [
    'sub',
  ]);

  const tool = makeMountReadTool(filesystem);
  t.is(await tool.invoke({ path: 'c.txt' }), 'in subtree');
  await t.throwsAsync(() => tool.invoke({ path: 'top.txt' }), {
    message: /ENOENT/,
  });
});

test('reads an empty file as the empty string', async t => {
  const rootPath = makeTempRoot(t);
  fs.writeFileSync(path.join(rootPath, 'empty.txt'), '');
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  await null;
  t.is(await tool.invoke({ path: 'empty.txt' }), '');
});

test('mountReadText returns the exact UTF-8 text without a presentation cap', async t => {
  const rootPath = makeTempRoot(t);
  const big = 'é'.repeat(30_001);
  fs.writeFileSync(path.join(rootPath, 'big.txt'), big);
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  const result = /** @type {string} */ (await tool.invoke({ path: 'big.txt' }));
  t.is(result, big);
});

test('normalizes leading, trailing, and doubled slashes to "." no-op steps', async t => {
  const rootPath = makeTempRoot(t);
  fs.mkdirSync(path.join(rootPath, 'sub'));
  fs.writeFileSync(path.join(rootPath, 'sub', 'd.txt'), 'normalized');
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  await null;
  t.is(await tool.invoke({ path: '/sub/d.txt' }), 'normalized');
  t.is(await tool.invoke({ path: 'sub//d.txt' }), 'normalized');
  t.is(await tool.invoke({ path: 'sub/d.txt/' }), 'normalized');
});

test('reads the exact file contents before draining bytes', async t => {
  await null;
  const filesystem = Far('BoundedReadFilesystem', {
    root() {
      return Far('BoundedReadRoot', {
        lookup(name) {
          t.is(name, 'big.txt');
          return Far('BoundedReadFile', {
            open(opts) {
              t.deepEqual(opts, { read: true });
              return Far('BoundedReadOpenFile', {
                read(offset, length) {
                  t.is(offset, 0n);
                  t.is(length, undefined);
                  return makeFakeBytesReader(
                    new TextEncoder().encode('x'.repeat(50_001)),
                  );
                },
              });
            },
          });
        },
      });
    },
  });

  const tool = makeMountReadTool(
    /** @type {ERef<Filesystem>} */ (/** @type {unknown} */ (filesystem)),
  );
  const result = /** @type {string} */ (await tool.invoke({ path: 'big.txt' }));
  t.is(result, 'x'.repeat(50_001));
});

test('emits a canonical ToolRecord with a one-line description', t => {
  const rootPath = makeTempRoot(t);
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));
  const tool = makeMountReadTool(filesystem);

  t.is(tool.name, 'mountReadText');
  t.is(typeof tool.description, 'string');
  t.true(tool.description.length > 0);
  t.is(typeof tool.invoke, 'function');
});

test('parameters and inputSchema advertise the mountReadText required path', t => {
  const rootPath = makeTempRoot(t);
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));
  const tool = makeMountReadTool(filesystem);

  // The same JSON Schema is used verbatim as both LLM `parameters` and MCP
  // `inputSchema`.
  t.is(tool.parameters, tool.inputSchema);
  const parameters =
    /** @type {{ type: string, properties: { path: { type: string } }, required: string[], additionalProperties: boolean }} */ (
      tool.parameters
    );
  t.is(parameters.type, 'object');
  t.deepEqual(parameters.properties.path.type, 'string');
  t.deepEqual(parameters.required, ['path']);
  t.false(parameters.additionalProperties);
});

test('rejects extra arguments before any filesystem send', async t => {
  let touched = false;
  const filesystem = /** @type {Filesystem} */ (
    /** @type {unknown} */ (
      Far('UntouchedFilesystem', {
        root() {
          touched = true;
          throw new Error('filesystem should not be touched');
        },
      })
    )
  );
  const tool = makeMountReadTool(filesystem);

  const err = await t.throwsAsync(() =>
    tool.invoke({ path: 'a.txt', extra: 'ignored' }),
  );
  t.true(
    err !== undefined && err.message.includes('extra'),
    `error message should name the offending key; got: ${err?.message}`,
  );
  t.false(touched);
});

test('rejects a missing or empty path before any send', async t => {
  const rootPath = makeTempRoot(t);
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));
  const tool = makeMountReadTool(filesystem);

  await t.throwsAsync(() => tool.invoke({}), {
    message: /non-empty string path/,
  });
  await t.throwsAsync(() => tool.invoke({ path: '' }), {
    message: /non-empty string path/,
  });
});

test('rejects a "../" escape via the Filesystem, not a string check', async t => {
  const outsideRoot = makeTempRoot(t);
  fs.writeFileSync(path.join(outsideRoot, 'secret'), 'TOP SECRET');
  const rootPath = path.join(outsideRoot, 'mounted');
  fs.mkdirSync(rootPath);
  fs.writeFileSync(path.join(rootPath, 'inside.txt'), 'ok');
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  t.is(
    fs.readFileSync(path.join(outsideRoot, 'secret'), 'utf-8'),
    'TOP SECRET',
  );
  await t.throwsAsync(() => tool.invoke({ path: '../secret' }), {
    message: /reserved|EINVAL|ENOENT/,
  });
  t.is(await tool.invoke({ path: 'inside.txt' }), 'ok');
});

test('rejects reading through a symlink that escapes the root', async t => {
  const outsideRoot = makeTempRoot(t);
  const outsideFile = path.join(outsideRoot, 'secret.txt');
  fs.writeFileSync(outsideFile, 'TOP SECRET');
  const rootPath = path.join(outsideRoot, 'mounted');
  fs.mkdirSync(rootPath);
  fs.symlinkSync(outsideFile, path.join(rootPath, 'link-out'));
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  await t.throwsAsync(() => tool.invoke({ path: 'link-out' }), {
    message: /escapes filesystem root|EACCES|ENOENT/,
  });
});

test('bridges through toPiAgentTool and reads a file end to end', async t => {
  const rootPath = makeTempRoot(t);
  fs.writeFileSync(path.join(rootPath, 'a.txt'), 'bridged content');
  const filesystem = readOnly(makeNodeFilesystem({ rootPath }));

  const tool = makeMountReadTool(filesystem);
  const agentTool = toPiAgentTool(tool);

  // The model-facing surface is copied verbatim from the canonical record.
  t.is(agentTool.name, 'mountReadText');
  t.is(agentTool.label, 'mountReadText');
  t.is(agentTool.description, tool.description);
  t.is(agentTool.parameters, tool.parameters);

  // Invoking through the bridge resolves the file and renders the contents.
  const result = await agentTool.execute('call-1', { path: 'a.txt' });
  t.deepEqual(result.content, [{ type: 'text', text: 'bridged content' }]);
  t.is(result.details, 'bridged content');
});

test('fails closed after the Filesystem is revoked, with no ambient fallback', async t => {
  const rootPath = makeTempRoot(t);
  fs.writeFileSync(path.join(rootPath, 'a.txt'), 'live content');
  const realFs = readOnly(makeNodeFilesystem({ rootPath }));

  let revoked = false;
  const revocableFs = Far('RevocableFilesystem', {
    async root() {
      if (revoked) {
        throw new Error('Filesystem has been revoked');
      }
      return E(/** @type {TestFilesystemLike} */ (realFs)).root();
    },
  });

  const tool = makeMountReadTool(
    /** @type {ERef<Filesystem>} */ (/** @type {unknown} */ (revocableFs)),
  );

  await null;
  t.is(await tool.invoke({ path: 'a.txt' }), 'live content');

  revoked = true;
  await t.throwsAsync(() => tool.invoke({ path: 'a.txt' }), {
    message: /revoked/,
  });

  t.is(fs.readFileSync(path.join(rootPath, 'a.txt'), 'utf-8'), 'live content');
});
