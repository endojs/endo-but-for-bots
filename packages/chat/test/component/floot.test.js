// @ts-check

import '@endo/init/debug.js';

import test from 'ava';

/** @import { ExecutionContext } from 'ava' */
import { Far } from '@endo/pass-style';
import { makePromiseKit } from '@endo/promise-kit';

import { flootComponent } from '../../floot-component.js';
import {
  makeFakeDaemon,
  staticSessionListWatch,
  staticSessionWatch,
} from '../helpers/fake-floot.js';
import {
  createDOM,
  tick,
  waitFor as waitForDOM,
} from '../helpers/dom-setup.js';

const dom = createDOM();
// Happy DOM implements the browser APIs exercised here; its declaration types
// carry implementation-specific symbols, so adapt only at the harness boundary.
const testWindow = /** @type {Window & typeof globalThis} */ (
  /** @type {unknown} */ (dom.window)
);
const testDocument = /** @type {Document} */ (
  /** @type {unknown} */ (dom.document)
);
globalThis.MutationObserver = testWindow.MutationObserver;
globalThis.requestAnimationFrame = fn => testWindow.setTimeout(() => fn(0), 0);
globalThis.cancelAnimationFrame = id => clearTimeout(id);
testWindow.confirm = () => true;
const waitFor = predicate => waitForDOM(predicate, 10, 2000);

// A hand-written fake session or factory, given the subscription the space
// opens on it: one snapshot assembled from its own getters, and no events. A
// test that needs the daemon to say more uses `makeFakeDaemon` (see `setup`).
/**
 * @param {string} name
 * @param {Record<string, (...args: any[]) => any>} methods
 */
const farSession = (name, methods) =>
  Far(name, { ...methods, watch: staticSessionWatch(methods) });
/**
 * @param {string} name
 * @param {Record<string, (...args: any[]) => any>} methods
 */
const farFactory = (name, methods) =>
  Far(name, {
    ...methods,
    watchSessions: staticSessionListWatch(() => methods.listSessions()),
  });

test.serial(
  'new session filters models by backend and resets reasoning',
  async t => {
    t.timeout(5000);
    const parent = testDocument.createElement('div');
    testDocument.body.appendChild(parent);
    const created = [];
    const facet = farSession('PickerSession', {
      getInfo: () => harden({ id: 'one', title: 'One' }),
      getHistory: () => harden([]),
      getCurrentTurn: () => null,
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0 }),
    });
    const factory = farFactory('PickerFactory', {
      listSessions: () => harden([{ id: 'one', title: 'One' }]),
      listPresets: () => harden([{ id: 'test', title: 'Test preset' }]),
      listBackends: () =>
        harden([
          { id: 'provider', title: 'Fae' },
          { id: 'codex', title: 'Codex' },
        ]),
      listModels: () =>
        harden([
          {
            id: 'openrouter/free',
            title: 'Auto free',
            backendId: 'provider',
            default: true,
          },
          {
            id: 'vendor/model:free',
            title: 'Free model',
            backendId: 'provider',
          },
          {
            id: 'codex:sol',
            modelId: 'sol',
            title: 'Sol',
            backendId: 'codex',
            reasoningEfforts: ['low', 'high'],
            defaultReasoningEffort: 'high',
          },
        ]),
      getSession: () => facet,
      createSession: (...args) => {
        created.push(args);
        return facet;
      },
    });
    const dispose = flootComponent(parent, factory, [], () => {}, [], []);
    t.teardown(() => {
      dispose();
      parent.remove();
    });
    await waitFor(() => parent.querySelector('.floot-session-item'));
    await tick(50);
    parent
      .querySelector('[aria-label="New session"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => parent.querySelector('[aria-label="Backend"]'));
    const select = label => {
      const element = parent.querySelector(`select[aria-label="${label}"]`);
      if (!(element instanceof testWindow.HTMLSelectElement)) {
        throw Error(`Missing select: ${label}`);
      }
      return element;
    };
    const change = async (label, value) => {
      select(label).value = value;
      select(label).dispatchEvent(
        new testWindow.Event('change', { bubbles: true }),
      );
      await tick();
    };
    const options = () => [...select('Model').options].map(o => o.value);
    t.deepEqual(options(), ['openrouter/free', 'vendor/model:free']);
    t.true(select('Backend').textContent.includes('Fae'));
    await change('Backend', 'codex');
    t.deepEqual(options(), ['codex:sol']);
    t.is(parent.querySelectorAll('select')[2].value, 'high');
    await change('Backend', 'provider');
    t.is(parent.querySelectorAll('select').length, 2);
    t.is(select('Model').value, 'openrouter/free');
    await change('Model', 'vendor/model:free');
    parent
      .querySelector('.floot-preset-card')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => created.length === 1);
    t.is(created[0][0].model, 'vendor/model:free');
    t.is(created[0][0].backendId, 'provider');
    t.false('reasoningEffort' in created[0][0]);
    t.is(created[0][0].spoken, true);
    await tick();
    parent
      .querySelector('[aria-label="New session"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => parent.querySelector('[aria-label="Backend"]'));
    await change('Backend', 'codex');
    parent
      .querySelector('.floot-preset-card')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => created.length === 2);
    t.like(created[1][0], {
      backendId: 'codex',
      modelId: 'sol',
      reasoningEffort: 'high',
      spoken: true,
    });
  },
);

test.serial('each session row says what backend and model it runs', async t => {
  t.timeout(5000);
  const parent = testDocument.createElement('div');
  testDocument.body.appendChild(parent);
  const sessions = [
    // Hosted: the catalog id is `backend:modelId`, which is also `model`.
    {
      id: 'hosted',
      title: 'Hosted',
      createdAt: 5,
      model: 'codex:sol',
      backendId: 'codex',
      modelId: 'sol',
      reasoningEffort: 'high',
    },
    // A pinned provider session: `model` and `modelId` are the same id.
    {
      id: 'pinned',
      title: 'Pinned',
      createdAt: 4,
      model: 'vendor/model:free',
      backendId: 'provider',
      modelId: 'vendor/model:free',
    },
    // Unpinned, and the factory says what it resolves to.
    {
      id: 'resolved',
      title: 'Resolved',
      createdAt: 3,
      model: '',
      backendId: 'provider',
      modelId: '',
      effectiveModelId: 'qwen3',
    },
    // Unpinned, from a factory that does not say. The catalog's `default`
    // flag is not what runs, so the row must not borrow its title.
    { id: 'unpinned', title: 'Unpinned', createdAt: 2, model: '' },
    // The backend and the model have both left the catalog.
    {
      id: 'gone',
      title: 'Gone',
      createdAt: 1,
      model: 'retired:old-model',
      backendId: 'retired',
      modelId: 'old-model',
    },
  ];
  const facet = id =>
    farSession('LabelSession', {
      getInfo: () => harden(sessions.find(session => session.id === id)),
      getHistory: () => harden([]),
      getCurrentTurn: () => null,
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0 }),
    });
  const factory = farFactory('LabelFactory', {
    listSessions: () => harden(sessions),
    listPresets: () => harden([]),
    listBackends: () =>
      harden([
        { id: 'provider', title: 'Fae' },
        { id: 'codex', title: 'Codex' },
      ]),
    listModels: () =>
      harden([
        {
          id: 'openrouter/free',
          title: 'Auto free',
          backendId: 'provider',
          default: true,
        },
        {
          id: 'vendor/model:free',
          title: 'Free model',
          backendId: 'provider',
        },
        { id: 'codex:sol', modelId: 'sol', title: 'Sol', backendId: 'codex' },
      ]),
    getSession: id => facet(id),
  });
  const dispose = flootComponent(parent, factory, [], () => {}, [], []);
  t.teardown(() => {
    dispose();
    parent.remove();
  });
  await waitFor(
    () => parent.querySelectorAll('.floot-session-runtime').length === 5,
  );
  const labels = Object.fromEntries(
    [...parent.querySelectorAll('.floot-session-item')].map(item => [
      item.querySelector('.floot-session-name')?.textContent,
      item.querySelector('.floot-session-runtime')?.textContent,
    ]),
  );
  t.deepEqual(labels, {
    Hosted: 'Codex · Sol high',
    Pinned: 'Fae · Free model',
    Resolved: 'Fae · qwen3 (default)',
    Unpinned: 'Fae · default model',
    Gone: 'retired · old-model',
  });
});

