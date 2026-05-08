// @ts-check

/**
 * Local, in-process implementation of `SandboxPowers` for callers that
 * do not have an Endo daemon.
 *
 * The `@endo/sandbox` factory's `scratchProvider` argument is shaped as
 * `SandboxPowers` (see `packages/sandbox/src/types.d.ts`):
 *
 * ```ts
 * type SandboxPowers = ERef<{
 *   provideScratchMount(petName: string): Promise<MountCap>;
 *   provideHostPath(cap: MountCap): Promise<string>;
 * }>;
 * ```
 *
 * Inside the daemon, `EndoHost` provides this via the daemon's mount
 * machinery — see `packages/daemon/src/host.js`'s `provideHostPath`
 * for the daemon-side counterpart, which consults the daemon's
 * mount-formula registry and rejects strangers with `not a
 * daemon-minted mount`.  This file is the dev-repl-shaped analogue:
 * a `WeakMap<cap, hostPath>`-backed implementation that rejects
 * strangers with `not a local-minted mount`, mirroring the daemon's
 * error wording so a misrouted cap looks the same on both paths.
 *
 * Outside the daemon — the dev-repl, scripted harnesses, unit tests
 * outside `packages/sandbox` — callers either build a stub (every test
 * in `packages/sandbox/test/*.test.js` does this) or go without slice
 * support entirely.  This module provides the former, shared,
 * in-process implementation so a single `makeLocalSandboxPowers` call
 * hands you a `SandboxPowers`-shaped exo plus a helper to mint a
 * Mount cap from any operator-supplied host path.
 *
 * The exposed Mount methods (`help`, `has`, `list`, `readText`,
 * `writeText`, `makeDirectory`) match the daemon's `MountInterface`
 * subset that the genie's `spawnAgent` Mount-cap validation requires
 * (`packages/genie/main.js` checks `__getMethodNames__()` against
 * `['readText', 'writeText', 'makeDirectory', 'has', 'list']`) and that
 * `initWorkspaceMount` drives.  The factory itself never calls these
 * methods on the cap — it only passes the cap through `provideHostPath`
 * to recover the host path — so a fully-faithful Mount surface is not
 * needed here.  See `TODO/51_genie_dev_repl_local_sandbox_powers.md`.
 *
 * Out of scope (deliberately a thinner abstraction than the daemon's):
 *   - Honouring Endo `provideMount`'s confinement-root semantics
 *     beyond a textual `..` check.  The dev-repl owns its workspace
 *     and trusts the operator-supplied path.
 *   - Persisting / reusing tmpdirs across runs.  Each `makeLocalSandboxPowers`
 *     call mints fresh scratch on demand and disposes on caller exit.
 */

import { promises as fs, mkdtempSync } from 'fs';
import { join, isAbsolute } from 'path';
import { tmpdir } from 'os';

import { makeError, q, X } from '@endo/errors';
import { makeExo } from '@endo/exo';
import harden from '@endo/harden';
import { M } from '@endo/patterns';

/** @import { MountCap, SandboxPowers } from '@endo/sandbox/types.js' */

/**
 * Subset of the daemon's `MountInterface` exposed by the local
 * Mount-cap exo.  Restricted to what `spawnAgent`'s pet-name
 * validation and `initWorkspaceMount` actually drive — the factory
 * itself only stuffs the cap through a `WeakMap` and never calls any
 * of these methods.
 */
const PathSegmentsShape = M.arrayOf(M.string());
const PathArgShape = M.or(M.string(), PathSegmentsShape);

const LocalMountInterface = M.interface('LocalMount', {
  help: M.call().returns(M.string()),
  has: M.call().rest(PathSegmentsShape).returns(M.promise()),
  list: M.call().rest(PathSegmentsShape).returns(M.promise()),
  readText: M.call(PathArgShape).returns(M.promise()),
  writeText: M.call(PathArgShape, M.string()).returns(M.promise()),
  makeDirectory: M.call(PathArgShape).returns(M.promise()),
});

