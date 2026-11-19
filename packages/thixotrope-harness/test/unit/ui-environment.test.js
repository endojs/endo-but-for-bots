// @ts-check
/* eslint-disable import/no-relative-packages */
// The Settings "Sandbox execution" section and the Composer's refusal of a
// stopped session (spec R6-50, R6-57; m6-interfaces.md 3.8, 4.5, seams C-1
// and U-1). Component tests in happy-dom with a fake `Session` and `Live`
// built from the real guards (`interfaces.Session`, `Live`,
// `LiveSubscription`): state from `getExecutionState` and the live
// `execution` event, Emergency stop, Resume, errors shown, hidden when not
// supported, the watch's bounds. The Composer case stages a long text for a
// session that refuses it with `texts.sessionStopped` and checks the file is
// deleted.
import './_m1a-prelude.js';

import test from '@endo/ses-ava/test.js';

import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import { h, render } from 'preact';

import { limits } from '../../guest/lib/limits.js';
import { interfaces, texts } from '../../guest/lib/interfaces.js';
import {
  isRefusal,
  makeComposer,
} from '../../resources/agent-host/impl/composer.js';
import { features } from '../../ui/src/features.js';
import { feature as environmentFeature } from '../../ui/src/environment/feature.js';
import {
  ExecutionPanel,
  RESUBSCRIBE_LIMIT,
  watchClosedText,
} from '../../ui/src/environment/ExecutionPanel.js';
import { executionTexts } from '../../ui/src/environment/texts.js';
import { harnessRoot } from '../_helpers.js';
import { filesIn, makeTestBlobs } from '../adapter/_m1b-blobs.js';
import { makeTestDom } from './_m3-fake-powers.js';
import { runEffectsPromptly } from './_m4-ui-fakes.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E, M, makeExo } = /** @type {GuestGlobals} */ (globalThis);

const flush = async (rounds = 20) => {
  await null;
  for (let i = 0; i < rounds; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise(resolve => setImmediate(resolve));
  }
};

/**
 * An interface guard of the product's own method guards for `methods` of
 * `name` (the fake implements only these; `payload.methodGuards` is the
 * technique of `guest/lib/interfaces-m3.js` `withGatewayAdmin`).
 *
 * @param {string} name
 * @param {string[]} methods
 */
const guardOf = (name, methods) => {
  const all = /** @type {any} */ (interfaces)[name].payload.methodGuards;
  return M.interface(
    name,
    Object.fromEntries(methods.map(method => [method, all[method]])),
  );
};

/**
 * A session with an execution state and its channel. `control` moves the
 * state as the session would (publishing an `execution` event in the same
 * step), fails the next stop, or closes every subscription.
 *
 * @param {{ supported?: boolean, state?: 'running' | 'stopping' | 'stopped' }} [options]
 */
const makeExecutionFakes = ({ supported = true, state = 'running' } = {}) => {
  /** @type {any[][]} */
  const calls = [];
  let current = state;
  let seq = 0;
  /** @type {string | undefined} */
  let failStopWith;
  /** @type {Promise<void> | undefined} */
  let stopGate;
  /** @type {Set<{ push: (delivery: any) => void, end: () => void }>} */
  const subscribers = new Set();

  const executionOf = () => harden({ state: current, supported });

  /** @param {'running' | 'stopping' | 'stopped'} next */
  const move = next => {
    current = next;
    seq += 1;
    const delivery = harden({
      seq,
      rev: seq,
      event: { type: 'execution', state: next, supported },
    });
    for (const subscriber of subscribers) subscriber.push(delivery);
  };

  const session = makeExo(
    'Session',
    guardOf('Session', ['getExecutionState', 'emergencyStop', 'resume']),
    {
      getExecutionState() {
        calls.push(['getExecutionState']);
        return executionOf();
      },
      async emergencyStop() {
        calls.push(['emergencyStop']);
        if (!supported) throw Error(texts.noEnvironmentToStop);
        if (current === 'stopped') return executionOf();
        move('stopping');
        await (stopGate ?? null);
        if (failStopWith !== undefined) {
          const message = failStopWith;
          failStopWith = undefined;
          throw Error(message);
        }
        move('stopped');
        return executionOf();
      },
      async resume() {
        calls.push(['resume']);
        if (current === 'stopping') throw Error(texts.finishStopFirst);
        if (current === 'stopped') move('running');
        return executionOf();
      },
    },
  );

  const subscriptionGuard = guardOf('LiveSubscription', ['next', 'close']);
  const live = makeExo('Live', guardOf('Live', ['subscribe']), {
    /**
     * @param {any} _session
     * @param {number} [_rev]
     */
    async subscribe(_session, _rev) {
      calls.push(['subscribe']);
      /** @type {any[]} */
      const queue = [harden({ seq, rev: seq, event: { type: 'snapshot' } })];
      let closed = false;
      /** @type {((batch: any) => void) | undefined} */
      let waiter;
      const flushQueue = () => {
        if (!waiter || (queue.length === 0 && !closed)) return;
        const resolve = waiter;
        waiter = undefined;
        resolve(
          harden({
            deliveries: queue.splice(0),
            ...(closed ? { closed: true } : {}),
          }),
        );
      };
      const subscriber = {
        /** @param {any} delivery */
        push: delivery => {
          queue.push(delivery);
          flushQueue();
        },
        end: () => {
          closed = true;
          subscribers.delete(subscriber);
          flushQueue();
        },
      };
      subscribers.add(subscriber);
      return makeExo('LiveSubscription', subscriptionGuard, {
        next() {
          return new Promise(resolve => {
            waiter = resolve;
            flushQueue();
          });
        },
        close() {
          calls.push(['close']);
          subscriber.end();
        },
      });
    },
  });

  const control = {
    calls,
    move,
    /** @param {string} message */
    failNextStop: message => {
      failStopWith = message;
    },
    /** Hold every stop until the returned function is called. */
    holdStops: () => {
      /** @type {() => void} */
      let release = () => {};
      stopGate = new Promise(resolve => {
        release = () => {
          stopGate = undefined;
          resolve();
        };
      });
      return release;
    },
    closeSubscriptions: () => {
      for (const subscriber of [...subscribers]) subscriber.end();
    },
    subscriberCount: () => subscribers.size,
    /** @param {string} method */
    count: method => calls.filter(([name]) => name === method).length,
  };
  return { session, live, control };
};

