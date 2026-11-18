// @ts-check
/**
 * The exec program (M1b W1b.3; `designs/m1b-interfaces.md` 3.4, 6.1, 6.2,
 * 8.1; architecture section 6, D-11). `scripts/bundle-guest.mjs exec`
 * bundles this module; the factory's pool evaluates the bundle in a fresh
 * worker vat (one evaluating crank) and calls `makeExecScope()` on its
 * namespace. The returned `ExecScope` is the vat's one persistent scope.
 *
 * One `Compartment` per vat, made here: its global object is the scope that
 * persists. `globalThis.x = 5` in one call is `x` in the next, across turns
 * and clean or SIGKILL restarts, because the vat heap is durable. Each call
 * is wrapped as the body of an async function, so top-level `await` and
 * `return` work and top-level `const`/`let` are per call.
 *
 * One call at a time: while a `run` is unsettled, another `run` answers
 * `{ status: 'busy' }` in the crank it arrives and evaluates nothing. A
 * synchronous runaway never answers: it exceeds the crank budget and the vat
 * halts (`MeterAbort`); only this vat is lost and the session retires it.
 * A key flood does not halt the vat: the engine's "property key space
 * exhausted" RangeError is catchable, and the name table never shrinks, so
 * any call that meets it answers `{ status: 'exhausted' }` and the session
 * retires the scope (M1b QC, J-0390).
 *
 * A call ends when its body's promise settles or the session abandons it
 * (`abandon()`, sendOnly, on cancel or recovery: the run answers
 * `execAbandoned` at once and the scope stays). Model code cannot outlive
 * its call (M1b QC, J-0391): `sleep` is the only endowment that reaches
 * outside the vat, and a sleep asked for after the call ended never settles
 * (and sends nothing). Sleeps already in flight still answer, so code the
 * call started runs at most until its next `sleep`, then stops, instead of
 * keeping the vat cranking; a `sleep` kept on `globalThis` is dead in later
 * calls. (Fencing the answers in flight too, with a `then` per sleep, made
 * 100 answered sleeps 2-3 x slower in a vat, J-0391.) That one more step
 * cannot send either (M1b follow-ups, J-9368): `E` and `powers` are per
 * call too, and a closed call's `E` sends to a promise that never settles;
 * `HandledPromise` and `Compartment` are not in the scope (J-9367). What the
 * step can still do is change the scope's own globals.
 *
 * Arguments are the model's JSON text: inline, or a `StagedText` read through
 * `Content` in pages of at most `blobPageBytes` (one answered page per
 * crank), joined and evaluated in the crank the last page arrives. A result
 * is rendered as Fae renders it, cut to the tool limit (R4-46), and staged
 * through the call's `BlobWriters` in pieces of at most `blobPieceBytes`
 * when it is over `inlineBytes`. Only `{ status, text }` leaves the vat.
 */
import { execArgumentNames, texts, textOf } from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import {
  EXHAUSTED,
  argumentText,
  describeParseFailure,
  execGuards,
  failed,
  finish,
  isKeysExhausted,
  messageOf,
  redactHostPaths,
  renderToolResult,
  stripCodeFence,
} from './render.js';
import { makeMembrane } from './membrane.js';
import { makeCallPowers } from './powers.js';
import { makeInspector } from './inspect.js';

// M1b's exports, kept for its tests.
export { NO_CONTENT_TEXT, isKeysExhausted } from './render.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);
// The exo methods are typed loosely; the interface guard checks the values.
const { makeExo } = /** @type {any} */ (globalThis);

/** The arguments parsed to something other than a JSON object. */
export const NOT_AN_OBJECT_TEXT = 'exec arguments must be a JSON object';

/** The wrapper's head: the code is the body of an async function. */
const WRAP_HEAD = '(async (powers, E, harden, console, sleep) => {\n';
const WRAP_TAIL = '\n})';

/**
 * The `console` endowment: every method accepts anything and discards it
 * (R3-42: console output never reaches the model; a vat has no daemon log;
 * `m1b-interfaces.md` decision 16.3).
 */
const discardingConsole = harden({
  log: (/** @type {unknown[]} */ ..._args) => undefined,
  info: (/** @type {unknown[]} */ ..._args) => undefined,
  warn: (/** @type {unknown[]} */ ..._args) => undefined,
  error: (/** @type {unknown[]} */ ..._args) => undefined,
  debug: (/** @type {unknown[]} */ ..._args) => undefined,
});

/**
 * Milliseconds for `Timer.sleep`: a number in `0..maxDelayMs`; anything that
 * is not a number (or throws when converted) is 0.
 * @param {unknown} ms
 * @returns {number}
 */
