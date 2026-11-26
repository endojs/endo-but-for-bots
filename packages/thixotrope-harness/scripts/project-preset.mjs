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
const { handBackExec, handBackFetch } = await import('./handback.js');
const { installGuestPrelude } = await import('./guest-prelude.js');
installGuestPrelude();
const { subagentRoleHeading: roleHeading } =
  // eslint-disable-next-line import/no-relative-packages -- the session program's own heading
  await import('../guest/lib/mail-prompt.js');
const { isDigestPin } =
  await import('../resources/environments/impl/images.js');

const run = promisify(execFile);
const presetName = 'Thixotrope development';
/** The project of the published seed (`publishSource`). */
const projectName = /** @type {const} */ ('thixotrope');
const { workspaceSeedLabel: markerLabel } =
  // eslint-disable-next-line import/no-relative-packages -- shared with the private guest preset contract
  await import('../guest/lib/workspace-seed.js');
const workflowLines = [
  'You are developing the Thixotrope harness in your own persistent Git checkout at /workspace.',
  'On first use, run sh -c "cd /workspace && thix-selfdev-prepare" to install the locked Linux dependencies and build the worker boot bundles offline.',
  'Run package commands from /workspace/packages/thixotrope-harness. For example, run corepack yarn test test/unit/m5-w58-presets.test.js.',
];
const projectWorkflow = [
  ...workflowLines,
  'Reproduce the issue with a focused test, edit the checkout, rerun the test and commit.',
].join(' ');
const scratchInstructionsV1 =
  'For nested integration tests set THIX_HARNESS_TMP=/tmp/thix. For a separate supervisor create a short private state directory on that same Linux scratch mount.';
// serve.mjs refuses a new state under /tmp without --allow-tmp-state.
const scratchInstructions =
  'For nested integration tests set THIX_HARNESS_TMP=/tmp/thix. For a separate supervisor create a short private state directory on that same Linux scratch mount and pass --allow-tmp-state to scripts/serve.mjs.';
const coldBuild =
  "For the first thix-selfdev-prepare command, set the shell tool's timeoutMs to 600000 (10 minutes) for the cold build.";
const operational = `${projectWorkflow} ${coldBuild} ${scratchInstructions}`;
const operationalV2 = `${projectWorkflow} ${coldBuild} ${scratchInstructionsV1}`;
/** The model a project manager session delegates implementation to. */
export const implementerModel = 'claude-opus-5-5';
/**
 * The heading of the session program's section for a subagent
 * (`guest/lib/mail-prompt.js` `subagentRoleSection`), which the roles below
 * key on. The section adds no limit on spawning: the roles below say an
 * implementer spawns none unless its brief asks.
 */
