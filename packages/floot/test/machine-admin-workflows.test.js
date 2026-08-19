// @ts-check
import test from '@endo/ses-ava/prepare-endo.js';

import { getPreset } from '../agent.js';

test('machine-admin receives the two attenuated deploy factories', t => {
  const preset = getPreset('machine-admin');
  const factories = preset.objects.filter(
    object => object.kind === 'workflow-factory',
  );

  t.deepEqual(factories, [
    {
      kind: 'workflow-factory',
      petName: 'deploy-endo',
      grantName: 'deploy-endo-factory',
    },
    {
      kind: 'workflow-factory',
      petName: 'change-nixos',
      grantName: 'change-nixos-factory',
    },
  ]);
});

test('machine-admin prompt routes ordinary deploys through durable runs', t => {
  const { systemPrompt } = getPreset('machine-admin');

  t.true(
    systemPrompt.includes(
      'NORMAL DEPLOYS MUST GO THROUGH A WORKFLOW FACTORY',
    ),
  );
  t.true(systemPrompt.includes("lookup('deploy-endo')"));
  t.true(systemPrompt.includes("lookup('change-nixos')"));
  t.true(systemPrompt.includes('E(deployEndo).start'));
  t.true(systemPrompt.includes('E(changeNixos).start'));
  t.true(systemPrompt.includes('storeValue(run, runName)'));
  t.true(systemPrompt.includes("approval form to the OWNER'S INBOX"));

  // The old source-deploy recipe staged and applied through the raw caplet.
  // Keeping that example would invite the model to bypass the journal and
  // operator gate even though the preset now holds attenuated factories.
  t.false(systemPrompt.includes('E(nixos).stageRev(head.oid)'));
  t.false(systemPrompt.includes("E(nixos).apply('pin endo"));
});
