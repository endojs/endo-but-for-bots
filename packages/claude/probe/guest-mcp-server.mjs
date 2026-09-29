#!/usr/bin/env node
// A dependency-free stdio MCP server standing in for a guest facet
// projection. It exposes exactly `writeText` and `readText` over a JSON file
// named by GUEST_STORE. The probe harness reads that file independently to
// verify a turn's effect (gate 1), never trusting model prose.
//
// gap: see PR body, Gap 2. This is not a live Endo daemon guest; it is a
// stand-in with the same two tool names the Track B live run used.
import fs from 'node:fs';
import readline from 'node:readline';

const store = process.env.GUEST_STORE;
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(store, 'utf8'));
  } catch {
    return {};
  }
};
const save = value => fs.writeFileSync(store, JSON.stringify(value));
const log = entry =>
  fs.appendFileSync(`${store}.calls`, `${JSON.stringify(entry)}\n`);

// Record which environment variable NAMES this process inherited (never
// values), so the harness can tell whether the binary passes its credential
// down to the guest's MCP server.
log({
  at: new Date().toISOString(),
  startupEnvNames: Object.keys(process.env).sort(),
  holdsAuthToken: 'ANTHROPIC_AUTH_TOKEN' in process.env,
});

const tools = [
  {
    name: 'writeText',
    description: 'Store a text value under a pet name in the guest directory.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, text: { type: 'string' } },
      required: ['name', 'text'],
    },
  },
  {
    name: 'readText',
    description: 'Read the text value stored under a pet name.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    },
  },
];

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = message;
  if (id === undefined) return;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'guest', version: '0.0.0' },
      },
    });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools } });
  } else if (method === 'tools/call') {
    const { name, arguments: args = {} } = params ?? {};
    log({ at: new Date().toISOString(), name, args });
    const value = load();
    let text;
    if (name === 'writeText') {
      value[args.name] = String(args.text);
      save(value);
      text = 'stored';
    } else if (name === 'readText') {
      text = value[args.name] ?? '(no such name)';
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32602, message: 'unknown tool' } });
      return;
    }
    send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no method' } });
  }
});
