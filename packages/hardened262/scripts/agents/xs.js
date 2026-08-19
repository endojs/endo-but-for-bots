import 'ses';
import { mkdirSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  scenarioIncludes,
  scenarioIsModule,
  scenarioIsRaw,
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
      quiet ? 'ignore' : 'inherit',
      quiet ? 'ignore' : 'inherit',
    ],
  });
  const { code, signal } = await new Promise((resolve, reject) => {
    // Without an 'error' listener a failure to launch `xst` (which the README
    // requires on the PATH for the xs/sesXs agents) never fires 'exit', so the
    // awaited promise would hang forever; reject so the run fails loud with a
    // diagnostic.
    child.on('error', reject);
    child.on('exit', (exitCode, exitSignal) => {
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  if (code === 0) {
    unlinkSync(temporaryFile);
    return { ok: true, ...test };
  } else {
    return { ok: false, code, signal, ...test };
  }
};
