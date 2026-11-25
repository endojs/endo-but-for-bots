// @ts-check
import test from 'ava';
import { execFile } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  choosePresetModel,
  editedInstructionsNote,
  implementerModel,
  instructionsKind,
  noPoolNote,
  planPreset,
  presetDefaults,
  projectInstructions,
  publishSource,
  resolveBackend,
  savePreset,
  subagentRoleHeading,
} from '../../scripts/project-preset.mjs';
import { handBackExec, handBackFetch } from '../../scripts/handback.js';

const git = promisify(execFile);

test('publishing pins committed source, leaves the operator checkout alone, and rejects damaged bundles', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'thix-publish-'));
  t.teardown(() => rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo');
  const state = path.join(dir, 'state');
  const pkg = path.join(repo, 'packages', 'thixotrope-harness');
  await mkdir(pkg, { recursive: true });
  await git('git', ['init', '-q', '-b', 'main', repo]);
  await writeFile(path.join(pkg, 'package.json'), '{}\n');
  await git('git', ['-C', repo, 'add', 'packages']);
  await git('git', [
    '-C',
    repo,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-qm',
    'baseline',
  ]);
  await writeFile(path.join(pkg, 'package.json'), '{"dirty":true}\n');
  const [a, b] = await Promise.all([
    publishSource(state, repo, 'HEAD'),
    publishSource(state, repo, 'main'),
  ]);
  t.deepEqual(a, b);
  t.is(
    (
      await git('git', ['-C', repo, 'for-each-ref', '--format=%(refname)'])
    ).stdout.trim(),
    'refs/heads/main',
  );
  t.is(
    await readFile(path.join(pkg, 'package.json'), 'utf8'),
    '{"dirty":true}\n',
  );
  const bundles = path.join(state, 'environments', 'projects', a.project);
  const bundle = path.join(bundles, `${a.commit}.bundle`);
  t.deepEqual(await readdir(bundles), [`${a.commit}.bundle`]);
  const check = path.join(dir, 'checkout');
  await git('git', ['clone', '--quiet', '--branch', 'seed', bundle, check]);
  t.is(
    await readFile(
      path.join(check, 'packages', 'thixotrope-harness', 'package.json'),
      'utf8',
    ),
    '{}\n',
  );
  const original = await readFile(bundle);
  await writeFile(bundle, original.subarray(0, original.length - 12));
  await t.throwsAsync(publishSource(state, repo, 'HEAD'));
});

