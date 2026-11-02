// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/far';
import { bytesReaderFromIterator } from '@endo/exo-stream/bytes-reader-from-iterator.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { E } from '@endo/eventual-send';
import { makeExo } from '@endo/exo';
import { M } from '@endo/patterns';
import { makeMount } from '@endo/daemon/src/mount.js';
import { makeFilePowers } from '@endo/daemon/src/manager-node-powers.js';

import {
  makeDescribeCapabilityTool,
  makeReadSourcesTool,
  makeListPetnamesTool,
  makeLookupTool,
  makeExecTool,
} from '../src/tool-makers.js';

/** @param {Record<string, string>} files */
const makePowers = files =>
  Far('Powers', {
    list: () => harden(['source']),
    lookup: name => {
      if (String(name) !== 'source') throw Error('Unknown petname');
      return Far('Source', {
        __getMethodNames__: () => harden(['lookup', 'help']),
        help: method =>
          method === 'lookup'
            ? 'lookup(path: string[]) -> ReadableBlob; example: lookup(["README.md"])'
            : 'Read-only source tree',
        lookup: segments => {
          const text = files[segments.join('/')];
          if (text === undefined) throw Error('File does not exist');
          const bytes = new TextEncoder().encode(text);
          const chunks = [];
          for (let start = 0; start < bytes.length; start += 32_768) {
            chunks.push(bytes.subarray(start, start + 32_768));
          }
          return bytesReaderFromIterator(chunks);
        },
      });
    },
  });

test('lookup/list/exec reject invented parameters before calling powers', async t => {
  const powers = Far('UnusedPowers', {});
  await t.throwsAsync(
    () =>
      makeLookupTool(powers).execute({
        petName: 'source',
        method: 'readText',
        args: [],
      }),
    { message: /Unexpected argument "method"/ },
  );
  await t.throwsAsync(
    () => makeListPetnamesTool(powers).execute({ path: ['src'] }),
    { message: /allowed arguments: \(none\)/ },
  );
  await t.throwsAsync(
    () => makeLookupTool(powers).execute({ petName: ['source'] }),
    { message: /petName must be string/ },
  );
  await t.throwsAsync(
    () => makeExecTool(powers).execute({ code: 'return 1', path: 'ignored' }),
    { message: /Unexpected argument/ },
  );
});

test('capability discovery uses advertised help signatures without invoking target', async t => {
  const tool = makeDescribeCapabilityTool(makePowers({}));
  const result = JSON.parse(
    await tool.execute({ petName: 'source', method: 'lookup' }),
  );
  t.regex(result.documentation, /lookup\(path: string\[\]\)/);
  t.deepEqual(result.methods, ['lookup', 'help']);
  await t.throwsAsync(
    () => tool.execute({ petName: 'source', method: 'readText' }),
    { message: /not in the callable method list/ },
  );
});

test('capability discovery falls back to guarded zero-argument help and keeps methods when docs fail', async t => {
  const withOverview = makeExo(
    'ZeroArgumentHelp',
    M.interface('ZeroArgumentHelp', {
      help: M.call().returns(M.string()),
      operate: M.call().returns(M.undefined()),
    }),
    {
      help: () => 'Overview only: operate() takes no arguments.',
      operate: () => undefined,
    },
  );
  const powers = Far('Powers', { lookup: () => withOverview });
  const overview = JSON.parse(
    await makeDescribeCapabilityTool(powers).execute({
      petName: 'cap',
      method: 'operate',
    }),
  );
  t.is(overview.documentationScope, 'overview');
  t.regex(overview.documentation, /Overview only/);
  const noDocs = Far('NoDocs', {
    // eslint-disable-next-line no-underscore-dangle
    __getMethodNames__: () => harden(['help', 'operate']),
    help: () => {
      throw Error('private backend diagnostic');
    },
  });
  const unavailable = JSON.parse(
    await makeDescribeCapabilityTool(
      Far('OtherPowers', { lookup: () => noDocs }),
    ).execute({ petName: 'cap', method: 'operate' }),
  );
  t.deepEqual(unavailable.methods, ['help', 'operate']);
  t.is(unavailable.documentationScope, 'unavailable');
  t.regex(unavailable.documentation, /do not guess/);
  t.false(JSON.stringify(unavailable).includes('private backend diagnostic'));
});

test('eight escaped source results fit the durable journal serialized envelope', async t => {
  const text = '\\"\u0000'.repeat(4000);
  const tool = makeReadSourcesTool(makePowers({ source: text }));
  const response = await tool.execute({
    petName: 'source',
    items: Array.from({ length: 8 }, () => ({ path: ['source'] })),
  });
  t.true(response.length <= 48_000);
  const journalEvent = JSON.stringify({
    turnId: '10000',
    type: 'observed-tool-result',
    callId: 'call'.repeat(200),
    result: response,
  });
  t.true(journalEvent.length < 131_072);
  const { results } = JSON.parse(response);
  t.is(results.length, 8);
  t.true(results.every(result => result.ok && result.outputTruncated));
  t.true(results.every(result => text.startsWith(result.lines[0].text)));
});

