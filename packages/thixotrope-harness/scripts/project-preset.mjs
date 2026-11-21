#!/usr/bin/env node
// @ts-check
/** Publish an operator-selected revision for the Thixotrope development preset. */
import './_init.mjs';
import { execFile } from 'node:child_process';
import { chmod, link, lstat, mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
// These modules read the SES globals installed by _init.mjs during evaluation.
const { E } = await import('@endo/far');
const { connectLocalControl } =
  await import('@endo/thixotrope/local-control.js');
const { makeNodePowers } = await import('@endo/thixotrope/node-powers.js');
const { bundleGuest } = await import('./bundle-guest.mjs');
const { guestRoot, loadProgramPieces, sessionEntry } =
  await import('./provision-steps.js');
const { steps: environmentSteps } =
  await import('./provision-steps/60-environments.js');
const { installGuestPrelude } = await import('./guest-prelude.js');
installGuestPrelude();
const { isDigestPin } =
  await import('../resources/environments/impl/images.js');

const run = promisify(execFile);
const presetName = 'Thixotrope development';
const { workspaceSeedLabel: markerLabel } =
  await import('../guest/lib/workspace-seed.js');
const instructions = [
  'You are developing the Thixotrope harness in your own persistent Git checkout at /workspace.',
  'On first use, run sh -c "cd /workspace && thix-selfdev-prepare" to install the locked Linux dependencies and build the worker boot bundles offline.',
  'Run package commands from /workspace/packages/thixotrope-harness. For example, run corepack yarn test test/unit/m5-w58-presets.test.js.',
  'Reproduce the issue with a focused test, edit the checkout and rerun the test. Return git diff HEAD for review. For a nested supervisor use a short private state directory under /home/node, where its staged Linux worker can execute.',
].join(' ');

/**
 * @param {string} state
 * @param {string} repo
 * @param {string} ref
 */
export const publishSource = async (state, repo, ref) => {
  const source = path.resolve(repo);
  const git = (.../** @type {string[]} */ args) => run('git', args);
  const commit = (
    await git(
      '-C',
      source,
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${ref}^{commit}`,
    )
  ).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw Error('Expected a full Git commit');
  await git(
    '-C',
    source,
    'cat-file',
    '-e',
    `${commit}:packages/thixotrope-harness/package.json`,
  );
  const dir = path.resolve(state, 'environments', 'projects', 'thixotrope');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = path.join(dir, `${commit}.bundle`);
  const scratch = await mkdtemp(path.join(dir, '.publish-'));
  // Verify in an empty object store. The source repository itself may satisfy
  // missing historical objects from a shallow or incremental bundle.
  const verify = async (/** @type {string} */ file) => {
    const heads = (await git('bundle', 'list-heads', file)).stdout.trim();
    if (heads !== `${commit} refs/heads/seed`)
      throw Error('Unexpected project bundle revision');
    const check = await mkdtemp(path.join(scratch, 'check-'));
    await git('init', '--quiet', '--bare', check);
    await git(
      '-C',
      check,
      'fetch',
      '--quiet',
      '--no-tags',
      file,
      'refs/heads/seed:refs/heads/seed',
    );
  };
  const seed = harden({ project: /** @type {const} */ ('thixotrope'), commit });
  try {
    const existing = await lstat(destination).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      if (!existing.isFile()) throw Error('Expected a regular project bundle');
      await verify(destination);
      return seed;
    }
    const objects = path.join(scratch, 'objects.git');
    const bundle = path.join(scratch, 'seed.bundle');
    await git(
      'clone',
      '--quiet',
      '--bare',
      '--shared',
      '--no-tags',
      '--',
      source,
      objects,
    );
    await git('-C', objects, 'update-ref', 'refs/heads/seed', commit);
    await git('-C', objects, 'bundle', 'create', bundle, 'refs/heads/seed');
    await verify(bundle);
    await chmod(bundle, 0o600);
    try {
      await link(bundle, destination);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'EEXIST')
        throw error;
      if (!(await lstat(destination)).isFile())
        throw Error('Expected a regular project bundle');
      await verify(destination);
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
  return seed;
};
harden(publishSource);

/**
 * @param {any} catalog
 * @param {any} admin
 * @param {Awaited<ReturnType<typeof publishSource>>} seed
 * @param {boolean} legacy
 */
const savePreset = async (catalog, admin, seed, legacy) => {
  const { revision, presets } = await E(catalog).configuration();
  const views = await Promise.all(
    presets.map(/** @param {any} p */ p => E(p).describe()),
  );
  const matches = views.flatMap((v, i) => (v.label === presetName ? [i] : []));
  if (matches.length > 1)
    throw Error('Multiple presets have the project preset name');
  const preset = presets[matches[0]];
  const prior = views[matches[0]];
  const endowments = prior?.endowments ?? [];
  const marker = endowments.find(
    /** @param {any} x */ x => x.label === markerLabel,
  );
  const previousSeed =
    prior?.workspaceSeed ?? (marker && (await E(marker.value).describe()));
  if (
    prior &&
    (prior.template !== 'development' || previousSeed?.project !== seed.project)
  )
    throw Error('The project preset name is already in use');
  if (previousSeed?.commit === seed.commit && Boolean(marker) === legacy) {
    if (!prior.available) throw Error(prior.unavailableReason);
    return;
  }
  const managedEndowments = endowments.filter(
    /** @param {any} x */ x => x.label !== markerLabel,
  );
  if (legacy)
    managedEndowments.push({
      label: markerLabel,
      value: await E(admin).makeWorkspaceSeed(seed),
    });
  const record = harden({
    label: presetName,
    template: 'development',
    description:
      prior?.description ??
      'Develop and test Thixotrope in a private checkout of the configured project revision.',
    instructions: prior?.instructions ?? instructions,
    networkPolicy: prior?.networkPolicy ?? 'off',
    objects: prior?.objects ?? [
      { kind: 'git-workspace', label: 'workspace' },
      { kind: 'development-environment', label: 'shell' },
    ],
    endowments: managedEndowments,
    ...(legacy ? {} : { workspaceSeed: seed }),
    ...(prior?.backend && { backend: prior.backend }),
    ...(prior?.modelId && { modelId: prior.modelId }),
    ...(prior?.reasoningEffort && { reasoningEffort: prior.reasoningEffort }),
  });
  let saved = preset;
  if (saved) await E(saved).save(record, revision);
  else ({ preset: saved } = await E(catalog).create(record, revision));
  const view = await E(saved).describe();
  if (!view.available) throw Error(view.unavailableReason);
  const actual = legacy
    ? await E(
        view.endowments.find(/** @param {any} x */ x => x.label === markerLabel)
          .value,
      ).describe()
    : view.workspaceSeed;
  if (actual?.commit !== seed.commit)
    throw Error('Factory did not retain the project revision');
};

/** @param {string[]} argv */
const main = async argv => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      ref: { type: 'string', default: 'HEAD' },
      image: { type: 'string' },
      runtime: { type: 'string', default: 'docker' },
      workspace: { type: 'string', default: 'w' },
      'legacy-factory': { type: 'boolean' },
      'replace-runner': { type: 'boolean' },
    },
  });
  const { image, repo, runtime } = values;
  if (
    positionals.length !== 1 ||
    !repo ||
    !image ||
    !isDigestPin(image) ||
    !['docker', 'podman'].includes(runtime)
  )
    throw Error(
      'Usage: project-preset.mjs STATE --repo REPO --image NAME@sha256:DIGEST [--ref REF] [--runtime docker|podman] [--workspace w] [--legacy-factory] [--replace-runner]',
    );
  await run(runtime, ['image', 'inspect', '--format', '{{.Id}}', image]);
  const state = path.resolve(positionals[0]);
  const seed = await publishSource(state, repo, values.ref);
  const client = await connectLocalControl(
    makeNodePowers(),
    path.join(state, 'control.sock'),
    { workspace: values.workspace },
  );
  try {
    const root = await client.call('lookup', 'harness');
    if (!root) throw Error('Provision the harness workspace first');
    const context = {
      client,
      options: {
        sessionEntry,
        environments: {
          runtime,
          image,
          allowedCommands: ['sh', 'git', 'node', 'corepack'],
        },
      },
    };
    const [install, configure, attach] = environmentSteps;
    await install.run(context);
    const admin = await client.call('lookup', 'environmentsAdmin');
    const current = await E(admin).getSettings();
    if (current) {
      if (
        (current.image !== image ||
          current.runtime !== runtime ||
          !current.allowedCommands.includes('sh')) &&
        !values['replace-runner']
      )
        throw Error(
          'The existing runner configuration differs. Use --replace-runner to change its image, runtime or shell access.',
        );
      context.options.environments = {
        ...current,
        runtime,
        image,
        allowedCommands: [...new Set([...current.allowedCommands, 'sh'])],
      };
    }
    const ready = await configure.run(context);
    if (ready.detail?.state !== 'ready')
      throw Error(
        String(ready.detail?.error ?? 'Environment runner is unavailable'),
      );
    // Older installed factories accept a source marker as a preset endowment.
    // Load the session program that consumes it before advertising this preset.
    if (values['legacy-factory']) {
      const bundle = await bundleGuest(sessionEntry, { guestRoot });
      if ((await E(root).status()).program?.digest !== bundle.digest)
        await loadProgramPieces(root, bundle, 'session');
    }
    await attach.run(context);
    const operator = await E(root).getOperator();
    await savePreset(
      await E(operator).getPresets(),
      admin,
      seed,
      !!values['legacy-factory'],
    );
    process.stdout.write(`${presetName} ready at ${seed.commit}\n`);
  } finally {
    client.close();
  }
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`project-preset: ${error.message}\n`);
    process.exitCode = 1;
  });
}
