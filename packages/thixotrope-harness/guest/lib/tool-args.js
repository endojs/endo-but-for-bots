// @ts-check
/**
 * Reading an M5 built-in tool's arguments without building a record from
 * model JSON (W5.3; `designs/m5-interfaces.md` 2.4.2, D-M5-4, rule 12.10).
 *
 * `parseClosedArgs(argsText, spec)` scans the model's JSON text once. The
 * top level must be an object; every key at every depth the spec describes
 * is compared, as a string, against the spec's field names before anything
 * is built, so an unknown key answers the R3-26 text
 * (`textOf.unexpectedArgument`) and never becomes a property name in the
 * vat. String literals are decoded by hand (no `JSON.parse` in session
 * code). Values are kept in a `Map` keyed by the spec's own field names.
 *
 * Value kinds:
 * - `'string'`: a JSON string, decoded;
 * - `'integer'`: a JSON number that is a safe integer;
 * - `'raw'`: any JSON value, checked for syntax and kept as the exact
 *   source span (text): `store`'s `value`, `readSources`' `items`;
 * - a nested spec `{ fields }`: an object read by the same rules.
 *
 * Blank arguments read as `{}` (a model may send none for `list`).
 *
 * Pure; runs in vats and in Node.
 */
import { textOf } from './interfaces.js';

/**
 * @typedef {'string' | 'integer' | 'raw' | ArgObjectSpec} ArgKind
 *
 * @typedef {object} ArgField
 * @property {string} name
 * @property {ArgKind} kind
 * @property {boolean} [required]
 *
 * @typedef {object} ArgObjectSpec
 * @property {readonly ArgField[]} fields
 *
 * @typedef {object} ArgSpec
 * @property {string} tool the tool's model-facing name (for the texts)
 * @property {readonly ArgField[]} fields
 *
 * @typedef {{ ok: true, values: Map<string, any> } | { ok: false, text: string }} ArgResult
 */

/** Nesting depth a scanned value may reach (raw spans included). */
export const maxArgDepth = 64;

/** A refusal thrown inside the scan and turned into `{ ok: false }`. */
class Refusal {
  /** @param {string} text */
  constructor(text) {
    this.text = text;
  }
}
harden(Refusal);

/** @param {string} detail */
const notJson = detail => new Refusal(textOf.argumentsNotJson(detail));

const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;

/** @type {Map<string, string>} */
const ESCAPES = new Map([
  ['"', '"'],
  ['\\', '\\'],
  ['/', '/'],
  ['b', '\b'],
  ['f', '\f'],
  ['n', '\n'],
  ['r', '\r'],
  ['t', '\t'],
]);

/**
 * @param {string} argsText
 * @param {ArgSpec} spec
 * @returns {ArgResult}
 */
