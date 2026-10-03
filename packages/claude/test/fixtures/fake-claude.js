#!/usr/bin/env node
// spell-out-exempt: `num_turns` is a field of Claude Code's result event.
// A stand-in for the `claude` binary: it reads the prompt from stdin and
// answers in stream-json with what it was given, or, for the prompt `hang`,
// starts a grandchild and never exits.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const chunks = [];
process.stdin.on('data', chunk => chunks.push(chunk));
process.stdin.on('end', () => {
  const prompt = Buffer.concat(chunks).toString('utf8');
  if (prompt === 'hang') {
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'inherit',
    });
    setInterval(() => {}, 1000);
    return;
  }
  const argv = process.argv.slice(2);
  const mcpConfig = JSON.parse(
    readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8'),
  );
  const report = {
    prompt,
    argv,
    cwd: process.cwd(),
    environmentKeys: Object.keys(process.env).sort(),
    home: process.env.HOME,
    mcpConfig,
  };
  const write = event => process.stdout.write(`${JSON.stringify(event)}\n`);
  write({ type: 'system', subtype: 'init' });
  write({ type: 'assistant', message: { id: 'm1', content: [] } });
  write({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: JSON.stringify(report),
    num_turns: 1,
  });
});
