// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { renderMcpConfig, serializeMcpConfig } from '../src/mcp-config.js';

const HEX64 = 'a'.repeat(64);

test('stdio transport renders one named server with no bearer on a wire', t => {
  const config = renderMcpConfig({
    serverName: 'endo',
    transport: {
      kind: 'stdio',
      command: '/opt/endo-claude-shim',
      args: ['--x'],
    },
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
      transport: {
        kind: 'http',
        url: 'http://127.0.0.1:8991/mcp',
        bearer: HEX64,
      },
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

test('renderMcpConfig requires a transport object', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: /** @type {any} */ (undefined),
      }),
    { message: /transport is required/ },
  );
});

test('stdio transport requires a non-empty command path', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: { kind: 'stdio', command: '' },
      }),
    { message: /requires a command path/ },
  );
});

test('stdio transport refuses a non-string arg', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: {
          kind: 'stdio',
          command: '/x',
          args: /** @type {any} */ ([1]),
        },
      }),
    { message: /args must be strings/ },
  );
});

test('http transport refuses a URL carrying a CR/LF (header-injection guard)', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: {
          kind: 'http',
          url: 'http://127.0.0.1/mcp\r\nX-Evil: 1',
          bearer: HEX64,
        },
      }),
    { message: /newline-free string/ },
  );
});

test('http transport refuses a syntactically invalid URL', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: { kind: 'http', url: 'not a url', bearer: HEX64 },
      }),
    { message: /not a valid URL/ },
  );
});

test('renderMcpConfig refuses an unknown transport kind', t => {
  t.throws(
    () =>
      renderMcpConfig({
        serverName: 'endo',
        transport: /** @type {any} */ ({ kind: 'carrier-pigeon' }),
      }),
    { message: /unknown transport kind/ },
  );
});