test('source batch keeps successes when a file or item fails', async t => {
  const tool = makeReadSourcesTool(
    makePowers({ 'src/a.js': 'one\ntwo checkpoint\nthree\nfour checkpoint' }),
  );
  const { results } = JSON.parse(
    await tool.execute({
      petName: 'source',
      items: [
        { path: ['src', 'a.js'], startLine: 2, lineCount: 2 },
        { path: ['missing'] },
        { path: ['src', 'a.js'], search: 'checkpoint' },
        { path: ['src', 'a.js'], method: 'ignored' },
      ],
    }),
  );
  t.deepEqual(results[0].lines, [
    { line: 2, text: 'two checkpoint' },
    { line: 3, text: 'three' },
  ]);
  t.true(results[0].outputTruncated);
  t.false(results[1].ok);
  t.deepEqual(
    results[2].lines.map(line => line.line),
    [2, 4],
  );
  t.false(results[3].ok);
});

test('source paths and limits are checked independently before lookup', async t => {
  const tool = makeReadSourcesTool(makePowers({}));
  const { results } = JSON.parse(
    await tool.execute({
      petName: 'source',
      items: [
        { path: ['..', 'secret'] },
        { path: ['/etc/passwd'] },
        { path: ['a\\b'] },
        { path: ['a'], lineCount: 201 },
        { path: ['a'], startLine: 0 },
        { path: ['a'], search: '' },
      ],
    }),
  );
  t.true(results.every(result => !result.ok));
  await t.throwsAsync(
    () =>
      tool.execute({
        petName: 'source',
        items: Array(9).fill({ path: ['a'] }),
      }),
    { message: /between 1 and 8/ },
  );
});

test('bounded source scanning distinguishes incomplete search from no match', async t => {
  const tool = makeReadSourcesTool(
    makePowers({
      large: `${'x'.repeat(1024 * 1024)}needle`,
      long: 'x'.repeat(9000),
    }),
  );
  const { results } = JSON.parse(
    await tool.execute({
      petName: 'source',
      items: [{ path: ['large'], search: 'needle' }, { path: ['long'] }],
    }),
  );
  t.deepEqual(results[0].lines, []);
  t.true(results[0].scanTruncated);
  t.is(results[1].lines[0].text.length, 8000);
  t.true(results[1].outputTruncated);
});

test('source reader closes its stream at the scan ceiling', async t => {
  t.timeout(10_000);
  let closed = false;
  let pulls = 0;
  const source = {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          pulls += 1;
          yield new TextEncoder().encode('x'.repeat(32_768));
        }
      } finally {
        closed = true;
      }
    },
  };
  const mount = Far('Mount', { lookup: () => bytesReaderFromIterator(source) });
  const powers = Far('Powers', { lookup: () => mount });
  const result = JSON.parse(
    await makeReadSourcesTool(powers).execute({
      petName: 'source',
      items: [{ path: ['a'] }],
    }),
  );
  t.true(result.results[0].scanTruncated);
  t.true(closed);
  t.is(pulls, 32);
});

test('real read-only mount retains symlink confinement and exposes method documentation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fae-source-tools-'));
  t.teardown(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'inside'));
  fs.writeFileSync(path.join(root, 'outside'), 'not-authorized');
  fs.writeFileSync(
    path.join(root, 'inside', 'code.js'),
    'first\nconst checkpoint = 1;\nlast',
  );
  fs.symlinkSync(
    path.join(root, 'outside'),
    path.join(root, 'inside', 'escape'),
  );
  const mount = makeMount({
    rootPath: path.join(root, 'inside'),
    readOnly: true,
    filePowers: makeFilePowers({ fs, path }),
  });
  const powers = Far('Powers', { lookup: () => mount });
  const { results } = JSON.parse(
    await makeReadSourcesTool(powers).execute({
      petName: 'source',
      items: [
        { path: ['code.js'], search: 'checkpoint' },
        { path: ['escape'] },
      ],
    }),
  );
  t.deepEqual(results[0].lines, [{ line: 2, text: 'const checkpoint = 1;' }]);
  t.false(results[1].ok);
  t.false(JSON.stringify(results).includes('not-authorized'));
  const description = JSON.parse(
    await makeDescribeCapabilityTool(powers).execute({
      petName: 'source',
      method: 'readText',
    }),
  );
  t.regex(description.documentation, /readText\(/);
  await t.throwsAsync(() => E(mount).writeText(['code.js'], 'mutated'), {
    message: /read-only/,
  });
});
