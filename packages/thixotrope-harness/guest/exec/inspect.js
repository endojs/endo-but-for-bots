// @ts-check
/**
 * The inspector (M5 W5.4; `m5-interfaces.md` D-M5-2, 2.7). The session vat
 * never makes an answered call to an object it did not mint: an object may
 * answer anything, and one message above about 94 KB halts the vat that
 * decodes it (fact 2). The exec vat calls the target for the session
 * instead, renders and bounds the answer and answers the session with a
 * value of the closed `InspectOutcome` shape, built here, never by the
 * target. A hostile answer halts at most the exec vat; the session then
 * retires it and states the loss (`texts.inspectTerminated`).
 *
 * Operations (`inspectOps`):
 * - `methods`: `__getMethodNames__`, at most `maxMethodNames` names of at
 *   most `methodNameUnits` units (for `lookup`'s rendering).
 * - `describe`: Fae's `describeCapability` (`src/source-tools.js` at
 *   `1315bef86`): method names and `help(method?)` documentation as JSON
 *   `{ methods, documentation, documentationScope, example, truncated }`, at
 *   most `inspectResultUnits`, then the tool limit.
 * - `readSources`: Fae's `readSources` item rules over the raw `items` text;
 *   `SourceReader.read(item)` per item (the callee reads and bounds; this
 *   checks its answer's shape and bounds it again); Fae's `{ results }`
 *   JSON, each item within an even share of `inspectResultUnits`.
 * - `toolSchema`: a granted tool's `schema()`, checked (Fae's `ToolSchema`;
 *   name 1-128 of `[A-Za-z0-9_-]`, R3-27; parameters an object schema of
 *   depth <= 32 and <= 10,000 nodes whose JSON is at most
 *   `grantedParametersUnits`), its description cut to
 *   `grantedDescriptionUnits` with the R4-46 marker: a `ToolDescription`.
 * - `toolExecute`: a granted tool's `execute(args)` with the model's JSON
 *   arguments (parsed here, measured by the membrane's bounds); a string
 *   answer as is, anything else as JSON.
 *
 * Nothing here evaluates model code. A key flood answers `exhausted`, as
 * `run` does.
 */
import { textOf as m1Text } from '../lib/guards/base.js';
import { limitsM5 } from '../lib/limits-m5.js';
import { boundToolOutput } from '../lib/bounded.js';
import {
  EXHAUSTED,
  argumentText,
  bigintsAsDecimalStrings,
  failed,
  finish,
  isKeysExhausted,
  messageOf,
  redactHostPaths,
  textOf,
} from './render.js';
import { measureArguments } from './membrane.js';

/** @import { GuestGlobals } from '@endo/thixotrope/guest.js' */
const { E } = /** @type {GuestGlobals} */ (globalThis);

/** Nesting depth of a granted tool's parameter schema. */
export const SCHEMA_DEPTH = 32;
/** Values in a granted tool's parameter schema. */
export const SCHEMA_NODES = 10_000;

// Fae's texts (`src/source-tools.js`, `src/tool-arguments.js`).
export const INVALID_METHODS_TEXT =
  'Capability returned an invalid method list';
export const UNKNOWN_METHOD_TEXT =
  'Requested method is not in the callable method list';
const NO_DOCUMENTATION =
  'Documentation is unavailable; do not guess method signatures.';
export const ITEMS_TEXT = 'items must contain between 1 and 8 requests';
const PATH_TEXT =
  'path must contain 1\u201364 relative segments without slash, backslash, NUL, dot, or dot-dot';
const SEARCH_TEXT =
  'search must be a nonempty literal string of at most 256 characters';
/** The harness's wording of Fae's unreadable-path text (SourceReader, not blob streams). */
export const UNREADABLE_TEXT =
  'Could not read this source path. Verify the path and that the capability implements SourceReader.read.';
/** Tool arguments that are not a JSON object (Fae `assertToolArguments`). */
export const ARGUMENTS_OBJECT_TEXT = 'Tool arguments must be an object';

const ITEM_KEYS = harden(['path', 'startLine', 'lineCount', 'search']);

/** @param {unknown} value */
const isPlainObject = value =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Fae `boundedInteger`.
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} maximum
 */
