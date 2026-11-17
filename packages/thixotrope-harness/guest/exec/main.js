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
 * 100 answered sleeps 2-3 x slower in a vat, J-0391.)
 *
 * Arguments are the model's JSON text: inline, or a `StagedText` read through
 * `Content` in pages of at most `blobPageBytes` (one answered page per
 * crank), joined and evaluated in the crank the last page arrives. A result
 * is rendered as Fae renders it, cut to the tool limit (R4-46), and staged
 * through the call's `BlobWriters` in pieces of at most `blobPieceBytes`
 * when it is over `inlineBytes`. Only `{ status, text }` leaves the vat.
 */
import {
  execArgumentNames,
  m1bInterfaces,
  texts,
  textOf,
} from '../lib/interfaces.js';
import { limits } from '../lib/limits.js';
import { boundToolOutput, chunkText, utf8Bytes } from '../lib/bounded.js';
import {
  describeParseFailure,
  messageOf,
  renderToolResult,
  stripCodeFence,
} from './render.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);
// The exo methods are typed loosely; the interface guard checks the values.
const { makeExo } = /** @type {any} */ (globalThis);

/** A staged source whose pages do not reach its end within this many reads. */
export const MAX_SOURCE_PAGES =
  4 * Math.ceil(limits.execSourceBytes / limits.blobPageBytes);

/** `ExecRequest.args` is staged but no `Content` came with it. */
export const NO_CONTENT_TEXT =
  'exec arguments were staged but no content reader was passed';
/** A staged source's pages did not reach its end. */
export const SOURCE_PAGES_TEXT =
  'exec source could not be read: its pages did not reach the end of the text';
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

/**
 * @typedef {{ status: 'ok' | 'failed', text: string | object }} Outcome
 * @typedef {{ blob: object, preview: string, bytes: number }} StagedText
 * @typedef {object} ExecRequest `m1bShapes.ExecRequest` (guard-checked)
 * @property {string | StagedText} args
 * @property {any} writers
 * @property {any} timer
 * @property {any} [content]
 * @property {string} [notice]
 */

/**
 * @param {string} text
 * @returns {Outcome}
 */
const failed = text => harden({ status: 'failed', text });

/** The engine's text when a vat's name table is full (J-0333). */
const KEYS_EXHAUSTED = 'property key space exhausted';

/**
 * Whether `error` (or a message) says this vat's name table is full.
 * @param {unknown} error
 */
export const isKeysExhausted = error =>
  messageOf(error).includes(KEYS_EXHAUSTED);
harden(isKeysExhausted);

const EXHAUSTED = harden({ status: 'exhausted' });

/** A promise that never settles (what a dead `sleep` answers). */
const never = () => new Promise(() => {});

/**
 * One call's life: its `sleep` endowment, which sends nothing and never
 * settles once the call is closed.
 * @param {any} timer
 */
const makeCall = timer => {
  let open = true;
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
  return {
    sleep: harden(sleep),
    isOpen: () => open,
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
 * The model's argument text: inline, or read from its blob in pages.
 * @param {ExecRequest} request
 * @returns {Promise<{ text: string } | { outcome: Outcome }>}
 */
const argumentText = async ({ args, content }) => {
  await null;
  if (typeof args === 'string') return { text: args };
  if (args.bytes > limits.execSourceBytes)
    return {
      outcome: failed(
        textOf.execSourceTooLarge(args.bytes, limits.execSourceBytes),
      ),
    };
  if (content === undefined) return { outcome: failed(NO_CONTENT_TEXT) };
  /** @type {string[]} */
  const pages = [];
  let offset = 0;
  for (let read = 0; read < MAX_SOURCE_PAGES; read += 1) {
    /** @type {{ text: string, next: number, done: boolean }} */
    let page;
    try {
      // eslint-disable-next-line no-await-in-loop -- one answered page per crank
      page = await E(content).read(
        args.blob,
        harden({ offset, maxBytes: limits.blobPageBytes }),
      );
    } catch (error) {
      // The adapter restarted (its Content is gone) or the blob is unknown.
      return { outcome: failed(messageOf(error)) };
    }
    if (page.next > limits.execSourceBytes)
      return {
        outcome: failed(
          textOf.execSourceTooLarge(
            Math.max(page.next, args.bytes),
            limits.execSourceBytes,
          ),
        ),
      };
    pages.push(page.text);
    if (page.done) return { text: pages.join('') };
    if (page.next <= offset) break;
    offset = page.next;
  }
  return { outcome: failed(SOURCE_PAGES_TEXT) };
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
 * The outcome for a model-facing text: inline when it is at most
 * `inlineBytes`, else staged through `writers` in pieces of at most
 * `blobPieceBytes` (one answered piece per crank).
 *
 * `ok`: `text` is the rendered result. `failed`: `text` is the error
 * message; inline it stays the message (the session writes `Error: ...`),
 * staged it is the complete model-facing result (`m1b-interfaces.md` 5.3).
 *
 * @param {'ok' | 'failed'} status
 * @param {string} text
 * @param {any} writers
 * @returns {Promise<Outcome>}
 */
const finish = async (status, text, writers) => {
  await null;
  const bounded = boundToolOutput(text);
  if (bounded === text && utf8Bytes(text) <= limits.inlineBytes)
    return harden({ status, text });
  const modelText =
    status === 'ok' ? bounded : boundToolOutput(textOf.errorResult(text));
  /** @type {any} */
  let writer;
  try {
    writer = await E(writers).open();
    for (const piece of chunkText(modelText, limits.blobPieceBytes)) {
      // eslint-disable-next-line no-await-in-loop -- one answered piece per crank
      await E(writer).append(piece);
    }
    const staged = await E(writer).close();
    return harden({ status, text: staged });
  } catch (error) {
    if (writer !== undefined) E.sendOnly(writer).abort();
    return failed(textOf.stagingFailed(messageOf(error)));
  }
};

/**
 * Make this vat's one persistent scope.
 * @returns {any} the `ExecScope` exo (`m1bInterfaces.ExecScope`)
 */
export const makeExecScope = () => {
  const compartment = new Compartment({
    __options__: true,
    globals: harden({ BigInt }),
  });
  /** M1b: an empty live facet (M5 passes the session's label map per call). */
  const powers = harden({});
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
      return failed(describeParseFailure(code, messageOf(error)));
    }
    /** @type {'ok' | 'failed'} */
    let status;
    /** @type {string} */
    let text;
    try {
      const result = await body(
        powers,
        E,
        harden,
        discardingConsole,
        call.sleep,
      );
      if (!call.isOpen()) return failed(texts.execAbandoned);
      status = 'ok';
      text =
        result === undefined
          ? texts.execNoReturn
          : await renderToolResult(result);
    } catch (error) {
      if (isKeysExhausted(error)) return EXHAUSTED;
      status = 'failed';
      text = messageOf(error);
    }
    // The call's model code is over: its sleeps die before anything else.
    call.close();
    if (notice !== undefined) text = `${notice}\n\n${text}`;
    return finish(status, text, writers);
  };

  return makeExo('ExecScope', m1bInterfaces.ExecScope, {
    /**
     * @param {ExecRequest} request
     * @returns {Promise<Outcome | { status: 'busy' } | typeof EXHAUSTED>}
     */
    async run(request) {
      if (current !== undefined) return harden({ status: 'busy' });
      const call = makeCall(request.timer);
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
  });
};
harden(makeExecScope);