test.serial(
  'Settings keeps emergency stop available during a pending resume',
  async t => {
    t.timeout(5000);
    const parent = testDocument.createElement('div');
    testDocument.body.appendChild(parent);
    const { promise: resumeResult, resolve: resolveResume } = makePromiseKit();
    let resumes = 0;
    let stops = 0;
    const execution = state => harden({ supported: true, state });
    const facet = farSession('ExecutionUiSession', {
      __getMethodNames__: () =>
        harden(['getExecutionState', 'emergencyStop', 'resume']),
      getExecutionState: () => execution('stopped'),
      getCurrentTurn: () => null,
      getHistory: () => harden([]),
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0 }),
      resume: () => {
        resumes += 1;
        return resumeResult;
      },
      emergencyStop: () => {
        stops += 1;
        return execution('stopped');
      },
    });
    const factory = farFactory('ExecutionUiFactory', {
      listSessions: () =>
        harden([{ id: 'one', title: 'Stopped session', createdAt: 1 }]),
      listPresets: () => harden([]),
      listModels: () => harden([]),
      getSession: () => facet,
    });
    const cleanup = flootComponent(parent, factory, [], () => {}, [], []);
    t.teardown(() => {
      resolveResume(execution('running'));
      cleanup();
      parent.remove();
    });
    await waitFor(() =>
      parent.querySelector('[aria-label="Settings & transcription"]'),
    );
    parent
      .querySelector('[aria-label="Settings & transcription"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    const button = text =>
      /** @type {HTMLButtonElement | undefined} */ (
        [...parent.querySelectorAll('button')].find(
          candidate => candidate.textContent === text,
        )
      );
    await waitFor(() => button('Resume session'));
    button('Resume session')?.click();
    await waitFor(() => resumes === 1 && button('Emergency stop'));
    t.false(button('Emergency stop')?.disabled);
    button('Emergency stop')?.click();
    await waitFor(() => stops === 1 && button('Resume session'));
    resolveResume(execution('running'));
    await tick();
    t.truthy(
      button('Resume session'),
      'late resume cannot undo the displayed stop',
    );
  },
);

test.serial(
  'sandbox network changes require explicit operator actions and escape request reasons',
  async t => {
    t.timeout(5000);
    const parent = testDocument.createElement('div');
    testDocument.body.appendChild(parent);
    const sets = [];
    const decisions = [];
    /** @type {{ policy: string | null, pendingPolicy?: string, error?: string, supportedPolicies: string[], applies: string, request?: { id: string, policy: string, reason: string } }} */
    let value = {
      policy: 'off',
      supportedPolicies: ['off', 'public-internet'],
      applies: 'next-turn',
      request: {
        id: 'r1',
        policy: 'public-internet',
        reason: '<img src=x onerror="alert(1)">',
      },
    };
    const facet = farSession('NetworkUiSession', {
      __getMethodNames__: () =>
        harden([
          'getNetworkPolicy',
          'getCurrentTurn',
          'setNetworkPolicy',
          'resolveNetworkPolicyRequest',
        ]),
      getNetworkPolicy: () => harden({ ...value }),
      getCurrentTurn: () => null,
      getHistory: () => harden([]),
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0 }),
      setNetworkPolicy: policy => {
        sets.push(policy);
        value = {
          ...value,
          policy,
          request: undefined,
          pendingPolicy: undefined,
          error: undefined,
        };
      },
      resolveNetworkPolicyRequest: (id, approve, note) => {
        decisions.push([id, approve, note]);
        value = {
          ...value,
          policy: approve
            ? value.request?.policy || value.policy
            : value.policy,
          request: undefined,
        };
      },
    });
    const unsupported = farSession('UnsupportedNetworkUiSession', {
      __getMethodNames__: () => harden(['getNetworkPolicy', 'getCurrentTurn']),
      getNetworkPolicy: () =>
        harden({ policy: null, supportedPolicies: [], applies: 'next-turn' }),
      getCurrentTurn: () => null,
      getHistory: () => harden([]),
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0 }),
    });
    const factory = farFactory('NetworkUiFactory', {
      listSessions: () =>
        harden([
          { id: 'network', title: 'Network session', createdAt: 2 },
          { id: 'old', title: 'Unsupported session', createdAt: 1 },
        ]),
      listPresets: () => harden([]),
      listModels: () => harden([]),
      getSession: id => (id === 'network' ? facet : unsupported),
    });
    const cleanup = flootComponent(parent, factory, [], () => {}, [], []);
    t.teardown(() => {
      cleanup();
      parent.remove();
    });
    const button = text =>
      /** @type {HTMLButtonElement | undefined} */ (
        [...parent.querySelectorAll('button')].find(
          candidate => candidate.textContent === text,
        )
      );
    const click = text =>
      button(text)?.dispatchEvent(
        new testWindow.Event('click', { bubbles: true }),
      );
    // The header chip's visible text is split across a label and a badge; the
    // accessible name is the whole phrase.
    const networkButton = () =>
      parent.querySelector('button[aria-label="Network approval requested"]');
    await waitFor(() => networkButton());
    networkButton()?.dispatchEvent(
      new testWindow.Event('click', { bubbles: true }),
    );
    await waitFor(() => parent.querySelector('.floot-network-request'));
    t.true(parent.textContent.includes('<img src=x onerror="alert(1)">'));
    t.falsy(parent.querySelector('img'));
    t.true(button('Deny request')?.disabled);
    const note = textareaIn(parent, '.floot-network-request textarea');
    note.value = 'No network needed for this task';
    note.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await waitFor(() => button('Deny request')?.disabled === false);
    click('Deny request');
    await waitFor(
      () =>
        decisions.length === 1 &&
        !parent.querySelector('.floot-network-request'),
    );
    t.deepEqual(decisions[0], ['r1', false, 'No network needed for this task']);
    const select = /** @type {HTMLSelectElement} */ (
      parent.querySelector('.floot-network-policy select')
    );
    await waitFor(() => !select.disabled);
    select.value = 'public-internet';
    select.dispatchEvent(new testWindow.Event('change', { bubbles: true }));
    await waitFor(
      () => button('Apply Public internet (HTTP/HTTPS)')?.disabled === false,
    );
    t.deepEqual(sets, [], 'selection alone is not authorization');
    click('Apply Public internet (HTTP/HTTPS)');
    await waitFor(() =>
      parent.textContent.includes('Configured policy: Public internet'),
    );
    t.deepEqual(sets, ['public-internet']);
    value = {
      ...value,
      policy: null,
      pendingPolicy: 'off',
      error: 'Sandbox stop incomplete',
    };
    click('Refresh network policy');
    await waitFor(() => button('Retry Off')?.disabled === false);
    t.true(parent.textContent.includes('No policy is verified'));
    t.true(parent.textContent.includes('Sandbox stop incomplete'));
    t.true(textareaIn(parent, '.floot-input').disabled);
    t.false(parent.textContent.includes('Configured policy: Off'));
    t.is(parent.querySelectorAll('.floot-network-policy option').length, 1);
    click('Retry Off');
    await waitFor(() => parent.textContent.includes('Configured policy: Off'));
    t.deepEqual(sets, ['public-internet', 'off']);
    parent
      .querySelectorAll('.floot-session-item')[1]
      .dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() =>
      parent.textContent.includes('No off policy is implied'),
    );
    t.falsy(parent.querySelector('.floot-network-policy select'));
    t.false(parent.textContent.includes('Configured policy: Off'));
  },
);

