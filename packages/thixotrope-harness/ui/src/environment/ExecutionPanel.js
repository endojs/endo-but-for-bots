// @ts-check
/**
 * Settings "Sandbox execution" (spec R6-50, R6-57; `designs/m6-interfaces.md`
 * 3.8, 4.5, acceptance 19): the session's execution state, Emergency stop
 * and Resume. Hidden for a session without a shell environment
 * (`ExecutionState.supported` false).
 *
 * The state comes from `Session.getExecutionState()` and then from the live
 * `execution` event the session publishes in the crank that changes it
 * (seam S-3). The page's controller does not hand vat events to features,
 * so while the section is shown it holds a subscription of its own on the
 * session's channel (`Live.subscribe`) and reads only `execution` events
 * from it. A session without an environment never gets one: the first read
 * answers `supported: false`, which cannot change for that session (its
 * services are fixed at creation), and the section stays hidden.
 *
 * Order: read, then (supported) subscribe and read again. An event the
 * session published before the second read may still arrive after it; the
 * events arrive in order and the last one is the newest state, so the shown
 * state ends at the session's. A closed subscription (evicted, or the
 * channel's adapter restarted) is opened again and the state read again, at
 * most `RESUBSCRIBE_LIMIT` times in a row with nothing but snapshots
 * received in between;
 * a rejection (the connection went away) stops the watch with the error
 * shown, and a reconnect brings new powers and with them a new watch.
 *
 * Emergency stop and Resume call the `Session` and show its answer; a
 * rejection (`stopIncomplete`, `finishStopFirst`, ...) is shown in the
 * section as the session wrote it, and the state is read again. Objects,
 * not names: the session is the presence of the row on screen
 * (`activeSessionOf`, the accounts feature's lookup).
 */
import { E } from '@endo/far';
import { h } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { activeSessionOf } from '../accounts/AccountChip.js';
import { executionTexts } from './texts.js';

/** @import { FeatureContext } from '../../../resources/agent-host/impl/gateway/protocol.js' */

/**
 * @typedef {{ state: 'running' | 'stopping' | 'stopped', supported: boolean }} ExecutionState
 */

/** Subscriptions opened in a row with nothing received before giving up. */
export const RESUBSCRIBE_LIMIT = 3;

/** Shown when the watch gave up after `RESUBSCRIBE_LIMIT` closes. */
export const watchClosedText =
  'Live updates of the execution state stopped; reopen Settings to see them again.';

/**
 * @param {unknown} error
 * @returns {string}
 */
const messageOf = error =>
  error && typeof error === 'object' && 'message' in error
    ? String(/** @type {{ message: unknown }} */ (error).message)
    : String(error);

/**
 * An `ExecutionState` from a live `execution` event (the event minus
 * `type`).
 *
 * @param {Record<string, any>} event
 * @returns {ExecutionState}
 */
const stateOfEvent = event =>
  harden({ state: event.state, supported: event.supported });

/**
 * Follow one session's execution state (module comment: order and bounds).
 *
 * @param {object} options
 * @param {any} options.session the `Session` presence
 * @param {any} options.live the connection's `Live`
 * @param {(state: ExecutionState) => void} options.onState
 * @param {(message: string) => void} options.onError
 * @returns {{ close: () => void, done: Promise<void> }}
 */
export const watchExecution = ({ session, live, onState, onError }) => {
  let closed = false;
  /** @type {any} */
  let subscription;

  const run = async () => {
    const first = await E(session).getExecutionState();
    if (closed) return;
    onState(first);
    if (!first.supported) return;
    let closesInARow = 0;
    while (!closed) {
      if (closesInARow >= RESUBSCRIBE_LIMIT) {
        onError(watchClosedText);
        return;
      }
      // eslint-disable-next-line no-await-in-loop
      const opened = await E(live).subscribe(session);
      if (closed) {
        E(opened)
          .close()
          .catch(() => {});
        return;
      }
      subscription = opened;
      // eslint-disable-next-line no-await-in-loop
      const read = await E(session).getExecutionState();
      if (closed) return;
      onState(read);
      let ended = false;
      while (!ended) {
        // eslint-disable-next-line no-await-in-loop
        const batch = await E(opened).next();
        if (closed) return;
        for (const { event } of batch.deliveries) {
          if (event.type === 'execution') onState(stateOfEvent(event));
          // Every subscription starts with its snapshot: only a later
          // delivery shows the channel is serving this one.
          if (event.type !== 'snapshot') closesInARow = 0;
        }
        ended = Boolean(batch.closed);
      }
      subscription = undefined;
      closesInARow += 1;
    }
  };

  const done = run().catch(error => {
    if (!closed) onError(messageOf(error));
  });

  return harden({
    close: () => {
      closed = true;
      if (subscription !== undefined) {
        E(subscription)
          .close()
          .catch(() => {});
        subscription = undefined;
      }
    },
    done,
  });
};