const boundedInteger = (value, fallback, maximum) => {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== 'number' ||
    !Number.isInteger(result) ||
    result < 1 ||
    result > maximum
  )
    throw Error(
      `Line/count arguments must be integers between 1 and ${maximum}`,
    );
  return result;
};

/**
 * One `readSources` item checked by Fae's rules: the `SourceReadRequest`.
 * @param {unknown} item
 */
const readRequestOf = item => {
  if (!isPlainObject(item)) throw Error(ARGUMENTS_OBJECT_TEXT);
  const fields = /** @type {Record<string, unknown>} */ (item);
  for (const key of Object.keys(fields)) {
    if (!ITEM_KEYS.includes(key))
      throw Error(
        `Unexpected argument ${JSON.stringify(key)} for readSources item; allowed arguments: ${ITEM_KEYS.join(', ')}`,
      );
  }
  const { path, startLine, lineCount, search } = fields;
  if (path === undefined) throw Error('Missing required argument path');
  if (
    !Array.isArray(path) ||
    path.length < 1 ||
    path.length > limitsM5.readSourcesPathSegments ||
    path.some(
      segment =>
        typeof segment !== 'string' ||
        segment.length < 1 ||
        segment.length > limitsM5.pathSegmentUnits ||
        /[/\\\0]/.test(segment) ||
        segment === '.' ||
        segment === '..',
    )
  )
    throw Error(PATH_TEXT);
  const request = {
    path: harden([...path]),
    startLine: boundedInteger(startLine, 1, limitsM5.readSourcesMaxStartLine),
    lineCount: boundedInteger(
      lineCount,
      limitsM5.readSourcesDefaultLines,
      limitsM5.readSourcesLineCount,
    ),
  };
  if (search === undefined) return harden(request);
  if (
    typeof search !== 'string' ||
    search.length < 1 ||
    search.length > limitsM5.searchUnits
  )
    throw Error(SEARCH_TEXT);
  return harden({ ...request, search });
};

/**
 * Fae `boundSourceResult`: keep the leading lines within `limit` units of
 * JSON, cutting the last one kept.
 * @param {{ lines: { line: number, text: string }[], outputTruncated: boolean }} result
 *   `{ index, ok, lines, scanTruncated, outputTruncated }`
 * @param {number} limit
 */
const boundSourceResult = (result, limit) => {
  if (JSON.stringify(result).length <= limit) return result;
  result.outputTruncated = true;
  while (result.lines.length > 0) {
    const last = /** @type {{ line: number, text: string }} */ (
      result.lines.pop()
    );
    if (JSON.stringify(result).length <= limit) {
      const shortened = { line: last.line, text: '' };
      result.lines.push(shortened);
      if (JSON.stringify(result).length > limit) {
        result.lines.pop();
        return result;
      }
      let low = 0;
      let high = last.text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        shortened.text = last.text.slice(0, middle);
        if (JSON.stringify(result).length <= limit) low = middle;
        else high = middle - 1;
      }
      shortened.text = last.text.slice(0, low);
      return result;
    }
  }
  return result;
};

/**
 * Why a parameter schema is refused, or undefined: depth and node count.
 * @param {unknown} schema
 */
const schemaShapeRefusal = schema => {
  let nodes = 0;
  /** @type {[unknown, number][]} */
  const stack = [[schema, 1]];
  while (stack.length > 0) {
    const [value, depth] = /** @type {[unknown, number]} */ (stack.pop());
    nodes += 1;
    if (nodes > SCHEMA_NODES)
      return `parameters have more than ${SCHEMA_NODES} values`;
    if (depth > SCHEMA_DEPTH)
      return `parameters nest deeper than ${SCHEMA_DEPTH}`;
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) stack.push([item, depth + 1]);
    }
  }
  return undefined;
};

/**
 * A granted tool's schema as a `ToolDescription`, or the refusal reason.
 * @param {any} schema
 * @returns {{ description: object } | { reason: string }}
 */
