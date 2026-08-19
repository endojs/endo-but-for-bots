import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import { scenarioIncludes, scenarioIsRaw, scenarioOk } from './scenario.js';

export const testSesNodeModule = (test, { quiet }) =>
  testNode(test, { quiet, lockdownFlag: 'no-lockdown' });
export const testSesNodeLockdownModule = (test, { quiet }) =>
  testNode(test, { quiet, lockdownFlag: 'lockdown' });

const testNode = async (test, { quiet, lockdownFlag }) => {
  const runPath = fileURLToPath(new URL('../node-helper.js', import.meta.url));

  // Run the scenario's OWN `test.contents`, not the on-disk `test.file`: for the
  // Strict mode `generateScenariosForTests` prepends a `"use strict";` pragma to
  // `contents`, exactly as the xs agent (agents/xs.js) writes that mutated
  // source to its temp file. Importing `test.file` directly would silently
  // execute the un-prefixed source, reintroducing the xs/node drift `scenario.js`
  // exists to prevent the moment the sloppy/strict axes wire to `sesNode`.
  const temporaryLocation = new URL(
    `../../tmp/${test.temporaryPath}`,
    import.meta.url,
  ).href;
  const temporaryFile = fileURLToPath(temporaryLocation);
  const temporaryDirectory = fileURLToPath(new URL('./', temporaryLocation));

  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(temporaryFile, test.contents);

  const childArguments = [
    runPath,
    temporaryFile,
    lockdownFlag,
    // A raw test262 case carries no harness wrapper, so it takes no includes;
    // mirror the xs agent's `scenarioIsRaw` guard so a raw-flagged case does not
    // get harness code eval'd into global scope before the subject runs — a
    // direct violation of the test262 `raw` contract.
    ...(scenarioIsRaw(test)
      ? []
      : scenarioIncludes(test).map(include =>
          fileURLToPath(new URL(`../../harness/${include}`, import.meta.url)),
        )),
  ];
  // console.error(`# node ${childArguments.join(' ')}`);
  const child = spawn('node', childArguments, {
    stdio: [
      'ignore',
      // ALWAYS pipe stdout so the async-protocol markers `$DONE` prints can be
      // inspected (scenarioOk): an async failure prints its marker yet exits 0,
      // so the exit code alone would launder it into a false pass. Forward the
      // captured stream to our own stdout only when not quiet, so the
      // human-facing output is unchanged.
      'pipe',
      quiet ? 'ignore' : 'inherit',
    ],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (!quiet) {
      process.stdout.write(chunk);
    }
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    // Without an 'error' listener a failure to launch the child (for example a
    // missing `node` on the PATH) never fires 'close', so the awaited promise
    // would hang forever; reject so the run fails loud with a diagnostic.
    child.on('error', reject);
    // Resolve on 'close' (not 'exit') so every stdout chunk has been captured
    // before we inspect it for the async markers.
    child.on('close', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  if (scenarioOk(test, code, stdout)) {
    unlinkSync(temporaryFile);
    return { ok: true, ...test };
  } else {
    return { ok: false, code, signal, ...test };
  }
};