export const subagentRoleHeading = roleHeading;
// The two roles share this one text: a subagent spawned without a
// systemPrompt is composed from its parent's preset snapshot (factory
// `create`), and a given systemPrompt replaces the whole composition. The
// role is told apart structurally: the session program adds its "Subagent
// role" section to a subagent's prompt (userInitiated false).
const roles = [
  `Roles. If this prompt has a "${subagentRoleHeading}" section, or your task begins with "You are the implementer", you are the implementer: do the task yourself in your own /workspace checkout as below and hand it back as below; spawn no subagents unless the brief asks for it.`,
  `Otherwise you are the project manager and quality-control master: plan the work and delegate all implementation, even small changes, to subagents (for you this replaces the general advice to do simple work yourself); review, test and report yourself. Spawn each with spawnSubagent { name, modelId: "${implementerModel}", attachments: [{ name: "parent-shell", petName: "shell" }] } and no systemPrompt, which would replace these instructions. If spawnSubagent offers no modelId or refuses it, spawn without it: the child runs on your model. A child sees none of your conversation: begin its askSubagent brief with "You are the implementer for this task." and give the goal, files, constraints, tests to run and when to stop.`,
].join(' ');
// The hand-back goes through the parent's shell, not an exec-published
// object: a parent exec deadline retires everything published in its exec
// scope (scripts/handback.js).
const handBack = [
  'Hand-back. A child has its own checkout and an answer is cut at about 31,000 characters, so the child writes its commits as a git bundle into your checkout through your shell, attached as parent-shell.',
  `The implementer commits, then runs this exec code unchanged, and again unchanged if it runs out of time (it resumes): ${handBackExec} It returns "handed back COMMIT" or "no commits"; answer with that line, your commits, git diff --stat, the commands run with results, and what you could not do.`,
  `You then run runCommand sh ["-c", "${handBackFetch}", "sh", "COMMIT", "NAME"] with the child's name as NAME (if it fails, have the child run the code again), read git diff main...NAME, merge in exec with E(workspace).merge("NAME", { mode: "merge-commit", message: "Merge NAME" }) (resolve and commit any conflicts it returns), run the tests, and send it back with fixes when it falls short; its next hand-back merges the same way.`,
  'Stop each child when its work is accepted, and report what you verified and how, and what remains unverified.',
].join(' ');
const rolesV2 = [
  `Roles. If this prompt has a "${subagentRoleHeading}" section, or your task begins with "You are the implementer", you are the implementer: do the task yourself in your own /workspace checkout as below and hand it back as below; spawn no subagents unless the brief asks for it.`,
  `Otherwise you are the project manager and quality-control master: plan the work and delegate all implementation, even small changes, to subagents (for you this replaces the general advice to do simple work yourself); review, test and report yourself. Spawn each with spawnSubagent { name, modelId: "${implementerModel}", attachments: [{ name: "handback", petName: "handback-NAME" }] } and no systemPrompt, which would replace these instructions. If spawnSubagent offers no modelId or refuses it, spawn without it: the child runs on your model. A child sees none of your conversation: begin its askSubagent brief with "You are the implementer for this task." and give the goal, files, constraints, tests to run and when to stop.`,
].join(' ');
const handBackV2 = [
  'Hand-back. A child has its own checkout of the seed commit that you cannot fetch from, and an answer is cut at about 31,000 characters, so its commits come back as a git bundle through a drop box.',
  'Before each spawn, in exec: let p = []; await powers.publish("handback-NAME", { clear() { p = []; return 0; }, put(s) { p.push(s); return p.length; }, count() { return p.length; }, piece(i) { return p[i]; } }).',
  // eslint-disable-next-line no-template-curly-in-string -- exec code the model runs
  'The implementer commits, then in exec: const sh = await E(powers).lookup("shell"), box = await E(powers).lookup("handback"); const run = c => E(sh).runCommand("sh", ["-c", c]); const n = Number((await run("git bundle create .git/hb.bundle $(git reflog --format=%H HEAD | tail -n 1)..HEAD && base64 -w0 .git/hb.bundle > .git/hb && wc -c < .git/hb")).stdout); await E(box).clear(); for (let i = 0; i < n; i += 2000) await E(box).put((await run(`cut -c ${i + 1}-${i + 2000} .git/hb`)).stdout.trim()); then answers with its commits, git diff --stat, the commands run with results, and what it could not do.',
  'You then, in exec, remove .git/NAME.b64 and append to it each E(box).piece(i) for i below E(box).count() with E(shell).runCommand("sh", ["-c", "printf %s \\"$1\\" >> .git/NAME.b64", "sh", piece]), run base64 -d .git/NAME.b64 > .git/NAME.bundle && git fetch .git/NAME.bundle HEAD:NAME, read git diff main...NAME, run the tests, and merge with E(workspace).merge("NAME"); send it back with fixes when it falls short.',
  'If an exec call runs out of time, rerun it from i = 2000 * E(box).count(). Stop each child when its work is accepted, and report what you verified and how, and what remains unverified.',
].join(' ');
const instructions = `${roles} ${handBack} ${operational}`;

