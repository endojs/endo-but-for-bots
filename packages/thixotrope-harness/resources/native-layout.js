// @ts-check
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { argv as argvDefault } from 'node:process';

/**
 * The harness package directory, from the adapter process's entry module.
 * @param {string | undefined} [entry]
 */
export const findHarnessRoot = (entry = argvDefault[1]) => {
  if (typeof entry !== 'string')
    throw Error('agent host: the adapter process has no entry module path');
  // .../packages/thixotrope/src/platform/node/adapter-process-entry.js
  const root = resolve(
    dirname(entry),
    '..',
    '..',
    '..',
    '..',
    'thixotrope-harness',
  );
  if (!existsSync(join(root, 'resources', 'agent-host', 'impl', 'index.js')))
    throw Error(
      `agent host: no implementation under ${root}; the harness must be the core's sibling package`,
    );
  return root;
};

/**
 * The daemon's state directory, from the adapter process's bundle path:
 * `argv[3]` is `<state>/bundles/<digest>.cjs` (pkg store-fs.js `bundlePath`,
 * adapter-process-entry.js), so state copies and templates carry their
 * files. The core gives an adapter no state directory (AR-SYN-28); this is
 * the one place that reads it from argv (HR-SYN-22).
 * @param {readonly string[]} [argv]
 */
export const findStateDir = (argv = argvDefault) => {
  const bundle = argv[3];
  if (
    typeof bundle !== 'string' ||
    !bundle.endsWith('.cjs') ||
    basename(dirname(bundle)) !== 'bundles'
  ) {
    throw Error(
      'agent host: no state directory (argv[3] is not <state>/bundles/<digest>.cjs)',
    );
  }
  return dirname(dirname(bundle));
};