export const clampDelay = ms => {
  let value = 0;
  try {
    value = Number(ms) || 0;
  } catch {
    value = 0;
  }
  return Math.min(limits.maxDelayMs, Math.max(0, value));
};
harden(clampDelay);

/** @import { Outcome, StagedText } from './render.js' */

/**
 * @typedef {object} ExecRequest `m5Shapes.ExecRequest` (guard-checked)
 * @property {string | StagedText} args
 * @property {any} writers
 * @property {any} timer
 * @property {any} [content]
 * @property {string} [notice]
 * @property {any} [powers] the session's `ExecPowersSource` (M5)
 */

/** A promise that never settles (what a dead `sleep` answers). */
const never = () => new Promise(() => {});

/**
 * Globals of the scope's compartment that model code must not see (M1b
 * follow-ups, J-9367): `Compartment` (new evaluators with fresh globals,
 * outside the per-call endowments), `lockdown` and `repairIntrinsics` (the
 * vat's own setup), `HandledPromise` (eventual sends without the call's
 * `E`, so past its fence). Each is deleted from the compartment's global
 * object, or shadowed with `undefined` where it cannot be deleted.
 */
export const HIDDEN_GLOBALS = harden([
  'Compartment',
  'lockdown',
  'repairIntrinsics',
  'HandledPromise',
]);

/**
 * Take the hidden globals off a compartment's global object.
 * @param {any} global
 */
const hideGlobals = global => {
  for (const name of HIDDEN_GLOBALS) {
    try {
      delete global[name];
    } catch {
      // Not configurable: shadowed below if writable.
    }
    if (global[name] !== undefined) {
      try {
        global[name] = undefined;
      } catch {
        // Neither: the exec scope test lists it as still visible.
      }
    }
  }
};

/**
 * One call's life: its `sleep`, `E` and `powers` endowments, which send
 * nothing and never settle once the call is closed (J-0391; `E` and
 * `powers` M1b follow-ups, J-9368). A closed call's `E(x).m()` is an
 * eventual send to a promise that never settles: nothing leaves the vat,
 * nothing answers, and no answer is wrapped while the call is open.
 *
 * M5 (W5.4, `m5-interfaces.md` 2.7): with the session's `ExecPowersSource`
 * the call's `powers` is `{ lookup, list, store, remove }` over it
 * (`powers.js`), and the model's `E` is the call's membrane (`membrane.js`):
 * both are built on the call's `E`, so they die with the call. Without it
 * (an M1b session) `powers` stays `{}` and `E` is the call's `E`.
 * @param {any} timer
 * @param {any} [powersSource]
 */
const makeCall = (timer, powersSource) => {
  let open = true;
  /** Where a closed call's sends go: nowhere, forever. */
  const nowhere = never();
  /** @type {(outcome: Outcome) => void} */
  let resolveAbandoned = () => {};
  /** @type {Promise<Outcome>} */
  const abandoned = new Promise(resolve => {
    resolveAbandoned = resolve;
  });
  /** @param {unknown} ms */
  const sleep = ms => {
    if (!open) return never();
    return E(timer).sleep(clampDelay(ms));
  };
  /** @param {unknown} target */
  const callE = target => E(open ? target : nowhere);
  callE.sendOnly = (/** @type {unknown} */ target) =>
    E.sendOnly(open ? target : nowhere);
  callE.get = (/** @type {unknown} */ target) => E.get(open ? target : nowhere);
  callE.resolve = (/** @type {unknown} */ value) =>
    open ? E.resolve(value) : nowhere;
  callE.when = (
    /** @type {unknown} */ value,
    /** @type {any} */ onFulfilled,
    /** @type {any} */ onRejected,
  ) => (open ? E.when(value, onFulfilled, onRejected) : nowhere);
  const isOpen = () => open;
  harden(callE);
  const membrane =
    powersSource === undefined ? undefined : makeMembrane({ callE });
  return {
    sleep: harden(sleep),
    E: membrane === undefined ? callE : membrane.E,
    // Per call, so a closed call holds none that still answer (J-9368).
    powers:
      membrane === undefined
        ? harden({})
        : makeCallPowers({ source: powersSource, callE, isOpen, membrane }),
    /** @param {unknown} result a wrapper renders as its target */
    unwrap: result =>
      membrane === undefined ? result : membrane.unwrap(result),
    isOpen,
    abandoned,
    close: () => {
      open = false;
    },
    /** @param {Outcome} outcome */
    abandon: outcome => {
      open = false;
      resolveAbandoned(outcome);
    },
  };
};

