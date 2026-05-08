// @ts-check

/**
 * Unit tests for {@link makeLocalSandboxPowers} — the daemon-free
 * in-process implementation of the `SandboxPowers` contract that
 * `@endo/sandbox`'s `makeSandboxFactory` consumes.
 *
 * The tests pin four invariants from
 * `TODO/51_genie_dev_repl_local_sandbox_powers.md`:
 *
 *   1. `provideScratchMount` mints distinct tmpdirs per call.
 *   2. `provideHostPath` round-trips a cap minted by
 *      `makeMountCapForPath`.
 *   3. `provideHostPath` rejects an unknown cap with a structured
 *      error matching the daemon's "not a … mount" pattern
 *      (`packages/daemon/src/host.js` `provideHostPath`).
 *   4. `dispose()` removes every tmpdir minted via
 *      `provideScratchMount`.
 *
 * The tests run without spinning up a daemon — they exercise the
 * powers exo directly via `E()` to mirror how the sandbox factory
 * would call them.
 */

import '@endo/init/debug.js';

import { promises as fs, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { E } from '@endo/eventual-send';
import { Far } from '@endo/far';
import test from 'ava';

import { makeLocalSandboxPowers } from '../src/sandbox/local-powers.js';

// ---------------------------------------------------------------------------
// provideScratchMount
// ---------------------------------------------------------------------------

test('provideScratchMount mints distinct tmpdirs per call', async t => {
  const { powers, dispose } = makeLocalSandboxPowers();
  t.teardown(dispose);

  const capA = await E(powers).provideScratchMount('alpha');
  const capB = await E(powers).provideScratchMount('alpha'); // same petName
  const capC = await E(powers).provideScratchMount('beta');

  const pathA = await E(powers).provideHostPath(capA);
  const pathB = await E(powers).provideHostPath(capB);
  const pathC = await E(powers).provideHostPath(capC);

  t.not(pathA, pathB, 'two scratch mounts with the same petName must differ');
  t.not(pathA, pathC);
  t.not(pathB, pathC);

  // Each path is an actual host directory.
  for (const path of [pathA, pathB, pathC]) {
    // eslint-disable-next-line no-await-in-loop
    const stat = await fs.stat(path);
    t.true(stat.isDirectory(), `${path} should be a real directory`);
  }

  // The petName is reflected in the tmpdir name so an operator
  // grepping `os.tmpdir()` can attribute a leak to its source.
  t.regex(pathA, /genie-local-alpha-/);
  t.regex(pathC, /genie-local-beta-/);
});

// ---------------------------------------------------------------------------
// provideHostPath round-trip via makeMountCapForPath
// ---------------------------------------------------------------------------

test('provideHostPath round-trips a cap minted by makeMountCapForPath', async t => {
  const { powers, makeMountCapForPath, dispose } = makeLocalSandboxPowers();
  t.teardown(dispose);

  // Set up a real host directory the operator would hand to the
  // dev-repl as its workspace.
  const workspaceDir = mkdtempSync(join(tmpdir(), 'genie-local-test-ws-'));
  t.teardown(() => fs.rm(workspaceDir, { recursive: true, force: true }));

  const cap = makeMountCapForPath(workspaceDir);
  const resolved = await E(powers).provideHostPath(cap);
  t.is(resolved, workspaceDir, 'round-trip must yield the original path');

  // The cap also exposes the Mount surface the genie's `spawnAgent`
  // validation requires, so a future consumer can drive it through
  // `E(cap).readText` / `writeText` / `makeDirectory` / `has` / `list`.
  // The factory itself never calls these, but pinning the surface
  // here guards against an accidental method-name regression.
  const methods = /** @type {string[]} */ (
    // eslint-disable-next-line no-underscore-dangle
    await E(/** @type {any} */ (cap)).__getMethodNames__()
  );
  for (const m of [
    'help',
    'readText',
    'writeText',
    'makeDirectory',
    'has',
    'list',
  ]) {
    t.true(
      methods.includes(m),
      `Mount cap should expose ${m} (got: ${methods.join(', ')})`,
    );
  }
});

// ---------------------------------------------------------------------------
// provideHostPath rejection paths
// ---------------------------------------------------------------------------

test('provideHostPath rejects an unknown cap with a structured error', async t => {
  const { powers, dispose } = makeLocalSandboxPowers();
  t.teardown(dispose);

  // A `Far` exo the powers never minted — the daemon would reject
  // this with `cap is not a daemon-minted mount`; the local powers
  // mirror that pattern with `not a local-minted mount`.
  const stranger = Far('Stranger', { help: () => 'not minted here' });
  await t.throwsAsync(() => E(powers).provideHostPath(stranger), {
    message: /not a local-minted mount/,
  });

  // Caps minted by *another* `makeLocalSandboxPowers` instance are
  // strangers to this one, even though both surfaces look identical
  // — the WeakMap is per-instance.
  const other = makeLocalSandboxPowers();
  t.teardown(other.dispose);
  const fromOther = await E(other.powers).provideScratchMount('x');
  await t.throwsAsync(() => E(powers).provideHostPath(fromOther), {
    message: /not a local-minted mount/,
  });

  // Non-object inputs are rejected up front (the `M.call(M.any())`
  // guard accepts them, so the runtime check carries the weight).
  for (const garbage of [null, undefined, 42, 'a string', true]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(
      () => E(powers).provideHostPath(/** @type {any} */ (garbage)),
      { message: /not a local-minted mount/ },
      `unknown cap of type ${typeof garbage} should be rejected`,
    );
  }
});

// ---------------------------------------------------------------------------
// dispose() cleanup
// ---------------------------------------------------------------------------

test('dispose() removes every tmpdir minted via provideScratchMount', async t => {
  const { powers, dispose } = makeLocalSandboxPowers();

  const capA = await E(powers).provideScratchMount('one');
  const capB = await E(powers).provideScratchMount('two');
  const pathA = await E(powers).provideHostPath(capA);
  const pathB = await E(powers).provideHostPath(capB);

  // Both directories are real on disk before disposal.
  for (const p of [pathA, pathB]) {
    // eslint-disable-next-line no-await-in-loop
    t.true((await fs.stat(p)).isDirectory(), `${p} present before dispose`);
  }

  // Drop a sentinel inside one of them so we know `dispose()` is
  // genuinely doing a recursive removal rather than relying on the
  // tmpdir being empty.
  await fs.writeFile(join(pathA, 'sentinel.txt'), 'present');

  await dispose();

  for (const p of [pathA, pathB]) {
    // eslint-disable-next-line no-await-in-loop
    await t.throwsAsync(() => fs.stat(p), { code: 'ENOENT' });
  }

  // Calling dispose() again is a no-op; the internal scratch list was
  // drained on the first call.
  await t.notThrowsAsync(dispose);
});

test('dispose() does not remove operator-supplied paths from makeMountCapForPath', async t => {
  // `makeMountCapForPath` wraps a directory the caller already owns;
  // `dispose()` must never delete those.  This pins the asymmetry
  // documented at the top of `local-powers.js` so a future refactor
  // does not accidentally collapse the two paths into one cleanup
  // list and start eating workspace contents on REPL exit.
  const { makeMountCapForPath, dispose } = makeLocalSandboxPowers();

  const operatorDir = mkdtempSync(join(tmpdir(), 'genie-local-test-op-'));
  t.teardown(() => fs.rm(operatorDir, { recursive: true, force: true }));
  await fs.writeFile(join(operatorDir, 'precious.txt'), 'do not delete me');

  // Mint a cap for the operator's path, then dispose.
  makeMountCapForPath(operatorDir);
  await dispose();

  // Both the directory and the file inside it must still be on disk.
  t.true((await fs.stat(operatorDir)).isDirectory());
  t.is(
    await fs.readFile(join(operatorDir, 'precious.txt'), 'utf8'),
    'do not delete me',
  );
});