test('all published defaults upgrade to the current one; an operator edit is kept with a note, or replaced on request', async t => {
  const workflow = [
    'You are developing the Thixotrope harness in your own persistent Git checkout at /workspace.',
    'On first use, run sh -c "cd /workspace && thix-selfdev-prepare" to install the locked Linux dependencies and build the worker boot bundles offline.',
    'Run package commands from /workspace/packages/thixotrope-harness. For example, run corepack yarn test test/unit/m5-w58-presets.test.js.',
    'Reproduce the issue with a focused test, edit the checkout and rerun the test. Return git diff HEAD for review.',
  ].join(' ');
  const current = projectInstructions(undefined);
  t.regex(current, /first thix-selfdev-prepare command.*timeoutMs to 600000/);
  t.is(projectInstructions(current), current);
  t.is(instructionsKind(current), 'current');
  t.is(instructionsKind(undefined), 'absent');
  const operational = `${workflow} For the first thix-selfdev-prepare command, set the shell tool's timeoutMs to 600000 (10 minutes) for the cold build. For nested integration tests set THIX_HARNESS_TMP=/tmp/thix. For a separate supervisor create a short private state directory on that same Linux scratch mount.`;
  t.is(
    projectInstructions(operational),
    current,
    'the cold-build default upgrades',
  );
  // The first delegating default (603845d2a), word for word.
  const delegating = `${[
    'Roles. If your task came from a parent session through askSubagent, you are its implementer: do the work yourself in your own /workspace checkout as described below, commit it, and answer with the commit hashes, git diff HEAD, the commands you ran with their results, and what you could not do. Do not spawn subagents of your own unless the brief asks for it or the work truly needs it.',
    'Otherwise you are the project manager and quality-control master for the work you are given. Do not implement it yourself: plan it, then delegate each piece to an Opus 5.5 subagent with spawnSubagent { name, modelId: "claude-opus-5-5" } and no systemPrompt, so the child keeps these instructions (a systemPrompt would replace them). Give each a self-contained brief in askSubagent: it sees none of your conversation, so state the goal, the files, the constraints, the tests to run and when to stop, and begin with "You are the implementer for this task."',
    "Pass a subagent's work on only after checking it: read its diff, run the relevant tests yourself, and send it back with concrete fixes when it falls short. Stop each subagent when its work is accepted. Report faithfully what was done, what you verified and how, and what remains unverified or failed.",
  ].join(' ')} ${operational}`;
  t.is(instructionsKind(delegating), 'earlier');
  t.is(
    projectInstructions(delegating),
    current,
    'the delegating default upgrades',
  );
  t.is(projectInstructions(`${operational} Mine.`), `${operational} Mine.`);
  for (const suffix of [
    'Use a separate short /tmp state path for nested supervisors.',
    'For a nested supervisor use a short private state directory under /home/node, where its staged Linux worker can execute.',
    'For nested integration tests set THIX_HARNESS_TMP=/tmp/thix. For a separate supervisor create a short private state directory on that same Linux scratch mount.',
  ]) {
    const old = `${workflow} ${suffix}`;
    t.is(projectInstructions(old), current);
    const customized = `${old} Run my local checks.`;
    t.is(instructionsKind(customized), 'edited');
    t.is(projectInstructions(customized), customized);
    t.is(projectInstructions(customized, { replace: true }), current);
  }
  t.is(projectInstructions(''), '');
  t.is(projectInstructions('', { replace: true }), current);

  // The plan says so: a note for a kept edit, another for a replaced one.
  /** @type {Record<string, any>} */
  let view = {
    label: 'Thixotrope development',
    template: 'development',
    workspaceSeed: { project: 'thixotrope', commit: 'ef'.repeat(20) },
    available: true,
    instructions: 'Operator text',
  };
  const catalog = {
    configuration: () => ({ presets: [{ describe: () => view }], revision: 0 }),
  };
  const kept = await planPreset(catalog, 'thixotrope');
  t.is(kept.prompt, 'Operator text');
  t.deepEqual(kept.notes, [editedInstructionsNote]);
  t.regex(editedInstructionsNote, /--replace-instructions/);
  const replaced = await planPreset(catalog, 'thixotrope', undefined, {
    replaceInstructions: true,
  });
  t.is(replaced.prompt, current);
  t.deepEqual(replaced.notes, [
    "the operator's edited instructions are replaced by the current default",
  ]);
  view = { ...view, instructions: delegating };
  t.deepEqual(
    (await planPreset(catalog, 'thixotrope')).notes,
    [],
    'an earlier default is no edit',
  );
});

test('refreshing the same project commit removes legacy effort once', async t => {
  const seed = /** @type {const} */ ({
    project: 'thixotrope',
    commit: 'ab'.repeat(20),
  });
  /** @type {Record<string, any>} */
  let view = {
    label: 'Thixotrope development',
    template: 'development',
    workspaceSeed: seed,
    available: true,
    instructions: 'Custom instructions',
    modelId: 'custom-model',
    reasoningEffort: 'old',
  };
  let saves = 0;
  const preset = {
    describe: () => view,
    save: (/** @type {object} */ record) => {
      saves += 1;
      view = { ...record, available: true };
    },
  };
  const catalog = {
    configuration: () => ({ presets: [preset], revision: saves }),
  };
  await savePreset(catalog, {}, seed, false);
  await savePreset(catalog, {}, seed, false);
  t.is(saves, 1);
  t.false('reasoningEffort' in view);
  t.is(view.instructions, 'Custom instructions');
  t.is(view.modelId, 'custom-model');
});

