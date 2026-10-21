import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootUrl = new URL('../', import.meta.url);
const packagesUrl = new URL('packages/', rootUrl);
const { Bun } = globalThis;
if (!Bun) {
  throw new Error('This test runner must be launched with Bun');
}
const avaCommandLineInterfacePath = fileURLToPath(
  new URL('node_modules/ava/entrypoints/cli.js', rootUrl),
);
const preloadPath = fileURLToPath(
  new URL('scripts/ava-bun-preload.mjs', rootUrl),
);

// Each requested package maps to the test files to run, or to an empty list
// to run its whole suite.
const requestedPackages = new Map();
const excludedPackages = new Set(['@endo/skel']);
let failFast = false;

const takeValue = (index, option) => {
  const value = process.argv[index];
  if (!value || value.startsWith('-')) {
    throw new Error(`${option} requires a value, got ${value ?? 'nothing'}`);
  }
  return value;
};

for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--package') {
    index += 1;
    const packageName = takeValue(index, '--package');
    if (requestedPackages.get(packageName)?.length) {
      throw new Error(`${packageName} is selected both whole and by --file`);
    }
    requestedPackages.set(packageName, []);
  } else if (argument === '--file') {
    index += 1;
    const selection = takeValue(index, '--file');
    const separator = selection.lastIndexOf(':');
    if (separator <= 0 || separator === selection.length - 1) {
      throw new Error(
        `--file requires <package>:<test file>, got ${selection}`,
      );
    }
    const packageName = selection.slice(0, separator);
    const testFile = selection.slice(separator + 1);
    const testFiles = requestedPackages.get(packageName);
    if (testFiles === undefined) {
      requestedPackages.set(packageName, [testFile]);
    } else if (testFiles.length === 0) {
      throw new Error(`${packageName} is selected both whole and by --file`);
    } else {
      testFiles.push(testFile);
    }
  } else if (argument === '--fail-fast') {
    failFast = true;
  } else {
    throw new Error(`Unknown argument: ${argument}`);
  }
}

const packageDirectories = await readdir(packagesUrl, { withFileTypes: true });
const runs = [];

for (const directory of packageDirectories) {
  if (!directory.isDirectory()) {
    continue;
  }
  const packageUrl = new URL(`${directory.name}/`, packagesUrl);
  const packageJsonUrl = new URL('package.json', packageUrl);
  let packageJsonText;
  try {
    packageJsonText = await readFile(packageJsonUrl, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      continue;
    }
    throw error;
  }
  let descriptor;
  try {
    descriptor = JSON.parse(packageJsonText);
  } catch (error) {
    throw new Error(`Cannot parse ${fileURLToPath(packageJsonUrl)}`, {
      cause: error,
    });
  }

  const testFiles = requestedPackages.get(descriptor.name);
  if (requestedPackages.size > 0 && testFiles === undefined) {
    continue;
  }
  if (requestedPackages.size === 0 && excludedPackages.has(descriptor.name)) {
    continue;
  }

  const testScript = descriptor.scripts?.test;
  if (typeof testScript !== 'string' || !testScript.includes('ava')) {
    continue;
  }

  const configurations = Object.entries(descriptor.sesAvaConfigs ?? {});
  if (descriptor.ava) {
    configurations.unshift(['default', undefined]);
  }
  if (configurations.length === 0) {
    configurations.push(['default', undefined]);
  }

  for (const [configuration, configPath] of configurations) {
    runs.push({
      packageName: descriptor.name,
      packagePath: fileURLToPath(packageUrl),
      configuration,
      configPath,
      testFiles: testFiles ?? [],
    });
  }
}

// An explicit selection that schedules nothing would otherwise pass without
// testing anything, so a misspelled or renamed package fails the run.
const scheduledPackages = new Set(runs.map(({ packageName }) => packageName));
const unscheduledPackages = [...requestedPackages.keys()].filter(
  packageName => !scheduledPackages.has(packageName),
);
if (unscheduledPackages.length > 0) {
  console.error(
    `[test:bun] no AVA runs scheduled for: ${unscheduledPackages.join(', ')}`,
  );
  process.exit(1);
}
if (runs.length === 0) {
  console.error('[test:bun] no AVA runs scheduled');
  process.exit(1);
}

const results = [];
for (const run of runs) {
  const label = `${run.packageName} (${run.configuration})`;
  console.log(`\n[test:bun] ${label}`);
  // Bun's worker_threads channel cannot clone some AVA messages. AVA's child
  // process transport reaches the test suite and reports the underlying error.
  const argumentsForAva = [
    process.execPath,
    '--import',
    preloadPath,
    avaCommandLineInterfacePath,
    '--no-worker-threads',
    ...(run.configPath ? ['--config', run.configPath] : []),
    ...run.testFiles,
  ];
  const started = performance.now();
  const child = Bun.spawn(argumentsForAva, {
    cwd: run.packagePath,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  const elapsedSeconds = ((performance.now() - started) / 1000).toFixed(1);
  results.push({ label, exitCode, elapsedSeconds });
  if (failFast && exitCode !== 0) {
    break;
  }
}

const passed = results.filter(({ exitCode }) => exitCode === 0);
const failed = results.filter(({ exitCode }) => exitCode !== 0);
console.log(
  `\n[test:bun] ${passed.length}/${results.length} runs passed across ${
    new Set(results.map(({ label }) => label.replace(/ \(.+\)$/, ''))).size
  } packages`,
);
for (const { label, exitCode, elapsedSeconds } of failed) {
  console.log(
    `[test:bun] FAIL ${label}: exit ${exitCode} (${elapsedSeconds}s)`,
  );
}

process.exitCode = failed.length === 0 ? 0 : 1;
