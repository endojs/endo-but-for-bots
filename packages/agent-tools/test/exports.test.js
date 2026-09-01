// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

test('agent-tools scoped exports resolve the relocated surfaces', async t => {
  const [
    root,
    pi,
    tool,
    workspace,
    jsonToolsGit,
    jsonToolsGitMount,
    jsonToolsGitRemote,
    jsonToolsFs,
    jsonToolsShell,
    jsonToolsHttp,
    evaluate,
    compartment,
    daemon,
    codeModeDeclarations,
    globalsGit,
    globalsFs,
    globalsFsSeams,
    globalsShell,
    globalsHttp,
    globalsGitRemote,
    adaptersPi,
    codeModeTypes,
    smallcaps,
    mcp,
    generatedGitDeclarations,
    generatedFsDeclarations,
    generatedShellDeclarations,
    generatedHttpDeclarations,
    generatedGitRemoteDeclarations,
    typesIndex,
  ] = await Promise.all([
    import('@endo/agent-tools'),
    import('@endo/agent-tools/pi'),
    import('@endo/agent-tools/tool.js'),
    import('@endo/agent-tools/workspace.js'),
    import('@endo/agent-tools/json-tools/git.js'),
    import('@endo/agent-tools/json-tools/git-mount.js'),
    import('@endo/agent-tools/json-tools/git-remote.js'),
    import('@endo/agent-tools/json-tools/fs.js'),
    import('@endo/agent-tools/json-tools/shell.js'),
    import('@endo/agent-tools/json-tools/http.js'),
    import('@endo/agent-tools/code-mode/evaluate-tool.js'),
    import('@endo/agent-tools/code-mode/compartment.js'),
    import('@endo/agent-tools/code-mode/daemon.js'),
    import('@endo/agent-tools/code-mode/declarations.js'),
    import('@endo/agent-tools/code-mode-globals/git.js'),
    import('@endo/agent-tools/code-mode-globals/fs.js'),
    import('@endo/agent-tools/code-mode-globals/fs-seams.js'),
    import('@endo/agent-tools/code-mode-globals/shell.js'),
    import('@endo/agent-tools/code-mode-globals/http.js'),
    import('@endo/agent-tools/code-mode-globals/git-remote.js'),
    import('@endo/agent-tools/adapters/pi.js'),
    import('@endo/agent-tools/code-mode/types.js'),
    import('@endo/agent-tools/adapters/smallcaps.js'),
    import('@endo/agent-tools/adapters/mcp.js'),
    import('@endo/agent-tools/generated/code-mode-globals/git-declarations.js'),
    import('@endo/agent-tools/generated/code-mode-globals/fs-declarations.js'),
    import('@endo/agent-tools/generated/code-mode-globals/shell-declarations.js'),
    import('@endo/agent-tools/generated/code-mode-globals/http-declarations.js'),
    import('@endo/agent-tools/generated/code-mode-globals/git-remote-declarations.js'),
    import('@endo/agent-tools/types-index.js'),
  ]);

  // Pin the public runtime surface of the package's primary tool entry points.
  t.is(typeof root.makeTool, 'function');
  t.deepEqual(
    Object.keys(root).sort(),
    [
      'makeGitHistoryTool',
      'makeGitMountTools',
      'makeGitRemoteTool',
      'makeGitTool',
      'makeHttpTool',
      'makeMountEditTool',
      'makeMountFsTools',
      'makeMountListTool',
      'makeMountReadTool',
      'makeMountStatTool',
      'makeShellTool',
      'makeSturdyRefEscrow',
      'makeTool',
      'makeWorkspaceTools',
      'provisionHistoryTools',
      'provisionWorkspaceTools',
    ],
    '@endo/agent-tools export surface',
  );

  t.is(typeof pi.toPiAgentTool, 'function');
  t.deepEqual(
    Object.keys(pi).sort(),
    ['toPiAgentTool'],
    '@endo/agent-tools/pi export surface',
  );

  t.deepEqual(
    Object.keys(tool).sort(),
    ['makeTool'],
    '@endo/agent-tools/tool.js export surface',
  );

  t.deepEqual(
    Object.keys(workspace).sort(),
    ['makeWorkspaceTools', 'provisionHistoryTools', 'provisionWorkspaceTools'],
    '@endo/agent-tools/workspace.js export surface',
  );

  // Each nested JSON-tool entry point exposes its own public tool subset.
  t.deepEqual(
    Object.keys(jsonToolsGit).sort(),
    ['makeGitHistoryTool', 'makeGitTool'],
    '@endo/agent-tools/json-tools/git.js export surface',
  );

  t.deepEqual(
    Object.keys(jsonToolsGitMount).sort(),
    ['makeGitMountTools'],
    '@endo/agent-tools/json-tools/git-mount.js export surface',
  );

  t.deepEqual(
    Object.keys(jsonToolsGitRemote).sort(),
    ['makeGitRemoteTool'],
    '@endo/agent-tools/json-tools/git-remote.js export surface',
  );

  t.deepEqual(
    Object.keys(jsonToolsFs).sort(),
    [
      'makeMountEditTool',
      'makeMountFsTools',
      'makeMountListTool',
      'makeMountReadTool',
      'makeMountStatTool',
    ],
    '@endo/agent-tools/json-tools/fs.js export surface',
  );

  t.deepEqual(
    Object.keys(jsonToolsShell).sort(),
    ['makeShellTool'],
    '@endo/agent-tools/json-tools/shell.js export surface',
  );

  t.deepEqual(
    Object.keys(jsonToolsHttp).sort(),
    ['makeHttpTool'],
    '@endo/agent-tools/json-tools/http.js export surface',
  );

  // Pin the public runtime surface of the nested code-mode support modules.
  t.is(typeof evaluate.makeEvaluateTool, 'function');
  t.is(typeof evaluate.EVALUATE_PARAMETERS, 'object');
  t.deepEqual(
    Object.keys(evaluate).sort(),
    ['EVALUATE_PARAMETERS', 'makeEvaluateTool'],
    '@endo/agent-tools/code-mode/evaluate-tool.js export surface',
  );

  t.is(typeof compartment.makeCompartmentEvaluate, 'function');
  t.deepEqual(
    Object.keys(compartment).sort(),
    ['makeCompartmentEvaluate'],
    '@endo/agent-tools/code-mode/compartment.js export surface',
  );

  t.is(typeof daemon.makeDaemonEvaluate, 'function');
  t.deepEqual(
    Object.keys(daemon).sort(),
    ['makeDaemonEvaluate'],
    '@endo/agent-tools/code-mode/daemon.js export surface',
  );

  t.deepEqual(
    Object.keys(codeModeDeclarations).sort(),
    ['formatGlobalDeclarations', 'normalizeGlobals'],
    '@endo/agent-tools/code-mode/declarations.js export surface',
  );

  // Each code-mode global entry point pairs declarations with its public maker.
  t.is(typeof globalsGit.makeGitGlobal, 'function');
  t.deepEqual(
    Object.keys(globalsGit).sort(),
    ['gitDeclarations', 'makeGitGlobal'],
    '@endo/agent-tools/code-mode-globals/git.js export surface',
  );

  t.is(typeof globalsFs.makeWorkspaceGlobal, 'function');
  t.is(typeof globalsFs.makeFilesystemGlobal, 'function');
  t.deepEqual(
    Object.keys(globalsFs).sort(),
    ['fsDeclarations', 'makeFilesystemGlobal', 'makeWorkspaceGlobal'],
    '@endo/agent-tools/code-mode-globals/fs.js export surface',
  );

  t.is(typeof globalsFsSeams.makeInMemoryWorkspaceSeam, 'function');
  t.is(typeof globalsFsSeams.makeNodeWorkspaceSeam, 'function');
  t.deepEqual(
    Object.keys(globalsFsSeams).sort(),
    ['makeInMemoryWorkspaceSeam', 'makeNodeWorkspaceSeam'],
    '@endo/agent-tools/code-mode-globals/fs-seams.js export surface',
  );

  t.is(typeof globalsShell.makeShellGlobal, 'function');
  t.deepEqual(
    Object.keys(globalsShell).sort(),
    ['makeShellGlobal', 'shellDeclarations'],
    '@endo/agent-tools/code-mode-globals/shell.js export surface',
  );

  t.is(typeof globalsHttp.makeHttpGlobal, 'function');
  t.deepEqual(
    Object.keys(globalsHttp).sort(),
    ['httpDeclarations', 'makeHttpGlobal'],
    '@endo/agent-tools/code-mode-globals/http.js export surface',
  );

  t.is(typeof globalsGitRemote.makeGitRemoteGlobal, 'function');
  t.deepEqual(
    Object.keys(globalsGitRemote).sort(),
    ['gitRemoteDeclarations', 'makeGitRemoteGlobal'],
    '@endo/agent-tools/code-mode-globals/git-remote.js export surface',
  );

  // Adapter subpaths remain public; type-only adapters stay empty at runtime.
  t.deepEqual(
    Object.keys(adaptersPi).sort(),
    ['toPiAgentTool'],
    '@endo/agent-tools/adapters/pi.js export surface',
  );

  t.deepEqual(
    Object.keys(codeModeTypes).sort(),
    [],
    '@endo/agent-tools/code-mode/types.js runtime export surface',
  );

  t.is(typeof smallcaps.toolResultToSmallcaps, 'function');
  t.deepEqual(
    Object.keys(smallcaps).sort(),
    ['smallcapsMarshal', 'toolResultToSmallcaps'],
    '@endo/agent-tools/adapters/smallcaps.js export surface',
  );

  t.deepEqual(
    Object.keys(mcp).sort(),
    [],
    '@endo/agent-tools/adapters/mcp.js runtime export surface',
  );

  // Generated declaration entry points expose their matching runtime constants.
  t.deepEqual(
    Object.keys(generatedGitDeclarations).sort(),
    ['gitDeclarations'],
    '@endo/agent-tools/generated/code-mode-globals/git-declarations.js export surface',
  );

  t.deepEqual(
    Object.keys(generatedFsDeclarations).sort(),
    ['fsDeclarations'],
    '@endo/agent-tools/generated/code-mode-globals/fs-declarations.js export surface',
  );

  t.deepEqual(
    Object.keys(generatedShellDeclarations).sort(),
    ['shellDeclarations'],
    '@endo/agent-tools/generated/code-mode-globals/shell-declarations.js export surface',
  );

  t.deepEqual(
    Object.keys(generatedHttpDeclarations).sort(),
    ['httpDeclarations'],
    '@endo/agent-tools/generated/code-mode-globals/http-declarations.js export surface',
  );

  t.deepEqual(
    Object.keys(generatedGitRemoteDeclarations).sort(),
    ['gitRemoteDeclarations'],
    '@endo/agent-tools/generated/code-mode-globals/git-remote-declarations.js export surface',
  );

  // The public types-index subpath also mirrors the root runtime surface.
  t.deepEqual(
    Object.keys(typesIndex).sort(),
    [
      'makeGitHistoryTool',
      'makeGitMountTools',
      'makeGitRemoteTool',
      'makeGitTool',
      'makeHttpTool',
      'makeMountEditTool',
      'makeMountFsTools',
      'makeMountListTool',
      'makeMountReadTool',
      'makeMountStatTool',
      'makeShellTool',
      'makeSturdyRefEscrow',
      'makeTool',
      'makeWorkspaceTools',
      'provisionHistoryTools',
      'provisionWorkspaceTools',
    ],
    '@endo/agent-tools/types-index.js export surface',
  );
});
