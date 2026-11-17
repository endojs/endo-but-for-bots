// @ts-check

import { spawn } from 'child_process';

const supervisor = new URL(
  '../../src/drivers/bwrap-parent-death.js',
  import.meta.url,
);
const command =
  "process.stdout.write('ready\\n'); setInterval(() => undefined, 60_000)";
const child = spawn(
  'setpriv',
  [
    '--pdeathsig',
    'SIGUSR2',
    '--',
    process.execPath,
    supervisor.pathname,
    String(process.pid),
    process.execPath,
    '-e',
    command,
  ],
  {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

/** @type {Buffer[]} */
const stderr = [];
child.stderr?.on('data', chunk => stderr.push(chunk));
child.stdout?.once('data', chunk => {
  if (!String(chunk).includes('ready')) {
    throw new Error(`unexpected supervisor output: ${String(chunk)}`);
  }
  process.stdout.write(`${child.pid}\n`);
});
child.once('error', error => {
  throw error;
});
child.once('exit', code => {
  throw new Error(
    `supervisor exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`,
  );
});

setInterval(() => undefined, 60_000);