const describeTool = schema => {
  if (!isPlainObject(schema) || schema.type !== 'function')
    return { reason: 'the schema is not { type: "function", function }' };
  const fn = schema.function;
  if (!isPlainObject(fn)) return { reason: 'the schema has no function' };
  const { name, description, parameters } = fn;
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name))
    return {
      reason: 'the name must be 1 to 128 letters, digits, "_" or "-"',
    };
  if (typeof description !== 'string')
    return { reason: 'the description must be a string' };
  if (!isPlainObject(parameters) || parameters.type !== 'object')
    return { reason: 'the parameters must be a JSON Schema of type "object"' };
  const shape = schemaShapeRefusal(parameters);
  if (shape !== undefined) return { reason: shape };
  /** @type {string | undefined} */
  let text;
  try {
    text = JSON.stringify(parameters);
  } catch {
    text = undefined;
  }
  if (typeof text !== 'string')
    return { reason: 'the parameters are not JSON' };
  if (text.length > limitsM5.grantedParametersUnits)
    return {
      reason: `the parameters are ${text.length} characters of JSON; the limit is ${limitsM5.grantedParametersUnits}`,
    };
  return {
    description: harden({
      name,
      description: boundToolOutput(
        description,
        limitsM5.grantedDescriptionUnits,
      ),
      parameters: text,
    }),
  };
};

/**
 * @typedef {object} InspectRequest `m5Shapes.InspectRequest` (guard-checked)
 * @property {'methods' | 'describe' | 'readSources' | 'toolSchema' | 'toolExecute'} op
 * @property {any} target
 * @property {any} writers
 * @property {any} [args]
 * @property {string} [method]
 * @property {any} [content]
 */

/**
 * The inspector for one request's adapter objects.
 * @param {{ writers: any, content?: any }} options
 */
