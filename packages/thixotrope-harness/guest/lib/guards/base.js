// @ts-check
/**
 * The interface contract's guards, shapes, method names and fixed texts
 * that the exec program reaches (and, with them, every program): the bottom
 * of the chain `base.js` < `session.js` < `factory.js` <
 * `../interfaces.js`. Each module holds the entries the programs above it
 * reach and none of the others, so a vat bundles only what it uses (X1;
 * m5-interfaces.md O-1's alternative to raising the program budgets).
 * `../interfaces.js` re-exports every table whole for Node-side code, tests
 * and the gateway's vocabulary.
 *
 * Which module an entry lives in is measured, not chosen: the lowest
 * program whose bundled modules read it, with everything it reads
 * (`test/unit/guards-split.test.js` checks that every name a guest module
 * reads from a table is in the table it imports). An entry a program comes
 * to need moves down to that program's module, unchanged.
 *
 * Also the shared helpers (`text`, `list`, `record`, `count`,
 * `staged`, `R`, `done`, `lazyTable`) the modules above
 * import.
 *
 * Runs in vats (prelude globals) and in Node: a Node process must install the
 * guest prelude on `globalThis` before importing this module
 * (`scripts/guest-prelude.js` `installGuestPrelude()`; tests import
 * `test/unit/_m1a-prelude.js` first).
 *
 * The rules of `../interfaces.js` apply: changing an existing guard is a
 * contract change.
 */
import { limits } from '../limits.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */

const { M } = /** @type {GuestGlobals} */ (globalThis);
if (M === undefined) {
  throw TypeError(
    'guest/lib/guards/base.js needs the guest prelude on globalThis; in Node call installGuestPrelude() from scripts/guest-prelude.js before importing it or guest/lib/interfaces.js',
  );
}

// ---------------------------------------------------------------- helpers

/** @type {Map<number, any>} */
const textShapes = new Map();
/**
 * A string of at most `units` UTF-16 units (one matcher per bound).
 * @param {number} units
 */
export const text = units => {
  if (!textShapes.has(units)) {
    textShapes.set(units, M.string({ stringLengthLimit: units }));
  }
  return textShapes.get(units);
};
/**
 * @param {any} shape
 * @param {number} length
 */
export const list = (shape, length) =>
  M.arrayOf(shape, { arrayLengthLimit: length });
/**
 * A closed record: these keys and no others. `M.splitRecord` admits any
 * further keys unless its rest pattern is given; the empty record as rest
 * refuses them (rule 12.10).
 * @param {Record<string, any>} required
 * @param {Record<string, any>} [optional]
 */
export const record = (required, optional = {}) =>
  M.splitRecord(required, optional, {});

/** Non-negative number: times in ms, counts, rounds, revisions. */
export const count = M.and(M.number(), M.gte(0));

/**
 * M1b: an inline text field (at most `inlineBytes` from M1b on, checked by
 * the sender) or the StagedText that replaces it when larger (D-10, D-15).
 * Called inside lazy builders only (`B` is defined below).
 * @param {any} inline
 */
export const staged = inline => M.or(inline, B.StagedText);

/**
 * A hardened record whose properties are built on first read and then kept.
 * Building every guard eagerly costs a vat about 0.55-0.7 s in its loading
 * crank (each `M.interface` about 25 ms, each `M.string` or `M.splitRecord`
 * about 1-1.5 ms; W1a.0 vat probe, JOURNAL J-0201), and most vats use a few.
 * With `below`, the record also answers every property of that table (the
 * same objects, read through): the module chain's tables (`base.js`).
 * @template {Record<string, () => any>} T
 * @template {object} [U={}]
 * @param {T} builders
 * @param {U} [below]
 * @returns {U & { readonly [K in keyof T]: ReturnType<T[K]> }}
 */
