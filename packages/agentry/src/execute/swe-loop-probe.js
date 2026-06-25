// @ts-check
/// <reference types="ses"/>

/**
 * Gap-revealing prototype: ocap-disciplined SWE loop (clone → push).
 *
 * This module walks the full software-engineering loop that a code-mode
 * agent would need to run — clone, worktree-add, yarn install, file
 * create/edit, test run, push to a local bare remote — using ONLY the
 * capability surface that exists on the `llm` branch today.
 *
 * Every step that cannot be written without a capability gap is left as a
 * stub with a `// gap: see PR body §N` comment. Steps that compose
 * cleanly are implemented with real code.
 *
 * @module swe-loop-probe
 */

import { E } from '@endo/far';

// ---------------------------------------------------------------------------
// Types used by the skeleton
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SweLoopPowers
 *   The set of lexical powers a code-mode agent would receive for the full
 *   SWE loop. Today's code-mode preset (`CodeModePowers`) supplies only
 *   `workspace` and `git`; the additional fields below are the gaps.
 *
 * @property {object} workspace
 *   A writable `@endo/platform/fs/extended` Filesystem rooted at the
 *   repository checkout. (PRESENT — supplied by the current preset.)
 *
 * @property {object} git
 *   A read/write `@endo/exo-git` Git capability bound to the same root.
 *   (PRESENT — supplied by the current preset.)
 *
 * @property {object} [remote]
 *   A `@endo/exo-git` GitRemote capability pre-configured for a LOCAL
 *   bare-remote URL (file: transport). Used for the push step.
 *   (GAP 4 — not exposed as a code-mode lexical power; see §4 below.)
 *
 * @property {object} [exec]
 *   A capability to run a confined subprocess (yarn install, npm test).
 *   (GAP 3 — no such power exists in code-mode today; see §3 below.)
 */

// ---------------------------------------------------------------------------
// Step 1: Clone — GAP 1
// ---------------------------------------------------------------------------

/**
 * Demonstrate the clone gap.
 *
 * A code-mode agent has no way to obtain a Git cap over a *freshly cloned*
 * repository. `provideGit(mountCap, petName)` mints a Git cap over an
 * EXISTING mount; it does not clone. The `GitBackend` contract has no
 * `clone` method; `GitRemote` has `fetch` and `push` but no `clone`.
 * The native backend (`makeNativeGitBackend`) has no `clone` entry.
 *
 * // gap: see PR body §1 — no clone operation on any public surface
 *
 * @param {SweLoopPowers} _powers
 * @returns {Promise<never>}
 */
export const probeClone = async _powers => {
  // gap: see PR body §1
  throw new Error(
    'clone is not available on any code-mode capability surface; ' +
      'the agent cannot obtain a Git cap over a freshly cloned repo',
  );
};
harden(probeClone);

// ---------------------------------------------------------------------------
// Step 2: Worktree-add — GAP 2
// ---------------------------------------------------------------------------

/**
 * Demonstrate the worktree-add gap.
 *
 * `git.worktree()` (on the `EndoGit` exo, `git.js:308`) returns the CURRENT
 * worktree authority (the `EndoMount` the Git cap was constructed over). It
 * does not mint a new worktree via `git worktree add`.
 *
 * // gap: see PR body §2
 *
 * @param {Pick<SweLoopPowers, 'git'>} powers
 * @returns {Promise<object>} The CURRENT worktree mount (not a new worktree).
 */
export const probeWorktreeAuthority = async powers => {
  // This composes: returns the existing worktree authority.
  const currentWorktree = await E(powers.git).worktree();
  return currentWorktree;
  // gap: see PR body §2 — no way to ADD a new linked worktree
};
harden(probeWorktreeAuthority);

// ---------------------------------------------------------------------------
// Step 3: exec/spawn (yarn install, npm test) — GAP 3
// ---------------------------------------------------------------------------

/**
 * Demonstrate the exec/spawn gap.
 *
 * `yarn install` and `npm test` require spawning a subprocess. No subprocess
 * power exists in the code-mode `CodeModePowers` set. The genie's `Spawner`
 * seam (`packages/genie/src/tools/spawner.js`) and the `SandboxHandle.spawn`
 * adapter (`sandbox-spawner.js`) exist on the genie side but are not plumbed
 * as a code-mode lexical capability.
 *
 * // gap: see PR body §3
 *
 * @param {SweLoopPowers} _powers
 * @returns {Promise<never>}
 */
export const probeExec = async _powers => {
  // gap: see PR body §3
  throw new Error(
    'no exec/spawn power is exposed as a code-mode lexical capability; ' +
      'yarn install and npm test cannot run through the cap boundary',
  );
};
harden(probeExec);

// ---------------------------------------------------------------------------
// Step 4: File create/edit — COMPOSES
// ---------------------------------------------------------------------------

/**
 * Demonstrate that file create/edit via the workspace Filesystem composes.
 *
 * The `EndoMount` surface exposed under `workspace` supports:
 *   - `writeText(pathArg, content)` — creates parent dirs automatically,
 *     creates the file if absent, overwrites if present.
 *   - `makeFile(pathArg, content)` — creates parent dirs, creates file
 *     if absent (idempotent on missing path).
 *   - `makeDirectory(pathArg)` — recursive mkdir.
 *   - `readText(pathArg)` — read file text.
 *
 * Creating a file at a path whose parent dirs do not exist works:
 * `makePath(parent)` is called internally before the write.
 *
 * @param {Pick<SweLoopPowers, 'workspace'>} powers
 * @param {string} relPath  Repository-relative path, e.g. 'src/foo.js'.
 * @param {string} content  UTF-8 text to write.
 * @returns {Promise<void>}
 */