const LocalSandboxPowersInterface = M.interface('LocalSandboxPowers', {
  provideScratchMount: M.call(M.string()).returns(M.promise()),
  provideHostPath: M.call(M.any()).returns(M.promise()),
});

/**
 * Coerce a `string | string[]` path argument into a flat array of
 * non-empty segments.  Mirrors the daemon's permissive shape.
 *
 * @param {string | string[]} pathArg
 * @returns {string[]}
 */
const segmentsOf = pathArg => {
  if (Array.isArray(pathArg)) return [...pathArg];
  return [pathArg];
};
harden(segmentsOf);

/**
 * Reject path segments that would escape the mount root.  The local
 * powers do not pretend to be a confined filesystem — they only veto
 * the obvious textual escape so a typo does not silently address an
 * unrelated host directory.
 *
 * @param {string[]} segments
 */
const assertNoEscape = segments => {
  for (const segment of segments) {
    if (typeof segment !== 'string') {
      throw makeError(
        X`local Mount: path segment must be a string, got ${q(typeof segment)}`,
      );
    }
    if (segment === '..' || segment.includes('\0')) {
      throw makeError(
        X`local Mount: path segment ${q(segment)} is not allowed`,
      );
    }
  }
};
harden(assertNoEscape);

/**
 * Build a Mount-shaped exo rooted at `hostPath`.  The cap and its
 * `hostPath` are wired into `capToHostPath` so the same powers'
 * `provideHostPath` can resolve it.
 *
 * @param {string} hostPath - Absolute host path the mount represents.
 * @param {WeakMap<object, string>} capToHostPath
 * @returns {object}
 */
const makeLocalMountCap = (hostPath, capToHostPath) => {
  if (!isAbsolute(hostPath)) {
    throw makeError(
      X`local Mount: hostPath must be absolute, got ${q(hostPath)}`,
    );
  }

  /** @param {string[]} segments */
  const resolve = segments => {
    assertNoEscape(segments);
    return segments.length === 0 ? hostPath : join(hostPath, ...segments);
  };

  const cap = makeExo('LocalMount', LocalMountInterface, {
    help() {
      return `local Mount @ ${hostPath}`;
    },

    /** @param {string[]} segments */
    async has(...segments) {
      await null;
      const target = resolve(segments);
      try {
        await fs.access(target);
        return true;
      } catch {
        return false;
      }
    },

    /** @param {string[]} segments */
    async list(...segments) {
      const target = resolve(segments);
      const entries = await fs.readdir(target);
      return harden(entries.sort());
    },

    /** @param {string | string[]} pathArg */
    async readText(pathArg) {
      const target = resolve(segmentsOf(pathArg));
      return fs.readFile(target, 'utf8');
    },

    /**
     * @param {string | string[]} pathArg
     * @param {string} content
     */
    async writeText(pathArg, content) {
      const segments = segmentsOf(pathArg);
      const target = resolve(segments);
      // Mirror the daemon's behaviour: ensure parent directories exist.
      const parent =
        segments.length <= 1
          ? hostPath
          : join(hostPath, ...segments.slice(0, -1));
      await fs.mkdir(parent, { recursive: true });
      await fs.writeFile(target, content);
    },

    /** @param {string | string[]} pathArg */
    async makeDirectory(pathArg) {
      const target = resolve(segmentsOf(pathArg));
      await fs.mkdir(target, { recursive: true });
    },
  });

  capToHostPath.set(cap, hostPath);
  return cap;
};
harden(makeLocalMountCap);