test.serial(
  'journal recovery renders evidence safely and keeps unavailable sessions visible',
  async t => {
    t.timeout(5000);
    const parent = testDocument.createElement('div');
    testDocument.body.appendChild(parent);
    const calls = [];
    let starts = 0;
    const hostile = '<img src=x onerror="alert(1)">';
    const facet = farSession('JournalSession', {
      __getMethodNames__: () =>
        harden([
          'getTurns',
          'getCurrentTurn',
          'resolveTurn',
          'getJournalStatus',
        ]),
      getTurns: () =>
        harden([
          ...Array.from({ length: 100 }, (_, index) => ({
            turnId: `${index + 2}`,
            state: 'completed',
            tools: [{ result: 'hidden'.repeat(20_000) }],
          })),
          {
            turnId: '1',
            state: 'outcome-unknown',
            error: hostile,
            tools: [
              { name: 'exec', result: `${'a'.repeat(20_000)}TAIL` },
              { name: 'second', result: 'SECOND ITEM' },
            ],
            activity: [{ name: 'native' }],
          },
        ]),
      getJournalStatus: () =>
        harden({
          usedEvents: '9990',
          retainedTurns: 256,
          archivedTurns: 3000,
          storage: 'private',
        }),
      getCurrentTurn: () => null,
      enqueue: () => {
        starts += 1;
        return harden({ id: 'p1' });
      },
      getHistory: () => harden([]),
      getUsage: () => harden({ inputTokens: 0, outputTokens: 0 }),
      resolveTurn: (...args) => {
        calls.push(args);
      },
    });
    const factory = farFactory('JournalFactory', {
      listSessions: () =>
        harden([
          {
            id: 'broken',
            title: 'Broken session',
            lifecycle: 'error',
            createdAt: 2,
          },
          {
            id: 'good',
            title: 'Review session',
            lifecycle: 'ready',
            createdAt: 1,
          },
        ]),
      listPresets: () => harden([]),
      listModels: () => harden([]),
      getSession: id => {
        if (id !== 'good') throw Error('unavailable');
        return facet;
      },
    });
    const cleanup = flootComponent(parent, factory, [], () => {}, [], []);
    t.teardown(() => {
      cleanup();
      parent.remove();
    });
    await waitFor(
      () => parent.querySelectorAll('.floot-session-item').length === 2,
    );
    parent
      .querySelector('button[aria-label^="Turn journal and recovery"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(
      () => parent.querySelectorAll('.floot-recovery-turn').length === 50,
    );
    t.is(
      parent.querySelectorAll('.floot-recovery pre').length,
      0,
      'collapsed evidence is not rendered',
    );
    t.false(textareaIn(parent, '.floot-input').disabled);
    const compose = textareaIn(parent, '.floot-input');
    compose.value = 'unrelated work without replay';
    compose.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    compose.dispatchEvent(
      new testWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await tick();
    t.is(starts, 1);
    parent
      .querySelector('.floot-recovery-turn summary')
      ?.dispatchEvent(
        new testWindow.Event('click', { bubbles: true, cancelable: true }),
      );
    await waitFor(() => parent.textContent.includes('Endo tool evidence'));
    t.true(parent.textContent.includes(hostile));
    t.falsy(parent.querySelector('img'));
    t.true(parent.textContent.includes('Observed native/backend activity'));
    t.true(
      parent.textContent.includes('3000 earlier settled turns are archived'),
    );
    const buttons = () => [...parent.querySelectorAll('button')];
    t.true(
      [...parent.querySelectorAll('.floot-recovery pre')].every(
        pre => pre.textContent.length <= 8192,
      ),
    );
    t.false(parent.textContent.includes('TAIL'));
    for (let chunk = 0; chunk < 2; chunk += 1) {
      buttons()
        .find(button => button.textContent === 'Next chunk')
        ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
      // eslint-disable-next-line no-await-in-loop
      await tick();
    }
    t.true(
      parent.textContent.includes('TAIL'),
      'paged tail remains inspectable',
    );
    buttons()
      .find(button => button.textContent === 'Next item')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => parent.textContent.includes('SECOND ITEM'));
    const acknowledge = () =>
      /** @type {HTMLButtonElement} */ (
        buttons().find(
          button => button.textContent === 'Record acknowledgement',
        )
      );
    t.true(acknowledge().disabled);
    const note = textareaIn(parent, '.floot-recovery textarea');
    note.value = 'Verified remote effects and retained the result';
    note.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    buttons()
      .find(
        button => button.textContent === 'Confirm: I checked external effects',
      )
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => !acknowledge().disabled);
    acknowledge().dispatchEvent(
      new testWindow.Event('click', { bubbles: true }),
    );
    await waitFor(() => calls.length === 1);
    t.deepEqual(calls[0], ['1', note.value]);
    parent
      .querySelector('.floot-session-item')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() =>
      parent.textContent.includes('Session unavailable (error)'),
    );
    t.true(textareaIn(parent, '.floot-input').disabled);
    t.false(parent.textContent.includes('Endo tool evidence'));
  },
);

/**
 * A queried element that must be there, so an assertion about it fails on what
 * it says rather than on a null dereference.
 *
 * @param {Element | null} element
 * @param {string} what
 * @returns {Element}
 */
const must = (element, what) => {
  if (!element) throw Error(`Missing ${what}`);
  return element;
};

/**
 * @param {Element} parent
 * @param {string} selector
 * @returns {HTMLTextAreaElement}
 */
const textareaIn = (parent, selector) =>
  /** @type {HTMLTextAreaElement} */ (
    must(parent.querySelector(selector), selector)
  );

/**
 * A mounted Floot space over a fake daemon (test/helpers/fake-floot.js).
 *
 * @param {ExecutionContext} t
 * @param {number} [count]
 * @param {boolean} [recover] a turn is already running when the page mounts
 * @param {(daemon: ReturnType<typeof makeFakeDaemon>) => void} [prepare] runs
 *   before the page mounts, to leave the daemon in some state
 */