/**
 * Render the section for one session on screen.
 *
 * @param {ReturnType<typeof makeExecutionFakes>} fakes
 * @param {{ hold?: { reason: string, message: string } }} [view]
 */
const mountPanel = async (fakes, view = {}) => {
  runEffectsPromptly();
  const dom = makeTestDom();
  let state = { activeKey: 's1', view: { ...view } };
  const context = harden({
    powers: { live: fakes.live },
    extra: () => undefined,
    controller: {
      getState: () => state,
      activeSession: () => fakes.session,
    },
    call: (/** @type {() => Promise<unknown>} */ fn) => fn(),
  });
  const draw = () => render(h(ExecutionPanel, { context }), dom.root);
  draw();
  await flush();
  const $ = (/** @type {string} */ selector) =>
    dom.document.querySelector(selector);
  const click = async (/** @type {any} */ element) => {
    element.dispatchEvent(
      new dom.window.MouseEvent('click', { bubbles: true }),
    );
    await flush();
  };
  return {
    dom,
    $,
    click,
    status: () => $('.floot-execution [role="status"]')?.textContent,
    alert: () => $('.floot-execution [role="alert"]')?.textContent,
    button: () => $('.floot-execution button'),
    /** @param {Record<string, any>} patch */
    setView: patch => {
      state = { ...state, view: { ...state.view, ...patch } };
      draw();
    },
    unmount: async () => {
      render(null, dom.root);
      await flush();
      await dom.close();
    },
  };
};

test.serial('the feature fills the session Settings slot', t => {
  t.like(environmentFeature, {
    id: 'environment',
    slot: 'session.settings',
    label: executionTexts.heading,
  });
  t.true(features.includes(environmentFeature), 'collected from its directory');
});

test.serial(
  'a session without an environment: the section is hidden and no subscription is opened',
  async t => {
    const fakes = makeExecutionFakes({ supported: false });
    const panel = await mountPanel(fakes);
    t.is(panel.$('.floot-execution'), null);
    t.is(panel.dom.root.textContent, '');
    t.is(fakes.control.count('getExecutionState'), 1);
    t.is(fakes.control.count('subscribe'), 0);
    await panel.unmount();
  },
);

test.serial(
  'running -> Emergency stop -> stopped -> Resume -> running, queue held note',
  async t => {
    const fakes = makeExecutionFakes();
    const panel = await mountPanel(fakes);
    t.is(
      panel.$('.floot-settings-heading')?.textContent,
      executionTexts.heading,
    );
    t.is(panel.status(), executionTexts.running);
    t.is(
      panel.$('[data-execution]')?.getAttribute('data-execution'),
      'running',
    );
    t.is(panel.button()?.textContent, executionTexts.emergencyStop);
    t.is(fakes.control.count('subscribe'), 1);

    await panel.click(panel.button());
    t.is(fakes.control.count('emergencyStop'), 1);
    t.is(panel.status(), executionTexts.stopped);
    t.is(panel.button()?.textContent, executionTexts.resume);
    t.is(panel.button()?.getAttribute('data-action'), 'resume');
    t.is(panel.alert(), undefined);

    // The queue stays held `stopped` after resume (R4-56, R6-50).
    panel.setView({
      hold: { reason: 'stopped', message: texts.sessionStopped },
    });
    await flush();
    t.false(
      panel.dom.root.textContent.includes(executionTexts.queueHeld),
      'no note while stopped',
    );
    await panel.click(panel.button());
    t.is(fakes.control.count('resume'), 1);
    t.is(panel.status(), executionTexts.running);
    t.true(panel.dom.root.textContent.includes(executionTexts.queueHeld));
    panel.setView({ hold: undefined });
    await flush();
    t.false(panel.dom.root.textContent.includes(executionTexts.queueHeld));
    await panel.unmount();
  },
);