/**
 * The status line of a state.
 *
 * @param {ExecutionState} execution
 * @param {string | undefined} action
 */
const statusText = (execution, action) => {
  if (action !== undefined) return executionTexts.changing;
  if (execution.state === 'stopped') return executionTexts.stopped;
  if (execution.state === 'stopping') return executionTexts.stopping;
  return executionTexts.running;
};

/**
 * @param {{ context: FeatureContext }} props
 */
export const ExecutionPanel = ({ context }) => {
  const { activeKey, view } = context.controller.getState();
  const powers = context.powers;
  /** @type {[ExecutionState | undefined, (v: ExecutionState | undefined) => void]} */
  const [execution, setExecution] = useState(
    /** @type {ExecutionState | undefined} */ (undefined),
  );
  /** @type {[any, (v: any) => void]} */
  const [session, setSession] = useState(/** @type {any} */ (undefined));
  /** @type {[string | undefined, (v: string | undefined) => void]} */
  const [action, setAction] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  /** @type {[string | undefined, (v: string | undefined) => void]} */
  const [error, setError] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  /** One token per watched session: answers for an older one are dropped. */
  const token = useRef(/** @type {object} */ ({}));

  useEffect(() => {
    const mine = {};
    token.current = mine;
    setExecution(undefined);
    setSession(undefined);
    setAction(undefined);
    setError(undefined);
    if (!powers || activeKey === undefined) return undefined;
    /** @type {{ close: () => void } | undefined} */
    let watch;
    const current = () => token.current === mine;
    (async () => {
      const found = await activeSessionOf(context, activeKey);
      if (!current() || found === undefined) return;
      setSession(found);
      watch = watchExecution({
        session: found,
        live: powers.live,
        onState: state => {
          if (current()) setExecution(state);
        },
        onError: message => {
          if (current()) setError(message);
        },
      });
    })().catch(failure => {
      if (current()) setError(messageOf(failure));
    });
    return () => {
      if (current()) token.current = {};
      watch?.close();
    };
    // `context` is the controller's one context; `powers` follow it.
  }, [powers, activeKey]);

  if (execution === undefined || !execution.supported) return null;

  /**
   * @param {'stop' | 'resume'} kind
   */
  const act = kind => {
    const mine = token.current;
    const current = () => token.current === mine;
    setAction(kind);
    setError(undefined);
    const call =
      kind === 'stop' ? E(session).emergencyStop() : E(session).resume();
    call
      .then(
        /** @param {ExecutionState} answer */ answer => {
          if (current()) setExecution(answer);
        },
        async (/** @type {unknown} */ failure) => {
          if (!current()) return;
          setError(messageOf(failure));
          const read = await E(session).getExecutionState();
          if (current()) setExecution(read);
        },
      )
      .catch(() => {
        // The second read failed too: the error above stays shown.
      })
      .finally(() => {
        if (current()) setAction(undefined);
      });
  };

  const stopped = execution.state === 'stopped';
  const held =
    execution.state === 'running' &&
    view !== null &&
    view !== undefined &&
    view.hold?.reason === 'stopped';
  return h(
    'section',
    {
      class: 'floot-execution floot-operator-panel',
      'data-execution': execution.state,
    },
    h('h3', { class: 'floot-settings-heading' }, executionTexts.heading),
    h('p', { role: 'status' }, statusText(execution, action)),
    h('p', { class: 'floot-settings-note' }, executionTexts.explanation),
    held
      ? h('p', { class: 'floot-settings-note' }, executionTexts.queueHeld)
      : null,
    error === undefined ? null : h('p', { role: 'alert' }, error),
    stopped
      ? h(
          'button',
          {
            type: 'button',
            class: 'floot-settings-action',
            'data-action': 'resume',
            disabled: action !== undefined,
            onClick: () => act('resume'),
          },
          executionTexts.resume,
        )
      : h(
          'button',
          {
            type: 'button',
            class: 'floot-settings-action',
            'data-action': 'emergency-stop',
            disabled: action !== undefined,
            onClick: () => act('stop'),
          },
          execution.state === 'stopping'
            ? executionTexts.retryStop
            : executionTexts.emergencyStop,
        ),
  );
};