/**
 * The `code` argument from the model's JSON (closed schema: `code` only).
 * @param {string} argsText
 * @returns {{ code: string } | { outcome: Outcome }}
 */
const codeOf = argsText => {
  let parsed;
  try {
    // Model data lands here on purpose (rule 12.10: a key flood halts only
    // this vat, which is then retired).
    parsed = JSON.parse(argsText);
  } catch (error) {
    return { outcome: failed(textOf.argumentsNotJson(messageOf(error))) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    return { outcome: failed(NOT_AN_OBJECT_TEXT) };
  for (const key of Object.keys(parsed)) {
    if (!execArgumentNames.includes(key))
      return {
        outcome: failed(
          textOf.unexpectedArgument(key, 'exec', execArgumentNames),
        ),
      };
  }
  const { code } = parsed;
  if (typeof code !== 'string' || code === '')
    return { outcome: failed(texts.execCodeRequired) };
  return { code };
};

/**
 * Make this vat's one persistent scope.
 * @returns {any} the `ExecScope` exo (`m5Interfaces.ExecScope`)
 */
export const makeExecScope = () => {
  const compartment = new Compartment({
    __options__: true,
    globals: harden({ BigInt }),
  });
  hideGlobals(compartment.globalThis);
  /** @type {ReturnType<typeof makeCall> | undefined} the running call */
  let current;

  /**
   * One call, from arguments to outcome. Nothing is evaluated or rendered
   * once the call was abandoned.
   * @param {ExecRequest} request
   * @param {ReturnType<typeof makeCall>} call
   * @returns {Promise<Outcome | typeof EXHAUSTED>}
   */
  const runOnce = async (request, call) => {
    const { writers, notice } = request;
    const source = await argumentText(request);
    if ('outcome' in source) return source.outcome;
    if (!call.isOpen()) return failed(texts.execAbandoned);
    // From here to the call, nothing awaits: a staged source is joined,
    // parsed and evaluated in the crank its last page arrived (S3).
    const argument = codeOf(source.text);
    if ('outcome' in argument) return argument.outcome;
    const { code } = argument;
    /** @type {(...endowments: unknown[]) => unknown} */
    let body;
    try {
      body = compartment.evaluate(
        [WRAP_HEAD, stripCodeFence(code), WRAP_TAIL].join(''),
      );
    } catch (error) {
      if (isKeysExhausted(error)) return EXHAUSTED;
      return failed(
        describeParseFailure(code, redactHostPaths(messageOf(error))),
      );
    }
    /** @type {'ok' | 'failed'} */
    let status;
    /** @type {string} */
    let text;
    try {
      const result = await body(
        call.powers,
        call.E,
        harden,
        discardingConsole,
        call.sleep,
      );
      if (!call.isOpen()) return failed(texts.execAbandoned);
      status = 'ok';
      text =
        result === undefined
          ? texts.execNoReturn
          : await renderToolResult(call.unwrap(result));
    } catch (error) {
      if (isKeysExhausted(error)) return EXHAUSTED;
      status = 'failed';
      text = messageOf(error);
    }
    // The call's model code is over: its sleeps die before anything else.
    call.close();
    // No host file paths reach the model (J-9367): stacks a result carries,
    // engine messages.
    text = redactHostPaths(text);
    if (notice !== undefined) text = `${notice}\n\n${text}`;
    return finish(status, text, writers);
  };

  return makeExo('ExecScope', execGuards().ExecScope, {
    /**
     * @param {ExecRequest} request
     * @returns {Promise<Outcome | { status: 'busy' } | typeof EXHAUSTED>}
     */
    async run(request) {
      if (current !== undefined) return harden({ status: 'busy' });
      const call = makeCall(request.timer, request.powers);
      current = call;
      await null;
      try {
        return await Promise.race([
          runOnce(request, call).catch(error =>
            isKeysExhausted(error) ? EXHAUSTED : failed(messageOf(error)),
          ),
          call.abandoned,
        ]);
      } finally {
        call.close();
        if (current === call) current = undefined;
      }
    },
    /** The session gave the running call up (cancel, recovery). */
    abandon() {
      const call = current;
      if (call === undefined) return;
      current = undefined;
      call.abandon(failed(texts.execAbandoned));
    },
    /**
     * Call `request.target` for the session and answer a bounded, rendered
     * outcome (D-M5-2; `inspect.js`). Runs beside `run`, never `busy`; the
     * session's client keeps at most `inspectWindow` in flight.
     * @param {any} request `m5Shapes.InspectRequest`
     */
    inspect(request) {
      const { writers, content } = request;
      return makeInspector({ writers, content }).inspect(request);
    },
  });
};
harden(makeExecScope);
