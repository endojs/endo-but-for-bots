// @ts-nocheck
/* global process */

// Smoke test for the Primer-into-CAS packaged-build flow (G16 in
// designs/familiar-release.md).  Mirrors what `lal/agent.js`'s
// `runManager` does at packaged-app startup: take the bundled
// primer directory (copied next to the agent bundle by
// `packages/familiar/scripts/bundle.mjs`), wrap it as a
// `LocalTree`, hand it to a real daemon host via `storeTree`, and
// confirm that a freshly-provisioned sub-guest can resolve its
// `primer` reference and read the documents back.
//
// The test exercises the runtime path the packaged Electron app
// depends on, without launching Electron itself.  An end-to-end
// Electron-launching smoke test is deferred (it requires a display
// or xvfb harness and would not catch any failure modes this test
// does not already cover).

import '@endo/init/debug.js';

import test from 'ava';
import url from 'url';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { E } from '@endo/eventual-send';
import { makePromiseKit } from '@endo/promise-kit';
import { start, stop, purge, makeEndoClient } from '@endo/daemon';
import { makeLocalTree } from '@endo/platform/fs/node';

const dirname = url.fileURLToPath(new URL('.', import.meta.url));
const lalRoot = path.resolve(dirname, '..');
const repoRoot = path.resolve(lalRoot, '../..');
const sourcePrimer = path.join(lalRoot, 'primer');
const familiarRoot = path.join(repoRoot, 'packages/familiar');
const bundledPrimer = path.join(familiarRoot, 'bundles/primer');
const bundleScript = path.join(familiarRoot, 'scripts/bundle.mjs');

// The bundled primer must exist for the smoke tests to mean
// anything; if it does not, run the bundle step once to produce it.
// In CI, the `familiar-bundle` job runs `step:bundle` separately, so
// in that path this becomes a no-op presence check.  Locally, the
// first run pays the bundle cost.
const ensureBundledPrimer = () => {
  if (
    fs.existsSync(bundledPrimer) &&
    fs.existsSync(path.join(bundledPrimer, 'README.md'))
  ) {
    return;
  }
  // node + the bundle script.  We do not use yarn here to avoid
  // dragging the workspace tool surface into the test.
  execFileSync(process.execPath, [bundleScript], {
    cwd: familiarRoot,
    stdio: 'inherit',
  });
};

ensureBundledPrimer();

// Test directories.  Use a unique scratch per test under the
// daemon's idiomatic `tmp/` to match the rest of the suite's
// cleanup discipline.
const tmpRoot = path.join(lalRoot, 'tmp');
let configCounter = 0;
const makeConfig = label => {
  configCounter += 1;
  const suffix = `${String(configCounter).padStart(4, '0')}`;
  const root = path.join(tmpRoot, `primer-cas-${label}-${suffix}`);
  return {
    statePath: path.join(root, 'state'),
    ephemeralStatePath: path.join(root, 'run'),
    cachePath: path.join(root, 'cache'),
    sockPath:
      process.platform === 'win32'
        ? String.raw`\\?\pipe\endo-primer-cas-${label}-${suffix}.sock`
        : path.join(root, 'endo.sock'),
    address: '127.0.0.1:0',
    pets: new Map(),
    values: new Map(),
  };
};

/**
 * Bring up a fresh daemon and return the host reference plus a
 * teardown registered on the AVA execution context.
 *
 * @param {import('ava').ExecutionContext} t
 * @param {string} label
 */
const prepareDaemonHost = async (t, label) => {
  const { reject: cancel, promise: cancelled } = makePromiseKit();
  // Sink the cancellation rejection; CapTP teardown attaches its
  // own .catch() to derivative promises but the root rejection still
  // needs a sink so SES does not flag it.
  cancelled.catch(() => {});
  const config = makeConfig(label);
  await purge(config);
  await start(config);
  t.teardown(async () => {
    await stop(config).catch(() => {});
    cancel(Error('teardown'));
    await fsp
      .rm(path.dirname(config.statePath), { force: true, recursive: true })
      .catch(() => {});
  });

  const { getBootstrap, closed } = await makeEndoClient(
    'client',
    config.sockPath,
    cancelled,
  );
  closed.catch(() => {});
  const bootstrap = getBootstrap();
  const host = E(bootstrap).host();
  return { host, config };
};

// ---------------------------------------------------------------------------
// Bundling discipline
// ---------------------------------------------------------------------------

test.serial(
  'familiar bundle step copies every lal/primer/ file into bundles/primer/',
  async t => {
    // Both directories must exist.
    t.true(
      fs.existsSync(sourcePrimer),
      'source packages/lal/primer/ is missing',
    );
    t.true(
      fs.existsSync(bundledPrimer),
      'bundled packages/familiar/bundles/primer/ is missing (run `yarn workspace @endo/familiar step:bundle`)',
    );

    await null;
    const sourceFiles = (await fsp.readdir(sourcePrimer)).sort();
    const bundledFiles = (await fsp.readdir(bundledPrimer)).sort();
    t.deepEqual(
      bundledFiles,
      sourceFiles,
      'bundled primer directory must contain exactly the same files as the source',
    );

    // Each file must round-trip byte-for-byte: no transform should
    // happen during the copy, otherwise readText() from the daemon
    // would surface different content in the packaged app than the
    // source primer's authors wrote.
    for (const name of sourceFiles) {
      // eslint-disable-next-line no-await-in-loop
      const sourceBytes = await fsp.readFile(path.join(sourcePrimer, name));
      // eslint-disable-next-line no-await-in-loop
      const bundledBytes = await fsp.readFile(path.join(bundledPrimer, name));
      const sourceHash = crypto
        .createHash('sha256')
        .update(sourceBytes)
        .digest('hex');
      const bundledHash = crypto
        .createHash('sha256')
        .update(bundledBytes)
        .digest('hex');
      t.is(
        bundledHash,
        sourceHash,
        `bundled primer file ${name} must be byte-identical to the source`,
      );
    }
  },
);

