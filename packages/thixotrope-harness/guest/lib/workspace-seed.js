// @ts-check
export const workspaceSeedLabel = 'thixotrope-project-source';

/** @typedef {{ project: 'thixotrope', commit: string }} WorkspaceSeed */

/**
 * The project is a packaged source identity. The commit identifies the exact
 * revision a newly created environment must open.
 * @param {WorkspaceSeed} seed
 */
export const assertWorkspaceSeed = seed => {
  if (
    seed?.project !== 'thixotrope' ||
    typeof seed.commit !== 'string' ||
    seed.commit.length !== 40 ||
    !/^[0-9a-f]+$/.test(seed.commit) ||
    Object.keys(seed).length !== 2
  )
    throw Error('Invalid workspace seed');
};
harden(assertWorkspaceSeed);