export const probeFileWrite = async (powers, relPath, content) => {
  // writeText creates parent dirs and the file. This is the clear path
  // for a code-mode agent to create or update a file.
  await E(powers.workspace).writeText(relPath, content);
};
harden(probeFileWrite);

/**
 * Verify a file can be read back after writing.
 *
 * @param {Pick<SweLoopPowers, 'workspace'>} powers
 * @param {string} relPath
 * @returns {Promise<string>}
 */
export const probeFileRead = async (powers, relPath) => {
  return E(powers.workspace).readText(relPath);
};
harden(probeFileRead);

// ---------------------------------------------------------------------------
// Step 5: git add/commit — COMPOSES
// ---------------------------------------------------------------------------

/**
 * Demonstrate that git add and commit via the Git cap compose.
 *
 * The `EndoGit` exo exposes `add(entries)` and `commit(message)`. Both
 * require an `EndoMountEntry[]` for the `add` path (produced by
 * `E(git).status()` rows' `.entry` field or by `E(mount).entry(segments)`).
 *
 * @param {Pick<SweLoopPowers, 'git'>} powers
 * @param {string} repoRelPath  Repo-relative path to stage, e.g. 'src/foo.js'.
 * @param {string} message  Commit message.
 * @returns {Promise<import('@endo/exo-git/src/types.js').GitCommit>}
 */
export const probeAddCommit = async (powers, repoRelPath, message) => {
  // Obtain the mount so we can mint an EndoMountEntry for the path.
  const mount = await E(powers.git).worktree();
  const segments = repoRelPath.split('/');
  const entry = await E(mount).entry(segments);
  // Add the file to the staging area.
  await E(powers.git).add([entry]);
  // Commit and return the resulting GitCommit record.
  return E(powers.git).commit(message);
};
harden(probeAddCommit);

// ---------------------------------------------------------------------------
// Step 6: Push to local bare remote — GAP 4
// ---------------------------------------------------------------------------

/**
 * Demonstrate the push/credential gap.
 *
 * `GitRemote.push()` EXISTS on the `@endo/exo-git` surface and the
 * native backend's `remotePush` is implemented. However:
 *
 *   (a) A `GitRemote` cap must be minted by the daemon via
 *       `provideGitRemote(gitCap, petName, opts)`; a code-mode agent
 *       cannot mint one itself.
 *   (b) For a `file:` URL the `normalizeRemoteUrl` validator in
 *       `git-remote.js` requires `allowLocalFileTransport: true` in the
 *       policy. This flag is not part of the current `GitRemotePolicy`
 *       default.
 *   (c) A credential cap is required for `https:` URLs; it is minted
 *       via `provideBearerCredential` / `provideBasicCredential` on the
 *       `EndoHost` (host-side only). A code-mode agent cannot mint one.
 *
 * For a LOCAL bare remote (file: URL) the credential requirement is
 * absent, but items (a) and (b) still block the push from code-mode.
 *
 * // gap: see PR body §4
 *
 * @param {SweLoopPowers} _powers
 * @returns {Promise<never>}
 */
export const probePush = async _powers => {
  // gap: see PR body §4
  throw new Error(
    'push requires a GitRemote cap that is not accessible from code-mode; ' +
      'the daemon must mint it and introduce it as a lexical power',
  );
};
harden(probePush);

// ---------------------------------------------------------------------------
// Step 7: File-write surface verification — COMPOSES (with a note)
// ---------------------------------------------------------------------------

/**
 * Confirm that `EndoMountEntry` (a structural entry descriptor minted by
 * `E(mount).entry(segments)`) is INERT with respect to I/O.
 *
 * An `EndoMountEntry` carries only path metadata (`segments()`); it does
 * not carry read/write authority. Write authority lives on the node
 * (`E(mount).lookup(segments)`) or on the parent mount's methods
 * (`writeText`, `makeFile`). This is not a gap for the SWE loop — the
 * workspace mount's `writeText` is the clear ergonomic write path — but
 * the job spec asks to confirm the surface.
 *
 * The `write(blob)` on `EndoMount` expects a `ReadableBlob` or
 * `ReadableTree` for binary/tree writes; UTF-8 text writes go through
 * `writeText`. There is no gap here: these compose cleanly.
 *
 * @param {Pick<SweLoopPowers, 'workspace'>} powers
 * @returns {Promise<{ hasEntry: boolean; canWriteViaMount: boolean }>}
 */
export const probeFileWriteSurface = async powers => {
  // Mint an entry for a sentinel path.
  const entry = await E(powers.workspace).entry(['probe-sentinel.txt']);
  // The entry exists as an authority-bearing descriptor; it is not inert
  // in the "undefined" sense, but its I/O authority is scoped: it cannot
  // initiate a write on its own. The write must go through the mount.
  const hasEntry = entry !== undefined;

  // Demonstrate the ergonomic write path via writeText on the mount.
  await E(powers.workspace).writeText('probe-sentinel.txt', '// probe file\n');
  const readBack = await E(powers.workspace).readText('probe-sentinel.txt');
  const canWriteViaMount = readBack === '// probe file\n';

  // Clean up.
  await E(powers.workspace).remove('probe-sentinel.txt');

  return harden({ hasEntry, canWriteViaMount });
};
harden(probeFileWriteSurface);
