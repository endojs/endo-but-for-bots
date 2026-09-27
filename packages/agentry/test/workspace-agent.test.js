// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/pass-style';

import { defineWorkspaceAgent } from '../src/workspace-agent.js';

/** @param {string} label */
const grant = label => Far(label, {});

test('workspace agent installs only its explicit grants with qualified inspect names', async t => {
  const makeAgent = defineWorkspaceAgent({
    model: { provider: 'ollama', model: 'qwen3' },
  });
  const agent = await makeAgent({
    workspaceGrants: {
      filesystem: grant('Filesystem'),
      git: grant('Git'),
      remote: grant('GitRemote'),
      shell: grant('Shell'),
    },
  });
  const names = new Set(agent.state.tools.map(tool => tool.name));

  t.true(names.has('mountReadText'));
  t.true(names.has('commit'));
  t.true(names.has('push'));
  t.true(names.has('exec'));
  t.true(names.has('inspectGitRemote'));
  t.true(names.has('inspectShell'));
  t.false(names.has('inspect'));
  t.is(names.size, agent.state.tools.length, 'no grant shadows another');
});

test('workspace agent does not discover capabilities omitted by the caller', async t => {
  const makeAgent = defineWorkspaceAgent();
  const agent = await makeAgent({
    workspaceGrants: { filesystem: grant('Filesystem') },
  });
  const names = new Set(agent.state.tools.map(tool => tool.name));

  t.deepEqual(
    names,
    new Set(['mountReadText', 'mountList', 'mountStat', 'mountWriteText']),
  );
});
