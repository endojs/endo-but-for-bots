// @ts-check

import test from '@endo/ses-ava/prepare-endo.js';

import { assertConfinedArgv } from '../src/argv.js';
import {
  buildCliArguments,
  buildSdkOptions,
  confinedAllowList,
} from '../src/confinement-options.js';
import { KNOWN_BUILTIN_TOOLS } from '../src/tool-permissions.js';

const cliSpec = () => ({
  mcpConfigPath: '/scratch/turn/mcp-config.json',
  settingsPath: '/scratch/turn/settings.json',
  serverName: 'endo',
  toolNames: ['readText', 'writeText'],
  maxTurns: 6,
});

test('the CLI argv carries the whole confinement recipe', t => {
  const argv = buildCliArguments(cliSpec());
  t.notThrows(() => assertConfinedArgv(argv));
  /** @param {string} flag */
  const valueOf = flag => argv[argv.indexOf(flag) + 1];
  t.true(argv.includes('-p'));
  t.true(argv.includes('--disable-slash-commands'));
  t.is(valueOf('--tools'), '');
  t.is(valueOf('--setting-sources'), '');
  t.is(valueOf('--output-format'), 'stream-json');
  t.is(valueOf('--permission-mode'), 'dontAsk');
  t.is(valueOf('--allowedTools'), 'mcp__endo__readText,mcp__endo__writeText');
  t.is(valueOf('--disallowedTools'), KNOWN_BUILTIN_TOOLS.join(','));
  t.is(valueOf('--mcp-config'), '/scratch/turn/mcp-config.json');
  t.is(valueOf('--settings'), '/scratch/turn/settings.json');
  t.is(valueOf('--max-turns'), '6');
  t.false(argv.includes('bypassPermissions'));
  t.false(argv.includes('--model'));
  t.false(argv.includes('--permission-prompts'));
  t.false(
    argv.some(token => token.includes('*')),
    'no wildcard allow entry',
  );
  t.true(Object.isFrozen(argv));
});

test('the CLI argv refuses values that would widen or break it', t => {
  t.throws(() => buildCliArguments({ ...cliSpec(), toolNames: [] }));
  t.throws(() => buildCliArguments({ ...cliSpec(), toolNames: ['evaluate'] }));
  t.throws(() => buildCliArguments({ ...cliSpec(), toolNames: ['a__b'] }));
  t.throws(() => buildCliArguments({ ...cliSpec(), serverName: 'a__b' }));
  t.throws(() => buildCliArguments({ ...cliSpec(), maxTurns: 0 }));
  t.throws(() => buildCliArguments({ ...cliSpec(), mcpConfigPath: '' }));
  t.throws(() =>
    buildCliArguments({ ...cliSpec(), model: '--mcp-config=/elsewhere' }),
  );
  t.notThrows(() =>
    buildCliArguments({ ...cliSpec(), model: 'claude-opus-5-5[1m]' }),
  );
});

test('the SDK options mirror the CLI recipe', t => {
  const abortController = new AbortController();
  const mcpServer = harden({ kind: 'server' });
  const options = buildSdkOptions({
    serverName: 'endo',
    toolNames: ['readText'],
    mcpServer,
    maxTurns: 3,
    workingDirectory: '/scratch/turn',
    environment: { PATH: '/bin' },
    executablePath: '/opt/claude/bin/claude',
    abortController,
  });
  t.deepEqual(options, {
    abortController,
    pathToClaudeCodeExecutable: '/opt/claude/bin/claude',
    cwd: '/scratch/turn',
    env: { PATH: '/bin' },
    tools: [],
    disallowedTools: [...KNOWN_BUILTIN_TOOLS],
    allowedTools: ['mcp__endo__readText'],
    settingSources: [],
    skills: [],
    strictMcpConfig: true,
    mcpServers: { endo: { type: 'sdk', name: 'endo', instance: mcpServer } },
    permissionMode: 'dontAsk',
    persistSession: false,
    maxTurns: 3,
  });
});

test('the allow-list is exactly the pinned catalog', t => {
  t.deepEqual(confinedAllowList('guest', ['list', 'lookup']), [
    'mcp__guest__list',
    'mcp__guest__lookup',
  ]);
  t.throws(() => confinedAllowList('guest', ['constructor']));
});