export const lazyTable = (builders, below) => {
  /** @type {Map<string, any>} */
  const built = new Map();
  /** @type {any} */
  const table = {};
  if (below !== undefined) {
    for (const name of Object.keys(/** @type {object} */ (below))) {
      // The names are the guard modules' own table keys, fixed in source.
      // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
      Object.defineProperty(table, name, {
        enumerable: true,
        get: () => /** @type {any} */ (below)[name],
      });
    }
  }
  for (const [name, build] of Object.entries(builders)) {
    if (Object.hasOwn(table, name)) {
      throw Error(`guard table entry ${name} is defined twice`);
    }
    // The names are this module's own table keys, fixed in its source.
    // eslint-disable-next-line thixotrope-harness-guest/no-data-keys
    Object.defineProperty(table, name, {
      enumerable: true,
      get: () => {
        if (!built.has(name)) built.set(name, build());
        return built.get(name);
      },
    });
  }
  return harden(table);
};

/** @param {string} label */
export const R = label => M.remotable(label);
export const done = M.undefined();

// ---------------------------------------------------------------- texts

/**
 * Fixed texts the spec requires (Part I section 4, Appendix A.4), word for
 * word, and the harness's own fixed texts. Builders use these constants and
 * functions; tests compare against them.
 */
export const texts = harden({
  /** R3-41 (Fae tool-makers.js:1650 at 1315bef86): `exec` returned undefined. */
  execNoReturn:
    'done (no return value). Use a top-level return to produce a result (for example: return await E(powers).list();). Final expressions and unreturned nested functions do not return a result; console output goes to daemon logs. Any effects already performed still happened: do not repeat them just to obtain output.',
  /** Fae tool-makers.js:1617: empty `code`. */
  execCodeRequired: 'code is required',
  /** Harness (R4-49): the turn was cancelled while its exec call ran. */
  execAbandoned:
    'exec call abandoned: the turn was cancelled while it ran; the code may still be running and its effects may still happen',
  /** `ExecPowersSource` after its call ended (rule 12.13). */
  powersExpired: 'This exec call has ended; use the powers of the current call',
});

/**
 * Fixed texts with parameters. Each returns the exact string.
 */
export const textOf = harden({
  /**
   * R4-43 (Fae src/tool-arguments.js:20).
   * @param {string} key
   * @param {string} tool
   * @param {readonly string[]} allowed
   */
  unexpectedArgument: (key, tool, allowed) =>
    `Unexpected argument ${JSON.stringify(key)} for ${tool}; allowed arguments: ${allowed.join(', ') || '(none)'}`,
  /**
   * R4-45 (Fae session-factory.js:1091).
   * @param {string} parseError the parser's message
   */
  argumentsNotJson: parseError =>
    `could not parse tool arguments as JSON (${parseError}). Re-send this tool call with valid JSON arguments.`,
  /**
   * R4-45: a thrown error becomes this result, marked failed.
   * @param {string} message
   */
  errorResult: message => `Error: ${message}`,
  /**
   * R4-46: appended to a cut tool output (Fae session/tool-output.js:18).
   * @param {number} originalUnits the untruncated length in UTF-16 units
   */
  truncationMarker: originalUnits =>
    `\n[Tool output truncated from ${originalUnits} characters. Only a prefix is shown; use filtering or pagination for more.]`,
  /**
   * Architecture 6: exec arguments over execSourceBytes.
   * @param {number} bytes
   * @param {number} limit
   */
  execSourceTooLarge: (bytes, limit) =>
    `exec source too large (${bytes} bytes; limit ${limit})`,
  /**
   * Staging failed (blob store or manager); the round or submission fails.
   * @param {string} message
   */
  stagingFailed: message => `could not stage large text: ${message}`,
  /**
   * @param {number} bytes
   * @param {number} limit
   */
  valueTooLarge: (bytes, limit) =>
    `Value too large to store (${bytes} bytes; limit ${limit})`,
  /**
   * @param {string} reason
   */
  toolSchemaInvalid: reason =>
    `The granted tool's schema was refused: ${reason}`,
  /**
   * The exec membrane (D-M5-3): a message model code sends out of its vat.
   * @param {number} bytes
   * @param {number} limit
   */
  membraneTooLarge: (bytes, limit) =>
    `Arguments too large to send to another vat (about ${bytes} bytes; limit ${limit}); stage large data in a blob or send it in parts`,
  /**
   * @param {number} keys
   * @param {number} limit
   */
  membraneTooManyKeys: (keys, limit) =>
    `Arguments carry too many record keys to send to another vat (${keys}; limit ${limit})`,
  /** @param {number} limit */
  membraneTooDeep: limit =>
    `Arguments are nested too deeply to send to another vat (limit ${limit})`,
});

