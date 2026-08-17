// @ts-check

/** @import { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent' */
/** @import { EndoConnectionFailureContext, EndoConnectionFailureObserver, EndoProvisionPersistence, EndoProvisionResult, EndoProvisionSpec } from '../src/code-mode-provisioning-types.js' */

import { initTheme } from '@earendil-works/pi-coding-agent';
import test from '@endo/ses-ava/prepare-endo.js';
import fc from 'fast-check';

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execPath } from 'node:process';

import {
  EndoCredentialUnavailableError,
  normalizeEndoProvisionSpec,
} from '../code-mode-provisioning.js';
import { makeEndoCodeModePiExtension } from '../endo-code-mode-pi-extension.js';
import { makeEndoProvisionGlobals } from '../src/code-mode-provision-globals.js';
import { makeCodeModeCapTpOptions } from '../src/code-mode-provisioning.js';
import { samePlainData } from '../src/endo-code-mode-pi-extension.js';
import {
  renderEvaluateCall,
  renderEvaluateResult,
} from '../src/pi-evaluate-render.js';

// The renderers call into Pi's `keyHint`, which reads the interactive theme
// singleton; initialize it once so the collapsed-result expand hint renders
// instead of throwing "Theme not initialized".
initTheme();

const SESSION_ENTRY_TYPE = 'endo.pi-code-mode.provision';
const NONINTERACTIVE_MODES = harden(/** @type {const} */ (['print', 'json']));
const FAKE_POWERS = /** @type {EndoProvisionResult['powers']} */ (harden({}));

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
const runLauncher = (args, cwd) =>
  new Promise((resolve, reject) => {
    const child = execFile(execPath, args, { cwd }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(error, { stdout, stderr }));
      } else {
        resolve({ stdout, stderr });
      }
    });
    // JSON mode accepts prompts on stdin, so explicitly close the stream when
    // this driver supplies its prompt in argv.
    child.stdin?.end();
  });

/**
 * @typedef {(event: unknown, context: unknown) => unknown} FakeHandler
 *
 * @typedef {object} HarnessOptions
 * @property {string} cwd
 * @property {string} [sessionId]
 * @property {unknown[]} [entries]
 * @property {string} [flag]
 * @property {string[]} [activeToolNames]
 * @property {'tui' | 'rpc' | 'json' | 'print'} [mode]
 * @property {(persistence: EndoProvisionPersistence, options: { onConnectionFailure: EndoConnectionFailureObserver }) => Promise<EndoProvisionResult>} [reconstructProvision]
 * @property {() => Promise<void>} [startDaemon]
 * @property {import('../src/endo-code-mode-pi-extension.js').EndoCodeModePiExtensionOptions['rehydrateCredential']} [rehydrateCredential]
 * @property {import('../src/endo-code-mode-pi-extension.js').EndoCodeModePiExtensionOptions['validatePersistence']} [validatePersistence]
 * @property {import('../src/endo-code-mode-pi-extension.js').EndoCodeModePiExtensionOptions['normalizeProvision']} [normalizeProvision]
 */

/** @param {import('ava').ExecutionContext} t */
const makeWorkspace = async t => {
  const workspace = await mkdtemp(join(tmpdir(), 'endo-pi-extension-'));
  t.teardown(() => rm(workspace, { recursive: true, force: true }));
  return workspace;
};

/**
 * @param {HarnessOptions} options
 */
const makeHarness = options => {
  const {
    cwd,
    sessionId = 'pi-session',
    entries = [],
    flag,
    mode = 'tui',
    activeToolNames = ['read', 'write', 'edit', 'bash'],
    startDaemon = async () => {},
    rehydrateCredential,
  } = options;
  /** @type {Map<string, FakeHandler[]>} */
  const handlers = new Map();
  /** @type {Array<{ name: string, options: unknown }>} */
  const flags = [];
  /** @type {Array<{ customType: string, data: unknown }>} */
  const appended = [];
  /** @type {unknown[]} */
  const tools = [];
  /** @type {string[][]} */
  const activeTools = [];
  let currentActiveTools = [...activeToolNames];
  /** @type {Array<{ message: string, type: string | undefined }>} */
  const notifications = [];
  /** @type {Array<import('../src/endo-code-mode-pi-extension.js').EndoCodeModePiProblem>} */
  const diagnostics = [];
  /** @type {number[]} */
  const terminations = [];
  /** @type {Array<{ name: string, options: unknown }>} */
  const commands = [];
  /** @type {EndoProvisionPersistence[]} */
  const reconstructions = [];
  let cleanupCount = 0;
  /** @type {EndoConnectionFailureObserver | undefined} */
  let onConnectionFailure;

  const defaultReconstruct = async persistence => {
    reconstructions.push(persistence);
    return harden({
      powers: FAKE_POWERS,
      globals: makeEndoProvisionGlobals(persistence),
      persistence,
      cleanup: async () => {
        cleanupCount += 1;
      },
    });
  };
  const selectedReconstruct =
    options.reconstructProvision ?? defaultReconstruct;
  const reconstructProvision = async (persistence, connectionOptions) => {
    onConnectionFailure = connectionOptions.onConnectionFailure;
    return selectedReconstruct(persistence, connectionOptions);
  };

  const extensionApi = /** @type {ExtensionAPI} */ (
    /** @type {unknown} */ ({
      on: (event, handler) => {
        const eventHandlers = handlers.get(event) ?? [];
        eventHandlers.push(handler);
        handlers.set(event, eventHandlers);
      },
      registerFlag: (name, flagOptions) => {
        flags.push({ name, options: flagOptions });
      },
      getFlag: name => (name === 'endo-provision' ? flag : undefined),
      registerCommand: (name, commandOptions) => {
        commands.push({ name, options: commandOptions });
      },
      registerTool: tool => {
        tools.push(tool);
      },
      getActiveTools: () => [...currentActiveTools],
      setActiveTools: names => {
        currentActiveTools = [...names];
        activeTools.push([...currentActiveTools]);
      },
      appendEntry: (customType, data) => {
        appended.push({ customType, data });
      },
    })
  );

  const extension = makeEndoCodeModePiExtension({
    reconstructProvision,
    startDaemon,
    rehydrateCredential,
    validatePersistence: options.validatePersistence,
    normalizeProvision: options.normalizeProvision,
    writeDiagnostic: problem => diagnostics.push(problem),
    terminate: status => terminations.push(status),
  });
  extension(extensionApi);

  const hasUI = mode === 'tui' || mode === 'rpc';
  const context = /** @type {ExtensionContext} */ (
    /** @type {unknown} */ ({
      cwd,
      mode,
      hasUI,
      sessionManager: {
        getSessionId: () => sessionId,
        getBranch: () => entries,
      },
      ui: {
        notify: (message, type) => notifications.push({ message, type }),
      },
    })
  );

  /**
   * @param {string} name
   * @param {unknown} event
   * @param {ExtensionContext} [eventContext]
   */
  const emit = async (name, event, eventContext = context) => {
    await null;
    /** @type {unknown[]} */
    const results = [];
    for (const handler of handlers.get(name) ?? []) {
      // Event handlers are intentionally sequential, matching Pi's runner.
      // eslint-disable-next-line no-await-in-loop
      results.push(await handler(event, eventContext));
    }
    return results;
  };

  return {
    activeTools,
    appended,
    commands,
    context,
    diagnostics,
    emit,
    flags,
    notifications,
    reconstructions,
    terminations,
    tools,
    get currentActiveTools() {
      return currentActiveTools;
    },
    /** @param {'disconnect' | 'protocol'} [kind] */
    failConnection(kind = 'disconnect') {
      if (onConnectionFailure === undefined) {
        throw Error('connection failure observer is not installed');
      }
      onConnectionFailure(
        Error('raw host detail must not be presented'),
        harden({ kind }),
      );
    },
    get cleanupCount() {
      return cleanupCount;
    },
  };
};

