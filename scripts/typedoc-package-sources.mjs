// @ts-check
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import ts from 'typescript';

const extensions = ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'];
const excluded =
  /(^|\/)(test|tests|demo|demos|node_modules|tmp|dist|dist-xs|dist-ironhorse|build|docs)(\/|$)|\.test[.-]/;
const isSource = path => extensions.some(extension => path.endsWith(extension));

/**
 * A package's docs program owns its production roots, not every workspace's
 * tests. Explicitly exported/configured entrypoints are retained even when
 * they live outside conventional source directories. Imported files remain
 * TypeScript's responsibility and are never filtered out of the program.
 * Configured entryPoints take precedence over inferred manifest exports,
 * matching TypeDoc's entrypoint selection.
 *
 * @param {import('typedoc').Options} options
 */
export const packageSourceRoots = options => {
  const dir = options.packageDir;
  if (dir === undefined) return options.getFileNames();
  const roots = new Set();
  for (const file of options.getFileNames()) {
    const local = relative(dir, file).replaceAll('\\', '/');
    if (!local.startsWith('../') && !excluded.test(local)) roots.add(file);
  }
  // Enumerate directly rather than parse a glob tsconfig: TS config root
  // discovery prefers a sibling generated .d.ts over the actual .js entry.
  // Both are valid roots; explicit checked-in declarations remain included.
  for (const file of ts.sys.readDirectory(
    dir,
    extensions,
    [
      '**/node_modules/**',
      '**/test/**',
      '**/tests/**',
      '**/demo/**',
      '**/tmp/**',
      '**/dist*/**',
      '**/build/**',
      '**/docs/**',
      '**/*.test.*',
    ],
    ['*', 'src/**/*'],
  ))
    roots.add(file);

  const addEntry = entry => {
    if (typeof entry !== 'string') return;
    const absolute = resolve(dir, entry);
    if (ts.sys.fileExists(absolute) && isSource(absolute)) roots.add(absolute);
    else {
      const pattern = relative(dir, absolute).replaceAll('\\', '/');
      for (const file of ts.sys.readDirectory(
        dir,
        extensions,
        ['**/node_modules/**'],
        [pattern],
      ))
        roots.add(file);
    }
  };
  const configured = options.getValue('entryPoints');
  if (configured.length > 0) {
    for (const entry of configured) addEntry(entry);
  } else {
    const manifest = JSON.parse(
      readFileSync(resolve(dir, 'package.json'), 'utf8'),
    );
    const addExports = value => {
      if (typeof value === 'string') addEntry(value);
      else if (value && typeof value === 'object') {
        for (const child of Object.values(value)) addExports(child);
      }
    };
    if (manifest.exports !== undefined) addExports(manifest.exports);
    else {
      addEntry(manifest.main);
      addEntry(manifest.types);
    }
  }
  return [...roots].sort();
};

/** @type {import('typedoc').OptionsReader} */
export const packageSourcesReader = {
  name: 'endo-package-sources',
  order: 250,
  supportsPackages: true,
  read(options, logger, _cwd, usedFile) {
    if (options.packageDir === undefined) return;
    usedFile(resolve(options.packageDir, 'package.json'));
    options.setCompilerOptions(
      packageSourceRoots(options),
      options.getCompilerOptions(logger),
      options.getProjectReferences(),
    );
  },
};

/** @param {import('typedoc').Application} application */
export const load = application =>
  application.options.addReader(packageSourcesReader);
