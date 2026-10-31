// @ts-check
import test from 'ava';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Application, TypeDocReader, TSConfigReader } from 'typedoc';
import ts from 'typescript';
import { packageSourcesReader } from './typedoc-package-sources.mjs';

const fixture = async t => {
  const root = await mkdtemp(join(tmpdir(), 'endo-docs-'));
  t.teardown(() => rm(root, { recursive: true, force: true }));
  const write = async (file, value) => {
    const target = join(root, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(
      target,
      typeof value === 'string' ? value : JSON.stringify(value),
    );
  };
  await write('tsconfig.json', {
    compilerOptions: {
      allowJs: true,
      checkJs: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: 'ES2022',
    },
    include: ['**/*'],
  });
  await write('typedoc.json', {
    entryPointStrategy: 'packages',
    entryPoints: ['./a'],
    tsconfig: './tsconfig.json',
  });
  await write('a/package.json', {
    name: 'fixture-a',
    type: 'module',
    exports: { '.': './index.js', './conformance': './test/conformance.js' },
  });
  await write('a/tsconfig.json', {
    extends: '../tsconfig.json',
    include: ['**/*'],
    compilerOptions: { strictNullChecks: false },
  });
  await write('a/index.js', 'export const answer = 42;');
  await write('a/index.d.ts', 'export declare const answer: number;');
  await write('a/test/conformance.js', 'export const conformance = true;');
  await write(
    'a/test/unrelated.test.js',
    '/** @type {string} */ const wrong = 1;',
  );
  await write('b/unrelated.js', '/** @type {string} */ const wrong = 1;');
  return { root, write };
};

const optionsFor = async root => {
  const app = await Application.bootstrap(
    { options: join(root, 'typedoc.json') },
    [new TypeDocReader(), new TSConfigReader(), packageSourcesReader],
  );
  const options = app.options.copyForPackage(join(root, 'a'));
  await options.read(app.logger, join(root, 'a'));
  return { app, options };
};

test('package option copies select own source roots and retain exported test helpers', async t => {
  const { root } = await fixture(t);
  const { app, options } = await optionsFor(root);
  const files = options.getFileNames();
  t.true(
    files.includes(join(root, 'a/index.js')),
    'generated sibling declarations must not hide JS',
  );
  t.true(files.includes(join(root, 'a/index.d.ts')));
  t.true(
    files.includes(join(root, 'a/test/conformance.js')),
    'public exports remain checked',
  );
  t.false(files.includes(join(root, 'a/test/unrelated.test.js')));
  t.false(files.includes(join(root, 'b/unrelated.js')));
  t.false(options.getCompilerOptions(app.logger).strictNullChecks);
  const program = ts.createProgram(
    files,
    options.getCompilerOptions(app.logger),
  );
  t.is(ts.getPreEmitDiagnostics(program).length, 0);
});

test('explicit declaration entrypoints remain roots and imported source errors remain visible', async t => {
  const { root, write } = await fixture(t);
  await write('a/typedoc.json', {
    entryPoints: ['./public.d.ts', './index.js'],
  });
  await write('a/public.d.ts', 'export interface Public { value: string }');
  await write('a/index.js', "export { wrong } from '../b/dependency.js';");
  await write(
    'b/dependency.js',
    '/** @type {string} */ export const wrong = 1;',
  );
  const { app, options } = await optionsFor(root);
  t.true(options.getFileNames().includes(join(root, 'a/public.d.ts')));
  t.false(options.getFileNames().includes(join(root, 'b/dependency.js')));
  const program = ts.createProgram(
    options.getFileNames(),
    options.getCompilerOptions(app.logger),
  );
  const diagnostics = ts.getPreEmitDiagnostics(program);
  t.true(
    diagnostics.some(
      diagnostic =>
        diagnostic.file?.fileName === join(root, 'b/dependency.js') &&
        diagnostic.code === 2322,
    ),
  );
});