/**
 * @param {EndoProvisionPersistence} persistence
 * @returns {unknown}
 */
const persistenceEntry = persistence => ({
  type: 'custom',
  customType: SESSION_ENTRY_TYPE,
  data: persistence,
});

/** @param {unknown} value */
const shuffleKeys = value => {
  if (Array.isArray(value)) {
    return value.map(shuffleKeys);
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(([key, child]) => [
      key,
      shuffleKeys(child),
    ]);
    // Reversing is a cheap, deterministic reordering: distinct from the
    // canonicalizer's own key sort whenever an object has more than one key.
    entries.reverse();
    return Object.fromEntries(entries);
  }
  return value;
};

// fc.jsonValue()/fc.dictionary() build recursive object trees; generating
// enough of them under this test file's SES-locked realm
// (@endo/ses-ava/prepare-endo.js) reliably crashes fast-check's own internal
// caching, which assigns to inherited, now-frozen Object.prototype data
// properties. fc.record() with fixed, primitive-only fields does not
// recurse and is stable here, so the property below mirrors the actual
// EndoProvisionPolicy shape samePlainData compares in production rather than
// arbitrary JSON.
const policyArb = fc.record(
  {
    fs: fc.constantFrom('readOnly', 'readWrite'),
    git: fc.constantFrom('readOnly', 'readWrite', 'historyRewrite'),
    deniedSegments: fc.array(fc.string({ minLength: 1, maxLength: 12 })),
  },
  { requiredKeys: [] },
);

test('samePlainData does not depend on property insertion order', t => {
  const result = fc.check(
    fc.property(policyArb, policy =>
      samePlainData(policy, shuffleKeys(policy)),
    ),
  );
  t.true(
    result.failed === false,
    result.failed
      ? `counter-example: ${JSON.stringify(result.counterexample)}`
      : undefined,
  );
});

test('samePlainData still distinguishes a changed leaf value', t => {
  const result = fc.check(
    fc.property(
      policyArb,
      fc.constantFrom('readOnly', 'readWrite'),
      (policy, replacementFs) => {
        if (samePlainData(policy.fs, replacementFs)) {
          // The generated replacement happened to be equivalent; not a
          // counter-example for this property.
          return true;
        }
        const changed = { ...shuffleKeys(policy), fs: replacementFs };
        return samePlainData(policy, changed) === false;
      },
    ),
  );
  t.true(
    result.failed === false,
    result.failed
      ? `counter-example: ${JSON.stringify(result.counterexample)}`
      : undefined,
  );
});

test('code-mode CapTP policy leaves promise rejection presentation to its caller', t => {
  /** @type {Array<{ error: unknown, context: EndoConnectionFailureContext }>} */
  const connectionFailures = [];
  const options = makeCodeModeCapTpOptions((error, context) => {
    connectionFailures.push({ error, context });
  });
  const applicationError = Error('tool owns this error');

  options.onReject(applicationError, {
    kind: 'promise',
  });
  t.deepEqual(connectionFailures, []);

  const disconnectError = Error('connection lost');
  options.onReject(disconnectError, {
    kind: 'disconnect',
  });
  t.deepEqual(connectionFailures, [
    {
      error: disconnectError,
      context: { kind: 'disconnect' },
    },
  ]);
});

