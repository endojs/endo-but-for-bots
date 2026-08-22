import 'ses';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

import {
  awaitScenarioChild,
  scenarioIncludes,
  scenarioIsLockdown,
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

  // Load the test262 harness includes (assert.js, sta.js, ...) into XS *global*
  // scope. They cannot be passed to `xst` as bare file arguments: `-m` is a
  // GLOBAL option covering every following file, so under the module scenarios
  // this agent runs the harness files parse as modules and their top-level
  // `var`/`function` declarations never leak onto the global object the subject
  // reads (`assert`, `Test262Error`, ...), throwing `ReferenceError` before the
  // test's own assertions run. Indirect eval always evaluates in global scope
  // regardless of `-m`, so a single generated loader that `(0, eval)`s each
  // include's source installs the harness globals by a mechanism insensitive to
  // the module flag — mirroring node-helper.js's indirect-eval of the same
  // includes.
  const harnessIncludes = scenarioIsRaw(test) ? [] : scenarioIncludes(test);
  let harnessLoaderFile;
  if (harnessIncludes.length > 0) {
    const loaderSource = harnessIncludes
      .map(include => {
        const includePath = fileURLToPath(
          new URL(`../../harness/${include}`, import.meta.url),
        );
        return `(0, eval)(${JSON.stringify(readFileSync(includePath, 'utf8'))});\n`;
      })
      .join('');
    harnessLoaderFile = fileURLToPath(
      new URL(`../../tmp/${test.temporaryPath}.harness.js`, import.meta.url),
    );
    writeFileSync(harnessLoaderFile, loaderSource);
  }

  const childArguments = [
    ...(scenarioIsModule(test) ? ['-m'] : []),
    ...(harnessLoaderFile ? [harnessLoaderFile] : []),
    ...(sesShim ? [sesXsPreludePath] : []),
    ...(scenarioIsLockdown(test) ? [lockdownPreludePath] : []),
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
    if (harnessLoaderFile) {
      unlinkSync(harnessLoaderFile);
    }
    return { ok: true, ...test };
  } else {
    return { ok: false, code, signal, ...test };
  }
};
