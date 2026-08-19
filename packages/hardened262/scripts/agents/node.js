import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { scenarioIncludes } from './scenario.js';

export const testSesNodeModule = (test, { quiet }) =>
  testNode(test, { quiet, lockdownFlag: 'no-lockdown' });
export const testSesNodeLockdownModule = (test, { quiet }) =>
  testNode(test, { quiet, lockdownFlag: 'lockdown' });

const testNode = async (test, { quiet, lockdownFlag }) => {
  const runPath = fileURLToPath(new URL('../node-helper.js', import.meta.url));
  const childArguments = [
    runPath,
    test.file,
    lockdownFlag,
    ...scenarioIncludes(test).map(include =>
      fileURLToPath(new URL(`../../harness/${include}`, import.meta.url)),
    ),
  ];
  // console.error(`# node ${childArguments.join(' ')}`);
  const child = spawn('node', childArguments, {
    stdio: [
      'ignore',
      quiet ? 'ignore' : 'inherit',
      quiet ? 'ignore' : 'inherit',
    ],
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    // Without an 'error' listener a failure to launch the child (for example a
    // missing `node` on the PATH) never fires 'exit', so the awaited promise
    // would hang forever; reject so the run fails loud with a diagnostic.
    child.on('error', reject);
    child.on('exit', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  if (code === 0) {
    return { ok: true, ...test };
  } else {
    return { ok: false, code, signal, ...test };
  }
};
