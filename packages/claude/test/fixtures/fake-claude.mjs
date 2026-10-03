#!/usr/bin/env node
// A scripted stand-in for `claude -p` (plain Node, no SES). It does what the
// confinement tests need Claude Code to do, the way Claude Code does it:
//
//   - `--version` prints a version line;
//   - it obtains its credential by running the `--settings` apiKeyHelper
//     through `/bin/sh -c`, then (the worst case endo-but-for-bots#1369 gap 2
//     observed) holds it in its own environment as ANTHROPIC_AUTH_TOKEN;
//   - it spawns the one `--mcp-config` stdio server with its OWN environment
//     merged with the entry's `env`, as Claude Code 2.1.278/2.1.280 do;
//   - it drives MCP (initialize, tools/list, one tools/call) as the model would.
//
// The prompt on stdin is JSON: { "tool": "<name>", "arguments": { ... },
// "probe": [<absolute path>, ...] }. For each probed path it reports whether
// the path exists and whether a unix-socket connect to it succeeds.
// It reports what it observed — its own environment and descriptors, and the
// MCP child's environment read from /proc — as the terminal `result` of a
// `stream-json` transcript.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

const argv = process.argv.slice(2);
if (argv[0] === '--version') {
  process.stdout.write(
    `${process.env.FAKE_CLAUDE_VERSION ?? '2.1.232'} (Claude Code)\n`,
  );
  process.exit(0);
}

const flag = name => argv[argv.indexOf(name) + 1];
const emit = event => process.stdout.write(`${JSON.stringify(event)}\n`);

/**
 * Descriptors held at startup, before this process opens or spawns anything.
 *
 * @param {string | number} pid
 */
const listFds = pid => {
  if (process.platform !== 'linux') return undefined;
  const dir = `/proc/${pid}/fd`;
  return fs.readdirSync(dir).map(fd => {
    let target;
    try {
      target = fs.readlinkSync(`${dir}/${fd}`);
    } catch {
      target = '?';
    }
    return [Number(fd), target];
  });
};
const startupFds = listFds('self');

/** @param {string | number} pid */
const environNames = pid => {
  if (process.platform !== 'linux') return undefined;
  return fs
    .readFileSync(`/proc/${pid}/environ`, 'utf-8')
    .split('\0')
    .filter(Boolean)
    .map(entry => entry.split('=')[0]);
};

/** @param {string} socketPath */
const tryConnect = socketPath =>
  new Promise(resolve => {
    const socket = net.connect(socketPath);
    socket.once('connect', () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', (/** @type {any} */ error) =>
      resolve(error.code ?? error.message),
    );
  });

/** @param {string} file */
const tryWrite = file => {
  try {
    fs.writeFileSync(file, 'probe');
    fs.rmSync(file);
    return 'written';
  } catch (/** @type {any} */ error) {
    return error.code ?? error.message;
  }
};

const readStdin = async () => {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
};

const main = async () => {
  const instruction = JSON.parse(await readStdin());
  const settings = JSON.parse(fs.readFileSync(flag('--settings'), 'utf-8'));
  const key = execFileSync('/bin/sh', ['-c', settings.apiKeyHelper], {
    encoding: 'utf-8',
  }).trim();
  process.env.ANTHROPIC_AUTH_TOKEN = key;

  const mcpConfigText = fs.readFileSync(flag('--mcp-config'), 'utf-8');
  const { mcpServers } = JSON.parse(mcpConfigText);
  const [[serverName, entry], ...others] = Object.entries(mcpServers);
  if (others.length > 0) throw Error('more than one MCP server');
  const allowed = flag('--allowedTools').split(',');

  const child = spawn(entry.command, entry.args ?? [], {
    env: { ...process.env, ...(entry.env ?? {}) },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buffer = '';
  const waiting = new Map();
  child.stdout.setEncoding('utf-8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const frame = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(frame.id)?.(frame);
      i = buffer.indexOf('\n');
    }
  });
  let nextId = 0;
  const request = (method, params = {}) => {
    nextId += 1;
    const id = nextId;
    return new Promise(resolve => {
      waiting.set(id, resolve);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  };

  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'fake-claude', version: '0' },
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
  );
  const mcpChildEnviron = environNames(Number(child.pid));
  let mcpChildEnvironText;
  if (process.platform === 'linux') {
    mcpChildEnvironText = fs.readFileSync(
      `/proc/${child.pid}/environ`,
      'utf-8',
    );
  }
  const list = await request('tools/list');
  const toolName = `mcp__${serverName}__${instruction.tool}`;
  const call = allowed.includes(toolName)
    ? await request('tools/call', {
        name: instruction.tool,
        arguments: instruction.arguments ?? {},
      })
    : { refused: toolName };
  child.stdin.end();
  await new Promise(resolve => child.on('exit', resolve));

  const probed = instruction.probe ?? [];
  const connects = await Promise.all(probed.map(tryConnect));
  const probes = Object.fromEntries(
    probed.map((probedPath, index) => [
      probedPath,
      { exists: fs.existsSync(probedPath), connect: connects[index] },
    ]),
  );

  const report = {
    serverInfo: init.result?.serverInfo,
    tools: list.result?.tools?.map(tool => tool.name),
    call,
    allowed,
    argv,
    ownEnvNames: Object.keys(process.env).filter(
      name => name !== 'ANTHROPIC_AUTH_TOKEN',
    ),
    startupFds,
    mcpChildEnviron,
    mcpChildHasCredential:
      mcpChildEnvironText === undefined
        ? undefined
        : mcpChildEnvironText.includes(key),
    mcpConfigText,
    cwd: process.cwd(),
    probes,
    home: process.env.HOME,
    homeWrite:
      process.env.HOME === undefined
        ? undefined
        : tryWrite(path.join(process.env.HOME, 'probe')),
    spawnDirectoryWrite: tryWrite(
      path.join(path.dirname(flag('--settings')), 'probe'),
    ),
  };
  emit({
    type: 'system',
    subtype: 'init',
    tools: allowed,
    mcp_servers: [serverName],
  });
  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(report),
    num_turns: 1,
    session_id: 'fake-session',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
};

main().catch(error => {
  process.stderr.write(`fake-claude: ${error.stack ?? error}\n`);
  process.exit(3);
});
