import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const rootUrl = new URL('../', import.meta.url);
const packagesUrl = new URL('packages/', rootUrl);
const { Bun } = globalThis;
if (!Bun) {
  throw new Error('This test runner must be launched with Bun');
}
const avaCliPath = fileURLToPath(
  new URL('node_modules/ava/entrypoints/cli.js', rootUrl),
);
const preloadPath = fileURLToPath(
  new URL('scripts/ava-bun-preload.mjs', rootUrl),
);

const requestedPackages = new Set();
const excludedPackages = new Set(['@endo/skel']);
let failFast = false;
for (let index = 2; index < process.argv.length; index += 1) {
  const argument = process.argv[index];
  if (argument === '--package') {
    index += 1;
    const packageName = process.argv[index];
    if (!packageName) {
      throw new Error('--package requires a package name');
    }
    requestedPackages.add(packageName);
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
  let descriptor;
  try {
    descriptor = JSON.parse(await readFile(packageJsonUrl, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') {
      continue;
    }
    throw error;
  }

  if (requestedPackages.size > 0 && !requestedPackages.has(descriptor.name)) {
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
    });
  }
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
    avaCliPath,
    '--no-worker-threads',
    ...(run.configPath ? ['--config', run.configPath] : []),
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