const setup = async (t, count = 2, recover = false, prepare = () => {}) => {
  t.timeout(5000);
  const parent = testDocument.createElement('div');
  testDocument.body.appendChild(parent);
  const daemon = makeFakeDaemon({
    count,
    turnStatus: () =>
      recover
        ? {
            messages: [],
            streamingText: 'already running',
            phase: 'thinking',
            usage: null,
            error: null,
            done: false,
          }
        : undefined,
  });
  const { factory, turns, deleted, cancelledTurns } = daemon;
  if (recover) daemon.startTurn('s0', 'submitted before reload');
  prepare(daemon);
  let cleanup = flootComponent(parent, factory, [], () => {}, [], []);
  t.teardown(() => {
    cleanup();
    for (const { channel } of turns) channel.push(harden({ type: 'end' }));
    parent.remove();
  });
  await waitFor(
    () => parent.querySelectorAll('.floot-session-item').length === count,
  );
  // Wait for Preact's mount subscription before sending input.
  await tick(50);
  // Scoped to the compose bar's own input: a queued message being edited puts
  // another textarea earlier in the document.
  const send = async text => {
    const input = textareaIn(parent, 'textarea.floot-input');
    input.value = text;
    input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
    await tick();
    input.dispatchEvent(
      new testWindow.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
  };
  const remove = index =>
    parent
      .querySelectorAll('button[aria-label="Delete"]')
      [index].dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  const buttonLabelled = label =>
    [...parent.querySelectorAll('button')].find(
      candidate => candidate.textContent.trim() === label,
    );
  const click = label => {
    const button = buttonLabelled(label);
    if (!button) throw Error(`Missing "${label}" button`);
    button.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  };
  return {
    parent,
    // A sent message is the daemon's once its queue entry is on screen, which
    // is when it grows controls; until then it is this page's request in
    // flight and has none.
    whenQueued: () => waitFor(() => buttonLabelled('Edit')),
    turns,
    deleted,
    cancelledTurns,
    daemon,
    buttonLabelled,
    click,
    // Rewrite the queued message currently open for editing. `save()` closes
    // over the draft of the render that installed it, so Enter must come from a
    // render that has already seen the input event. `tick` is not a budget bet
    // here: Preact schedules re-renders on a microtask, which always drains
    // before a timer, so one macrotask boundary is enough by construction.
    retype: async text => {
      const input = textareaIn(parent, 'textarea.floot-pending-input');
      input.value = text;
      input.dispatchEvent(new testWindow.Event('input', { bubbles: true }));
      await tick();
      input.dispatchEvent(
        new testWindow.KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
        }),
      );
    },
    send,
    remove,
    setCreationFailure: daemon.setCreationFailure,
    created: daemon.created,
    mountSibling: () => {
      const sibling = testDocument.createElement('div');
      testDocument.body.appendChild(sibling);
      const dispose = flootComponent(sibling, factory, [], () => {}, [], []);
      t.teardown(() => {
        dispose();
        sibling.remove();
      });
      return sibling;
    },
    remount: () => {
      cleanup();
      cleanup = flootComponent(parent, factory, [], () => {}, [], []);
    },
    unmount: () => {
      cleanup();
      cleanup = () => {};
    },
    mount: () => {
      cleanup = flootComponent(parent, factory, [], () => {}, [], []);
    },
    setHistoryReader: daemon.setHistoryReader,
  };
};

test.serial(
  'deleting the active session releases submissions before the old turn ends',
  async t => {
    const { parent, turns, deleted, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    remove(0);
    await waitFor(() => deleted.length === 1);
    await send('second');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's1');
    t.is(turns[1].text, 'second');
    turns[0].channel.push(harden({ type: 'abort', reason: 'old turn failed' }));
    await tick(30);
    t.false(parent.textContent.includes('old turn failed'));
    t.truthy(
      parent.querySelector('[aria-label="Stop"]'),
      'late completion does not clear the new turn',
    );
    turns[1].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    parent
      .querySelector('button[aria-label="New session"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(
      () => parent.querySelectorAll('.floot-session-item').length === 2,
    );
    parent
      .querySelectorAll('div.floot-session-item')[1]
      .dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() =>
      parent
        .querySelector('.floot-session-item.active')
        ?.textContent.includes('Session 1'),
    );
    t.pass();
  },
);

test.serial(
  'deleting a non-active session preserves the running attachment',
  async t => {
    const { parent, turns, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    remove(1);
    await tick(30);
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    await send('next');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's0');
  },
);

test.serial(
  'deleting the last session permits creating a new session by sending',
  async t => {
    const { turns, send, remove } = await setup(t, 1);
    await send('first');
    await waitFor(() => turns.length === 1);
    remove(0);
    await send('new session');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's1');
  },
);

test.serial('Stop continues observing cancellation failure', async t => {
  const { parent, turns, send } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  parent
    .querySelector('button[aria-label="Stop"]')
    ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  turns[0].channel.push(harden({ type: 'phase', phase: 'cancelling' }));
  await tick(30);
  t.truthy(parent.querySelector('[aria-label="Stop"]'));
  turns[0].channel.push(
    harden({ type: 'abort', reason: 'cancellation failed' }),
  );
  await waitFor(() => parent.textContent.includes('cancellation failed'));
  t.truthy(parent.querySelector('[aria-label="Send"]'));
});

test.serial(
  'a fresh view recovers the daemon turn and serializes its next submission',
  async t => {
    const { parent, turns, send } = await setup(t, 2, true);
    await waitFor(() => parent.textContent.includes('already running'));
    t.true(parent.textContent.includes('submitted before reload'));
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
    await send('after recovered turn');
    await tick(30);
    t.is(turns.length, 1);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'after recovered turn');
  },
);

test.serial(
  'queued input for a deleted session is never sent to its replacement',
  async t => {
    const { turns, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('queued for the deleted session');
    remove(0);
    await send('for the replacement');
    await waitFor(() => turns.length === 2);
    t.deepEqual(
      turns.map(({ id, text }) => ({ id, text })),
      [
        { id: 's0', text: 'first' },
        { id: 's1', text: 'for the replacement' },
      ],
    );
  },
);

test.serial(
  'factories with identical session IDs have independent observation caches',
  async t => {
    const first = await setup(t);
    await first.send('first factory');
    await waitFor(() => first.turns.length === 1);
    const second = await setup(t);
    t.truthy(second.parent.querySelector('[aria-label="Send"]'));
    await second.send('second factory');
    await waitFor(() => second.turns.length === 1);
    t.is(first.turns.length, 1);
    t.is(second.turns[0].text, 'second factory');
  },
);

test.serial('a transcript update cannot erase the turn in flight', async t => {
  const { parent, turns, send, daemon, setHistoryReader } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  setHistoryReader(() =>
    harden([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'first answer' },
    ]),
  );
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.textContent.includes('first answer'));
  await send('do not erase this input');
  await waitFor(() => turns.length === 2);
  // The settled transcript is published again while the second turn runs
  // (a mail turn settling, a resolution). It holds settled turns only, and
  // the prompt on screen belongs to the turn, not to the transcript.
  daemon.touchTranscript('s0');
  await tick(30);
  t.true(parent.textContent.includes('do not erase this input'));
  t.is(parent.textContent.split('first answer').length - 1, 1);
  t.truthy(parent.querySelector('[aria-label="Stop"]'));
});

