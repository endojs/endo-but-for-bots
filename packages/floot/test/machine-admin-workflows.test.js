// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { getPreset, refreshPresetEntry } from '../agent.js';

/** @type {(id: string) => Array<{ kind: string, petName: string, grantName?: string, required?: boolean }>} */
const objectsOf = id => /** @type {any} */ (getPreset(id).objects);

test('machine-admin receives the raw caplet and the two attenuated deploy connections', t => {
  const preset = getPreset('machine-admin');
  t.is(preset.id, 'machine-admin');
  const objects = objectsOf('machine-admin');
  t.deepEqual(
    objects.map(({ kind, petName }) => [kind, petName]),
    [
      ['host-powers', 'endo'],
      ['code-mount', 'endo-src'],
      ['nixos-admin', 'nixos'],
      ['workflow-factory', 'deploy-endo'],
      ['workflow-factory', 'change-nixos'],
    ],
  );
  // The connections are optional: a host without the workflow service still
  // opens the session, and the prompt then reports deployment unavailable.
  t.deepEqual(
    objects.filter(object => object.kind === 'workflow-factory'),
    [
      {
        kind: 'workflow-factory',
        petName: 'deploy-endo',
        grantName: 'deploy-endo-factory',
        required: false,
      },
      {
        kind: 'workflow-factory',
        petName: 'change-nixos',
        grantName: 'change-nixos-factory',
        required: false,
      },
    ],
  );
  // The raw caplet is what makes the session a machine admin; without it
  // the session must fail to open rather than open as something else.
  t.deepEqual(
    objects.find(object => object.kind === 'nixos-admin'),
    { kind: 'nixos-admin', petName: 'nixos', grantName: 'nixos-admin' },
  );
});

test('machine-admin prompt routes ordinary deploys through durable runs', t => {
  const { systemPrompt } = getPreset('machine-admin');

  t.true(
    systemPrompt.includes('NORMAL DEPLOYS MUST GO THROUGH A WORKFLOW FACTORY'),
  );
  t.true(systemPrompt.includes("lookup('deploy-endo')"));
  t.true(systemPrompt.includes("lookup('change-nixos')"));
  t.true(systemPrompt.includes('E(deployEndo).start'));
  t.true(systemPrompt.includes('E(changeNixos).start'));
  t.true(systemPrompt.includes("approval form to the OWNER'S INBOX"));

  // The old source-deploy recipe staged and applied through the raw caplet.
  // Keeping that example would invite the model to bypass the journal and
  // operator gate even though the preset now holds attenuated connections.
  t.false(systemPrompt.includes('E(nixos).stageRev(head.oid)'));
  t.false(systemPrompt.includes("E(nixos).apply('pin endo"));
});

test('machine-admin prompt re-reaches a run through its connection, not by name or via the service', t => {
  const { systemPrompt } = getPreset('machine-admin');

  // A run observer is a derived object with no formula behind it, so
  // storeValue throws on one and there is nothing to look up by name.
  t.false(systemPrompt.includes('storeValue(run'));
  // The connection scopes observation to its own factory's runs; the pinned
  // service would hand the session control over every run on the daemon.
  t.false(systemPrompt.includes("lookup('@pins')"));
  t.false(systemPrompt.includes("lookup('workflow-service')"));
  t.true(systemPrompt.includes('E(deployEndo).status(runId)'));
  t.true(systemPrompt.includes('E(deployEndo).explain(runId)'));
  t.true(systemPrompt.includes('E(deployEndo).journal(runId'));
});