export const makeInspector = ({ writers, content }) => {
  /** @param {any} target */
  const methodNames = async target => {
    // eslint-disable-next-line no-underscore-dangle
    const names = await E(target).__getMethodNames__();
    if (!Array.isArray(names)) throw Error(INVALID_METHODS_TEXT);
    return {
      count: names.length,
      names: names
        .filter(name => typeof name === 'string')
        .slice(0, limitsM5.maxMethodNames),
    };
  };

  /** @param {InspectRequest} request */
  const methods = async ({ target }) => {
    const { names } = await methodNames(target);
    return harden({
      status: 'ok',
      methods: names.map(name => name.slice(0, limitsM5.methodNameUnits)),
    });
  };

  /** @param {InspectRequest} request Fae `describeCapability` */
  const describe = async ({ target, method }) => {
    const { count, names } = await methodNames(target);
    if (method !== undefined && !names.includes(method))
      return failed(UNKNOWN_METHOD_TEXT);
    let documentation = NO_DOCUMENTATION;
    let documentationScope = 'unavailable';
    if (names.includes('help')) {
      try {
        const text = await E(target).help(
          ...(method === undefined ? [] : [method]),
        );
        if (typeof text === 'string') {
          documentation = text;
          documentationScope = method === undefined ? 'overview' : 'method';
        }
      } catch (error) {
        if (isKeysExhausted(error)) throw error;
        // Some guarded capabilities support only zero-argument help().
        if (method !== undefined) {
          try {
            const text = await E(target).help();
            if (typeof text === 'string') {
              documentation = text;
              documentationScope = 'overview';
            }
          } catch (again) {
            if (isKeysExhausted(again)) throw again;
            // Preserve the discovered callable interface even without docs.
          }
        }
      }
    }
    const limit = limitsM5.describeDocumentationUnits;
    const description = {
      methods: names.map(name => name.slice(0, limitsM5.methodNameUnits)),
      documentation: documentation.slice(0, limit),
      documentationScope,
      example:
        documentationScope === 'overview'
          ? 'const ref = await E(powers).lookup(petName); return await E(ref).help();'
          : 'const ref = await E(powers).lookup(petName); return await E(ref).help(method);',
      truncated:
        count > names.length ||
        documentation.length > limit ||
        names.some(name => name.length > limitsM5.methodNameUnits),
    };
    while (JSON.stringify(description).length > limitsM5.inspectResultUnits) {
      description.truncated = true;
      if (description.documentation.length > 0) {
        description.documentation = description.documentation.slice(
          0,
          Math.floor(description.documentation.length / 2),
        );
      } else description.methods.pop();
    }
    return finish('ok', JSON.stringify(description), writers);
  };

  /** @param {InspectRequest} request */
  const parsedArgs = async ({ args }) => {
    if (args === undefined) return { outcome: failed(ARGUMENTS_OBJECT_TEXT) };
    const source = await argumentText({ args, content });
    if ('outcome' in source) return source;
    try {
      // Model data, parsed in the exec vat on purpose (rule 12.10).
      return { value: JSON.parse(source.text) };
    } catch (error) {
      if (isKeysExhausted(error)) throw error;
      return { outcome: failed(m1Text.argumentsNotJson(messageOf(error))) };
    }
  };

  /** @param {InspectRequest} request Fae `readSources` over `SourceReader` */
  const readSources = async request => {
    const parsed = await parsedArgs(request);
    if ('outcome' in parsed) return parsed.outcome;
    const items = parsed.value;
    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > limitsM5.readSourcesItems
    )
      return failed(ITEMS_TEXT);
    // Leave 100 characters for the outer result envelope and separators.
    const itemBudget = Math.floor(
      (limitsM5.inspectResultUnits - 100) / items.length,
    );
    /** @type {object[]} */
    const results = [];
    for (const [index, item] of items.entries()) {
      let reading = false;
      try {
        const readRequest = readRequestOf(item);
        reading = true;
        // eslint-disable-next-line no-await-in-loop -- one item at a time (Fae)
        const answer = await E(request.target).read(readRequest);
        // An answer of another shape throws below: the unreadable text.
        if (!answer.ok) {
          results.push({
            index,
            ok: false,
            error: String(answer.error ?? UNREADABLE_TEXT).slice(0, 512),
          });
        } else {
          // The callee bounds its answer; bound it again as Fae does.
          /** @type {{ line: number, text: string }[]} */
          const lines = [];
          let characters = 0;
          let outputTruncated = answer.outputTruncated === true;
          for (const {
            line,
            text,
          } of /** @type {{ line: number, text: string }[]} */ (
            answer.lines ?? []
          )) {
            if (typeof line !== 'number') throw Error('not a line');
            if (
              lines.length === readRequest.lineCount ||
              characters === limitsM5.readSourcesItemUnits
            ) {
              outputTruncated = true;
              break;
            }
            const rendered = text.slice(
              0,
              limitsM5.readSourcesItemUnits - characters,
            );
            characters += rendered.length;
            lines.push({ line, text: rendered });
            if (rendered.length < text.length) outputTruncated = true;
          }
          results.push(
            boundSourceResult(
              /** @type {any} */ ({
                index,
                ok: true,
                lines,
                scanTruncated: answer.scanTruncated === true,
                outputTruncated,
              }),
              itemBudget,
            ),
          );
        }
      } catch (error) {
        if (isKeysExhausted(error)) throw error;
        // No stack, locator or arbitrary thrown object data.
        const message =
          !reading && error instanceof Error ? error.message : UNREADABLE_TEXT;
        results.push({ index, ok: false, error: message.slice(0, 512) });
      }
    }
    return finish('ok', JSON.stringify({ results }), writers);
  };

  /** @param {InspectRequest} request */
  const toolSchema = async ({ target }) => {
    const schema = await E(target).schema();
    const described = describeTool(schema);
    if ('reason' in described)
      return failed(textOf.toolSchemaInvalid(described.reason));
    return harden({ status: 'ok', description: described.description });
  };

  /** @param {InspectRequest} request */
  const toolExecute = async request => {
    const parsed = await parsedArgs(request);
    if ('outcome' in parsed) return parsed.outcome;
    if (!isPlainObject(parsed.value)) return failed(ARGUMENTS_OBJECT_TEXT);
    const measured = measureArguments([parsed.value]);
    if ('refusal' in measured) return failed(measured.refusal);
    const answer = await E(request.target).execute(...measured.args);
    /** @type {string | undefined} */
    let text;
    if (typeof answer === 'string') text = answer;
    else {
      try {
        text = JSON.stringify(answer, bigintsAsDecimalStrings);
      } catch {
        text = undefined;
      }
    }
    return finish('ok', text ?? String(answer), writers);
  };

  const operations = harden({
    methods,
    describe,
    readSources,
    toolSchema,
    toolExecute,
  });

  /**
   * @param {InspectRequest} request
   * @returns {Promise<object>}
   */
  const inspect = async request => {
    await null;
    try {
      return await operations[request.op](request);
    } catch (error) {
      if (isKeysExhausted(error)) return EXHAUSTED;
      return finish('failed', redactHostPaths(messageOf(error)), writers);
    }
  };
  return harden({ inspect });
};
harden(makeInspector);