test.serial('a URL in a reply renders as a new-tab link', async t => {
  const { parent, turns, send, setHistoryReader } = await setup(t);
  await send('publish it');
  await waitFor(() => turns.length === 1);
  setHistoryReader(() =>
    Promise.resolve(
      harden([
        { role: 'user', content: 'publish it' },
        {
          role: 'assistant',
          content: 'Published at http://127.0.0.1:8080/abc/ (open it).',
        },
      ]),
    ),
  );
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.querySelector('a.floot-link'));
  const link = /** @type {HTMLAnchorElement} */ (
    parent.querySelector('a.floot-link')
  );
  t.is(link.getAttribute('href'), 'http://127.0.0.1:8080/abc/');
  // The sanitizing renderer drops `target` unless the host opts it in; a
  // published capability URL must open in a new tab, as the tool promises.
  t.is(link.getAttribute('target'), '_blank');
  t.regex(link.getAttribute('rel') || '', /noopener/);
});

test.serial(
  'session creation failure does not poison later submissions',
  async t => {
    const { parent, turns, send, remove, setCreationFailure, created } =
      await setup(t, 1);
    remove(0);
    setCreationFailure(true);
    await send('first attempt');
    await waitFor(() => parent.textContent.includes('creation unavailable'));
    setCreationFailure(false);
    await send('retry');
    await waitFor(() => turns.length === 1);
    // The session the page makes for a first message is one it drives: it
    // says so, because only a session that says so is composed with the voice
    // rules, and the positional call cannot say anything.
    t.is(created.length, 1);
    t.like(created[0][0], { spoken: true });
    t.is(turns[0].text, 'retry');
  },
);

test.serial('remount restores the prompt for a cached live turn', async t => {
  const { parent, turns, send, remount } = await setup(t);
  await send('keep this prompt visible');
  await waitFor(() => turns.length === 1);
  remount();
  await waitFor(() => parent.querySelector('[aria-label="Stop"]'));
  t.true(parent.textContent.includes('keep this prompt visible'));
});

test.serial(
  'a remount mid-turn shows the prompt and the reply so far once each',
  async t => {
    const { parent, turns, send, remount } = await setup(t);
    await send('one prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'delta', text: 'one answer' }));
    await waitFor(() => parent.textContent.includes('one answer'));
    remount();
    await waitFor(
      () =>
        parent.querySelector('[aria-label="Stop"]') &&
        parent.textContent.includes('one answer'),
    );
    t.is(parent.textContent.split('one prompt').length - 1, 1);
    t.is(parent.textContent.split('one answer').length - 1, 1);
  },
);

test.serial('a turn found running at mount can be stopped', async t => {
  const { parent, turns, cancelledTurns } = await setup(t, 2, true);
  await waitFor(() => parent.querySelector('[aria-label="Stop"]'));
  parent
    .querySelector('[aria-label="Stop"]')
    ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => cancelledTurns.length === 1);
  t.is(cancelledTurns[0], turns[0].ref);
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.querySelector('[aria-label="Send"]'));
});

