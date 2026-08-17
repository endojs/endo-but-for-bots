// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { renderMcpConfig, serializeMcpConfig } from '../src/mcp-config.js';

const HEX64 = 'a'.repeat(64);

test('stdio transport renders one named server with no bearer on a wire', t => {
  const config = renderMcpConfig({
    serverName: 'endo',
    transport: { kind: 'stdio', command: '/opt/endo-claude-shim', args: ['--x'] },
  });
  t.deepEqual(config, {
    mcpServers: {
      endo: { type: 'stdio', command: '/opt/endo-claude-shim', args: ['--x'] },
    },
  });
  // Round-trips through JSON.
  t.deepEqual(JSON.parse(serializeMcpConfig(config)), {
    mcpServers: {
      endo: { type: 'stdio', command: '/opt/endo-claude-shim', args: ['--x'] },
    },
  });
});

test('http transport carries a loopback URL and a formula-id bearer', t => {
  const config = /** @type {any} */ (
    renderMcpConfig({
      serverName: 'endo',
      transport: { kind: 'http', url: 'http://127.0.0.1:8991/mcp', bearer: HEX64 },
    })
  );
  t.deepEqual(config.mcpServers.endo, {
    type: 'http',
    url: 'http://127.0.0.1:8991/mcp',
    headers: { Authorization: `Bearer ${HEX64}` },
  });
});

test('http transport refuses a non-loopback URL', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: { kind: 'http', url: 'http://10.0.0.5/mcp', bearer: HEX64 },
      }),
    { message: /not loopback/ },
  );
});

test('http transport refuses a non-64-hex bearer (header injection guard)', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: {
          kind: 'http',
          url: 'http://127.0.0.1/mcp',
          bearer: 'not-hex\r\nX-Evil: 1',
        },
      }),
    { message: /64 lowercase hex/ },
  );
});

test('renderMcpConfig refuses a malformed server name', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo__x',
        transport: { kind: 'stdio', command: '/x' },
      }),
    { message: /invalid server name/ },
  );
});
