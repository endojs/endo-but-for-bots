// @ts-check

import { Fail, q } from '@endo/errors';
import { M, mustMatch } from '@endo/patterns';

/** @import { GeneratedFile, GeneratedFilePath, ValidatedGeneratedFile } from './generated-file-types.js' */

export const GeneratedFileShape = harden({
  innerPath: M.string(),
  contents: M.string(),
});
harden(GeneratedFileShape);

// These mounts belong to the runtime. A generated file cannot replace a
// parent, occupy their destination, or hide underneath one of them.
const reservedDestinations = harden([
  '/proc',
  '/sys',
  '/dev',
  '/tmp',
  '/scratch',
]);

/**
 * @param {string} path
 * @returns {GeneratedFilePath}
 */
const assertDestination = path => {
  (path.startsWith('/') &&
    !path.includes('\0') &&
    path
      .slice(1)
      .split('/')
      .every(part => part !== '' && part !== '.' && part !== '..')) ||
    Fail`Generated file destination must be canonical, absolute, and non-root: ${q(path)}`;
  return /** @type {GeneratedFilePath} */ (path);
};

/**
 * @param {string} first
 * @param {string} second
 */
const overlaps = (first, second) =>
  first === '/' ||
  second === '/' ||
  first === second ||
  first.startsWith(`${second}/`) ||
  second.startsWith(`${first}/`);

/**
 * Validate literal records and destination ownership before acquiring resources.
 * Mount destinations must be canonical too, so aliases cannot evade overlap checks.
 * Host staging location, budget, and native mount encoding belong to the runtime.
 *
 * @param {readonly GeneratedFile[]} files
 * @param {readonly string[]} [mountDestinations]
 * @returns {readonly ValidatedGeneratedFile[]}
 */
export const validateGeneratedFiles = (files, mountDestinations = []) => {
  mustMatch(harden(files), M.arrayOf(GeneratedFileShape));
  if (files.length === 0) return harden([]);
  const occupied = [
    ...reservedDestinations,
    ...mountDestinations.map(path =>
      path === '/' ? path : assertDestination(path),
    ),
  ];
  return harden(
    files.map(file => {
      const innerPath = assertDestination(file.innerPath);
      for (const destination of occupied) {
        !overlaps(innerPath, destination) ||
          Fail`Generated file destination ${q(innerPath)} overlaps ${q(destination)}`;
      }
      occupied.push(innerPath);
      return harden({ innerPath, contents: file.contents });
    }),
  );
};
harden(validateGeneratedFiles);