test("machine-admin prompt teaches this tree's exec and mount contracts", t => {
  const { systemPrompt } = getPreset('machine-admin');

  // exec hands in sleep(ms) and nothing else can wait.
  t.true(systemPrompt.includes('await sleep(ms)'));
  // Mount paths are segments or entry() tokens here; the source deployment's
  // prompt claimed a slash-joined string names the same file, which this
  // tree rejects.
  t.true(systemPrompt.includes('a slash-joined string is rejected'));
  t.false(systemPrompt.includes("readText('a/b')"));
  // Container mounts are not part of this tree.
  t.false(systemPrompt.includes('attachContainerMount'));
  t.false(systemPrompt.includes('listContainerMounts'));
  // git.status() is copy data, not an array (matching the new-project prompt).
  t.true(systemPrompt.includes('{ entries, truncated }'));
  t.false(systemPrompt.includes('st.map'));
});

test('machine-admin prompt sets up a remote this tree can construct and push through', t => {
  const { systemPrompt } = getPreset('machine-admin');

  // Git remotes here speak https only, and a credential is accepted only on
  // an https remote: the forge URL is derived from the credential's audience,
  // never hard-coded with a scheme.
  t.true(systemPrompt.includes('E(credential).audience()'));
  t.false(systemPrompt.includes('http://'));
  // A push-capable remote must name what it may push; the policy fences the
  // session to its review branch.
  t.true(systemPrompt.includes("allowedBranches: ['agent']"));
  t.false(systemPrompt.includes('not fenced in'));
  // An http audience is refused by the transport, so the recipe stops and
  // reports rather than erroring at the clone.
  t.true(systemPrompt.includes("url.startsWith('https:')"));
  // createBranch does not switch by itself, and switchBranch fails on a
  // branch that does not exist yet: the recipe checks first.
  t.true(systemPrompt.includes('E(git).branches()'));
  t.true(
    systemPrompt.includes("createBranch('agent', { switchAfterCreate: true })"),
  );
  // The git the session commits through is minted separately from the clone
  // and takes its own identity; without it commits are attributed to Endo.
  t.true(systemPrompt.includes("provideGit(mount, 'endo-work', { identity })"));
  // The clone's own capabilities can be stored by name; the prompt must not
  // claim otherwise.
  t.false(systemPrompt.includes('cannot store by name'));
});

test('machine-admin prompt migration updates legacy sessions exactly once', t => {
  const legacy = harden({
    id: 'old-admin',
    presetId: 'machine-admin',
    systemPrompt: 'use the raw caplet',
  });
  const migrated = refreshPresetEntry(legacy);

  t.not(migrated, legacy);
  t.is(migrated.presetPromptVersion, 2);
  t.is(migrated.systemPrompt, getPreset('machine-admin').systemPrompt);
  t.is(refreshPresetEntry(migrated), migrated);

  // The deployment this preset was ported from stamped its sessions v1;
  // their recipes do not hold in this tree, so they migrate too.
  const v1 = harden({ ...legacy, presetPromptVersion: 1 });
  const fromV1 = refreshPresetEntry(v1);
  t.not(fromV1, v1);
  t.is(fromV1.presetPromptVersion, 2);
});

test('versioned migration leaves other preset snapshots unchanged', t => {
  const general = harden({
    id: 'general-session',
    presetId: 'general',
    systemPrompt: 'my pinned persona',
  });
  t.is(refreshPresetEntry(general), general);

  const unknown = harden({
    id: 'unknown-session',
    presetId: 'no-such-preset',
    systemPrompt: 'my pinned persona',
  });
  t.is(refreshPresetEntry(unknown), unknown);
});

test('versioned migration never replaces a custom or a delegated prompt', t => {
  // An operator's own prompt replaced the preset's at creation.
  const custom = harden({
    id: 'custom-admin',
    presetId: 'machine-admin',
    systemPrompt: 'operator rules',
    customPrompt: true,
  });
  t.is(refreshPresetEntry(custom), custom);

  // A subagent's prompt is the preset composed with what its parent wrote;
  // the parent's part is not stored on its own, so it cannot be recomposed.
  const delegated = harden({
    id: 'helper',
    presetId: 'machine-admin',
    systemPrompt: 'preset text --- parent instructions',
    parentSessionId: 'old-admin',
    subagentName: 'helper',
  });
  t.is(refreshPresetEntry(delegated), delegated);
});