test.serial(
  'a turn that finished while the page was away is shown once, from the transcript',
  async t => {
    const { parent, turns, send, unmount, mount, setHistoryReader } =
      await setup(t);
    await send('saved prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'delta', text: 'saved answer' }));
    await waitFor(() => parent.textContent.includes('saved answer'));
    unmount();
    setHistoryReader(() =>
      harden([
        { role: 'user', content: 'saved prompt' },
        { role: 'assistant', content: 'saved answer' },
      ]),
    );
    turns[0].channel.push(harden({ type: 'end' }));
    mount();
    await waitFor(
      () =>
        parent.querySelector('[aria-label="Send"]') &&
        parent.textContent.includes('saved answer'),
    );
    t.is(parent.textContent.split('saved answer').length - 1, 1);
    t.is(parent.textContent.split('saved prompt').length - 1, 1);
  },
);

test.serial(
  'a turn the daemon started on its own reaches the page, and Stop stops that turn',
  async t => {
    const { parent, turns, send, daemon, cancelledTurns } = await setup(t);
    await send('older prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    // Another page, or the queue, starts the next one. Nobody here asked.
    const replacement = daemon.startTurn('s0', 'replacement prompt');
    await waitFor(() => parent.textContent.includes('replacement prompt'));
    parent
      .querySelector('[aria-label="Stop"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], replacement);
  },
);

test.serial('two pages on one session see the same conversation', async t => {
  const { parent, turns, send, setHistoryReader, mountSibling } =
    await setup(t);
  await send('shared prompt');
  await waitFor(() => turns.length === 1);
  const sibling = mountSibling();
  await waitFor(() => sibling.textContent.includes('shared prompt'));
  turns[0].channel.push(harden({ type: 'delta', text: 'shared answer' }));
  await waitFor(() => parent.textContent.includes('shared answer'));
  await waitFor(() => sibling.textContent.includes('shared answer'));
  setHistoryReader(() =>
    harden([
      { role: 'user', content: 'shared prompt' },
      { role: 'assistant', content: 'shared answer' },
    ]),
  );
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(
    () =>
      parent.querySelector('[aria-label="Send"]') &&
      sibling.querySelector('[aria-label="Send"]'),
  );
  t.is(parent.textContent.split('shared answer').length - 1, 1);
  t.is(sibling.textContent.split('shared answer').length - 1, 1);
});

test.serial(
  'a message queued from one page is on the other, which can stop the turn ahead of it',
  async t => {
    const { parent, turns, send, mountSibling, cancelledTurns } =
      await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    const sibling = mountSibling();
    await waitFor(() => sibling.querySelector('[aria-label="Stop"]'));
    await send('queued from the first page');
    await waitFor(
      () =>
        sibling.textContent.includes('queued from the first page') &&
        [...sibling.querySelectorAll('button')].some(
          button => button.textContent.trim() === 'Edit',
        ),
    );
    sibling
      .querySelector('[aria-label="Stop"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], turns[0].ref);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'queued from the first page');
    // And it runs with the first page closed just as well: see the daemon's
    // own tests. Here, both pages follow it into its turn.
    await waitFor(() => !sibling.querySelector('.floot-msg-row.pending'));
    t.true(sibling.textContent.includes('queued from the first page'));
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
  },
);

test.serial(
  'mail that arrives while the page is idle appears without being asked for',
  async t => {
    const { parent, turns, daemon, setHistoryReader } = await setup(t);
    await tick(30);
    setHistoryReader(() =>
      harden([
        {
          role: 'user',
          content: 'Your design is ready at commit abc123.',
          meta: { mail: { from: 'workflow', messageNumber: '7' } },
        },
      ]),
    );
    // The daemon says the transcript moved. Nothing here runs on a timer, so
    // this appears as fast as the event does, not within three seconds.
    daemon.touchTranscript('s0');
    await waitFor(() =>
      parent.textContent.includes('Your design is ready at commit abc123.'),
    );
    t.is(turns.length, 0, 'showing mail does not start a UI turn');
  },
);

test.serial('the page asks the daemon for nothing on a timer', async t => {
  const { daemon } = await setup(t);
  await tick(200);
  const before = daemon.calls.length;
  // Well past the old three-second poll, which re-read the transcript, the
  // execution state and the network policy each time.
  await new Promise(resolve => setTimeout(resolve, 3500));
  t.deepEqual(daemon.calls.slice(before), []);
});

// ── A message is on screen exactly once, from the keystroke on ───────────────

const occurrences = (parent, text) => parent.textContent.split(text).length - 1;

/**
 * Sample how many times `text` is on screen, every few milliseconds, until
 * `done()` says stop. A message that blinks out or doubles shows up here.
 */
const watchCount = (parent, text, done) =>
  new Promise(resolve => {
    /** @type {Set<number>} */
    const seen = new Set();
    const sample = () => {
      seen.add(occurrences(parent, text));
      if (done()) resolve([...seen].sort());
      else setTimeout(sample, 5);
    };
    sample();
  });

test.serial(
  "a message stays on screen when its acknowledgement beats the daemon's report of it",
  async t => {
    const { parent, turns, send, daemon, setHistoryReader } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    setHistoryReader(() =>
      harden([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'done' },
      ]),
    );
    // The turn ends and the daemon goes to read a long transcript. Its
    // reports queue behind that read; the acknowledgement of a send does not.
    daemon.setTranscriptDelay(400);
    turns[0].channel.push(harden({ type: 'end' }));
    await tick(50);
    const input = textareaIn(parent, 'textarea.floot-input');
    input.disabled = false;
    await send('sent during the read');
    const counts = await watchCount(
      parent,
      'sent during the read',
      () =>
        turns.length === 2 &&
        Boolean(parent.querySelector('[aria-label="Stop"]')),
    );
    daemon.setTranscriptDelay(0);
    t.deepEqual(counts, [1], 'never absent, never doubled');
  },
);

test.serial(
  'two identical messages sent back to back are two messages',
  async t => {
    const { parent, turns, send } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('ok');
    await send('ok');
    const pendingRows = () =>
      [...parent.querySelectorAll('.floot-msg-row.pending')].filter(row =>
        row.textContent.includes('ok'),
      ).length;
    /** @type {Set<number>} */
    const seen = new Set();
    for (let i = 0; i < 60; i += 1) {
      seen.add(pendingRows());
      // eslint-disable-next-line no-await-in-loop
      await tick(5);
    }
    t.deepEqual(
      [...seen],
      [2],
      'both on screen throughout, neither hidden by the other',
    );
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    turns[1].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 3);
    t.deepEqual(
      turns.map(turn => turn.text),
      ['first', 'ok', 'ok'],
    );
  },
);

test.serial(
  'a send the daemon queued and then failed to acknowledge is not offered twice',
  async t => {
    const { parent, turns, send, daemon, whenQueued } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    daemon.setFailAfterAccepting(true);
    await send('queued, then the reply was lost');
    await whenQueued();
    await waitFor(() => parent.textContent.includes('acknowledgement lost'));
    daemon.setFailAfterAccepting(false);
    t.is(
      textareaIn(parent, 'textarea.floot-input').value,
      '',
      'it is in the queue; putting it back in the box would make two',
    );
    t.is(occurrences(parent, 'queued, then the reply was lost'), 1);
  },
);

test.serial('a send the daemon refused goes back in the box', async t => {
  // A queue record this release cannot read: the session opens all the same
  // (the queue is reported as held), and a send is refused.
  const { parent, send } = await setup(t, 2, false, daemon => {
    daemon.store.set('floot-pending-2-s0', harden({ version: 99 }));
  });
  await send('could not be queued');
  await waitFor(
    () =>
      textareaIn(parent, 'textarea.floot-input').value ===
      'could not be queued',
  );
  t.falsy(parent.querySelector('.floot-msg-row.pending'));
});

test.serial(
  'a reply stays on screen when the transcript cannot be read at the end of its turn',
  async t => {
    const { parent, turns, send, daemon, setHistoryReader } = await setup(t);
    await send('the prompt');
    await waitFor(() => turns.length === 1);
    turns[0].channel.push(harden({ type: 'delta', text: 'the reply' }));
    await waitFor(() => parent.textContent.includes('the reply'));
    setHistoryReader(() =>
      harden([
        { role: 'user', content: 'the prompt' },
        { role: 'assistant', content: 'the reply' },
      ]),
    );
    daemon.failTranscript(1);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => parent.textContent.includes('disk hiccup'));
    t.is(occurrences(parent, 'the reply'), 1, 'still there, from the turn');
    t.is(occurrences(parent, 'the prompt'), 1);
    t.truthy(parent.querySelector('[aria-label="Send"]'), 'and not stoppable');
    // The daemon retries the read; the transcript takes over, once.
    await waitForDOM(
      () => !parent.textContent.includes('disk hiccup'),
      10,
      5000,
    );
    t.is(occurrences(parent, 'the reply'), 1);
    t.is(occurrences(parent, 'the prompt'), 1);
  },
);

test.serial(
  'deleting the session on screen mid-turn leaves no "thinking" behind',
  async t => {
    const { parent, turns, send, remove } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await waitFor(() => parent.textContent.includes('thinking'));
    remove(0);
    await waitFor(() => activeTitle(parent) === 'Session 1');
    await tick(50);
    t.false(
      parent
        .querySelector('.floot-status-bar')
        ?.textContent.includes('thinking'),
    );
    t.truthy(parent.querySelector('[aria-label="Send"]'));
  },
);

test.serial(
  'coming back to a session whose turn ended while away offers no Stop',
  async t => {
    const { parent, turns, send, daemon, setHistoryReader } = await setup(t);
    await send('runs while away');
    await waitFor(() => turns.length === 1);
    selectSessionRow(parent, 'Session 1');
    await waitFor(() => activeTitle(parent) === 'Session 1');
    setHistoryReader(id =>
      id === 's0'
        ? harden([
            { role: 'user', content: 'runs while away' },
            { role: 'assistant', content: 'finished unwatched' },
          ])
        : harden([]),
    );
    turns[0].channel.push(harden({ type: 'end' }));
    await tick(50);
    // The way back is slow: what this page last knew of s0 is a running turn.
    daemon.setTranscriptDelay(300);
    selectSessionRow(parent, 'Session 0');
    const stops = new Set();
    for (let i = 0; i < 80; i += 1) {
      stops.add(Boolean(parent.querySelector('[aria-label="Stop"]')));
      // eslint-disable-next-line no-await-in-loop
      await tick(5);
    }
    daemon.setTranscriptDelay(0);
    await waitFor(() => parent.textContent.includes('finished unwatched'));
    t.deepEqual([...stops], [false], 'never a Stop for a turn that is over');
    t.is(occurrences(parent, 'runs while away'), 1);
  },
);

test.serial(
  'a new session is one row, and its first message is titled and sent',
  async t => {
    const { parent, turns, send } = await setup(t);
    parent
      .querySelector('button[aria-label="New session"]')
      ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
    await waitFor(
      () => parent.querySelectorAll('.floot-session-item').length === 3,
    );
    await tick(50);
    await send('hello there');
    await waitFor(() => turns.length === 1);
    t.is(parent.querySelectorAll('.floot-session-item').length, 3);
    t.is(turns[0].id, 's2');
  },
);

// ── Queued submissions ───────────────────────────────────────────────────────

test.serial(
  'a message sent mid-turn stays visible while it waits its turn',
  async t => {
    const { parent, turns, send, buttonLabelled, whenQueued } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('second question');
    // On screen from the keystroke: first as this page's own request in
    // flight, then as the daemon's queue entry, with its controls.
    await waitFor(() => parent.querySelector('.floot-msg-row.pending'));
    t.true(parent.textContent.includes('second question'));
    await whenQueued();
    t.is(
      parent.querySelectorAll('.floot-msg-row.pending').length,
      1,
      'never both the placeholder and the entry',
    );
    t.true(
      parent.textContent.includes('second question'),
      'the queued message renders in the transcript rather than vanishing',
    );
    // Position and muting carry "not sent yet"; a badge on every queued line
    // would just be noise.
    t.false(
      parent.textContent.includes('Pending'),
      'no badge: position and muting carry it',
    );
    for (const label of ['Send now', 'Edit', 'Delete']) {
      t.truthy(buttonLabelled(label), `offers ${label}`);
    }
    t.is(turns.length, 1, 'it has not started its own turn yet');

    // Finish the first turn; the queued message hands off to the turn it starts
    // and stays visible across the swap.
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'second question');
    t.true(parent.textContent.includes('second question'));
    await waitFor(() => !parent.querySelector('.floot-msg-row.pending'));
    t.falsy(
      buttonLabelled('Send now'),
      'a running message is no longer queued',
    );
  },
);

