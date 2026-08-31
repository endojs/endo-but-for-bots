// @ts-check

/** @import { ExecutionContext } from 'ava' */

import test from 'ava';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  findDeclarationExistenceProblems,
  findDeclarationPublicationProblems,
} from '../check-package-uniformity.mjs';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

test('repository Node engine covers npm-packlist 10 runtime support', async t => {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'package.json'), 'utf8'),
  );

  t.is(packageJson.engines?.node, '^20.19.0 || >=22.12.0');
});

/**
 * @param {ExecutionContext} t
 * @param {Record<string, unknown>} metadata
 * @param {string[]} files
 * @returns {Promise<{packageDir: string, packageJson: Record<string, unknown>}>}
 */
const makePackage = async (t, metadata, files) => {
  const packageDir = await mkdtemp(join(tmpdir(), 'endo-packlist-test-'));
  t.teardown(() => rm(packageDir, { recursive: true, force: true }));
  const packageJson = {
    name: '@example/declarations',
    version: '1.0.0',
    ...metadata,
  };
  await writeFile(
    join(packageDir, 'package.json'),
    `${JSON.stringify(packageJson, null, 2)}\n`,
  );
  await Promise.all(
    files.map(async file => {
      const filePath = join(packageDir, file);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, 'export {};\n');
    }),
  );
  return { packageDir, packageJson };
};

test('nested export substitutions must be in the npm pack list', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['types/*.d.ts'],
      exports: {
        './feature/*': {
          types: './types/*.d.ts',
          default: './src/*.js',
        },
      },
    },
    ['types/direct.d.ts', 'types/nested/omitted.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/example',
  );

  t.deepEqual(problems, [
    `packages/example: package.json["exports"]["./feature/*"]["types"] target pattern './types/*.d.ts' resolves to 'types/nested/omitted.d.ts', which is not included in the npm pack list`,
  ]);
});

test('scoped literal declaration targets normalize npm packlist paths', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['@scope'],
      types: './@scope/index.d.ts',
    },
    ['@scope/index.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/scoped-literal',
  );

  t.deepEqual(problems, []);
});

test('scoped declaration patterns normalize npm packlist paths', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['@scope'],
      exports: {
        './feature/*': {
          types: './@scope/*.d.ts',
          default: './src/*.js',
        },
      },
    },
    ['@scope/index.d.ts', 'src/feature.js'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/scoped-pattern',
  );

  t.deepEqual(problems, []);
});

test('versioned TypeScript export conditions are checked', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['types/current.d.ts'],
      exports: {
        '.': {
          'types@>=5.2': './types/modern.d.ts',
          types: './types/current.d.ts',
          default: './index.js',
        },
      },
    },
    ['index.js', 'types/current.d.ts', 'types/modern.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/versioned',
  );

  t.deepEqual(problems, [
    `packages/versioned: package.json["exports"]["."]["types@>=5.2"] target './types/modern.d.ts' is not included in the npm pack list`,
  ]);
});

test('npm globstar includes a declaration without an intermediate directory', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['dist/**/*.d.ts'],
      types: './dist/index.d.ts',
    },
    ['dist/index.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/globstar',
  );

  t.deepEqual(problems, []);
});

test('an unpacked declaration reports package, metadata, and target context', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['index.js'],
      typings: './types/index.d.ts',
    },
    ['index.js', 'types/index.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/uncovered',
  );

  t.deepEqual(problems, [
    `packages/uncovered: package.json["typings"] target './types/index.d.ts' is not included in the npm pack list`,
  ]);
});

test('every declaration target in an export array is checked', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['types/primary.d.ts'],
      exports: {
        '.': {
          types: ['./types/primary.d.ts', './types/fallback.d.ts'],
          default: './index.js',
        },
      },
    },
    ['index.js', 'types/fallback.d.ts', 'types/primary.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/array',
  );

  t.deepEqual(problems, [
    `packages/array: package.json["exports"]["."]["types"][1] target './types/fallback.d.ts' is not included in the npm pack list`,
  ]);
});

test('typesVersions declaration trees are checked across selectors', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['index.d.ts', 'ts5/*.d.ts'],
      types: './index.d.ts',
      typesVersions: {
        '>=5.2': {
          '*': ['ts5/*'],
        },
      },
    },
    ['index.d.ts', 'ts5/direct.d.ts', 'ts5/nested/omitted.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/types-versions',
  );

  t.deepEqual(problems, [
    `packages/types-versions: package.json["typesVersions"][">=5.2"]["*"][0] target pattern 'ts5/*' resolves to 'ts5/nested/omitted.d.ts', which is not included in the npm pack list`,
  ]);
});

