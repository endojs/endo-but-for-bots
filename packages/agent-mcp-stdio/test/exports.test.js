// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

test('the package entry re-exports exactly its public surface', async t => {
  const entry = await import('@endo/agent-mcp-stdio');
  t.deepEqual(
    Object.keys(entry).sort(),
    [
      'FORMULA_ID_ENV',
      'SERVER_LABEL',
      'connectToDaemon',
      'constructGuestMcpServer',
      'hostOnlyMethods',
      'makeAgentTools',
      'makeGuestMcpServer',
      'makeLineWriter',
      'makeMcpConfig',
      'parseClaudeStreamJson',
      'readFormulaId',
      'renderGuestAllowedTools',
      'requiredGuestMethods',
      'resolveGuest',
      'serveStdio',
    ],
    '@endo/agent-mcp-stdio export surface',
  );
});
