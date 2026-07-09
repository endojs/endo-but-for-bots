import { q } from '@endo/errors';

/**
 * Splits a slash-delimited pet name path into an array of pet names.
 * Throws if the path is not a string or if any of the path segments are empty.
 *
 * @param {string} petNamePath - A slash-delimited pet name path.
 * @returns {string[]} - The pet name path, as an array of pet names.
 */
export const parsePetNamePath = petNamePath => {
  assert(typeof petNamePath === 'string');

  const petNames = petNamePath.split('/');
  for (const petName of petNames) {
    if (petName === '') {
      throw new Error(
        `Pet name path ${q(petNamePath)} contains an empty segment.`,
      );
    }
  }
  return petNames;
};

/**
 * Like {@link parsePetNamePath}, but immediately returns `undefined` values.
 *
 * @param {string | undefined} optionalPetNamePath - A slash-delimited pet name path,
 * or `undefined`.
 * @returns {string[] | undefined} - The pet name path as an array of pet names, or
 * `undefined`.
 */
export const parseOptionalPetNamePath = optionalPetNamePath => {
  assert(
    optionalPetNamePath === undefined ||
      typeof optionalPetNamePath === 'string',
  );

  return optionalPetNamePath === undefined
    ? undefined
    : parsePetNamePath(optionalPetNamePath);
};

/**
 * Normalizes the variadic in-mount path arguments of the mount-scoped CLI
 * verbs (`endo ls <mount> [path...]`, `endo cat <mount> <path...>`,
 * `endo write <mount> <path...>`) into a flat array of path segments. Each
 * argument may itself carry `/`-separated segments, so `['src/index.js']` and
 * `['src', 'index.js']` both normalize to `['src', 'index.js']`. Empty
 * segments (from leading, trailing, or doubled slashes) are dropped; `.` and
 * `..` are preserved for the mount's own path resolver to interpret.
 *
 * @param {string[]} [pathArgs] - The trailing in-mount path arguments.
 * @returns {string[]} - The flattened, non-empty path segments.
 */
export const mountPathSegments = (pathArgs = []) =>
  pathArgs.flatMap(arg => arg.split('/')).filter(segment => segment !== '');