test('unsupported typesVersions substitutions fail closed', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      files: ['types'],
      typesVersions: {
        '*': {
          '*': ['types/*/copy-*.d.ts'],
        },
      },
    },
    ['types/feature/copy-feature.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/unsupported',
  );

  t.deepEqual(problems, [
    `packages/unsupported: package.json["typesVersions"]["*"]["*"][0] target 'types/*/copy-*.d.ts' has multiple stars; only single-star typesVersions substitutions are supported`,
  ]);
});

test('private packages are exempt', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      private: true,
      types: './types/omitted.d.ts',
      files: [],
    },
    ['types/omitted.d.ts'],
  );

  const problems = await findDeclarationPublicationProblems(
    packageDir,
    packageJson,
    'packages/private',
  );

  t.deepEqual(problems, []);
});

test('a dangling target with no generator source fails for a private package', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      private: true,
      types: './types/missing.d.ts',
      files: [],
    },
    ['index.js'],
  );

  const problems = await findDeclarationExistenceProblems(
    packageDir,
    packageJson,
    'packages/private-dangling',
  );

  t.deepEqual(problems, [
    `packages/private-dangling: package.json["types"] target './types/missing.d.ts' does not exist and has no declaration-emit source to derive it from`,
  ]);
});

test('a dangling target with no generator source fails for a public package', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      types: './types/missing.d.ts',
      files: [],
    },
    ['index.js'],
  );

  const problems = await findDeclarationExistenceProblems(
    packageDir,
    packageJson,
    'packages/public-dangling',
  );

  t.deepEqual(problems, [
    `packages/public-dangling: package.json["types"] target './types/missing.d.ts' does not exist and has no declaration-emit source to derive it from`,
  ]);
});

test('a missing target with a generator sibling passes', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      types: './types/index.d.ts',
      files: [],
    },
    ['types/index.ts'],
  );

  const problems = await findDeclarationExistenceProblems(
    packageDir,
    packageJson,
    'packages/derivable',
  );

  t.deepEqual(problems, []);
});

test('an existing tracked target passes', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      types: './types/index.d.ts',
      files: [],
    },
    ['types/index.d.ts'],
  );

  const problems = await findDeclarationExistenceProblems(
    packageDir,
    packageJson,
    'packages/existing',
  );

  t.deepEqual(problems, []);
});

test('.d.mts and .d.cts targets are derivable from their own extension family', async t => {
  const { packageDir, packageJson } = await makePackage(
    t,
    {
      exports: {
        '.': {
          types: './dist/index.d.mts',
          default: './dist/index.mjs',
        },
        './commonjs': {
          types: './dist/commonjs.d.cts',
          default: './dist/commonjs.cjs',
        },
      },
      files: [],
    },
    ['dist/index.mts', 'dist/commonjs.cts'],
  );

  const problems = await findDeclarationExistenceProblems(
    packageDir,
    packageJson,
    'packages/dual-format',
  );

  t.deepEqual(problems, []);
});

test('repository packages have declaration targets that exist or are derivable', async t => {
  const packagesDir = join(repoRoot, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  /** @type {string[]} */
  const problems = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    let packageJson;
    try {
      packageJson = JSON.parse(
        await readFile(join(packageDir, 'package.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    problems.push(
      ...(await findDeclarationExistenceProblems(
        packageDir,
        packageJson,
        `packages/${entry.name}`,
      )),
    );
  }

  t.deepEqual(problems, []);
});

test('repository public packages publish their declaration entries', async t => {
  const packagesDir = join(repoRoot, 'packages');
  const entries = await readdir(packagesDir, { withFileTypes: true });
  /** @type {string[]} */
  const problems = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = join(packagesDir, entry.name);
    let packageJson;
    try {
      packageJson = JSON.parse(
        await readFile(join(packageDir, 'package.json'), 'utf8'),
      );
    } catch {
      continue;
    }
    if (packageJson.private === true) continue;
    problems.push(
      ...(await findDeclarationPublicationProblems(
        packageDir,
        packageJson,
        `packages/${entry.name}`,
      )),
    );
  }

  t.deepEqual(problems, []);
});
