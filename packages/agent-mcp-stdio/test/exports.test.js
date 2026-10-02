// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

test('the package entry re-exports exactly its public surface', async t => {
  const entry = await import('@endo/agent-mcp-stdio');
  t.deepEqual(
    Object.keys(entry).sort(),
    [
      'BROKER_SOCKET_NAME',
      'FORMULA_ID_ENV',
      'RELAY_PATH',
      'SERVER_LABEL',
      'confinedToolNames',
      'connectToDaemon',
      'constructGuestMcpServer',
      'hostOnlyMethods',
      'makeAgentTools',
      'makeGuestMcpServer',
      'makeLineWriter',
      'makeMcpConfig',
      'makeRelayTransport',
      'parseClaudeStreamJson',
      'readFormulaId',
      'renderGuestAllowedTools',
      'requiredGuestMethods',
      'resolveGuest',
      'selectConfinedTools',
      'serveStdio',
      'startGuestBroker',
    ],
    '@endo/agent-mcp-stdio export surface',
  );
});
