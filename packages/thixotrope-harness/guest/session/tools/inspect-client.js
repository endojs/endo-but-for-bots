// @ts-check
/**
 * The session side of the inspector (M5 W5.4; `m5-interfaces.md` D-M5-2,
 * 2.7). The session vat never makes an answered call to an object it did
 * not mint; it asks its exec vat to (`ExecScope.inspect`), and receives a
 * bounded, rendered `InspectOutcome` built by the exec program.
 *
 * `inspectFor(context)` (`context` is the tool's `ToolContext`, or for a
 * call outside a turn, such as a grant's schema read, any record with
 * `services`) answers a function `(request) -> Promise<outcome>`. The
 * request is the `InspectRequest` fields `{ op, target, writers, args?,
 * method?, content? }` plus, for a call a tool issued, its `opId` (it arms
 * the deadline and lets the tool entry's `deadline` hook find the call: see
 * `inspectDeadline`). `writers` (and `content` for staged `args`) are the
 * round's ports, which the caller holds.
 *
 * It shares `tools/exec.js`' per-session state: the current scope from the
 * session's `ExecHandle`, taken on first use and shared with `exec`; and the
 * cancel and recovery hooks (`execHooks`) settle its calls of the turn.
 * Endings:
 * - the answer, as the exec program built it;
 * - a retired break (the exec vat is lost: a hostile answer halted it, or
 *   its worker was given up) -> retire the scope,
 *   `failed(texts.inspectTerminated)`;
 * - `{ status: 'exhausted' }` -> retire, `failed(texts.execExhausted)`;
 * - turn cancel -> `failed(texts.execAbandoned)`, recovery ->
 *   `failed(texts.toolOutcomeUnknown)` (a call never sent: the not-run
 *   text); the call in the exec vat is not interrupted and its late answer
 *   is ignored;
 * - the deadline (`readSources`, `toolExecute` only, armed as `run` arms
 *   it: a hanging target is bounded by the exec deadline) -> retire,
 *   `failed(textOf.execTimeout(ms))`. `methods`, `describe` and
 *   `toolSchema` arm none.
 *
 * At most `inspectWindow` calls of a session are in flight; more wait, in
 * issue order. Guest rules.
 */
import { texts, textOf } from '../../lib/guards/session.js';
import { limits } from '../../lib/limits.js';
import { isRetiredBreak } from '../../lib/retired.js';
import { NOT_RUN_TEXT, execStateOf, retireScope, takeScope } from './exec.js';
import { messageOf } from '../../lib/bounded.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
/** @import { ExecState } from './exec.js' */
const { E, makePromiseKit } = /** @type {GuestGlobals} */ (globalThis);

/** Operations that call into the target's own work: they arm the deadline. */
const DEADLINE_OPS = harden(['readSources', 'toolExecute']);

/** @param {string} text */
const failed = text => harden({ status: 'failed', text });

/**
 * Calls in flight (sent, or taking the scope) per session state.
 * @param {ExecState} state
 */
const inFlight = state => {
  let n = 0;
  for (const call of state.inspecting) if (call.started) n += 1;
  return n;
};

/** @param {any} state */
const pump = state => {
  let room = limits.inspectWindow - inFlight(state);
  for (const call of state.inspecting) {
    if (room <= 0) return;
    if (!call.started) {
      call.started = true;
      room -= 1;
      void start(call);
    }
  }
};

/**
 * @param {{ settled: boolean, ms: number, opId?: string, context: any, state: ExecState, kit: any }} call
 * @param {any} outcome
 * @param {boolean} quiet no disarm (deadline fired, or the ports are dead)
 */
const settle = (call, outcome, quiet) => {
  if (call.settled) return;
  call.settled = true;
  const { context, state } = call;
  if (!quiet && call.ms > 0 && context.endpoint !== undefined)
    E.sendOnly(context.endpoint).disarm(
      harden({ turn: context.turn, opId: call.opId }),
    );
  state.inspecting.delete(call);
  call.kit.resolve(outcome);
  pump(state);
};

/**
 * Take a scope if the session holds none, arm the deadline, send.
 * @param {any} call
 */
const start = async call => {
  await null;
  const { state, context, handle } = call;
  if (state.scope === undefined) {
    try {
      await takeScope(state, handle);
    } catch (error) {
      settle(call, failed(textOf.execUnavailable(messageOf(error))), false);
      return;
    }
  }
  if (call.settled) return;
  if (
    call.deadline &&
    context.endpoint !== undefined &&
    context.turn !== undefined
  ) {
    call.ms = state.deadlineMs;
    E.sendOnly(context.endpoint).armDeadline(
      harden({ turn: context.turn, opId: call.opId, ms: call.ms }),
    );
  }
  const { scope } = state;
  call.scope = scope;
  call.sent = true;
  E(scope)
    .inspect(call.request)
    .then(
      outcome => {
        if (outcome?.status === 'exhausted') {
          // The name table never shrinks: this scope is done (J-0390).
          retireScope(state, handle, scope);
          settle(call, failed(texts.execExhausted), false);
          return;
        }
        settle(call, outcome, false);
      },
      error => {
        if (isRetiredBreak(error)) {
          // The exec vat is lost (a hostile answer, or a crash give-up).
          retireScope(state, handle, scope);
          settle(call, failed(texts.inspectTerminated), false);
        } else {
          settle(call, failed(messageOf(error)), false);
        }
      },
    );
};

/**
 * The inspector of one tool call (or one call outside a turn).
 * @param {any} context the ToolContext (`services.execVat` at least)
 * @returns {(request: any) => Promise<any>}
 */
export const inspectFor = context => request => {
  const handle = context.services?.execVat;
  if (handle === undefined)
    return Promise.resolve(failed(textOf.execUnavailable('no exec vat')));
  const state = execStateOf(handle);
  const { op, target, writers, args, method, content, opId } = request;
  /** @type {Record<string, any>} */
  const sent = { op, target, writers };
  if (args !== undefined) sent.args = args;
  if (method !== undefined) sent.method = method;
  if (content !== undefined) sent.content = content;
  const kit = makePromiseKit();
  const call = {
    context,
    handle,
    state,
    request: harden(sent),
    opId,
    deadline: opId !== undefined && DEADLINE_OPS.includes(op),
    kit,
    settled: false,
    started: false,
    sent: false,
    ms: 0,
    scope: undefined,
    /**
     * @param {any} outcome
     * @param {boolean} quiet
     */
    end: (outcome, quiet) => settle(call, outcome, quiet),
  };
  state.inspecting.add(call);
  pump(state);
  return kit.promise;
};
harden(inspectFor);

/**
 * The adapter's deadline for an inspector call a tool issued: the tool
 * entry's `deadline` hook calls this with its own arguments. The exec vat
 * is retired (the only way to stop a hanging target) and the call answers
 * `textOf.execTimeout(ms)`. Answers whether it found the call.
 * @param {{ opId: string }} request
 * @param {any} context
 */
export const inspectDeadline = ({ opId }, context) => {
  const handle = context.services?.execVat;
  if (handle === undefined) return false;
  const state = execStateOf(handle);
  for (const call of state.inspecting) {
    if (call.opId === opId && call.context.turn === context.turn) {
      retireScope(state, handle, call.scope);
      settle(call, failed(textOf.execTimeout(call.ms)), true);
      return true;
    }
  }
  return false;
};
harden(inspectDeadline);

/** The text a call never sent answers on cancel or recovery (as `exec`). */
export { NOT_RUN_TEXT };
