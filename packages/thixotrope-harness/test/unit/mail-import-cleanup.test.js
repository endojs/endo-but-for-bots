// @ts-check
import './_m1a-prelude.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from '@endo/ses-ava/test.js';
import { Far } from '@endo/far';
import { importState } from '../../scripts/export.mjs';
import { names } from '../../scripts/provision-steps.js';

test('a refused staged inbox page releases its newly minted blob and abandons its session', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mail-import-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'export.jsonl');
  await writeFile(
    file,
    [
      {
        type: 'session',
        head: {
          title: 'import',
          userInitiated: true,
          config: { backendTitle: 'fake', modelId: 'm', createdAt: 1 },
        },
      },
      { type: 'inbox', messages: [{ body: { text: 'mail body' } }] },
    ]
      .map(v => JSON.stringify(v))
      .join('\n'),
  );
  const session = Far('Session', {});
  const blob = Far('Blob', {});
  const seen = [];
  const backend = Far('Backend', { describe: () => harden({ label: 'fake' }) });
  const factory = Far('SessionFactory', {
    listBackends: () => harden([backend]),
    deleteSession: (/** @type {any} */ s) => {
      seen.push(s);
    },
  });
  const operator = Far('Operator', { getFactory: () => factory });
  const internal = Far('SessionInternal', {
    importState: (/** @type {any} */ chunk) => {
      if (chunk.part === 'inbox') {
        t.is(chunk.messages[0].body.blob, blob);
        throw Error('refused inbox');
      }
    },
  });
  const root = Far('HarnessRoot', {
    getOperator: () => operator,
    importSession: () => harden({ session, internal }),
  });
  const writer = Far('BlobWriter', {
    append: () => {},
    close: () => harden({ blob, bytes: 9, preview: 'mail body' }),
  });
  const writers = Far('BlobWriters', { open: () => writer });
  const admin = Far('AgentHostAdmin', {
    writersFor: () => writers,
    releaseBlobs: (/** @type {any[]} */ blobs) => {
      seen.push(...blobs);
    },
  });
  const client = {
    call: (/** @type {string} */ _method, /** @type {string} */ key) =>
      key === names.harness ? root : admin,
  };
  await t.throwsAsync(importState({ client, file }), {
    message: /contains a refused inbox page/,
  });
  t.deepEqual(seen, [blob, session]);
});
