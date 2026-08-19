import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

import {
  awaitScenarioChild,
  scenarioIncludes,
  scenarioIsLockdown,
  scenarioIsRaw,
  scenarioOk,
} from './scenario.js';

// One export that reads the scenario's own `lockdown` axis (scenarioIsLockdown),
// rather than the caller re-deriving Lockdown by string-matching the composed
// scenario NAME (`scenario === 'lockdownModule'`) — the same single source of
// truth the xs agent (agents/xs.js) already reads via `test.lockdown`.
export const testSesNode = (test, { quiet }) =>
  testNode(test, {
    quiet,
    lockdownFlag: scenarioIsLockdown(test) ? 'lockdown' : 'no-lockdown',
  });

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
  const { code, signal } = await awaitScenarioChild(child, 'node');
  if (scenarioOk(test, code, stdout)) {
    unlinkSync(temporaryFile);
    return { ok: true, ...test };
  } else {
    return { ok: false, code, signal, ...test };
  }
};
