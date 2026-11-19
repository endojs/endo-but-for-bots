// @ts-check
/**
 * The `exec` tool (M1b W1b.4; m1b-interfaces.md 8.2-8.4, 7; architecture 6).
 * The session calls its exec vat's `ExecScope` directly; the scope comes
 * from the session's `ExecHandle` (`services.execVat`) and is kept until
 * retired. Calls of one session run one at a time, in issue order.
 *
 * Endings of a call (8.3): the answer; a retired break (exec vat lost) ->
 * `execTerminated` + retire; `exhausted` (the vat's name table ran out,
 * M1b QC J-0390) -> `execExhausted` + retire; the adapter deadline ->
 * `execTimeout` + retire; cancel -> `execAbandoned`, scope kept, and the
 * exec vat is told (`ExecScope.abandon`, sendOnly, M1b QC J-0391) so the
 * next call runs in the same scope at once; restart (recovery) -> the same,
 * never awaited; `busy` -> retire, fresh scope, run again once with the
 * `execBusyReset` notice.
 *
 * The session's exec state is the `exec` runtime part (`execPart`, made
 * once per session; `ToolContext.runtime.exec.state()`): each session has
 * its own ExecHandle (`services.execVat`, made per session by the factory),
 * so the state per part is the state per handle. Its hooks settle the
 * turn's calls on cancel and in recovery. Guest rules.
 *
 * M5 (W5.4, `m5-interfaces.md` 2.7): `run` carries the session's
 * `ExecPowersSource` (`ToolContext.runtime.powers`, W5.5's part) as
 * `ExecRequest.powers`; the inspector client (`inspect-client.js`) shares
 * this state through `runtime.exec.state()`, `takeScope` and `retireScope`
 * (one scope per session, taken once), and its calls are settled by the
 * same cancel and recovery hooks, by turn.
 */
