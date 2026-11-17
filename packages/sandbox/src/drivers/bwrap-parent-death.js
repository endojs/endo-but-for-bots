// @ts-check

/* global process */

import { spawn } from 'child_process';

const [expectedParentText, command, ...commandArguments] =
  process.argv.slice(2);
const expectedParent = Number(expectedParentText);

if (!Number.isSafeInteger(expectedParent) || expectedParent <= 0 || !command) {
  process.stderr.write('invalid bwrap parent-death supervisor arguments\n');
  process.exit(2);
}

// setpriv arms SIGUSR2 before this module starts.  Install the handler before
// creating a descendant, then verify that the expected parent survived the
// exec boundary.  These two steps close both sides of PR_SET_PDEATHSIG's
// documented race: before the handler there is no descendant, and afterwards
// owner death synchronously kills the complete owned process group.
process.once('SIGUSR2', () => {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } finally {
    process.kill(process.pid, 'SIGKILL');
  }
});

// Explicit soft termination is delivered to the whole process group.  Keep
// its leader alive while bwrap and the workload react, so the driver can still
// address that same, non-reusable group if the supervisor escalates to
// SIGKILL.  Without these handlers the leader can exit first and make the
// driver's stale-pgid guard correctly decline the escalation.
for (const signal of ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGTERM']) {
  process.on(signal, () => undefined);
}

if (process.ppid !== expectedParent) {
  process.stderr.write('bwrap owner exited before supervision was armed\n');
  process.exit(1);
}

const child = spawn(command, commandArguments, {
  stdio: 'inherit',
  env: process.env,
});

child.once('error', error => {
  process.stderr.write(`failed to start bwrap: ${error.message}\n`);
  process.exitCode = 127;
});

child.once('exit', (code, signal) => {
  if (signal !== null) {
    // bwrap can die before its init has armed --die-with-parent.  Keep the
    // stable group leader alive until this point, then close that setup window
    // by killing the entire group instead of reproducing bwrap's signal only
    // on the supervisor.
    process.kill(-process.pid, 'SIGKILL');
    return;
  }
  process.exitCode = code ?? 1;
});