test.serial(
  "a failed stop shows the session's text and offers a retry; the retry stops",
  async t => {
    const fakes = makeExecutionFakes();
    const panel = await mountPanel(fakes);
    fakes.control.failNextStop(texts.stopIncomplete);
    await panel.click(panel.button());
    t.is(panel.alert(), texts.stopIncomplete);
    t.is(panel.status(), executionTexts.stopping);
    t.is(panel.button()?.textContent, executionTexts.retryStop);
    t.false(panel.button()?.disabled);
    await panel.click(panel.button());
    t.is(panel.alert(), undefined, 'the error is cleared by the next action');
    t.is(panel.status(), executionTexts.stopped);
    t.is(fakes.control.count('emergencyStop'), 2);
    await panel.unmount();
  },
);

test.serial('the buttons are disabled while an action runs', async t => {
  const fakes = makeExecutionFakes();
  const panel = await mountPanel(fakes);
  const release = fakes.control.holdStops();
  await panel.click(panel.button());
  t.is(panel.status(), executionTexts.changing);
  t.true(panel.button()?.disabled);
  release();
  await flush();
  t.is(panel.status(), executionTexts.stopped);
  t.false(panel.button()?.disabled);
  await panel.unmount();
});

test.serial(
  'a state changed elsewhere arrives as the live execution event',
  async t => {
    const fakes = makeExecutionFakes();
    const panel = await mountPanel(fakes);
    const readsBefore = fakes.control.count('getExecutionState');
    fakes.control.move('stopping');
    await flush();
    t.is(panel.status(), executionTexts.stopping);
    fakes.control.move('stopped');
    await flush();
    t.is(panel.status(), executionTexts.stopped);
    t.is(
      fakes.control.count('getExecutionState'),
      readsBefore,
      'no read: the event carries the state',
    );
    await panel.unmount();
  },
);

test.serial(
  'a closed subscription is opened again and the state read again, at most RESUBSCRIBE_LIMIT in a row',
  async t => {
    const fakes = makeExecutionFakes();
    const panel = await mountPanel(fakes);
    t.is(fakes.control.count('subscribe'), 1);
    // Closed with a state change missed in between: the re-read finds it.
    fakes.control.closeSubscriptions();
    await flush();
    t.is(fakes.control.count('subscribe'), 2);
    fakes.control.move('stopped');
    await flush();
    t.is(panel.status(), executionTexts.stopped);
    // Closes with nothing received in between: the watch gives up.
    for (let i = 0; i < RESUBSCRIBE_LIMIT + 2; i += 1) {
      fakes.control.closeSubscriptions();
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    t.true(fakes.control.count('subscribe') <= 2 + RESUBSCRIBE_LIMIT);
    t.is(fakes.control.subscriberCount(), 0);
    t.is(panel.alert(), watchClosedText);
    t.is(panel.status(), executionTexts.stopped, 'the last state stays shown');
    await panel.unmount();
  },
);

test.serial('leaving Settings closes the subscription', async t => {
  const fakes = makeExecutionFakes();
  const panel = await mountPanel(fakes);
  t.is(fakes.control.subscriberCount(), 1);
  await panel.unmount();
  t.is(fakes.control.count('close'), 1);
  t.is(fakes.control.subscriberCount(), 0);
});

// ---------------------------------------------------------------- composer

const AT = 1_700_000_000_000;
const ID = `${AT}-00000000-0000-4000-8000-000000000001`;

test.serial(
  'Composer: a stopped session refuses a staged submission and the staged file is deleted (seam C-1)',
  async t => {
    t.true(isRefusal(Error(texts.sessionStopped)));
    t.false(isRefusal(Error(`${texts.sessionStopped}.`)), 'compared whole');
    const tmpRoot = join(harnessRoot, 'tmp');
    mkdirSync(tmpRoot, { recursive: true });
    const blobs = makeTestBlobs({
      dir: mkdtempSync(join(tmpRoot, 'composer-stopped-')),
    });
    t.teardown(blobs.cleanup);
    /** @type {any[]} */
    const submitted = [];
    const session = makeExo('Session', guardOf('Session', ['enqueueOnce']), {
      /** @param {any[]} args */
      enqueueOnce(...args) {
        submitted.push(args);
        throw Error(texts.sessionStopped);
      },
    });
    const composer = makeComposer({ now: () => AT, blobs: blobs.store });
    const text = 'S'.repeat(limits.inlineBytes + 10);
    await t.throwsAsync(() => E(composer).submit(session, text, ID), {
      message: texts.sessionStopped,
    });
    t.is(submitted.length, 1);
    t.truthy(submitted[0][0].blob, 'the text was staged and sent as a handle');
    const deadline = Date.now() + 5000;
    while (filesIn(blobs.blobDir).length > 0 && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await flush();
    }
    t.deepEqual(filesIn(blobs.blobDir), [], 'the staged file is deleted');
  },
);