// ---------------------------------------------------------------- shapes

/**
 * M1a's shapes (W1a.0), widened in place by M1b (`staged(...)`) and M2
 * (optional fields; m2-interfaces.md 1.4). `shapes` below holds them with
 * M1b's and M2's.
 */
const m1aShapeBuilders = {
  Reason: () => text(limits.reasonUnits),
  ToolName: () => text(limits.toolNameUnits),
  /** A tool as offered to the model; `parameters` is JSON Schema as text. */
  ToolDescription: () =>
    record({
      name: S.ToolName,
      description: text(limits.toolDescriptionUnits),
      parameters: text(limits.toolParametersUnits),
    }),
  /**
   * A tool outcome (adapter tools and the vat's tool-table entries alike).
   * `failed`: `text` is the error message (the session writes `Error: <text>`).
   * `frame-limit`: `text` is `texts.frameLimit`; the round fails after its
   * other calls settle. M1b: `text` may be a StagedText (m1b-interfaces.md 5).
   */
  ToolOutcome: () =>
    record({
      status: M.or('ok', 'failed', 'frame-limit'),
      text: staged(text(limits.toolOutputUnits)),
    }),
};

/**
 * Method guards of interfaces later milestones extend: the M1a methods, then
 * (in `foldedMethods` below) M1b's, then (in `m2InterfaceBuilders`) M2's,
 * always in that order.
 */
export const methodsOf = harden({});

/** M1a's method names per interface, in declaration order. */
export const m1aMethodNames = harden({});

// ================================================================ M1b
//
// The M1b contract (W1b.0): m1b-interfaces.md section 1.3 says how these
// tables relate to the M1a ones and when an implementer switches.

/** `exec` as offered to the model (W1b.4); its argument names (R3-41, R4-43). */
export const execArgumentNames = harden(['code']);

/**
 * `ExecScope.inspect` operations (D-M5-2): `methods` (`__getMethodNames__`,
 * for `lookup`), `describe` (`describeCapability`: method names and
 * `help(method?)`), `readSources` (`SourceReader.read` per item),
 * `toolSchema` (a granted tool's `schema()`, checked and projected to a
 * `ToolDescription`), `toolExecute` (a granted tool's `execute(args)`).
 */
export const inspectOps = harden([
  'methods',
  'describe',
  'readSources',
  'toolSchema',
  'toolExecute',
  // Mail and subagents (m9-interfaces.md 6.2 S10; WX.1): split a tool's
  // staged JSON arguments into inline JSON and staged strings.
  'splitArgs',
]);