// Our earlier published defaults, upgraded on a republish; any other text
// is the operator's and is kept unless --replace-instructions is given.
const workflowV1 = [
  ...workflowLines,
  'Reproduce the issue with a focused test, edit the checkout and rerun the test. Return git diff HEAD for review.',
].join(' ');
const operationalV1 = `${workflowV1} ${coldBuild} ${scratchInstructionsV1}`;
// Published by 603845d2a (the first delegating default).
const delegationV1 = [
  'Roles. If your task came from a parent session through askSubagent, you are its implementer: do the work yourself in your own /workspace checkout as described below, commit it, and answer with the commit hashes, git diff HEAD, the commands you ran with their results, and what you could not do. Do not spawn subagents of your own unless the brief asks for it or the work truly needs it.',
  `Otherwise you are the project manager and quality-control master for the work you are given. Do not implement it yourself: plan it, then delegate each piece to an Opus 5.5 subagent with spawnSubagent { name, modelId: "${implementerModel}" } and no systemPrompt, so the child keeps these instructions (a systemPrompt would replace them). Give each a self-contained brief in askSubagent: it sees none of your conversation, so state the goal, the files, the constraints, the tests to run and when to stop, and begin with "You are the implementer for this task."`,
  "Pass a subagent's work on only after checking it: read its diff, run the relevant tests yourself, and send it back with concrete fixes when it falls short. Stop each subagent when its work is accepted. Report faithfully what was done, what you verified and how, and what remains unverified or failed.",
].join(' ');
const earlierInstructions = harden([
  ...[
    'Use a separate short /tmp state path for nested supervisors.',
    'For a nested supervisor use a short private state directory under /home/node, where its staged Linux worker can execute.',
    scratchInstructionsV1,
  ].map(suffix => `${workflowV1} ${suffix}`),
  operationalV1,
  `${delegationV1} ${operationalV1}`,
  // Round 3: the exec-scope drop box.
  `${rolesV2} ${handBackV2} ${operationalV2}`,
  // Round 4: the hand-back through the parent shell, before serve.mjs
  // refused a new /tmp state without --allow-tmp-state.
  `${roles} ${handBack} ${operationalV2}`,
]);

/**
 * What the prior preset text is: none, the current default, one of our
 * earlier defaults, or the operator's own.
 * @param {string | undefined} prior
 * @returns {'absent' | 'current' | 'earlier' | 'edited'}
 */
export const instructionsKind = prior => {
  if (prior === undefined) return 'absent';
  if (prior === instructions) return 'current';
  return earlierInstructions.includes(prior) ? 'earlier' : 'edited';
};
harden(instructionsKind);

/**
 * The instructions to save: the current default unless the prior text is
 * the operator's own, which is kept unless `replace` is given.
 * @param {string | undefined} prior
 * @param {{ replace?: boolean }} [options]
 */
export const projectInstructions = (prior, { replace = false } = {}) =>
  replace || instructionsKind(prior) !== 'edited'
    ? instructions
    : /** @type {string} */ (prior);
harden(projectInstructions);

/** The note for kept operator-edited instructions (or none). */
export const editedInstructionsNote =
  "the preset's instructions differ from every default this script published, so they are kept as the operator's edit and the current default (project manager and implementer roles, hand-back through the parent shell) is not applied; give --replace-instructions to replace them";

/** The defaults of a preset that has no backend of its own. */
export const presetDefaults = harden({
  backendKind: 'claude-pool',
  modelId: 'claude-fable-5-2',
  reasoningEffort: 'medium',
});

/** Catalogue pages read at most to find a model. */
const MODEL_PAGES = 20;

/**
 * The Backend among `backends` (the factory's `listBackends()`) that `name`
 * names, by label or else by kind (`claude-pool`), and by the default kind
 * when no name is given. Objects, not names: the answer is the factory's
 * own Backend object, and the preset saves that object.
 * @param {readonly any[]} backends
 * @param {string} [name]
 */
