// @ts-check

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import {
  awaitScenarioChild,
  scenarioIsAsync,
  scenarioIsLockdown,
} from './scenario.js';

const packageRootUrl = new URL('../..', import.meta.url);
const packageRoot = fileURLToPath(packageRootUrl);
const repositoryRoot = new URL('../../', packageRootUrl);
const engineDirectoryUrl = new URL('rust/engine/', repositoryRoot);
const engineDirectory = fileURLToPath(engineDirectoryUrl);
const ironhorseBinary = fileURLToPath(
  new URL('target/release/endot-ih', engineDirectoryUrl),
);

let ironhorseBuilt = false;

const ironhorseHarnessSource = source =>
  source.replace(
    /Object\.defineProperty\(Test262Error\.prototype, 'toString', \{[\s\S]*?\n\}\);/,
    `Test262Error.prototype.toString = function () {
  return 'Test262Error: ' + this.message;
};`,
  );

const ensureIronhorse = () => {
  if (ironhorseBuilt) {
    return;
  }
  const build = spawnSync(
    'cargo',
    [
      'build',
      '--release',
      '--quiet',
      '-p',
      'ironhorse-262',
      '--bin',
      'endot-ih',
    ],
    {
      cwd: engineDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  if (build.error) {
    throw new Error(`Failed to launch cargo: ${build.error.message}`);
  }
  if (build.status !== 0) {
    const diagnostic = build.stderr.trim();
    throw new Error(
      `cargo build exited with status ${build.status}${diagnostic ? `:\n${diagnostic}` : ''}`,
    );
  }
  ironhorseBuilt = true;
};

export const makeIronhorseSource = (test, { sesShim }) => {
  const sources = [
    `/*---\nflags: [raw${scenarioIsAsync(test) ? ', async' : ''}]\n---*/\n`,
  ];
  const harness = test.contents.slice(0, test.insertionIndex);
  const subject = test.contents.slice(test.insertionIndex);
  sources.push(ironhorseHarnessSource(harness));
  if (sesShim) {
    sources.push(
      readFileSync(
        new URL('../../tmp/ses-xs-prelude.js', import.meta.url),
        'utf8',
      ),
      '\n',
    );
  }
  if (scenarioIsLockdown(test)) {
    sources.push(
      readFileSync(new URL('../lockdown.js', import.meta.url), 'utf8'),
      '\n',
    );
  }
  sources.push(subject);
  return sources.join('');
};

export const decodeIronhorseOutcome = (test, code, signal, reportText) => {
  let record;
  try {
    const report = JSON.parse(reportText);
    [record] = report.cases;
  } catch {
    return {
      ok: false,
      code,
      signal,
      failureReason: 'invalid endot-ih report',
      ...test,
    };
  }
  if (record?.outcome === 'covered' && code === 0 && signal === null) {
    return { ok: true, ...test };
  }
  return {
    ok: false,
    code: code === 0 ? 1 : (code ?? 1),
    signal,
    failureReason:
      record?.reason ??
      (record?.outcome
        ? `endot-ih outcome: ${record.outcome}`
        : 'endot-ih produced no case'),
    ...test,
  };
};

export const testIronhorse = async (test, { sesShim, quiet }) => {
  ensureIronhorse();
  const temporaryLocation = new URL(
    `../../tmp/${test.temporaryPath}`,
    import.meta.url,
  ).href;
  const temporaryFile = fileURLToPath(temporaryLocation);
  const reportFile = `${temporaryFile}.ironhorse.json`;
  const temporaryDirectory = fileURLToPath(new URL('./', temporaryLocation));
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(temporaryFile, makeIronhorseSource(test, { sesShim }));

  const child = spawn(
    ironhorseBinary,
    ['--test262-dir', packageRoot, '--json', reportFile, temporaryFile],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const { code, signal } = await awaitScenarioChild(child, 'endot-ih');
  let reportText = '';
  try {
    reportText = readFileSync(reportFile, 'utf8');
  } catch {
    reportText = JSON.stringify({
      cases: [
        {
          outcome: 'adapter-failure',
          reason: [stderr.trim(), stdout.trim()].filter(Boolean).join('\n'),
        },
      ],
    });
  }
  const outcome = decodeIronhorseOutcome(test, code, signal, reportText);
  unlinkSync(temporaryFile);
  try {
    unlinkSync(reportFile);
  } catch {
    // The report is absent when the runner cannot start or terminates early.
  }
  if (!quiet && !outcome.ok && outcome.failureReason) {
    console.error(outcome.failureReason);
  }
  return outcome;
};
