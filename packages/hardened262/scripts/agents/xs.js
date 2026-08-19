import 'ses';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  awaitScenarioChild,
  scenarioIncludes,
  scenarioIsModule,
  scenarioIsRaw,
  scenarioOk,
} from './scenario.js';

const sesXsPreludePath = fileURLToPath(
  new URL('../../tmp/ses-xs-prelude.js', import.meta.url),
);

const lockdownPreludePath = fileURLToPath(
  new URL('../lockdown.js', import.meta.url),
);

export const testXs = async (test, { sesShim, quiet }) => {
  const temporaryLocation = new URL(
    `../../tmp/${test.temporaryPath}`,
    import.meta.url,
  ).href;
  const temporaryFile = fileURLToPath(temporaryLocation);
  const temporaryDirectory = fileURLToPath(new URL('./', temporaryLocation));

  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(temporaryFile, test.contents);

  const childArguments = [
    ...(scenarioIsModule(test) ? ['-m'] : []),
    ...(scenarioIsRaw(test)
      ? []
      : scenarioIncludes(test).map(include =>
          fileURLToPath(new URL(`../../harness/${include}`, import.meta.url)),
        )),
    ...(sesShim ? [sesXsPreludePath] : []),
    ...(test.lockdown ? [lockdownPreludePath] : []),
    temporaryFile,
  ];
  // console.error(`# ${['xst', ...childArguments].join(' ')}`);
  const child = spawn('xst', childArguments, {
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
  const { code, signal } = await awaitScenarioChild(child, 'xst');
  if (scenarioOk(test, code, stdout)) {
    unlinkSync(temporaryFile);
    return { ok: true, ...test };
  } else {
    return { ok: false, code, signal, ...test };
  }
};