import { execDescription, texts, textOf } from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { isRetiredBreak } from '../../lib/retired.js';
import { fieldBytes, isStaged } from '../staging.js';
import { messageOf } from '../../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ToolTableEntry } from '../tool-table.js' */
/** @import { HookTurn } from '../runtime-parts.js' */
const { E, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** The result of a call the turn never ran (as turn.js words it). */
export const NOT_RUN_TEXT = 'the turn was cancelled before this call ran';

/**
 * @typedef {object} ExecState
 * @property {any} scope the current ExecScope, or undefined
 * @property {number} deadlineMs from the last `ExecHandle.scope()`
 * @property {any} running the call whose run is out, or undefined
 * @property {Set<ExecCall>} waiting calls in issue order
 * @property {Promise<void> | undefined} taking a `scope()` call in flight
 * @property {Set<any>} inspecting inspector calls of `inspect-client.js`,
 *   sent or waiting (`{ context, sent, end(outcome, quiet), ... }`)
 *
 * @typedef {object} ExecCall
 * @property {string} opId
 * @property {any} args
 * @property {any} ports
 * @property {any} context ToolContext (contract 2.3)
 * @property {ExecState} state
 * @property {any} kit
 * @property {boolean} settled
 * @property {boolean} sent `run` was sent
 * @property {number} ms the armed deadline, or 0
 * @property {any} scope the scope `run` went to
 */

/** @returns {ExecState} */
const makeExecState = () => ({
  scope: undefined,
  deadlineMs: limits.execDeadlineMs,
  running: undefined,
  waiting: new Set(),
  taking: undefined,
  inspecting: new Set(),
});

/**
 * Make sure the session holds a scope: one `ExecHandle.scope()` call at a
 * time, shared by the exec tool and the inspector. Rejects with the
 * handle's error.
 * @param {ExecState} state
 * @param {any} handle
 * @returns {Promise<void>}
 */
export const takeScope = (state, handle) => {
  if (state.scope !== undefined) return Promise.resolve();
  if (state.taking === undefined) {
    const taking = E(handle)
      .scope()
      .then(lease => {
        if (state.scope === undefined) state.scope = lease.scope;
        state.deadlineMs = lease.deadlineMs;
      })
      .finally(() => {
        if (state.taking === taking) state.taking = undefined;
      });
    state.taking = taking;
  }
  return /** @type {Promise<void>} */ (state.taking);
};

/**
 * Drop `scope` if it is still the session's and have the handle retire it.
 * @param {ExecState} state
 * @param {any} handle
 * @param {any} scope
 */
export const retireScope = (state, handle, scope) => {
  if (scope === undefined || state.scope !== scope) return;
  state.scope = undefined;
  E.sendOnly(handle).retire(scope);
};

/** @param {any} text */
const failed = text => harden({ status: 'failed', text });

/**
 * Drop `scope` if it is still current and have the handle retire its vat.
 * @param {ExecCall} call
 * @param {any} scope
 */
const retire = (call, scope) =>
  retireScope(call.state, call.context.services.execVat, scope);

/** @param {ExecState} state */
const pump = state => {
  if (state.running !== undefined || state.waiting.size === 0) return;
  const [call] = state.waiting;
  state.waiting.delete(call);
  state.running = call;
  void start(call);
};

/**
 * @param {ExecCall} call
 * @param {any} outcome
 * @param {boolean} [quiet] no disarm (deadline fired, or the ports are dead)
 */
const settle = (call, outcome, quiet = false) => {
  if (call.settled) return;
  call.settled = true;
  const { state, context } = call;
  if (!quiet && call.ms > 0 && context.endpoint !== undefined) {
    E.sendOnly(context.endpoint).disarm(
      harden({ turn: context.turn, opId: call.opId }),
    );
  }
  call.kit.resolve(outcome);
  state.waiting.delete(call);
  if (state.running === call) {
    state.running = undefined;
    pump(state);
  }
};

/**
 * Send `run` to the current scope (contract 6.1 crank D / D').
 * @param {ExecCall} call
 * @param {string} [notice]
 */
const run = (call, notice) => {
  const { ports, state } = call;
  const { scope } = state;
  call.scope = scope;
  call.sent = true;
  /** @type {Record<string, any>} */
  const request = {
    args: call.args,
    writers: ports.writers,
    timer: ports.timer,
  };
  if (isStaged(call.args) && ports.content !== undefined)
    request.content = ports.content;
  if (notice !== undefined) request.notice = notice;
  // M5: the session's label map as its exec vat reads it (W5.5's part).
  const powers = call.context.runtime?.powers;
  if (powers !== undefined) request.powers = powers;
  E(scope)
    .run(harden(request))
    .then(
      outcome => {
        if (outcome?.status === 'exhausted') {
          // The name table never shrinks: this scope is done (J-0390).
          retire(call, scope);
          settle(call, failed(texts.execExhausted));
          return;
        }
        if (outcome?.status === 'busy') {
          if (call.settled) return;
          retire(call, scope);
          if (notice !== undefined) settle(call, failed(texts.execBusyReset));
          else void start(call, texts.execBusyReset);
          return;
        }
        // The exec vat prefixes the notice except on argument failures.
        const prefix =
          notice !== undefined &&
          typeof outcome?.text === 'string' &&
          !outcome.text.startsWith(notice);
        settle(
          call,
          prefix
            ? harden({ ...outcome, text: `${notice}\n\n${outcome.text}` })
            : outcome,
        );
      },
      error => {
        if (isRetiredBreak(error)) {
          // The exec vat is lost (halt or crash give-up, D-17): never recovery.
          retire(call, scope);
          settle(call, failed(texts.execTerminated));
        } else {
          settle(call, failed(messageOf(error)));
        }
      },
    );
};

/**
 * Take a scope if the session holds none, arm the deadline once, run.
 * @param {ExecCall} call
 * @param {string} [notice]
 */
const start = async (call, notice) => {
  await null;
  const { state, context } = call;
  if (state.scope === undefined) {
    try {
      await takeScope(state, context.services.execVat);
    } catch (error) {
      settle(call, failed(textOf.execUnavailable(messageOf(error))));
      return;
    }
  }
  if (call.settled) return;
  if (call.ms === 0 && context.endpoint !== undefined) {
    call.ms = state.deadlineMs;
    E.sendOnly(context.endpoint).armDeadline(
      harden({ turn: context.turn, opId: call.opId, ms: call.ms }),
    );
  }
  run(call, notice);
};

/**
 * Settle every call of `active`'s turn: waiting ones first (they never ran),
 * then the running one, so settling it does not start a call of this turn.
 * Nothing to do when the turn has no running tool call.
 * @param {ExecState} state
 * @param {any} active
 * @param {any} ranText
 * @param {boolean} quiet
 */
const abandon = (state, active, ranText, quiet) => {
  const running = active.calls?.running;
  if (running === undefined || running.size === 0) return;
  // Inspector calls of the turn (M5): never interrupted in the exec vat,
  // their late answers ignored.
  for (const call of state.inspecting) {
    if (call.context.turn === active.turn)
      call.end(failed(call.sent ? ranText : NOT_RUN_TEXT), quiet);
  }
  for (const call of state.waiting) {
    if (call.context.turn === active.turn)
      settle(call, failed(NOT_RUN_TEXT), quiet);
  }
  const call = state.running;
  if (call !== undefined && call.context.turn === active.turn) {
    // Tell the exec vat first (J-0391): a later `run` from this vat to the
    // same scope arrives after it, so the next call is not busy.
    if (call.sent && call.scope !== undefined && call.scope === state.scope)
      E.sendOnly(call.scope).abandon();
    settle(call, failed(call.sent ? ranText : NOT_RUN_TEXT), quiet);
  }
};

/**
 * The tool-table entry (contract 8.2, 12).
 * @type {ToolTableEntry}
 */
export const execEntry = harden({
  name: 'exec',
  site: 'guest',
  describe: () => execDescription,
  /**
   * @param {any} ports
   * @param {any} services
   */
  available: (ports, services) =>
    services?.execVat !== undefined &&
    ports?.writers !== undefined &&
    ports?.timer !== undefined,
  /**
   * @param {{ opId: string, args: any }} request
   * @param {any} ports
   * @param {any} context
   */
  execute: ({ opId, args }, ports, context) => {
    const bytes = /** @type {number} */ (fieldBytes(args));
    if (bytes > limits.execSourceBytes)
      return Promise.resolve(
        failed(textOf.execSourceTooLarge(bytes, limits.execSourceBytes)),
      );
    const state = context.runtime.exec.state();
    const kit = makePromiseKit();
    /** @type {ExecCall} */
    const call = {
      opId,
      args,
      ports,
      context,
      state,
      kit,
      settled: false,
      sent: false,
      ms: 0,
      scope: undefined,
    };
    state.waiting.add(call);
    pump(state);
    return kit.promise;
  },
  /**
   * @param {{ opId: string }} request
   * @param {any} context
   */
  deadline: ({ opId }, context) => {
    const call = context.runtime.exec.state().running;
    if (call === undefined || call.opId !== opId) return;
    if (call.context.turn !== context.turn || call.settled) return;
    // Retire first: settling starts the next call, which must not reuse it.
    retire(call, call.scope);
    settle(call, failed(textOf.execTimeout(call.ms)), true);
  },
});

/**
 * The `exec` runtime part (`runtime-parts.js`): the session's exec state
 * and the hooks that settle a turn's calls (contract 8.4).
 */
export const execPart = harden({
  name: /** @type {const} */ ('exec'),
  make: () => {
    const state = makeExecState();
    return harden({
      /** The session's exec state (mutable; shared with the inspector). */
      state: () => state,
      hooks: harden({
        /** @param {HookTurn} turn */
        onCancel: turn =>
          abandon(state, turn.active, texts.execAbandoned, false),
        /** @param {HookTurn} turn recovery wrote the unknown results */
        onRecover: turn =>
          abandon(state, turn.active, texts.toolOutcomeUnknown, true),
      }),
    });
  },
});
