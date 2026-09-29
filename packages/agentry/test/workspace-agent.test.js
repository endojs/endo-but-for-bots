// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';
import { Far } from '@endo/pass-style';

import { defineWorkspaceAgent } from '../src/workspace-agent.js';

/** @import { ProvisionWorkspaceGrants } from '@endo/agent-tools/types-index.js' */

/** @param {string} label */
const grant = label => Far(label, {});

/**
 * The agent only derives tool records in these tests, so inert remotables are
 * sufficient stand-ins for the capabilities the records would invoke.
 *
 * @param {Record<string, object>} grants
 * @returns {ProvisionWorkspaceGrants}
 */
const testGrants = grants =>
  /** @type {ProvisionWorkspaceGrants} */ (/** @type {unknown} */ (grants));

test('workspace agent installs only its explicit grants with qualified inspect names', async t => {
  const makeAgent = defineWorkspaceAgent({
    model: { provider: 'ollama', model: 'qwen3' },
  });
  const agent = await makeAgent({
    workspaceGrants: testGrants({
      filesystem: grant('Filesystem'),
      git: grant('Git'),
      remote: grant('GitRemote'),
      shell: grant('Shell'),
    }),
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
    workspaceGrants: testGrants({ filesystem: grant('Filesystem') }),
  });
  const names = new Set(agent.state.tools.map(tool => tool.name));

  t.deepEqual(
    names,
    new Set(['mountReadText', 'mountList', 'mountStat', 'mountWriteText']),
  );
});

test('workspace agent rejects tools from any source other than its grants', async t => {
  const workspaceGrants = testGrants({ filesystem: grant('Filesystem') });
  t.throws(() => defineWorkspaceAgent(/** @type {any} */ ({ tools: [] })), {
    message: /remove config\.tools/,
  });
  await t.throwsAsync(
    () =>
      defineWorkspaceAgent()(
        /** @type {any} */ ({ workspaceGrants, tools: [] }),
      ),
    { message: /remove options\.tools/ },
  );
  const endowed = defineWorkspaceAgent({ endow: () => ({ tools: [] }) });
  await t.throwsAsync(() => endowed({ workspaceGrants }), {
    message: /endow hook may not return tools/,
  });
  const credentialed = defineWorkspaceAgent({
    endow: () => ({ getApiKey: () => 'key' }),
  });
  const agent = await credentialed({ workspaceGrants });
  t.is(agent.state.tools.length, 4);
});

test('workspace agent endow hook never sees the granted tools', async t => {
  /** @type {object[]} */
  const seen = [];
  const makeAgent = defineWorkspaceAgent({
    endow: (_definition, options) => {
      seen.push(options);
      return {};
    },
  });
  const agent = await makeAgent({
    workspaceGrants: testGrants({
      filesystem: grant('Filesystem'),
      git: grant('Git'),
      remote: grant('GitRemote'),
      shell: grant('Shell'),
    }),
  });
  t.true(agent.state.tools.length > 0);
  t.is(seen.length, 1);
  t.false('tools' in seen[0]);
  t.false('workspaceGrants' in seen[0]);
});

test('workspace agent fails closed when an endow hook returns no endowments', async t => {
  const makeAgent = defineWorkspaceAgent({
    endow: /** @type {any} */ (() => undefined),
  });
  await t.throwsAsync(
    () =>
      makeAgent({
        workspaceGrants: testGrants({ filesystem: grant('Filesystem') }),
      }),
    { message: /endow hook must return an endowments object/ },
  );
});