test.serial('Send now cuts the running turn short', async t => {
  const { turns, cancelledTurns, send, click, whenQueued } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  await send('jump the queue');
  await whenQueued();
  click('Send now');
  await waitFor(() => cancelledTurns.length === 1);
  t.is(cancelledTurns[0], turns[0].ref, 'the turn ahead of it is cancelled');
  // A turn the user stopped ends cleanly, so its queued message runs next.
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => turns.length === 2);
  t.is(turns[1].text, 'jump the queue');
});

test.serial(
  'only the message at the head of the queue can jump it',
  async t => {
    const { parent, turns, cancelledTurns, send, buttonLabelled } =
      await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('queued A');
    await send('queued B');
    await waitFor(
      () => parent.querySelectorAll('button.floot-pending-action').length === 5,
    );
    // Every entry runs the message it was scheduled with, so a "Send now" on B
    // would cancel the turn in front of A — throwing away that reply — and
    // still leave B waiting. The control belongs to the head alone.
    t.is(
      parent.querySelectorAll('button.floot-pending-action').length,
      2 * 2 + 1,
      'Edit and Delete on both, Send now on the head only',
    );
    t.truthy(buttonLabelled('Send now'));
    t.is(
      buttonLabelled('Send now')
        ?.closest('.floot-msg-row')
        ?.textContent.includes('queued A'),
      true,
      'the head is the one that offers it',
    );

    buttonLabelled('Send now')?.dispatchEvent(
      new testWindow.Event('click', { bubbles: true }),
    );
    await waitFor(() => cancelledTurns.length === 1);
    t.is(cancelledTurns[0], turns[0].ref);
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'queued A', 'the head runs, in order');
  },
);

test.serial('editing a queued message is what actually runs', async t => {
  const { parent, turns, send, click, retype, whenQueued } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  await send('original wording');
  await whenQueued();
  click('Edit');
  await waitFor(() => parent.querySelector('textarea.floot-pending-input'));
  await retype('rewritten before it ran');
  await waitFor(() => parent.textContent.includes('rewritten before it ran'));
  t.false(parent.textContent.includes('original wording'));
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => turns.length === 2);
  t.is(
    turns[1].text,
    'rewritten before it ran',
    'the turn runs the edit, not the text that was typed',
  );
});

test.serial(
  'an empty edit keeps the queued message rather than dropping it',
  async t => {
    const { parent, turns, send, click, retype, whenQueued } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('do not lose me');
    await whenQueued();
    click('Edit');
    await waitFor(() => parent.querySelector('textarea.floot-pending-input'));
    // Deleting has its own button; losing a message by clearing the box would
    // be a surprising way to lose one.
    await retype('   ');
    await waitFor(() => !parent.querySelector('textarea.floot-pending-input'));
    t.true(parent.textContent.includes('do not lose me'));
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'do not lose me');
  },
);

test.serial('deleting a queued message skips its turn entirely', async t => {
  const { parent, turns, send, click, whenQueued } = await setup(t);
  await send('first');
  await waitFor(() => turns.length === 1);
  await send('never mind');
  await whenQueued();
  click('Delete');
  await waitFor(() => !parent.querySelector('.floot-msg-row.pending'));
  t.false(parent.textContent.includes('never mind'));
  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.querySelector('[aria-label="Send"]'));
  t.is(turns.length, 1, 'the daemon has nothing queued and starts nothing');
  // Dropping one must not poison the queue for what comes after it.
  await send('but this one runs');
  await waitFor(() => turns.length === 2);
  t.is(turns[1].text, 'but this one runs');
});

// ── Leaving a busy session ──────────────────────────────────────────────────

const sessionRow = (parent, title) =>
  [...parent.querySelectorAll('div.floot-session-item')].find(item =>
    item.textContent.includes(title),
  );
const selectSessionRow = (parent, title) =>
  sessionRow(parent, title)?.dispatchEvent(
    new testWindow.Event('click', { bubbles: true }),
  );
const activeTitle = parent =>
  parent.querySelector('.floot-session-item.active .floot-session-name')
    ?.textContent;

test.serial(
  'a running turn does not lock the session list, and carries on unwatched',
  async t => {
    const { parent, turns, send } = await setup(t);
    await send('long job');
    await waitFor(() => turns.length === 1);
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
    selectSessionRow(parent, 'Session 1');
    await waitFor(() => activeTitle(parent) === 'Session 1');
    // The other session is idle and says so; the one left behind is working.
    await waitFor(() => parent.querySelector('[aria-label="Send"]'));
    t.false(parent.textContent.includes('long job'));
    await waitFor(() =>
      sessionRow(parent, 'Session 0')?.querySelector(
        '.floot-status-dot-working',
      ),
    );
    t.truthy(
      sessionRow(parent, 'Session 1')?.querySelector(
        '.floot-status-dot-passive',
      ),
    );
    // It kept going, and coming back finds it where it has got to.
    turns[0].channel.push(harden({ type: 'delta', text: 'still at it' }));
    selectSessionRow(parent, 'Session 0');
    await waitFor(() => parent.textContent.includes('still at it'));
    t.truthy(parent.querySelector('[aria-label="Stop"]'));
    t.is(
      parent.textContent.split('long job').length - 1,
      1,
      'the prompt, once',
    );
  },
);

test.serial(
  'a message queued behind a turn runs after the user has left the session',
  async t => {
    const { parent, turns, send, whenQueued } = await setup(t);
    await send('first');
    await waitFor(() => turns.length === 1);
    await send('second, sent before leaving');
    await whenQueued();
    selectSessionRow(parent, 'Session 1');
    await waitFor(() => activeTitle(parent) === 'Session 1');
    // A message in the other session is its own conversation.
    await send('elsewhere');
    await waitFor(() => turns.length === 2);
    t.is(turns[1].id, 's1');
    // The first turn ends with nobody looking at it. The daemon runs what was
    // queued; the page that queued it is on another session.
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 3);
    t.deepEqual(
      { id: turns[2].id, text: turns[2].text },
      { id: 's0', text: 'second, sent before leaving' },
    );
    t.is(activeTitle(parent), 'Session 1', 'and the view stayed put');
  },
);