/**
 * Construct an in-process `SandboxPowers` plus the helpers a caller
 * needs to mint workspace-shaped Mount caps and clean up afterwards.
 *
 * The returned `powers` object satisfies the
 * `MakeSandboxFactoryInput.scratchProvider` contract:
 *
 *   - `provideScratchMount(petName)` mints a fresh tmpdir and wraps it
 *     in a Mount cap whose `hostPath` is recorded in the same WeakMap
 *     `provideHostPath` consults.
 *   - `provideHostPath(cap)` resolves a previously-minted Mount cap to
 *     its host path, throwing a structured error for any cap the
 *     powers did not mint.  This mirrors the daemon's `EndoHost.provideHostPath`
 *     (`packages/daemon/src/host.js`) which rejects unknown caps with
 *     "not a daemon-minted mount".
 *
 * `makeMountCapForPath(hostPath)` mints a workspace-shaped Mount cap
 * pointing at the operator-supplied path; the cap is wired into the
 * same WeakMap so the factory can resolve it through `provideHostPath`.
 * Callers pass the resulting cap into `factory.make({ mounts: [...] })`
 * (and, in the dev-repl's case, also into `initWorkspaceMount` and
 * `buildGenieTools` so the daemon-side and slice-side views land on
 * the same bytes).
 *
 * `dispose()` removes every tmpdir minted via `provideScratchMount`.
 * Caps minted by `makeMountCapForPath` are owned by the caller (the
 * powers never created the directory) and are not removed by
 * `dispose()`.
 *
 * @returns {{
 *   powers: SandboxPowers,
 *   makeMountCapForPath: (hostPath: string) => MountCap,
 *   dispose: () => Promise<void>,
 * }}
 */
export const makeLocalSandboxPowers = () => {
  /** @type {WeakMap<object, string>} */
  const capToHostPath = new WeakMap();
  /** @type {string[]} */
  const scratchDirs = [];

  const powersExo = makeExo('LocalSandboxPowers', LocalSandboxPowersInterface, {
    /** @param {string} petName */
    async provideScratchMount(petName) {
      // `mkdtemp` ensures distinct tmpdirs per call even when two
      // requests land in the same tick.
      const safePet = petName.replace(/[^a-zA-Z0-9-]/g, '-');
      const dir = mkdtempSync(join(tmpdir(), `genie-local-${safePet}-`));
      scratchDirs.push(dir);
      return /** @type {MountCap} */ (makeLocalMountCap(dir, capToHostPath));
    },

    /** @param {unknown} cap */
    async provideHostPath(cap) {
      // The WeakMap lookup is the privileged operation: a cap the
      // powers did not mint will have no entry, mirroring the
      // daemon's "cap is not a daemon-minted mount" error.
      if (
        cap === null ||
        (typeof cap !== 'object' && typeof cap !== 'function')
      ) {
        throw makeError(
          X`local provideHostPath: cap is not a local-minted mount`,
        );
      }
      const path = capToHostPath.get(/** @type {object} */ (cap));
      if (path === undefined) {
        throw makeError(
          X`local provideHostPath: cap is not a local-minted mount`,
        );
      }
      return path;
    },
  });
  const powers = /** @type {SandboxPowers} */ (
    /** @type {unknown} */ (powersExo)
  );

  /** @param {string} hostPath */
  const makeMountCapForPath = hostPath =>
    /** @type {MountCap} */ (makeLocalMountCap(hostPath, capToHostPath));

  const dispose = async () => {
    await null;
    // Drain the array so a second `dispose()` call is a no-op even
    // when the first one was interrupted partway through.
    const dirs = scratchDirs.splice(0);
    await Promise.all(
      dirs.map(async dir => {
        await null;
        try {
          await fs.rm(dir, { recursive: true, force: true });
        } catch (e) {
          // Surface unexpected rm failures on stderr without
          // poisoning a clean shutdown — the tmpdir lives under
          // `os.tmpdir()` and the OS will reap it eventually.
          console.error(
            `[local-sandbox-powers] failed to remove scratch ${dir}: ${
              /** @type {Error} */ (e).message
            }`,
          );
        }
      }),
    );
  };

  return harden({
    powers,
    makeMountCapForPath,
    dispose,
  });
};
harden(makeLocalSandboxPowers);