test('the default instructions key the roles on the subagent section, fall back on an older factory, and hand commits back through the parent shell', t => {
  const text = projectInstructions(undefined);
  t.is(implementerModel, 'claude-opus-5-5');
  t.is(subagentRoleHeading, 'Subagent role');
  t.regex(text, /If this prompt has a "Subagent role" section/);
  t.regex(
    text,
    /Otherwise you are the project manager and quality-control master/,
  );
  t.regex(text, /replaces the general advice to do simple work yourself/);
  t.regex(
    text,
    /spawnSubagent \{ name, modelId: "claude-opus-5-5", attachments: \[\{ name: "parent-shell", petName: "shell" \}\] \} and no systemPrompt/,
  );
  t.regex(text, /offers no modelId or refuses it, spawn without it/);
  t.regex(text, /begin its askSubagent brief with "You are the implementer/);
  t.regex(text, /spawn no subagents unless the brief asks for it/);
  t.false(text.includes('git diff HEAD'), 'empty after a commit');
  for (const kept of [
    '/workspace',
    'thix-selfdev-prepare',
    'timeoutMs to 600000',
    'THIX_HARNESS_TMP=/tmp/thix',
    // The text the integration test runs (subagents-handback).
    `runs this exec code unchanged, and again unchanged if it runs out of time (it resumes): ${handBackExec} It returns`,
    `runCommand sh ["-c", "${handBackFetch}", "sh", "COMMIT", "NAME"]`,
    'E(workspace).merge("NAME", { mode: "merge-commit", message: "Merge NAME" })',
    'about 31,000 characters',
  ])
    t.true(text.includes(kept), kept);
  for (const gone of ['powers.publish', 'clear()', 'E(box)'])
    t.false(text.includes(gone), gone);
  t.true(text.length <= 4096, 'within presetInstructionsUnits');
});

/**
 * @param {string} label
 * @param {string} kind
 * @param {Record<string, { efforts: string[], effort?: string }>} [models]
 */
const makeBackend = (label, kind, models = {}) => {
  let reads = 0;
  const ids = Object.keys(models);
  return {
    describe: () => ({ label, kind }),
    get reads() {
      return reads;
    },
    /** @param {{ after?: string }} request */
    listModels: ({ after }) => {
      reads += 1;
      const start = after === undefined ? 0 : Number(after);
      const page = ids.slice(start, start + 1);
      return {
        state: 'ok',
        rows: page.map(modelId => ({
          modelId,
          reasoningEfforts: models[modelId].efforts,
          ...(models[modelId].effort === undefined
            ? {}
            : { defaultReasoningEffort: models[modelId].effort }),
        })),
        ...(start + 1 < ids.length ? { next: String(start + 1) } : {}),
      };
    },
  };
};
const five = ['low', 'medium', 'high', 'xhigh', 'max'];
const claudeModels = {
  'claude-opus-5-5': { efforts: five, effort: 'medium' },
  'claude-fable-5-2': { efforts: five, effort: 'medium' },
  'claude-haiku-4-5': { efforts: [] },
};

test("the backend is the factory's object: by label, else by kind, else the one Claude pool; absent or ambiguous fails", async t => {
  const claude = makeBackend('Claude', 'claude-pool', claudeModels);
  const chatgpt = makeBackend('ChatGPT', 'codex-pool');
  const api = makeBackend('Anthropic API', 'anthropic');
  const backends = [chatgpt, claude, api];
  t.is((await resolveBackend(backends)).backend, claude);
  t.is((await resolveBackend(backends, 'ChatGPT')).backend, chatgpt);
  t.is((await resolveBackend(backends, 'anthropic')).backend, api);
  await t.throwsAsync(resolveBackend(backends, 'Nope'), {
    message:
      'No backend labelled or of kind "Nope"; the factory offers: ChatGPT (codex-pool), Claude (claude-pool), Anthropic API (anthropic)',
  });
  await t.throwsAsync(resolveBackend([chatgpt]), {
    message: /^No backend of kind claude-pool/,
  });
  const second = makeBackend('Claude 2', 'claude-pool');
  await t.throwsAsync(resolveBackend([claude, second]), {
    message:
      /^2 backends are of kind claude-pool; name one with --backend LABEL/,
  });
  t.is((await resolveBackend([claude, second], 'Claude 2')).backend, second);
});

test('a preset without a backend gets the Claude pool, Fable 5.2, checked at medium; options replace saved values; none keeps them', async t => {
  t.deepEqual(presetDefaults, {
    backendKind: 'claude-pool',
    modelId: 'claude-fable-5-2',
    reasoningEffort: 'medium',
  });
  const claude = makeBackend('Claude', 'claude-pool', claudeModels);
  const chatgpt = makeBackend('ChatGPT', 'codex-pool', {
    'gpt-5.6-terra': { efforts: ['low', 'medium'], effort: 'medium' },
  });
  const backends = [chatgpt, claude];
  t.like(await choosePresetModel(undefined, { backends }), {
    backend: claude,
    modelId: 'claude-fable-5-2',
    notes: [],
  });
  // Operator edits survive a republish without options, unread.
  const edited = { backend: chatgpt, modelId: 'gpt-5.6-terra' };
  const before = chatgpt.reads;
  t.like(await choosePresetModel(edited, { backends }), edited);
  t.is(chatgpt.reads, before, 'no catalogue read for a kept model');
  // An option replaces the saved value.
  t.like(
    await choosePresetModel(edited, { backends, backend: 'claude-pool' }),
    { backend: claude, modelId: 'claude-fable-5-2' },
  );
  t.like(
    await choosePresetModel(edited, {
      backends,
      backend: 'Claude',
      modelId: 'claude-opus-5-5',
      reasoningEffort: 'medium',
    }),
    { backend: claude, modelId: 'claude-opus-5-5' },
  );
  t.like(
    await choosePresetModel(
      { backend: claude, modelId: 'claude-opus-5-5' },
      { backends, modelId: 'claude-fable-5-2' },
    ),
    { backend: claude, modelId: 'claude-fable-5-2', notes: [] },
  );
  // Another backend without a model: its catalogue default.
  const other = await choosePresetModel(undefined, {
    backends,
    backend: 'ChatGPT',
  });
  t.is(other.backend, chatgpt);
  t.is(other.modelId, undefined);
  await t.throwsAsync(
    choosePresetModel(undefined, { backends, modelId: 'claude-none' }),
    { message: 'Model "claude-none" is not in the backend\'s catalogue' },
  );
  await t.throwsAsync(
    choosePresetModel(undefined, { backends, reasoningEffort: 'high' }),
    {
      message:
        'claude-fable-5-2 starts sessions at reasoning effort medium, not high (offered: low, medium, high, xhigh, max); presets carry no effort, so pick it per session',
    },
  );
  // A row with no efforts at all: the running agent-host's efforts table
  // is stale. The implied medium only notes it; --effort fails with it.
  const stale =
    "claude-fable-5-2 has no reasoning efforts in the running agent-host's model catalogue, so it cannot be checked at medium. If the model takes efforts, the running agent-host adapter has a stale efforts table: reload the adapter (a supervisor restart does) on a tree that has the fix, then publish again";
  const old = makeBackend('Claude', 'claude-pool', {
    'claude-fable-5-2': { efforts: [] },
  });
  const noted = await choosePresetModel(undefined, { backends: [old] });
  t.is(noted.modelId, 'claude-fable-5-2');
  t.deepEqual(noted.notes, [stale]);
  await t.throwsAsync(
    choosePresetModel(undefined, {
      backends: [old],
      reasoningEffort: 'medium',
    }),
    { message: stale },
  );
  // No Claude pool and no --backend: no backend, with a note.
  t.deepEqual(await choosePresetModel(undefined, { backends: [chatgpt] }), {
    backend: undefined,
    modelId: undefined,
    notes: [noPoolNote],
  });
  t.deepEqual(await choosePresetModel(undefined, { backends: [] }), {
    backend: undefined,
    modelId: undefined,
    notes: [noPoolNote],
  });
  await t.throwsAsync(
    choosePresetModel(undefined, {
      backends: [chatgpt],
      modelId: 'claude-fable-5-2',
    }),
    { message: /^--model and --effort need a backend/ },
  );
  // A preset that already names a backend keeps it without a Claude pool.
  t.like(await choosePresetModel(edited, { backends: [chatgpt] }), edited);
  await t.throwsAsync(
    choosePresetModel(undefined, {
      backends,
      backend: 'ChatGPT',
      reasoningEffort: 'low',
    }),
    { message: '--effort needs a model: give --model too' },
  );
});

test('savePreset saves the chosen backend object and model, and a republish with the same choice saves nothing', async t => {
  const seed = /** @type {const} */ ({
    project: 'thixotrope',
    commit: 'cd'.repeat(20),
  });
  const claude = makeBackend('Claude', 'claude-pool', claudeModels);
  /** @type {Record<string, any> | undefined} */
  let view;
  let saves = 0;
  const preset = {
    describe: () => view,
    save: (/** @type {object} */ record) => {
      saves += 1;
      view = { ...record, available: true };
    },
  };
  const catalog = {
    configuration: () => ({
      presets: view === undefined ? [] : [preset],
      revision: saves,
    }),
    create: (/** @type {object} */ record) => {
      saves += 1;
      view = { ...record, available: true };
      return { preset };
    },
  };
  const choice = { backends: [claude] };
  await savePreset(catalog, {}, seed, false, choice);
  t.is(saves, 1);
  t.is(view?.backend, claude);
  t.is(view?.modelId, 'claude-fable-5-2');
  t.false('reasoningEffort' in (view ?? {}));
  t.is(view?.instructions, projectInstructions(undefined));
  await savePreset(catalog, {}, seed, false, choice);
  t.is(saves, 1, 'unchanged');
  await savePreset(catalog, {}, seed, false, {
    ...choice,
    modelId: 'claude-opus-5-5',
  });
  t.is(saves, 2);
  t.is(view?.modelId, 'claude-opus-5-5');
  await savePreset(catalog, {}, seed, false, choice);
  t.is(view?.modelId, 'claude-opus-5-5', 'kept without an option');
  t.is(saves, 2);
});

test('the plan refuses a wrong effort with nothing saved, and savePreset saves without a backend when the state has no Claude pool', async t => {
  const seed = /** @type {const} */ ({
    project: 'thixotrope',
    commit: 'cd'.repeat(20),
  });
  const claude = makeBackend('Claude', 'claude-pool', claudeModels);
  /** @type {Record<string, any> | undefined} */
  let view;
  let saves = 0;
  const preset = {
    describe: () => view,
    save: (/** @type {object} */ record) => {
      saves += 1;
      view = { ...record, available: true };
    },
  };
  const catalog = {
    configuration: () => ({
      presets: view === undefined ? [] : [preset],
      revision: saves,
    }),
    create: (/** @type {object} */ record) => {
      saves += 1;
      view = { ...record, available: true };
      return { preset };
    },
  };
  await t.throwsAsync(
    planPreset(catalog, 'thixotrope', {
      backends: [claude],
      reasoningEffort: 'high',
    }),
    { message: /starts sessions at reasoning effort medium, not high/ },
  );
  t.is(saves, 0);
  const chatgpt = makeBackend('ChatGPT', 'codex-pool');
  const { notes } = await savePreset(catalog, {}, seed, false, {
    backends: [chatgpt],
  });
  t.deepEqual(notes, [noPoolNote]);
  t.is(saves, 1);
  t.false('backend' in (view ?? {}));
  t.false('modelId' in (view ?? {}));
});