export const resolveBackend = async (backends, name) => {
  const views = await Promise.all(backends.map(b => E(b).describe()));
  /** @param {(view: any) => boolean} test */
  const indexes = test => views.flatMap((v, i) => (test(v) ? [i] : []));
  const byLabel = name === undefined ? [] : indexes(v => v.label === name);
  const kind = name ?? presetDefaults.backendKind;
  const wanted = byLabel.length > 0 ? byLabel : indexes(v => v.kind === kind);
  const what =
    byLabel.length > 0
      ? `labelled ${JSON.stringify(name)}`
      : name === undefined
        ? `of kind ${kind}`
        : `labelled or of kind ${JSON.stringify(name)}`;
  const known = views.map(v => `${v.label} (${v.kind})`).join(', ') || 'none';
  if (wanted.length === 0)
    throw Error(`No backend ${what}; the factory offers: ${known}`);
  if (wanted.length > 1)
    throw Error(
      `${wanted.length} backends are ${what}; name one with --backend LABEL (the factory offers: ${known})`,
    );
  return { backend: backends[wanted[0]], view: views[wanted[0]] };
};
harden(resolveBackend);

/**
 * A model's catalogue row on `backend`, or undefined.
 * @param {any} backend
 * @param {string} modelId
 */
const modelRow = async (backend, modelId) => {
  /** @type {string | undefined} */
  let after;
  for (let page = 0; page < MODEL_PAGES; page += 1) {
    const answer = await E(backend).listModels(
      harden(after === undefined ? { limit: 50 } : { after, limit: 50 }),
    );
    if (answer.state !== 'ok')
      throw Error(
        `The backend's model catalogue is ${answer.state}${answer.error ? `: ${answer.error}` : ''}`,
      );
    const row = answer.rows.find(
      (/** @type {any} */ r) => r.modelId === modelId,
    );
    if (row || answer.next === undefined) return row;
    after = answer.next;
  }
  return undefined;
};

/**
 * The refusal or note for an effort the model's catalogue row does not
 * start at. A row with no efforts at all, for a model the efforts table
 * should know, means the running agent-host adapter has an older table:
 * it is loaded from the source tree whenever the adapter process starts
 * (an adapter reload; a supervisor restart is one)
 * (`resources/agent-host/impl/subscriptions/messages.js` `claudeEfforts`).
 * @param {string} modelId
 * @param {any} row
 * @param {string} effort
 */
export const effortMismatch = (modelId, row, effort) => {
  const efforts = row.reasoningEfforts ?? [];
  if (efforts.length === 0)
    return `${modelId} has no reasoning efforts in the running agent-host's model catalogue, so it cannot be checked at ${effort}. If the model takes efforts, the running agent-host adapter has a stale efforts table: reload the adapter (a supervisor restart does) on a tree that has the fix, then publish again`;
  return `${modelId} starts sessions at reasoning effort ${row.defaultReasoningEffort ?? 'none'}, not ${effort} (offered: ${efforts.join(', ')}); presets carry no effort, so pick it per session`;
};
harden(effortMismatch);

/** The note when the state has no Claude pool and no backend was named. */
export const noPoolNote = `the factory has no ${presetDefaults.backendKind} backend, so the preset names no backend or model and sessions use the factory defaults; give --backend LABEL to choose one`;

/**
 * The backend and model the preset saves, and notes for the operator.
 * With no option the prior preset's backend and model are kept (operator
 * edits survive a republish); a preset without a backend gets the defaults
 * (none, with a note, when the factory has no Claude pool); an option
 * replaces the saved value. A model chosen here is checked in the
 * backend's catalogue. Reads only: nothing is changed here.
 *
 * Presets carry no reasoning effort (J-13015: the catalogue ignores one), so
 * an effort is checked, not saved: a session on the model starts at the
 * pool's default effort, which must be the requested one. An explicit
 * `effort` that is not the default fails; the implied default only warns.
 * @param {{ backend?: any, modelId?: string } | undefined} prior
 * @param {{ backends: readonly any[], backend?: string, modelId?: string, reasoningEffort?: string }} choice
 * @returns {Promise<{ backend: any, modelId: string | undefined, notes: readonly string[] }>}
 */
