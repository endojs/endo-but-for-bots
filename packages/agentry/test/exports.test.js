// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

test('agentry subpaths resolve through package exports', async t => {
  const [
    rootModule,
    harnessModule,
    defineAgentModule,
    codeModeModule,
    codeModeProvisioningModule,
    harnessTypesModule,
    codeModeTypesModule,
    endoCodeModePiExtensionModule,
    evalModule,
    editTextModule,
  ] = await Promise.all([
    import('@endo/agentry'),
    import('@endo/agentry/harness'),
    import('@endo/agentry/define-agent'),
    import('@endo/agentry/code-mode'),
    import('@endo/agentry/code-mode-provisioning'),
    import('@endo/agentry/harness/types.js'),
    import('@endo/agentry/code-mode/types.js'),
    import('@endo/agentry/endo-code-mode-pi-extension'),
    import('@endo/agentry/eval'),
    import('@endo/agentry/edit-text'),
  ]);

  // Pin the public runtime surface of the package's primary entry points.
  t.is(typeof rootModule.defineAgent, 'function');
  t.deepEqual(
    Object.keys(rootModule).sort(),
    [
      'buildOllamaModel',
      'defineAgent',
      'defineModels',
      'getAmbientEnv',
      'makeApiKeyGetter',
      'makeEnvCredentials',
      'makePiAgent',
      'resolveModel',
      'resolveModelProfile',
      'resolveModelString',
    ],
    '@endo/agentry export surface',
  );

  t.is(typeof harnessModule.makePiAgent, 'function');
  t.deepEqual(
    Object.keys(harnessModule).sort(),
    [
      'buildOllamaModel',
      'defineModels',
      'getAmbientEnv',
      'makeApiKeyGetter',
      'makeEnvCredentials',
      'makePiAgent',
      'resolveModel',
      'resolveModelProfile',
      'resolveModelString',
    ],
    '@endo/agentry/harness export surface',
  );

  t.deepEqual(
    Object.keys(defineAgentModule).sort(),
    ['defineAgent', 'makeEnvCredentials'],
    '@endo/agentry/define-agent export surface',
  );

  t.is(typeof codeModeModule.makeCodeModeAgent, 'function');
  t.deepEqual(
    Object.keys(codeModeModule).sort(),
    [
      'makeCodeModeAgent',
      'makeCodeModeAgentFromLookup',
      'makeCodeModeGitLoopAgent',
      'makeCodeModeSystemPrompt',
      'resolveCodeModePowers',
    ],
    '@endo/agentry/code-mode export surface',
  );

  t.is(typeof codeModeProvisioningModule.provisionEndoCodeMode, 'function');
  t.is(typeof codeModeProvisioningModule.reconstructEndoCodeMode, 'function');
  t.deepEqual(
    Object.keys(codeModeProvisioningModule).sort(),
    ['provisionEndoCodeMode', 'reconstructEndoCodeMode'],
    '@endo/agentry/code-mode-provisioning export surface',
  );

  // The nested type-only entry points intentionally have empty runtime surfaces.
  t.deepEqual(
    Object.keys(harnessTypesModule).sort(),
    [],
    '@endo/agentry/harness/types.js runtime export surface',
  );
  t.deepEqual(
    Object.keys(codeModeTypesModule).sort(),
    [],
    '@endo/agentry/code-mode/types.js runtime export surface',
  );

  t.is(typeof endoCodeModePiExtensionModule.default, 'function');
  t.is(
    typeof endoCodeModePiExtensionModule.makeEndoCodeModePiExtension,
    'function',
  );
  t.deepEqual(
    Object.keys(endoCodeModePiExtensionModule).sort(),
    ['default', 'makeEndoCodeModePiExtension'],
    '@endo/agentry/endo-code-mode-pi-extension export surface',
  );

  // Pin the public runtime surface of the evaluation and text-editing utilities.
  t.is(typeof evalModule.runGitScenario, 'function');
  t.deepEqual(
    Object.keys(evalModule).sort(),
    ['makeRunMetricsRecorder', 'resolveEvalModelFromEnv', 'runGitScenario'],
    '@endo/agentry/eval export surface',
  );

  t.is(typeof editTextModule.applyEdits, 'function');
  t.deepEqual(
    Object.keys(editTextModule).sort(),
    ['applyEdits', 'computeUnifiedDiff', 'normalizeEdits'],
    '@endo/agentry/edit-text export surface',
  );
});