test.serial('a new session can be started while another is busy', async t => {
  const { parent, turns, send } = await setup(t);
  await send('busy');
  await waitFor(() => turns.length === 1);
  parent
    .querySelector('button[aria-label="New session"]')
    ?.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(
    () => parent.querySelectorAll('.floot-session-item').length === 3,
  );
  await waitFor(() => parent.querySelector('[aria-label="Send"]'));
  await send('in the new one');
  await waitFor(() => turns.length === 2);
  t.is(turns[1].id, 's2');
});

// ── What a restart leaves behind ─────────────────────────────────────────────

test.serial(
  'messages held over a restart say why they wait, and go when told to',
  async t => {
    const { parent, turns, click, buttonLabelled } = await setup(
      t,
      2,
      false,
      daemon => {
        daemon.store.set(
          'floot-pending-2-s0',
          harden({
            version: 1,
            nextSequence: 3n,
            entries: [
              {
                id: 'pa-1',
                text: 'was sending',
                createdAt: 1,
                state: 'dispatching',
              },
              {
                id: 'pa-2',
                text: 'was waiting',
                createdAt: 2,
                state: 'queued',
              },
            ],
          }),
        );
      },
    );
    await waitFor(() => parent.querySelector('.floot-pending-hold'));
    t.regex(
      parent.querySelector('.floot-pending-hold')?.textContent || '',
      /restarted/,
    );
    t.is(turns.length, 0, 'nothing is sent on its own');
    // The list says so too, without the session having to be opened.
    t.true(sessionRow(parent, 'Session 0')?.textContent.includes('2 queued'));
    // The one the daemon was sending may or may not have arrived.
    const interrupted = parent.querySelector('.floot-pending-interrupted');
    t.truthy(interrupted);
    t.regex(interrupted?.textContent || '', /May already have been sent/);
    t.truthy(buttonLabelled('Send again'));
    click('Send again');
    await waitFor(() => turns.length === 1);
    t.is(turns[0].text, 'was sending');
    turns[0].channel.push(harden({ type: 'end' }));
    await waitFor(() => turns.length === 2);
    t.is(turns[1].text, 'was waiting', 'and the rest follow, in order');
  },
);

// ── Agent actions ────────────────────────────────────────────────────────────

test.serial("a turn's tool calls collapse into one group", async t => {
  const { parent, turns, send } = await setup(t);
  await send('run some tools');
  await waitFor(() => turns.length === 1);
  const { channel } = turns[0];
  channel.push(
    harden({
      type: 'tool_call',
      id: 'a',
      name: 'exec',
      args: JSON.stringify({ code: 'const x = 1;' }),
    }),
  );
  channel.push(harden({ type: 'tool_result', id: 'a', result: '1' }));
  channel.push(
    harden({ type: 'tool_call', id: 'b', name: 'exec', args: '{"code":"2"}' }),
  );
  channel.push(harden({ type: 'tool_result', id: 'b', result: '2' }));
  channel.push(
    harden({ type: 'tool_call', id: 'c', name: 'list', args: '{}' }),
  );
  channel.push(harden({ type: 'tool_result', id: 'c', result: '[]' }));
  await waitFor(() => parent.querySelector('.floot-actions'));

  t.is(
    parent.querySelectorAll('.floot-actions').length,
    1,
    'one group for the run between two replies',
  );
  const head = must(
    parent.querySelector('.floot-actions-head'),
    'action group header',
  );
  t.true(head.textContent.includes('3 actions'));
  t.true(head.textContent.includes('exec ×2, list'));
  t.is(head.getAttribute('aria-expanded'), 'false', 'closed by default');
  t.is(
    parent.querySelectorAll('.floot-action').length,
    0,
    'the raw JSON stays out of the way until asked for',
  );

  head.dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => parent.querySelectorAll('.floot-action').length === 3);
  // Each action is one entry pairing its call with its result, still collapsed.
  t.is(
    must(parent.querySelector('.floot-action-name'), 'action name').textContent,
    'exec',
  );
  t.falsy(parent.querySelector('.floot-action-body'));

  must(
    parent.querySelector('.floot-action-head'),
    'action header',
  ).dispatchEvent(new testWindow.Event('click', { bubbles: true }));
  await waitFor(() => parent.querySelector('.floot-action-body'));
  const body = must(
    parent.querySelector('.floot-action-body'),
    'expanded action body',
  );
  t.true(body.textContent.includes('javascript'), 'exec unwraps to its source');
  t.true(body.textContent.includes('const x = 1;'));
  t.truthy(
    body.querySelector('.floot-tok-keyword'),
    'the JavaScript is syntax-highlighted',
  );
});

// ── Screen wake lock ─────────────────────────────────────────────────────────

/**
 * Install a `navigator.wakeLock` stand-in for the duration of one test. The
 * component reads `globalThis.navigator?.wakeLock` afresh on every apply, and
 * `navigator` stays configurable after lockdown, so this is what lets the
 * wiring be exercised at all: under plain Node the API is absent and every
 * request short-circuits.
 *
 * @param {ExecutionContext} t
 * @param {number} [latencyMs] how long `request()` takes to resolve
 */
const stubWakeLock = (t, latencyMs = 0) => {
  const sentinels = [];
  const wakeLock = {
    request: () =>
      new Promise(resolve => {
        const sentinel = {
          released: false,
          release: () => {
            sentinel.released = true;
            return Promise.resolve();
          },
          addEventListener: () => {},
        };
        sentinels.push(sentinel);
        testWindow.setTimeout(() => resolve(sentinel), latencyMs);
      }),
  };
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { wakeLock },
    configurable: true,
  });
  t.teardown(() => {
    if (had) Object.defineProperty(globalThis, 'navigator', had);
    else delete (/** @type {any} */ (globalThis).navigator);
  });
  return {
    sentinels,
    get held() {
      return sentinels.filter(sentinel => !sentinel.released);
    },
  };
};

test.serial('a busy turn holds exactly one screen lock', async t => {
  // The lock is driven by `notify()`, which fires many times per turn. Each
  // surplus request would be a lock held by the platform that this component
  // can no longer reach, which is the battery bug the policy exists to avoid.
  const lock = stubWakeLock(t, 5);
  const { parent, turns, send } = await setup(t);
  t.deepEqual(lock.held, [], 'an idle session holds nothing');

  await send('keep the screen on');
  await waitFor(() => turns.length === 1);
  turns[0].channel.push(harden({ type: 'delta', text: 'thinking' }));
  turns[0].channel.push(harden({ type: 'delta', text: ' out' }));
  turns[0].channel.push(harden({ type: 'delta', text: ' loud' }));
  await waitFor(() => parent.textContent.includes('thinking out loud'));
  await waitFor(() => lock.held.length === 1);
  t.is(lock.sentinels.length, 1, 'one request for one busy stretch');

  turns[0].channel.push(harden({ type: 'end' }));
  await waitFor(() => parent.querySelector('[aria-label="Send"]'));
  await waitFor(() => lock.held.length === 0);
  t.pass();
});

test.serial('unmounting releases the screen lock', async t => {
  const lock = stubWakeLock(t);
  const { turns, send, remount } = await setup(t);
  await send('still running when we leave');
  await waitFor(() => turns.length === 1);
  await waitFor(() => lock.held.length === 1);
  // `remount` disposes the old component; the turn keeps running in the
  // background, but this view has no business holding the screen for it.
  remount();
  await waitFor(() => lock.held.length === 0);
  t.pass();
});
