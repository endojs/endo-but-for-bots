// @ts-check
/// <reference types="ses"/>

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import test from '@endo/ses-ava/prepare-endo.js';
import { E } from '@endo/eventual-send';

import { makeCompartmentEvaluate } from '../src/code-mode/compartment.js';
import { formatGlobalDeclarations } from '../src/code-mode/declarations.js';
import { makeEvaluateTool } from '../src/code-mode/evaluate-tool.js';
import {
  makeInMemoryWorkspaceSeam,
  makeNodeWorkspaceSeam,
} from '../src/code-mode-globals/fs-seams.js';
import { listDeclaredTypeMembers } from './_util/declaration-inspect.js';

/** @import { Directory } from '@endo/platform/fs/extended' */
/** @import { WorkspaceSeam } from '../src/code-mode-globals/fs-seams.js' */

/**
 * Mint a node-fs seam over a temporary directory that the test tears down.
 *
 * @param {import('ava').ExecutionContext} t
 */
const makeTempNodeSeam = async t => {
  const rootPath = await mkdtemp(join(tmpdir(), 'agent-tools-workspace-'));
  t.teardown(() => rm(rootPath, { recursive: true, force: true }));
  return makeNodeWorkspaceSeam({ rootPath });
};

test('both seams describe the same guest-facing workspace', async t => {
  const memory = makeInMemoryWorkspaceSeam();
  const node = await makeTempNodeSeam(t);

  t.deepEqual(memory.global, node.global);
  t.like(memory.global, { name: 'workspace', petName: 'workspace' });
  const { declaration } = memory.global;
  if (declaration === undefined) {
    throw new Error('expected workspace global declaration');
  }
  t.true(declaration.body.startsWith('{'));
  t.true(declaration.aux?.includes('type NodeStat =') ?? false);
  // The backing is the host's business: nothing in what the guest reads names
  // it.
  const prompt = formatGlobalDeclarations([memory.global]);
  t.true(prompt.includes('declare const workspace: {'));
  t.false(/in-memory|node:fs/u.test(prompt));
});

// Conformance: a declaration that advertises a method the minted capability
// does not have would send the model straight into a failed call. Check the
// declared surface against the live one rather than trusting the pairing.
test('each seam declares a subset of the methods its capability has', async t => {
  const nodeSeam = await makeTempNodeSeam(t);
  /** @type {Array<[string, WorkspaceSeam]>} */
  const seams = [
    ['in-memory', makeInMemoryWorkspaceSeam()],
    ['node-fs', nodeSeam],
  ];
  await Promise.all(
    seams.map(async ([label, { workspace, global }]) => {
      const body = global.declaration?.body;
      if (body === undefined) {
        t.fail(`${label} seam must carry a declaration`);
        return;
      }
      const declared = listDeclaredTypeMembers(
        `type Filesystem = ${body};`,
        'Filesystem',
      );
      t.true(declared.length > 0, `${label} declares no methods`);
      // eslint-disable-next-line no-underscore-dangle
      const live = await E(/** @type {any} */ (workspace)).__getMethodNames__();
      for (const name of declared) {
        t.true(
          live.includes(name),
          `${label}: declared ${name} is absent from the minted capability`,
        );
      }
    }),
  );
});

test('a compartment guest writes and reads through the in-memory seam', async t => {
  const { workspace, global } = makeInMemoryWorkspaceSeam();
  const evaluate = makeCompartmentEvaluate({ endowments: { E, workspace } });
  const tool = makeEvaluateTool(evaluate, [global]);

  const result = await tool.invoke({
    source: `(async () => {
  const root = await E(workspace).root();
  await E(root).write('note.txt', 'from the guest');
  const file = await E(root).lookup('note.txt');
  const info = await E(await E(file).snapshot()).getInfo();
  const entries = await E(await E(root).list()).toArray();
  return { size: info.size, entries: entries.map(entry => entry.name) };
})()`,
  });
  t.deepEqual(result, { size: 14n, entries: ['note.txt'] });
});

test('the node seam roots the guest at the host path it was given', async t => {
  const { workspace, global } = await makeTempNodeSeam(t);
  const evaluate = makeCompartmentEvaluate({ endowments: { E, workspace } });
  const tool = makeEvaluateTool(evaluate, [global]);

  await tool.invoke({
    source: `(async () => {
  const root = await E(workspace).root();
  const sub = await E(root).makeDirectory('nested');
  await E(sub).write('kept.txt', 'on disk');
})()`,
  });

  const root = await E(workspace).root();
  const sub = /** @type {Directory} */ (await E(root).lookup('nested'));
  const page = await E(await E(sub).list()).read();
  t.deepEqual(
    page.entries.map(entry => entry.name),
    ['kept.txt'],
  );
  // The workspace root is the top of the guest's reach; there is no parent to
  // climb to.
  await t.throwsAsync(() => E(root).lookup('..'), { message: /EINVAL/ });
});