test('load registers only daemon-independent flag and command', async t => {
  const cwd = await makeWorkspace(t);
  let reconstructCount = 0;
  const harness = makeHarness({
    cwd,
    reconstructProvision: async persistence => {
      reconstructCount += 1;
      return harden({
        powers: FAKE_POWERS,
        globals: harden([]),
        persistence,
        cleanup: async () => {},
      });
    },
  });

  t.deepEqual(
    harness.flags.map(({ name }) => name),
    ['endo-provision'],
  );
  t.deepEqual(harness.flags[0].options, {
    type: 'string',
    description:
      'Inert EndoProvisionSpec JSON for this Pi session (never credential material)',
  });
  t.deepEqual(
    harness.commands.map(({ name }) => name),
    ['endo-code-mode'],
  );
  t.is(reconstructCount, 0);
  t.deepEqual(harness.tools, []);
});

for (const flag of ['{malformed', '[]', '"string"']) {
  test(`malformed flag ${JSON.stringify(flag)} fails without connecting`, async t => {
    const cwd = await makeWorkspace(t);
    const harness = makeHarness({ cwd, flag });

    await harness.emit('session_start', {
      type: 'session_start',
      reason: 'startup',
    });

    t.deepEqual(harness.reconstructions, []);
    t.deepEqual(harness.appended, []);
    t.is(harness.notifications.length, 1);
    t.regex(harness.notifications[0].message, /must be a JSON object/);
    t.false(harness.notifications[0].message.includes(flag));
    t.deepEqual(harness.currentActiveTools, []);
  });
}