/** M1b's shapes (W1b.0); in `shapes` since M2 W2.0. */
const m1bShapeBuilders = {
  /**
   * Text over inlineBytes (D-15; m1b-interfaces.md 4). `digest` (M1b
   * follow-ups, J-9360): the SHA-256 of the text's UTF-8 bytes, 64 lowercase
   * hex digits, computed by the adapter that wrote the file; every staging
   * from then on carries it. Optional only so records staged before it stay
   * valid. Duplicates compare by it (3.3).
   */
  StagedText: () =>
    record(
      {
        blob: M.remotable('Blob'),
        preview: text(limits.messagePreviewUnits),
        bytes: count,
      },
      { digest: text(64) },
    ),
  /**
   * `ExecScope.run` argument (m1b-interfaces.md 3.4); M5: + the session's
   * `ExecPowersSource`.
   */
  ExecRequest: () =>
    record(
      {
        args: staged(text(limits.inlineBytes)),
        writers: R('BlobWriters'),
        timer: R('Timer'),
      },
      {
        content: R('Content'),
        notice: S.Reason,
        powers: R('ExecPowersSource'),
      },
    ),
  /**
   * `ExecScope.run` answer: a ToolOutcome; `busy` at once while a call runs;
   * `exhausted` when the vat's name table ran out (M1b QC: retire it).
   */
  ExecOutcome: () =>
    M.or(
      S.ToolOutcome,
      record({ status: 'busy' }),
      record({ status: 'exhausted' }),
    ),
  /** `ExecScope.inspect` operation. */
  InspectOp: () => M.or(...inspectOps),
  /**
   * `ExecScope.inspect` argument (D-M5-2): call `target` for the session
   * and answer a bounded, rendered result. `args` is the model's JSON text
   * (`readSources`, `toolExecute`); `method` the method `describe` asks
   * `help` about.
   */
  InspectRequest: () =>
    record(
      {
        op: S.InspectOp,
        target: M.remotable(),
        writers: R('BlobWriters'),
      },
      {
        args: staged(text(limits.inlineBytes)),
        method: text(limits.methodNameUnits),
        content: R('Content'),
      },
    ),
  /** `ExecScope.inspect` answer. */
  InspectOutcome: () =>
    M.or(
      S.ToolOutcome,
      record({
        status: 'ok',
        methods: list(text(limits.methodNameUnits), limits.maxMethodNames),
      }),
      record({ status: 'ok', description: S.ToolDescription }),
      record({ status: 'exhausted' }),
      // `splitArgs` (m9-interfaces.md 6.2 S10; WX.1).
      record({ status: 'split', split: S.SplitArgs }),
    ),
  /**
   * An endowment, inventory or attachment label (R3-22: 80 characters).
   * With `Attachment` and `Attachments`, moved here from `./session.js`
   * unchanged by WX.1: `./mail.js` reads them and `./session.js` imports
   * `./mail.js`, so they live below both (no import cycle).
   */
  EdgeLabel: () => text(limits.endowmentLabelUnits),
  /** One attachment of a message (R3-8): its label and the object. */
  Attachment: () => record({ label: S.EdgeLabel, value: M.remotable() }),
  /** A message's attachments (R4-99: 32 slots). */
  Attachments: () => list(S.Attachment, limits.maxAttachments),
  /**
   * The exec vat's `splitArgs` answer (m9-interfaces.md D-M9-14, seam S10;
   * moved here from `./mail.js` by WX.1): the arguments' JSON with every
   * long string replaced by a placeholder (`"\u0000s<k>"`), and the staged
   * strings in placeholder order (owned by the session).
   */
  SplitArgs: () =>
    record({
      json: text(limits.inlineBytes),
      staged: list(S.StagedText, limits.splitStagedStrings),
    }),
};

/**
 * Method guards of the M1b versions that M2 extends again (M1a's methods
 * first, then M1b's).
 */
export const foldedMethodsOf = harden({});

/** M1b's interface guards (W1b.0); in `interfaces` since M2 W2.0. */
const m1bInterfaceBuilders = {
  // ---- exec (W1b.3 vat, W1b.5 handle) ----

  /** The exec vat's one persistent scope (architecture 6, D-11). */
  ExecScope: () =>
    M.interface('ExecScope', {
      run: M.callWhen(B.ExecRequest).returns(B.ExecOutcome),
      // M1b QC (J-0391): the session gave the running call up (cancel or
      // recovery); sendOnly. The call ends now: its run answers
      // `execAbandoned`, its `sleep` never settles again, the scope is kept.
      abandon: M.call().returns(done),
      // M5 (W5.4, D-M5-2): the session's object tools, run in this vat.
      inspect: M.callWhen(B.InspectRequest).returns(B.InspectOutcome),
    }),
};

/** M1b's method names per interface (M1a's first where M1b extends one). */
export const m1bMethodLists = harden({});

/** M2's new interfaces' method names. */
export const m2NewMethodNames = harden({});

/** Method names of `m2Interfaces`: the folded ones first, then M2's. */
export const m2VersionMethodNames = harden({});

// ================================================================ tables

/**
 * Every shape this module and the modules below it hold, by name, built on
 * first use and kept (see `lazyTable`).
 */
export const shapes = lazyTable({ ...m1aShapeBuilders, ...m1bShapeBuilders });
/** Shorthands inside this module. */
const S = shapes;
const B = shapes;

/**
 * Every interface guard this module and the modules below it hold, by
 * interface name, built on first use and kept. Where M1b or M2 extended an
 * interface this is the latest version (the M2 fold, m2-interfaces.md 1.3).
 */
export const interfaces = lazyTable({ ...m1bInterfaceBuilders });

/** Method names per interface of `interfaces`, in declaration order. */
export const methodNames = harden({
  ...m1aMethodNames,
  ...m1bMethodLists,
  ...m2NewMethodNames,
  ...m2VersionMethodNames,
});
