// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

test('the package entry re-exports exactly its public surface', async t => {
  const entry = await import('@endo/agent-mcp-stdio');
  t.deepEqual(
    Object.keys(entry).sort(),
    [
      'BROKER_SOCKET_NAME',
      'FORMULA_ID_ENV',
      'MCP_HTTP_DEFAULT_PORT',
      'MCP_HTTP_PATH',
      'RELAY_PATH',
      'SERVER_LABEL',
      'connectToDaemon',
      'constructGuestMcpServer',
      'hostOnlyMethods',
      'isFormulaIdentifier',
      'mainHttp',
      'makeAgentTools',
      'makeGuestMcpServer',
      'makeGuestServerResolver',
      'makeLineWriter',
      'makeMcpConfig',
      'makeMcpHttpHandler',
      'makeRelayTransport',
      'parseBearer',
      'parseClaudeStreamJson',
      'readFormulaId',
      'renderGuestAllowedTools',
      'requiredGuestMethods',
      'resolveGuest',
      'serveStdio',
      'startGuestBroker',
      'startMcpHttpGateway',
    ],
    '@endo/agent-mcp-stdio export surface',
  );
});