export const choosePresetModel = async (prior, choice) => {
  /** @type {string[]} */
  const notes = [];
  const keep = choice.backend === undefined && prior?.backend !== undefined;
  if (!keep && choice.backend === undefined) {
    const views = await Promise.all(choice.backends.map(b => E(b).describe()));
    if (!views.some(v => v.kind === presetDefaults.backendKind)) {
      if (choice.modelId !== undefined || choice.reasoningEffort !== undefined)
        throw Error(
          `--model and --effort need a backend: the factory has no ${presetDefaults.backendKind} backend, so give --backend LABEL`,
        );
      notes.push(noPoolNote);
      return harden({ backend: undefined, modelId: undefined, notes });
    }
  }
  const { backend, view } = keep
    ? {
        backend: prior?.backend,
        view: await E(prior?.backend)
          .describe()
          .catch(() => undefined),
      }
    : await resolveBackend(choice.backends, choice.backend);
  const sameBackend = backend === prior?.backend;
  const defaultKind = view?.kind === presetDefaults.backendKind;
  const modelId =
    choice.modelId ??
    (sameBackend
      ? prior?.modelId
      : defaultKind
        ? presetDefaults.modelId
        : undefined);
  const chosen = modelId !== undefined && modelId !== prior?.modelId;
  const effort =
    choice.reasoningEffort ??
    (chosen && defaultKind ? presetDefaults.reasoningEffort : undefined);
  if (modelId === undefined) {
    if (choice.reasoningEffort !== undefined)
      throw Error('--effort needs a model: give --model too');
    return harden({ backend, modelId: undefined, notes });
  }
  if (chosen || effort !== undefined) {
    const row = await modelRow(backend, modelId);
    if (row === undefined)
      throw Error(
        `Model ${JSON.stringify(modelId)} is not in the backend's catalogue`,
      );
    if (effort !== undefined && row.defaultReasoningEffort !== effort) {
      const text = effortMismatch(modelId, row, effort);
      if (choice.reasoningEffort !== undefined) throw Error(text);
      notes.push(text);
    }
  }
  return harden({ backend, modelId, notes });
};
harden(choosePresetModel);

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
  const dir = path.resolve(state, 'environments', 'projects', projectName);
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
  const seed = harden({ project: projectName, commit });
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
 * @typedef {object} PresetOptions
 * @property {boolean} [replaceInstructions] replace operator-edited
 *   instructions with the current default
 */

/**
 * What a publish would save, read and checked before anything changes: the
 * project preset (if any), its instructions, backend and model, and notes
 * for the operator. Refusals (a taken name, an unknown backend or model, a
 * wrong effort) come from here, so `main` runs it before any mutating step.
 * @param {any} catalog
 * @param {string} project the seed's project
 * @param {Parameters<typeof choosePresetModel>[1]} [choice] absent: the
 *   prior backend and model are kept as they are
 * @param {PresetOptions} [options]
 */
export const planPreset = async (
  catalog,
  project,
  choice,
  { replaceInstructions = false } = {},
) => {
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
    (prior.template !== 'development' || previousSeed?.project !== project)
  )
    throw Error('The project preset name is already in use');
  const kind = instructionsKind(prior?.instructions);
  const prompt = projectInstructions(prior?.instructions, {
    replace: replaceInstructions,
  });
  const { backend, modelId, notes } =
    choice === undefined
      ? { backend: prior?.backend, modelId: prior?.modelId, notes: [] }
      : await choosePresetModel(prior, choice);
  return harden({
    revision,
    preset,
    prior,
    endowments,
    marker,
    previousSeed,
    prompt,
    backend,
    modelId,
    notes: [
      ...(kind === 'edited' && !replaceInstructions
        ? [editedInstructionsNote]
        : []),
      ...(kind === 'edited' && replaceInstructions
        ? [
            "the operator's edited instructions are replaced by the current default",
          ]
        : []),
      ...notes,
    ],
  });
};
harden(planPreset);