test('invalid secret-shaped input is never echoed or persisted', async t => {
  const cwd = await makeWorkspace(t);
  const secret = 'DO-NOT-PRINT-THIS';
  const harness = makeHarness({
    cwd,
    flag: JSON.stringify({ token: secret }),
    mode: 'print',
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.deepEqual(harness.terminations, [1]);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_INVALID');
  const observable = JSON.stringify({
    appended: harness.appended,
    diagnostics: harness.diagnostics,
    notifications: harness.notifications,
  });
  t.false(observable.includes(secret));
  t.false(observable.includes('token'));
});

test('startup with an omitted grant uses cwd and activates only evaluate', async t => {
  const cwd = await makeWorkspace(t);
  const canonicalCwd = await realpath(cwd);
  const harness = makeHarness({ cwd });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.is(harness.reconstructions.length, 1);
  const [persistence] = harness.reconstructions;
  t.is(persistence.workspacePath, canonicalCwd);
  t.deepEqual(Object.keys(persistence.policy), ['mounts']);
  t.deepEqual(harness.activeTools, [[], ['evaluate']]);
  t.is(harness.tools.length, 1);
  const [evaluateTool] =
    /** @type {{ name: string, renderCall: unknown, renderResult: unknown }[]} */ (
      harness.tools
    );
  t.is(evaluateTool.name, 'evaluate');
  // The registered tool carries the terminal renderers so Pi's TUI stops
  // falling back to a name-only header and a bare SmallCaps JSON dump.
  t.is(evaluateTool.renderCall, renderEvaluateCall);
  t.is(evaluateTool.renderResult, renderEvaluateResult);
  t.deepEqual(harness.appended, [
    { customType: SESSION_ENTRY_TYPE, data: persistence },
  ]);

  const [promptResult] = await harness.emit('before_agent_start', {
    type: 'before_agent_start',
  });
  const prompt = /** @type {{ systemPrompt: string }} */ (promptResult)
    .systemPrompt;
  t.regex(prompt, /exactly one tool: evaluate/);
  t.false(prompt.includes(canonicalCwd));
  t.false(prompt.includes(JSON.stringify(persistence.policy)));
});

test('piTools preserve keeps active Pi tools and composes the system prompt', async t => {
  const cwd = await makeWorkspace(t);
  const standardTools = ['read', 'write', 'edit', 'bash', 'other-extension'];
  const harness = makeHarness({
    cwd,
    activeToolNames: standardTools,
    flag: JSON.stringify({ piTools: 'preserve' }),
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.deepEqual(harness.activeTools, [[], [...standardTools, 'evaluate']]);
  t.deepEqual(harness.currentActiveTools, [...standardTools, 'evaluate']);
  t.is(harness.reconstructions[0].policy.piTools, 'preserve');

  const [promptResult] = await harness.emit('before_agent_start', {
    type: 'before_agent_start',
    systemPrompt: 'standard harness prompt',
  });
  const prompt = /** @type {{ systemPrompt: string }} */ (promptResult)
    .systemPrompt;
  t.true(prompt.startsWith('standard harness prompt\n\n'));
  t.regex(prompt, /evaluate tool plus the other active Pi tools/);
  t.false(prompt.includes('exactly one tool: evaluate'));

  await harness.emit('session_shutdown', {
    type: 'session_shutdown',
    reason: 'reload',
  });
  t.deepEqual(harness.currentActiveTools, [...standardTools, 'evaluate']);

  const retained = /** @type {EndoProvisionPersistence} */ (
    harness.appended[0].data
  );
  const resumed = makeHarness({
    cwd,
    entries: [persistenceEntry(retained)],
    activeToolNames: harness.currentActiveTools,
  });
  await resumed.emit('session_start', {
    type: 'session_start',
    reason: 'reload',
  });
  t.deepEqual(resumed.currentActiveTools, [...standardTools, 'evaluate']);
});

test('explicit filesystem and Git grants default their workspace to cwd', async t => {
  const cwd = await makeWorkspace(t);
  const harness = makeHarness({
    cwd,
    flag: JSON.stringify({ fs: 'readWrite', git: 'readOnly' }),
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  const [persistence] = harness.reconstructions;
  t.is(persistence.workspacePath, await realpath(cwd));
  t.is(persistence.policy.mounts.workspace.mode, 'readWrite');
  t.is(persistence.policy.gits?.git?.mode, 'readOnly');
  t.deepEqual(
    makeEndoProvisionGlobals(persistence).map(({ name }) => name),
    ['workspace', 'git'],
  );
});

for (const reason of ['resume', 'reload']) {
  test(`${reason} reconnects the same retained guest from session data`, async t => {
    const cwd = await makeWorkspace(t);
    const persistence = await normalizeEndoProvisionSpec(
      { fs: 'readOnly' },
      { harness: 'pi', sessionId: 'retained-session', cwd },
    );
    const harness = makeHarness({
      cwd,
      sessionId: 'retained-session',
      entries: [persistenceEntry(persistence)],
    });

    await harness.emit('session_start', {
      type: 'session_start',
      reason,
    });

    t.deepEqual(harness.reconstructions, [persistence]);
    t.deepEqual(harness.appended, [
      { customType: SESSION_ENTRY_TYPE, data: persistence },
    ]);
  });
}

test('new and fork create distinct retained namespaces; fork inherits policy', async t => {
  const cwd = await makeWorkspace(t);
  const parent = await normalizeEndoProvisionSpec(
    { fs: 'readWrite', git: 'readOnly', piTools: 'preserve' },
    { harness: 'pi', sessionId: 'parent-session', cwd },
  );
  const fresh = makeHarness({ cwd, sessionId: 'new-session' });
  const fork = makeHarness({
    cwd,
    sessionId: 'fork-session',
    entries: [persistenceEntry(parent)],
  });

  await fresh.emit('session_start', {
    type: 'session_start',
    reason: 'new',
  });
  await fork.emit('session_start', {
    type: 'session_start',
    reason: 'fork',
  });

  const [freshPersistence] = fresh.reconstructions;
  const [forkPersistence] = fork.reconstructions;
  t.notDeepEqual(freshPersistence.guestHandlePath, parent.guestHandlePath);
  t.notDeepEqual(forkPersistence.guestHandlePath, parent.guestHandlePath);
  t.deepEqual(forkPersistence.policy, parent.policy);
  t.is(forkPersistence.workspacePath, parent.workspacePath);
  t.deepEqual(fork.activeTools, [
    [],
    ['read', 'write', 'edit', 'bash', 'evaluate'],
  ]);
});

test('resume and fork use pinned Git roots after a selector is retargeted', async t => {
  const cwd = await makeWorkspace(t);
  const nested = join(cwd, 'nested-repo');
  const replacement = join(cwd, 'replacement-repo');
  const selector = join(cwd, 'nested-link');
  await mkdir(nested);
  await mkdir(replacement);
  await symlink(nested, selector, 'dir');
  const stored = await normalizeEndoProvisionSpec(
    {
      fs: 'readOnly',
      gits: { nested: { path: ['nested-link'], mode: 'readOnly' } },
    },
    { harness: 'pi', sessionId: 'retained-session', cwd },
  );
  await rm(selector, { force: true });
  await symlink(replacement, selector, 'dir');

  for (const reason of ['resume', 'fork']) {
    const harness = makeHarness({
      cwd,
      mode: 'json',
      sessionId: reason === 'resume' ? 'retained-session' : 'fork-session',
      entries: [persistenceEntry(stored)],
    });
    // The two lifecycle modes intentionally run serially against the same
    // retargeted selector fixture.
    // eslint-disable-next-line no-await-in-loop
    await harness.emit('session_start', {
      type: 'session_start',
      reason,
    });
    t.is(harness.reconstructions.length, 1);
    t.deepEqual(harness.reconstructions[0].policy, stored.policy);
  }
});

test('resume rejects a conflicting CLI policy with fork/new guidance', async t => {
  const cwd = await makeWorkspace(t);
  const stored = await normalizeEndoProvisionSpec(
    { fs: 'readOnly' },
    { harness: 'pi', sessionId: 'retained-session', cwd },
  );
  const harness = makeHarness({
    cwd,
    sessionId: 'retained-session',
    entries: [persistenceEntry(stored)],
    flag: JSON.stringify({ fs: 'readWrite' }),
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.deepEqual(harness.reconstructions, []);
  t.deepEqual(harness.appended, []);
  t.regex(harness.notifications[0].message, /conflicts/);
  t.regex(harness.notifications[0].message, /new session.*fork/s);
});

const preservationConflicts =
  /** @type {Array<[string, EndoProvisionSpec | undefined, EndoProvisionSpec]>} */ ([
    ['enabling', undefined, { piTools: 'preserve' }],
    ['disabling', { piTools: 'preserve' }, {}],
  ]);

for (const [label, storedSpec, flag] of preservationConflicts) {
  test(`resume rejects ${label} pi tool preservation`, async t => {
    const cwd = await makeWorkspace(t);
    const stored = await normalizeEndoProvisionSpec(storedSpec, {
      harness: 'pi',
      sessionId: 'retained-session',
      cwd,
    });
    const harness = makeHarness({
      cwd,
      entries: [persistenceEntry(stored)],
      flag: JSON.stringify(flag),
    });

    await harness.emit('session_start', {
      type: 'session_start',
      reason: 'resume',
    });

    t.deepEqual(harness.reconstructions, []);
    t.regex(harness.notifications[0].message, /conflicts/);
    t.deepEqual(harness.currentActiveTools, []);
  });
}

test('resume with unparseable stored persistence is rejected as invalid', async t => {
  const cwd = await makeWorkspace(t);
  const stored = await normalizeEndoProvisionSpec(
    { fs: 'readOnly' },
    { harness: 'pi', sessionId: 'retained-session', cwd },
  );
  const harness = makeHarness({
    cwd,
    mode: 'json',
    sessionId: 'retained-session',
    // The real validator rejects a persisted record whose version does not
    // match the current schema, e.g. a session entry written by an older
    // extension build.
    entries: [
      persistenceEntry(
        /** @type {EndoProvisionPersistence} */ (
          /** @type {unknown} */ ({ ...stored, version: 1 })
        ),
      ),
    ],
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.deepEqual(harness.reconstructions, []);
  t.deepEqual(harness.appended, []);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_SESSION_INVALID');
  t.regex(
    harness.diagnostics[0].message,
    /missing or invalid Endo code-mode authority/,
  );
});

test('resume with a missing Git directory fails closed for the session', async t => {
  const cwd = await makeWorkspace(t);
  const nestedPath = join(cwd, 'nested-repo');
  await mkdir(nestedPath);
  const stored = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      gits: { nested: { path: ['nested-repo'], mode: 'readOnly' } },
    },
    { harness: 'pi', sessionId: 'missing-nested-repo', cwd },
  );
  await rm(nestedPath, { recursive: true, force: true });
  const harness = makeHarness({
    cwd,
    mode: 'json',
    sessionId: 'missing-nested-repo',
    entries: [persistenceEntry(stored)],
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.deepEqual(harness.reconstructions, []);
  t.deepEqual(harness.appended, []);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_SESSION_INVALID');
  t.regex(harness.diagnostics[0].message, /Git directory is unavailable/);
  t.regex(
    harness.diagnostics[0].action,
    /no previous grant is silently dropped or changed/,
  );
});

test('resume whose stored authority cannot be re-derived is rejected as invalid', async t => {
  const cwd = await makeWorkspace(t);
  const stored = await normalizeEndoProvisionSpec(
    { fs: 'readOnly' },
    { harness: 'pi', sessionId: 'retained-session', cwd },
  );
  // A workspace that no longer exists lets validation trust the record as-is
  // (a stubbed validator) while the real normalizer's realpath lookup fails
  // when the extension re-derives authority from the stored spec.
  const missingWorkspace = join(cwd, 'gone');
  const goneStored = { ...stored, workspacePath: missingWorkspace };
  const harness = makeHarness({
    cwd,
    mode: 'json',
    sessionId: 'retained-session',
    entries: [persistenceEntry(goneStored)],
    validatePersistence: async persistence =>
      /** @type {EndoProvisionPersistence} */ (persistence),
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.deepEqual(harness.reconstructions, []);
  t.deepEqual(harness.appended, []);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_SESSION_INVALID');
  t.regex(harness.diagnostics[0].message, /cannot be reconstructed/);
});

test('resume whose re-derived authority differs from the persisted policy is rejected', async t => {
  const cwd = await makeWorkspace(t);
  const stored = await normalizeEndoProvisionSpec(
    { fs: 'readOnly' },
    { harness: 'pi', sessionId: 'retained-session', cwd },
  );
  // Not-yet-normalized deniedSegments (duplicated, mixed case) pass a stubbed
  // validator unchanged, but persistenceToSpec + the real normalizer collapse
  // them to a single lowercase entry, so the re-derived policy no longer
  // matches what was trusted as stored.
  const drifted = {
    ...stored,
    policy: {
      ...stored.policy,
      mounts: {
        workspace: {
          ...stored.policy.mounts.workspace,
          deniedSegments: ['NODE_MODULES', 'node_modules'],
        },
      },
    },
  };
  const harness = makeHarness({
    cwd,
    mode: 'json',
    sessionId: 'retained-session',
    entries: [persistenceEntry(drifted)],
    validatePersistence: async persistence =>
      /** @type {EndoProvisionPersistence} */ (persistence),
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.deepEqual(harness.reconstructions, []);
  t.deepEqual(harness.appended, []);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_SESSION_INVALID');
  t.regex(
    harness.diagnostics[0].message,
    /does not normalize to its persisted policy/,
  );
});

test("resume with another session's retained guest is rejected as mismatched", async t => {
  const cwd = await makeWorkspace(t);
  // Persistence derived under a different session id yields a distinct
  // guestHandlePath; resuming it from this session re-derives the same
  // workspace/policy authority (same cwd, same spec) but a different
  // guestHandlePath, which is the "wrong session" signal.
  const stored = await normalizeEndoProvisionSpec(
    { fs: 'readOnly' },
    { harness: 'pi', sessionId: 'other-session', cwd },
  );
  const harness = makeHarness({
    cwd,
    mode: 'json',
    sessionId: 'retained-session',
    entries: [persistenceEntry(stored)],
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.deepEqual(harness.reconstructions, []);
  t.deepEqual(harness.appended, []);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_SESSION_MISMATCH');
  t.regex(harness.diagnostics[0].message, /different Pi session/);
});

test('daemon absence triggers one standard-daemon autostart and reconnect', async t => {
  const cwd = await makeWorkspace(t);
  let attempt = 0;
  let startCount = 0;
  const harness = makeHarness({
    cwd,
    reconstructProvision: async persistence => {
      attempt += 1;
      if (attempt === 1) {
        throw Object.assign(
          Error('Cannot connect to Endo. Is Endo running? socket absent'),
          { code: 'ENOENT' },
        );
      }
      return harden({
        powers: FAKE_POWERS,
        globals: harden([]),
        persistence,
        cleanup: async () => {},
      });
    },
    startDaemon: async () => {
      startCount += 1;
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.is(attempt, 2);
  t.is(startCount, 1);
  t.deepEqual(harness.activeTools.at(-1), ['evaluate']);
});

test('failed daemon autostart is deterministic and actionable', async t => {
  const cwd = await makeWorkspace(t);
  let startCount = 0;
  const harness = makeHarness({
    cwd,
    mode: 'json',
    reconstructProvision: async () => {
      throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' });
    },
    startDaemon: async () => {
      startCount += 1;
      throw Error('start race');
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.is(startCount, 1);
  t.deepEqual(harness.terminations, [1]);
  t.is(harness.diagnostics[0].code, 'ENDO_DAEMON_UNAVAILABLE');
  t.regex(harness.diagnostics[0].action, /endo start/);
  t.is(harness.diagnostics.length, 1);
});

test('failed preserved startup leaves standard Pi tools active', async t => {
  const cwd = await makeWorkspace(t);
  const standardTools = ['read', 'write', 'edit', 'bash'];
  const harness = makeHarness({
    cwd,
    activeToolNames: standardTools,
    flag: JSON.stringify({ piTools: 'preserve' }),
    reconstructProvision: async () => {
      throw Object.assign(Error('refused'), { code: 'ECONNREFUSED' });
    },
    startDaemon: async () => {
      throw Error('start race');
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.deepEqual(harness.activeTools, [[], standardTools]);
  t.deepEqual(harness.currentActiveTools, standardTools);
  const [promptResult] = await harness.emit('before_agent_start', {
    type: 'before_agent_start',
    systemPrompt: 'standard harness prompt',
  });
  t.is(
    /** @type {{ systemPrompt: string }} */ (promptResult).systemPrompt,
    'standard harness prompt\n\nEndo code mode is unavailable. Standard Pi tools remain active; resolve the extension startup error before continuing.',
  );
});

test('startup connection failure keeps its structured diagnostic', async t => {
  const cwd = await makeWorkspace(t);
  const harness = makeHarness({
    cwd,
    mode: 'json',
    reconstructProvision: async (persistence, { onConnectionFailure }) => {
      onConnectionFailure(
        Error('raw host detail must not be presented'),
        harden({ kind: 'disconnect' }),
      );
      throw Error('connection closed');
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.is(harness.diagnostics[0].code, 'ENDO_DAEMON_CONNECTION_FAILED');
  t.regex(harness.diagnostics[0].message, /closed unexpectedly/);
  t.false(JSON.stringify(harness.diagnostics).includes('raw host detail'));
});

test('unexpected disconnect fails code mode once and disables evaluate', async t => {
  const cwd = await makeWorkspace(t);
  const harness = makeHarness({ cwd });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });
  harness.failConnection('disconnect');
  harness.failConnection('disconnect');

  t.deepEqual(harness.activeTools.at(-1), []);
  t.is(harness.cleanupCount, 1);
  t.is(harness.notifications.length, 1);
  t.like(harness.notifications[0], { type: 'error' });
  t.regex(harness.notifications[0].message, /closed unexpectedly/);
  t.false(harness.notifications[0].message.includes('raw host detail'));
});

for (const mode of NONINTERACTIVE_MODES) {
  test(`${mode} mode emits one structured connection diagnostic`, async t => {
    const cwd = await makeWorkspace(t);
    const harness = makeHarness({ cwd, mode });

    await harness.emit('session_start', {
      type: 'session_start',
      reason: 'startup',
    });
    harness.failConnection('protocol');
    harness.failConnection('protocol');

    t.deepEqual(harness.notifications, []);
    t.deepEqual(harness.terminations, [1]);
    t.deepEqual(harness.activeTools.at(-1), []);
    t.is(harness.diagnostics.length, 1);
    t.like(harness.diagnostics[0], {
      type: 'endo_code_mode_error',
      code: 'ENDO_DAEMON_PROTOCOL_FAILED',
    });
    t.false(JSON.stringify(harness.diagnostics).includes('raw host detail'));
  });
}

test('a daemon that returns different persistence than requested is rejected and cleaned up', async t => {
  const cwd = await makeWorkspace(t);
  let cleanupCount = 0;
  const harness = makeHarness({
    cwd,
    mode: 'json',
    reconstructProvision: async persistence =>
      harden({
        powers: FAKE_POWERS,
        globals: makeEndoProvisionGlobals(persistence),
        // The daemon is trusted to echo back the persistence it was asked to
        // provision; simulate it returning a workspace other than requested.
        persistence: { ...persistence, workspacePath: `${cwd}-other` },
        cleanup: async () => {
          cleanupCount += 1;
        },
      }),
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.is(cleanupCount, 1);
  t.deepEqual(harness.appended, []);
  t.is(harness.diagnostics[0].code, 'ENDO_PROVISION_RECOVERY_MISMATCH');
  t.regex(harness.diagnostics[0].message, /different persistence/);
});

test('trusted interactive hook can rehydrate a credential without handling its value', async t => {
  const cwd = await makeWorkspace(t);
  const credentialPersistence = await normalizeEndoProvisionSpec(
    {
      fs: 'readWrite',
      git: 'readWrite',
      gitRemotes: {
        origin: {
          url: 'https://example.test/repository.git',
          credential: ['credentials', 'origin'],
        },
      },
    },
    { harness: 'pi', sessionId: 'credential-session', cwd },
  );
  let attempts = 0;
  let hookCount = 0;
  const harness = makeHarness({
    cwd,
    sessionId: 'credential-session',
    entries: [persistenceEntry(credentialPersistence)],
    reconstructProvision: async persistence => {
      attempts += 1;
      if (attempts === 1) {
        throw new EndoCredentialUnavailableError('origin', [
          'credentials',
          'origin',
        ]);
      }
      return harden({
        powers: FAKE_POWERS,
        globals: makeEndoProvisionGlobals(persistence),
        persistence,
        cleanup: async () => {},
      });
    },
    rehydrateCredential: async ({ error, persistence, hasUI }) => {
      hookCount += 1;
      t.is(error.remoteName, 'origin');
      t.deepEqual(persistence, credentialPersistence);
      t.true(hasUI);
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });

  t.is(hookCount, 1);
  t.is(attempts, 2);
  t.deepEqual(harness.diagnostics, []);
  t.deepEqual(harness.terminations, []);
});

for (const mode of NONINTERACTIVE_MODES) {
  test(`${mode} mode fails credential recovery on stderr without secret persistence`, async t => {
    const cwd = await makeWorkspace(t);
    const secret = 'credential-value-never-passed';
    const harness = makeHarness({
      cwd,
      mode,
      reconstructProvision: async () => {
        // The secret represents unavailable process-local material. It is not
        // passed to the extension error and must not appear in any output.
        void secret;
        throw new EndoCredentialUnavailableError('origin', [
          'credentials',
          'origin',
        ]);
      },
    });

    await harness.emit('session_start', {
      type: 'session_start',
      reason: 'startup',
    });

    t.deepEqual(harness.terminations, [1]);
    t.deepEqual(harness.appended, []);
    t.deepEqual(harness.notifications, []);
    t.is(harness.diagnostics[0].code, 'ENDO_CREDENTIAL_UNAVAILABLE');
    t.false(JSON.stringify(harness.diagnostics).includes(secret));
  });
}

test('interactive credential failure remains disconnected and actionable', async t => {
  const cwd = await makeWorkspace(t);
  const harness = makeHarness({
    cwd,
    mode: 'rpc',
    reconstructProvision: async () => {
      throw new EndoCredentialUnavailableError('origin', [
        'credentials',
        'origin',
      ]);
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });

  t.deepEqual(harness.appended, []);
  t.deepEqual(harness.activeTools, [[], []]);
  t.regex(harness.notifications[0].message, /trusted non-echoing TUI or RPC/);
});

test('shutdown disposes only the live connection and leaves persistence reusable', async t => {
  const cwd = await makeWorkspace(t);
  const harness = makeHarness({ cwd });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });
  const retained = /** @type {EndoProvisionPersistence} */ (
    harness.appended[0].data
  );
  await harness.emit('session_shutdown', {
    type: 'session_shutdown',
    reason: 'quit',
  });

  t.is(harness.cleanupCount, 1);
  t.deepEqual(harness.activeTools.at(-1), []);

  const resumed = makeHarness({
    cwd,
    entries: [persistenceEntry(retained)],
  });
  await resumed.emit('session_start', {
    type: 'session_start',
    reason: 'resume',
  });
  t.deepEqual(resumed.reconstructions, [retained]);
});

test('intentional shutdown ignores the connection close observation', async t => {
  const cwd = await makeWorkspace(t);
  /** @type {EndoConnectionFailureObserver | undefined} */
  let observer;
  const harness = makeHarness({
    cwd,
    reconstructProvision: async (persistence, options) => {
      observer = options.onConnectionFailure;
      return harden({
        powers: FAKE_POWERS,
        globals: harden([]),
        persistence,
        cleanup: async () => {
          observer?.(
            Error('intentional close'),
            harden({ kind: 'disconnect' }),
          );
        },
      });
    },
  });

  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });
  await harness.emit('session_shutdown', {
    type: 'session_shutdown',
    reason: 'quit',
  });

  t.deepEqual(harness.notifications, []);
  t.deepEqual(harness.diagnostics, []);
  t.deepEqual(harness.terminations, []);
  t.deepEqual(harness.activeTools.at(-1), []);
});

test('/endo-code-mode reports state without exposing policy data', async t => {
  const cwd = await makeWorkspace(t);
  const harness = makeHarness({ cwd });
  const command =
    /** @type {{ handler: (args: string, context: ExtensionCommandContext) => Promise<void> }} */ (
      harness.commands[0].options
    );

  await command.handler(
    '',
    /** @type {ExtensionCommandContext} */ (harness.context),
  );
  await harness.emit('session_start', {
    type: 'session_start',
    reason: 'startup',
  });
  await command.handler(
    '',
    /** @type {ExtensionCommandContext} */ (harness.context),
  );

  t.deepEqual(
    harness.notifications.map(({ message }) => message),
    [
      'Endo code mode will connect when the session starts.',
      'Endo code mode is connected.',
    ],
  );
  t.false(JSON.stringify(harness.notifications).includes(cwd));
});

test('thin launcher forwards Pi help and preloads the extension flag', async t => {
  const { stdout, stderr: childStderr } = await runLauncher(
    [new URL('../bin/endo-pi.js', import.meta.url).pathname, '--help'],
    new URL('..', import.meta.url).pathname,
  );

  t.regex(stdout, /pi - AI coding assistant/);
  t.regex(stdout, /--endo-provision <value>/);
  t.is(childStderr, '');
});

test('JSON launcher keeps structured extension failure off stdout', async t => {
  const sessionDir = await makeWorkspace(t);
  const secret = 'DO-NOT-ECHO-FROM-ARGV';
  const failure = await t.throwsAsync(
    () =>
      runLauncher(
        [
          new URL('../bin/endo-pi.js', import.meta.url).pathname,
          '--mode',
          'json',
          '--session-dir',
          sessionDir,
          `--endo-provision=${JSON.stringify({ token: secret })}`,
          'probe',
        ],
        new URL('..', import.meta.url).pathname,
      ),
    { code: 1 },
  );
  const { stdout, stderr: childStderr } =
    /** @type {Error & { stdout: string, stderr: string }} */ (failure);

  for (const line of stdout.trim().split('\n')) {
    t.notThrows(() => JSON.parse(line));
  }
  t.like(JSON.parse(childStderr), {
    type: 'endo_code_mode_error',
    code: 'ENDO_PROVISION_INVALID',
  });
  t.false(stdout.includes(secret));
  t.false(childStderr.includes(secret));
});

const fakeTheme =
  /** @type {import('@earendil-works/pi-coding-agent').Theme} */ (
    /** @type {unknown} */ ({
      fg: (_color, text) => text,
      bold: text => text,
    })
  );

/**
 * Pi's `ToolRenderContext` is not re-exported from the package root (see
 * `../src/pi-evaluate-render.js`), so this fake mirrors the subset the
 * renderers under test actually read.
 *
 * @typedef {{
 *   lastComponent: import('@earendil-works/pi-tui').Component | undefined,
 *   state: Record<string, unknown>,
 *   isError: boolean,
 *   expanded?: boolean,
 * }} FakeRenderContext
 */

/**
 * Returned loosely as `any`: this fake is duck-typed against the renderers'
 * own (unexported) context type, not Pi's real `ToolRenderContext`.
 *
 * @param {Partial<FakeRenderContext>} [overrides]
 * @returns {any}
 */
const makeRenderContext = overrides =>
  /** @type {FakeRenderContext} */ (
    /** @type {unknown} */ ({
      args: {},
      toolCallId: 'call-1',
      invalidate: () => {},
      lastComponent: undefined,
      state: {},
      cwd: '/',
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: false,
      showImages: false,
      isError: false,
      ...overrides,
    })
  );

/**
 * @param {import('@earendil-works/pi-tui').Component} component
 * @param {number} [width]
 * @returns {string}
 */
const renderText = (component, width = 80) =>
  component
    .render(width)
    // eslint-disable-next-line no-control-regex
    .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''))
    .join('\n');

test('renderEvaluateCall renders a bash-style header and the highlighted source', t => {
  const source = 'const answer = 42;\nconsole.log(answer);';
  const component = renderEvaluateCall(
    { source },
    fakeTheme,
    makeRenderContext(),
  );
  const text = renderText(component);
  t.regex(text, /\$ evaluate/);
  t.true(text.includes('const answer = 42;'));
  t.true(text.includes('console.log(answer);'));
});

test('renderEvaluateCall shows the source on an errored call for context', t => {
  const source = 'throw new Error("boom");';
  const component = renderEvaluateCall(
    { source },
    fakeTheme,
    makeRenderContext({ isError: true }),
  );
  t.true(renderText(component).includes('throw new Error("boom");'));
});

test('renderEvaluateResult collapses long output to a tail preview with a hidden-line marker', t => {
  const lines = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const result =
    /** @type {import('@earendil-works/pi-agent-core').AgentToolResult<unknown>} */ ({
      content: [],
      details: lines.join('\n'),
    });
  const component = renderEvaluateResult(
    result,
    { expanded: false, isPartial: false },
    fakeTheme,
    makeRenderContext(),
  );
  const text = renderText(component);
  // Two lines were pushed out of the 5-line tail preview; the marker states
  // the exact count and offers the expand hint, matching the built-in bash
  // tool's collapsed shape.
  t.regex(text, /\.\.\. \(2 earlier lines,/);
  t.regex(text, /to expand/);
  t.false(text.includes('one'));
  t.false(text.includes('two'));
  t.true(text.includes('three'));
  t.true(text.includes('seven'));
});

test('renderEvaluateResult shows small output in full with no marker when collapsed', t => {
  const result =
    /** @type {import('@earendil-works/pi-agent-core').AgentToolResult<unknown>} */ ({
      content: [],
      details: 'one\ntwo',
    });
  const component = renderEvaluateResult(
    result,
    { expanded: false, isPartial: false },
    fakeTheme,
    makeRenderContext(),
  );
  const text = renderText(component);
  t.true(text.includes('one'));
  t.true(text.includes('two'));
  t.false(text.includes('earlier lines'));
});

test('renderEvaluateResult shows the full output with no marker when expanded', t => {
  const lines = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
  const result =
    /** @type {import('@earendil-works/pi-agent-core').AgentToolResult<unknown>} */ ({
      content: [],
      details: lines.join('\n'),
    });
  const component = renderEvaluateResult(
    result,
    { expanded: true, isPartial: false },
    fakeTheme,
    makeRenderContext({ expanded: true }),
  );
  const text = renderText(component);
  for (const line of lines) {
    t.true(text.includes(line), `expected expanded output to include ${line}`);
  }
  t.false(text.includes('earlier lines'));
});

test('renderEvaluateResult renders the completion value, not the SmallCaps model text', t => {
  const result =
    /** @type {import('@earendil-works/pi-agent-core').AgentToolResult<unknown>} */ ({
      content: [{ type: 'text', text: '!not-the-details-text' }],
      details: 42n,
    });
  const component = renderEvaluateResult(
    result,
    { expanded: true, isPartial: false },
    fakeTheme,
    makeRenderContext({ expanded: true }),
  );
  const text = renderText(component);
  t.true(text.includes('42n'));
  t.false(text.includes('not-the-details-text'));
});

test('renderEvaluateResult renders the error message from content when isError', t => {
  const result =
    /** @type {import('@earendil-works/pi-agent-core').AgentToolResult<unknown>} */ ({
      content: [{ type: 'text', text: 'evaluate.source must be a string' }],
      details: undefined,
    });
  const component = renderEvaluateResult(
    result,
    { expanded: false, isPartial: false },
    fakeTheme,
    makeRenderContext({ isError: true }),
  );
  t.true(renderText(component).includes('evaluate.source must be a string'));
});