test.serial(
  'bundled primer contains the documents the agent loop references',
  async t => {
    // The lal agent's system prompt directs the LLM to read
    // README.md (overview), cli-reference.md, chat-reference.md, and
    // the howto-*.md scenario guides.  If any of these are not in
    // the bundle, the packaged app's first interaction with the
    // primer goes sideways.
    const required = [
      'README.md',
      'cli-reference.md',
      'chat-reference.md',
      'howto-capabilities.md',
      'howto-code.md',
      'howto-inventory.md',
      'howto-messaging.md',
    ];
    await null;
    for (const name of required) {
      // eslint-disable-next-line no-await-in-loop
      const stat = await fsp.stat(path.join(bundledPrimer, name));
      t.true(
        stat.isFile() && stat.size > 0,
        `bundled primer is missing or empty: ${name}`,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// Daemon round-trip: storeTree(makeLocalTree(bundledPrimer))
// ---------------------------------------------------------------------------

test.serial(
  'host can checkin the bundled primer via storeTree + makeLocalTree',
  async t => {
    const { host } = await prepareDaemonHost(t, 'host-checkin');

    // This is exactly what lal/agent.js's runManager() does at
    // startup with the bundled primer's path (since import.meta.url
    // in the bundled agent.js resolves to bundles/agent.js, the
    // sibling ./primer is bundles/primer).
    const localPrimerTree = makeLocalTree(bundledPrimer);
    await E(host).storeTree(localPrimerTree, 'lal-primer');

    // The host now resolves a readable tree at the pet name.
    const tree = await E(host).lookup(['lal-primer']);
    const names = await E(tree).list();
    const sourceNames = (await fsp.readdir(bundledPrimer)).sort();
    t.deepEqual(
      [...names].sort(),
      sourceNames,
      'host-side primer tree should list every bundled primer file',
    );

    // identify() returns a stable id we can pin to a sub-guest.
    const primerTreeId = await E(host).identify('lal-primer');
    t.true(
      typeof primerTreeId === 'string' && primerTreeId.length > 0,
      'identify() must return a non-empty formula identifier',
    );

    // Content round-trip via the daemon's content-addressed store.
    const readme = await E(tree).lookup('README.md');
    const readmeText = await E(readme).text();
    const sourceReadme = await fsp.readFile(
      path.join(bundledPrimer, 'README.md'),
      'utf8',
    );
    t.is(
      readmeText,
      sourceReadme,
      'primer README.md content must round-trip through the daemon CAS unchanged',
    );
  },
);

// ---------------------------------------------------------------------------
// provisionPrimer shape: sub-guest gets a `primer` reference
// ---------------------------------------------------------------------------

test.serial(
  'sub-guest receives the primer via storeIdentifier and can read it',
  async t => {
    const { host } = await prepareDaemonHost(t, 'guest-provision');

    // Step 1: host-side checkin of the bundled primer.
    const localPrimerTree = makeLocalTree(bundledPrimer);
    await E(host).storeTree(localPrimerTree, 'lal-primer');
    const primerTreeId = await E(host).identify('lal-primer');

    // Step 2: provision a sub-guest the way lal's manager loop does
    // when a form submission creates a new agent profile.
    const guest = await E(host).provideGuest('test-guest', {
      agentName: 'profile-for-test-guest',
    });

    // Step 3: mirror lal/agent.js provisionPrimer(): if the sub-guest
    // does not already have a `primer` pet name, plumb the host's
    // primer tree id into the guest's namespace under that name.
    const hasPrimer = await E(guest).has('primer');
    t.false(
      hasPrimer,
      'fresh sub-guest should not already have a primer reference',
    );
    await E(guest).storeIdentifier('primer', primerTreeId);

    // Step 4: the agent's worker loop calls
    // E(powers).lookup('primer') and then list()/readText() on the
    // returned capability.  Confirm both shapes work end-to-end.
    const primerFromGuest = await E(guest).lookup('primer');
    const guestSideNames = await E(primerFromGuest).list();
    const sourceNames = (await fsp.readdir(bundledPrimer)).sort();
    t.deepEqual(
      [...guestSideNames].sort(),
      sourceNames,
      'guest-side primer must list every bundled primer file',
    );

    // The README is what the system prompt explicitly tells the LLM
    // to read first; surface a useful failure message if its content
    // does not round-trip.
    const readme = await E(primerFromGuest).lookup('README.md');
    const readmeText = await E(readme).text();
    const sourceReadme = await fsp.readFile(
      path.join(bundledPrimer, 'README.md'),
      'utf8',
    );
    t.is(
      readmeText,
      sourceReadme,
      'guest-side primer README.md content must match the bundled source',
    );

    // The agent's primer-using tools (readText) take a path of the
    // shape ('primer', 'cli-reference.md').  Exercise it the way the
    // agent's `readText` tool would.
    const cliRef = await E(primerFromGuest).lookup('cli-reference.md');
    const cliRefText = /** @type {string} */ (await E(cliRef).text());
    t.true(
      typeof cliRefText === 'string' && cliRefText.length > 0,
      'cli-reference.md must be readable through the guest-side primer',
    );
  },
);