/**
 * @param {any} catalog
 * @param {any} admin
 * @param {Awaited<ReturnType<typeof publishSource>>} seed
 * @param {boolean} legacy
 * @param {Parameters<typeof choosePresetModel>[1]} [choice] absent: the
 *   prior backend and model are kept as they are
 * @param {PresetOptions} [options]
 * @returns {Promise<{ notes: readonly string[] }>}
 */
export const savePreset = async (
  catalog,
  admin,
  seed,
  legacy,
  choice,
  options,
) => {
  const {
    revision,
    preset,
    prior,
    endowments,
    marker,
    previousSeed,
    prompt,
    backend,
    modelId,
    notes,
  } = await planPreset(catalog, seed.project, choice, options);
  if (
    previousSeed?.commit === seed.commit &&
    Boolean(marker) === legacy &&
    prior.reasoningEffort === undefined &&
    prior.instructions === prompt &&
    prior.backend === backend &&
    prior.modelId === modelId
  ) {
    if (!prior.available) throw Error(prior.unavailableReason);
    return harden({ notes });
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
    instructions: prompt,
    networkPolicy: prior?.networkPolicy ?? 'off',
    objects: prior?.objects ?? [
      { kind: 'git-workspace', label: 'workspace' },
      { kind: 'development-environment', label: 'shell' },
    ],
    endowments: managedEndowments,
    ...(legacy ? {} : { workspaceSeed: seed }),
    ...(backend && { backend }),
    ...(modelId && { modelId }),
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
  if (view.backend !== backend || view.modelId !== modelId)
    throw Error('Factory did not retain the preset backend and model');
  return harden({ notes });
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
      backend: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      'replace-instructions': { type: 'boolean' },
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
      'Usage: project-preset.mjs STATE --repo REPO --image NAME@sha256:DIGEST [--ref REF] [--runtime docker|podman] [--workspace w] [--legacy-factory] [--replace-runner] [--backend LABEL] [--model ID] [--effort LEVEL] [--replace-instructions]',
    );
  await run(runtime, ['image', 'inspect', '--format', '{{.Id}}', image]);
  const state = path.resolve(positionals[0]);
  const client = await connectLocalControl(
    makeNodePowers(),
    path.join(state, 'control.sock'),
    { workspace: values.workspace },
  );
  try {
    const root = await client.call('lookup', 'harness');
    if (!root) throw Error('Provision the harness workspace first');
    const operator = await E(root).getOperator();
    const factory = await E(operator).getFactory();
    const catalog = await E(operator).getPresets();
    const choice = harden({
      backends: await E(factory).listBackends(),
      ...(values.backend === undefined ? {} : { backend: values.backend }),
      ...(values.model === undefined ? {} : { modelId: values.model }),
      ...(values.effort === undefined
        ? {}
        : { reasoningEffort: values.effort }),
    });
    const presetOptions = harden({
      replaceInstructions: !!values['replace-instructions'],
    });
    // Resolve and check the preset (name, backend, model, effort) before
    // any step that changes the state: the environment install and
    // configuration, and the session program load that retires spares.
    const plan = await planPreset(catalog, projectName, choice, presetOptions);
    for (const note of plan.notes)
      process.stderr.write(`project-preset: ${note}\n`);
    const seed = await publishSource(state, repo, values.ref);
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
    await savePreset(
      catalog,
      admin,
      seed,
      !!values['legacy-factory'],
      choice,
      presetOptions,
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