export const parseClosedArgs = (argsText, spec) => {
  if (typeof argsText !== 'string') {
    return harden({
      ok: false,
      text: textOf.argumentsNotJson('the arguments are not text'),
    });
  }
  const s = argsText;
  let i = 0;

  const ws = () => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i += 1;
      else break;
    }
  };
  /** @param {string} what */
  const unexpected = what =>
    i >= s.length
      ? notJson(`unexpected end of the arguments, expected ${what}`)
      : notJson(`unexpected character at position ${i}, expected ${what}`);
  /** @param {string} char */
  const expect = char => {
    if (s[i] !== char) throw unexpected(JSON.stringify(char));
    i += 1;
  };

  /**
   * Read a string literal at `i`; decode it when `decode`.
   * @param {boolean} decode
   */
  const readString = decode => {
    if (s[i] !== '"') throw unexpected('a string');
    i += 1;
    /** @type {string[]} */
    const pieces = [];
    let start = i;
    for (;;) {
      if (i >= s.length) throw notJson('unterminated string');
      const c = s.charCodeAt(i);
      if (c === 0x22) {
        if (decode) pieces.push(s.slice(start, i));
        i += 1;
        return decode ? pieces.join('') : '';
      }
      if (c < 0x20) {
        throw notJson(`control character in a string at position ${i}`);
      }
      if (c === 0x5c) {
        if (decode) pieces.push(s.slice(start, i));
        const e = s[i + 1];
        if (e === 'u') {
          const hex = s.slice(i + 2, i + 6);
          if (!HEX4.test(hex)) {
            throw notJson(`bad unicode escape at position ${i}`);
          }
          if (decode) pieces.push(String.fromCharCode(parseInt(hex, 16)));
          i += 6;
        } else {
          const decoded = e === undefined ? undefined : ESCAPES.get(e);
          if (decoded === undefined) {
            throw notJson(`bad escape at position ${i}`);
          }
          if (decode) pieces.push(decoded);
          i += 2;
        }
        start = i;
      } else {
        i += 1;
      }
    }
  };

  const readNumber = () => {
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(s);
    if (m === null) throw unexpected('a value');
    i += m[0].length;
    return m[0];
  };

  /** @param {string} word */
  const literal = word => {
    if (s.startsWith(word, i)) {
      i += word.length;
      return;
    }
    throw unexpected('a value');
  };

  /**
   * Check any JSON value at `i` and move past it (raw spans).
   * @param {number} depth
   */
  const skipValue = depth => {
    if (depth > maxArgDepth) {
      throw notJson(`arguments nested deeper than ${maxArgDepth}`);
    }
    ws();
    const c = s[i];
    if (c === '{') {
      i += 1;
      ws();
      if (s[i] === '}') {
        i += 1;
        return;
      }
      for (;;) {
        ws();
        readString(false);
        ws();
        expect(':');
        skipValue(depth + 1);
        ws();
        if (s[i] === ',') {
          i += 1;
        } else {
          expect('}');
          return;
        }
      }
    }
    if (c === '[') {
      i += 1;
      ws();
      if (s[i] === ']') {
        i += 1;
        return;
      }
      for (;;) {
        skipValue(depth + 1);
        ws();
        if (s[i] === ',') {
          i += 1;
        } else {
          expect(']');
          return;
        }
      }
    }
    if (c === '"') {
      readString(false);
      return;
    }
    if (c === 't') {
      literal('true');
      return;
    }
    if (c === 'f') {
      literal('false');
      return;
    }
    if (c === 'n') {
      literal('null');
      return;
    }
    readNumber();
  };

  /**
   * @param {ArgField} field
   * @param {string} expected
   */
  const wrongType = (field, expected) =>
    notJson(`argument "${field.name}" must be ${expected}`);

  /**
   * Read an object whose keys `fields` names, at `i`.
   * @param {readonly ArgField[]} fields
   * @param {number} depth
   * @returns {Map<string, any>}
   */
  const readObject = (fields, depth) => {
    if (depth > maxArgDepth) {
      throw notJson(`arguments nested deeper than ${maxArgDepth}`);
    }
    /** @type {Map<string, any>} */
    const values = new Map();
    expect('{');
    ws();
    if (s[i] === '}') {
      i += 1;
    } else {
      for (;;) {
        ws();
        const key = readString(true);
        const field = fields.find(f => f.name === key);
        if (field === undefined) {
          throw new Refusal(
            textOf.unexpectedArgument(
              key,
              spec.tool,
              fields.map(f => f.name),
            ),
          );
        }
        ws();
        expect(':');
        ws();
        // eslint-disable-next-line no-use-before-define
        values.set(field.name, readField(field, depth + 1));
        ws();
        if (s[i] === ',') {
          i += 1;
        } else {
          expect('}');
          break;
        }
      }
    }
    for (const field of fields) {
      if (field.required && !values.has(field.name)) {
        throw notJson(`argument "${field.name}" is required`);
      }
    }
    return values;
  };

  /**
   * @param {ArgField} field
   * @param {number} depth
   */
  const readField = (field, depth) => {
    const { kind } = field;
    if (kind === 'raw') {
      const start = i;
      skipValue(depth);
      return s.slice(start, i);
    }
    if (kind === 'string') {
      if (s[i] !== '"') throw wrongType(field, 'a string');
      return readString(true);
    }
    if (kind === 'integer') {
      const c = s[i];
      if (c !== '-' && !(c >= '0' && c <= '9')) {
        throw wrongType(field, 'an integer');
      }
      const n = Number(readNumber());
      if (!Number.isSafeInteger(n)) throw wrongType(field, 'an integer');
      return n;
    }
    if (s[i] !== '{') throw wrongType(field, 'an object');
    return readObject(kind.fields, depth);
  };

  try {
    ws();
    if (i === s.length) {
      // No arguments at all: read as `{}`.
      for (const field of spec.fields) {
        if (field.required) {
          throw notJson(`argument "${field.name}" is required`);
        }
      }
      return harden({ ok: true, values: new Map() });
    }
    if (s[i] !== '{') throw notJson('the arguments must be a JSON object');
    const values = readObject(spec.fields, 1);
    ws();
    if (i !== s.length) {
      throw notJson(`unexpected text after the arguments at position ${i}`);
    }
    return harden({ ok: true, values });
  } catch (error) {
    if (error instanceof Refusal) {
      return harden({ ok: false, text: error.text });
    }
    throw error;
  }
};
harden(parseClosedArgs);

/**
 * @param {string} name
 * @param {ArgKind} kind
 * @param {boolean} [required]
 * @returns {ArgField}
 */
const field = (name, kind, required = true) => harden({ name, kind, required });

/**
 * The argument specs of M5's built-in tools, field order as
 * `interfaces-m5.js` `m5ToolArgumentNames` (the R3-26 text lists them in
 * that order; `m5-w53-args.test.js` keeps the two equal).
 */
export const argSpecs = harden({
  list: harden({ tool: 'list', fields: harden([]) }),
  lookup: harden({
    tool: 'lookup',
    fields: harden([field('petName', 'string')]),
  }),
  store: harden({
    tool: 'store',
    fields: harden([field('value', 'raw'), field('petName', 'string')]),
  }),
  remove: harden({
    tool: 'remove',
    fields: harden([field('petName', 'string')]),
  }),
  describeCapability: harden({
    tool: 'describeCapability',
    fields: harden([
      field('petName', 'string'),
      field('method', 'string', false),
    ]),
  }),
  readSources: harden({
    tool: 'readSources',
    fields: harden([field('petName', 'string'), field('items', 'raw')]),
  }),
  adopt: harden({
    tool: 'adopt',
    fields: harden([
      field('messageNumber', 'integer'),
      field('edgeName', 'string'),
      field('petName', 'string'),
    ]),
  }),
  adoptTool: harden({
    tool: 'adoptTool',
    fields: harden([
      field('messageNumber', 'integer'),
      field('edgeName', 'string'),
      field('toolName', 'string'),
    ]),
  }),
});
