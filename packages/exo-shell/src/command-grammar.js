// @ts-check
/// <reference types="ses"/>

import { makeError, q, X } from '@endo/errors';

/**
 * @import {
 *   ShellCommandElement,
 *   ShellCommandGrammar,
 *   ShellOptionMember,
 *   ShellSlotType,
 * } from './types.js'
 */

/**
 * Passable command grammars: the unit of a Shell grant.  A grammar is plain
 * copyable pass-style data (records, arrays, strings, booleans — no closures,
 * no RegExp), so it travels in a `provideShell` policy, bakes into the `shell`
 * formula, returns from `inspect()`, and crosses the wire to `attenuate`.
 *
 * A command-name allowlist cannot attenuate a POSIX command — `find` grants
 * arbitrary execution through `-exec` — so the grammar constrains the
 * *argument language*, not just `argv[0]` (design § Command grammars).
 */

const SLOT_TYPES = harden(['string', 'path']);

/**
 * A slot value (a free token, or the remainder after a prefix) must be a
 * non-empty NUL-free string that cannot read as an option token.  `path`
 * additionally confines the value lexically to the granted worktree: no
 * absolute path, no `..` segment.  (Under the host engine this bounds the
 * request, not the started child's OS authority — design § The honest
 * boundary.)
 *
 * @param {ShellSlotType} type
 * @param {string} value
 * @returns {boolean}
 */
const valueMatchesType = (type, value) => {
  if (typeof value !== 'string' || value.length === 0) {
    return false;
  }
  if (value.includes('\u0000')) {
    return false;
  }
  if (value.startsWith('-')) {
    return false;
  }
  if (type === 'path') {
    if (value.startsWith('/')) {
      return false;
    }
    if (value.split('/').some(segment => segment === '..')) {
      return false;
    }
  }
  return true;
};

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string}
 */
const assertToken = (label, value) => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000')
  ) {
    throw makeError(
      X`${q(label)} must be a non-empty string without NUL, got ${q(value)}`,
    );
  }
  return value;
};

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {ShellSlotType}
 */
const assertSlotType = (label, value) => {
  if (!SLOT_TYPES.includes(/** @type {string} */ (value))) {
    throw makeError(
      X`${q(label)} must be one of ${q(SLOT_TYPES)}, got ${q(value)}`,
    );
  }
  return /** @type {ShellSlotType} */ (value);
};

/**
 * @param {string} label
 * @param {unknown} value
 * @param {string[]} allowedKeys
 * @returns {Record<string, unknown>}
 */
const assertRecordKeys = (label, value, allowedKeys) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw makeError(X`${q(label)} must be a record`);
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.includes(key)) {
      throw makeError(X`${q(label)} has unrecognized property ${q(key)}`);
    }
  }
  return record;
};

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
const assertOptionalBoolean = (label, value) => {
  if (value !== undefined && typeof value !== 'boolean') {
    throw makeError(X`${q(label)} must be a boolean when present`);
  }
  return /** @type {boolean | undefined} */ (value);
};

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string | undefined}
 */
const assertOptionalString = (label, value) => {
  if (value !== undefined && typeof value !== 'string') {
    throw makeError(X`${q(label)} must be a string when present`);
  }
  return /** @type {string | undefined} */ (value);
};

/**
 * @param {string} label
 * @param {unknown} member
 * @returns {ShellOptionMember}
 */
const normalizeOptionMember = (label, member) => {
  if (typeof member === 'string') {
    return assertToken(label, member);
  }
  const record = assertRecordKeys(label, member, ['prefix', 'type', 'name']);
  const prefix = assertToken(`${label}.prefix`, record.prefix);
  const type = assertSlotType(`${label}.type`, record.type);
  const name = assertOptionalString(`${label}.name`, record.name);
  return harden({ prefix, type, ...(name !== undefined && { name }) });
};

/**
 * Validate one grammar element and return a fresh hardened copy, so a later
 * mutation of the caller's structure cannot alter the accepted language.
 *
 * @param {string} label
 * @param {unknown} element
 * @param {{ topLevel: boolean, last: boolean }} position
 * @returns {ShellCommandElement}
 */
const normalizeElement = (label, element, position) => {
  if (
    typeof element !== 'object' ||
    element === null ||
    Array.isArray(element)
  ) {
    throw makeError(X`${q(label)} must be a grammar element record`);
  }
  const { kind } = /** @type {{ kind?: unknown }} */ (element);
  switch (kind) {
    case 'literal': {
      const record = assertRecordKeys(label, element, ['kind', 'value']);
      return harden({
        kind: 'literal',
        value: assertToken(`${label}.value`, record.value),
      });
    }
    case 'slot': {
      const record = assertRecordKeys(label, element, [
        'kind',
        'name',
        'type',
        'prefix',
        'optional',
        'description',
      ]);
      const name = assertToken(`${label}.name`, record.name);
      const type = assertSlotType(`${label}.type`, record.type);
      const prefix =
        record.prefix === undefined
          ? undefined
          : assertToken(`${label}.prefix`, record.prefix);
      const optional = assertOptionalBoolean(
        `${label}.optional`,
        record.optional,
      );
      const description = assertOptionalString(
        `${label}.description`,
        record.description,
      );
      return harden({
        kind: 'slot',
        name,
        type,
        ...(prefix !== undefined && { prefix }),
        ...(optional !== undefined && { optional }),
        ...(description !== undefined && { description }),
      });
    }
    case 'options': {
      const record = assertRecordKeys(label, element, [
        'kind',
        'options',
        'optional',
        'repeat',
        'name',
        'description',
      ]);
      if (!Array.isArray(record.options) || record.options.length === 0) {
        throw makeError(X`${q(label)}.options must be a non-empty array`);
      }
      const options = harden(
        record.options.map((member, i) =>
          normalizeOptionMember(`${label}.options[${i}]`, member),
        ),
      );
      const optional = assertOptionalBoolean(
        `${label}.optional`,
        record.optional,
      );
      const repeat = assertOptionalBoolean(`${label}.repeat`, record.repeat);
      const name = assertOptionalString(`${label}.name`, record.name);
      const description = assertOptionalString(
        `${label}.description`,
        record.description,
      );
      return harden({
        kind: 'options',
        options,
        ...(optional !== undefined && { optional }),
        ...(repeat !== undefined && { repeat }),
        ...(name !== undefined && { name }),
        ...(description !== undefined && { description }),
      });
    }
    case 'group': {
      const record = assertRecordKeys(label, element, [
        'kind',
        'elements',
        'optional',
        'repeat',
        'description',
      ]);
      if (!Array.isArray(record.elements) || record.elements.length === 0) {
        throw makeError(X`${q(label)}.elements must be a non-empty array`);
      }
      const elements = harden(
        record.elements.map((inner, i) =>
          normalizeElement(`${label}.elements[${i}]`, inner, {
            topLevel: false,
            last: false,
          }),
        ),
      );
      const optional = assertOptionalBoolean(
        `${label}.optional`,
        record.optional,
      );
      const repeat = assertOptionalBoolean(`${label}.repeat`, record.repeat);
      const description = assertOptionalString(
        `${label}.description`,
        record.description,
      );
      return harden({
        kind: 'group',
        elements,
        ...(optional !== undefined && { optional }),
        ...(repeat !== undefined && { repeat }),
        ...(description !== undefined && { description }),
      });
    }
    case 'rest': {
      if (!position.topLevel || !position.last) {
        throw makeError(
          X`${q(label)}: a rest element is only valid as the final top-level element`,
        );
      }
      const record = assertRecordKeys(label, element, [
        'kind',
        'name',
        'type',
        'description',
      ]);
      const name = assertToken(`${label}.name`, record.name);
      const type = assertSlotType(`${label}.type`, record.type);
      const description = assertOptionalString(
        `${label}.description`,
        record.description,
      );
      return harden({
        kind: 'rest',
        name,
        type,
        ...(description !== undefined && { description }),
      });
    }
    default:
      throw makeError(
        X`${q(label)}.kind must be one of 'literal', 'slot', 'options', 'group', 'rest', got ${q(kind)}`,
      );
  }
};

/**
 * Validate one command grammar and return a fresh hardened copy.
 *
 * @param {unknown} grammar
 * @param {string} [label]
 * @returns {ShellCommandGrammar}
 */
export const normalizeShellCommandGrammar = (grammar, label = 'command') => {
  const record = assertRecordKeys(label, grammar, [
    'program',
    'args',
    'description',
  ]);
  const program = assertToken(`${label}.program`, record.program);
  if (!Array.isArray(record.args)) {
    throw makeError(X`${q(label)}.args must be an array of grammar elements`);
  }
  const { length } = record.args;
  const args = harden(
    record.args.map((element, i) =>
      normalizeElement(`${label}.args[${i}]`, element, {
        topLevel: true,
        last: i === length - 1,
      }),
    ),
  );
  const description = assertOptionalString(
    `${label}.description`,
    record.description,
  );
  return harden({
    program,
    args,
    ...(description !== undefined && { description }),
  });
};
harden(normalizeShellCommandGrammar);

/**
 * Validate a non-empty grammar array and return a fresh hardened copy.
 *
 * @param {unknown} commands
 * @param {string} [label]
 * @returns {ShellCommandGrammar[]}
 */
export const normalizeShellCommandGrammars = (commands, label = 'commands') => {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw makeError(
      X`${q(label)} must be a non-empty array of command grammars`,
    );
  }
  return harden(
    commands.map((grammar, i) =>
      normalizeShellCommandGrammar(grammar, `${label}[${i}]`),
    ),
  );
};
harden(normalizeShellCommandGrammars);

/**
 * @param {ShellCommandElement & { kind: 'slot' }} element
 * @param {string} token
 * @returns {boolean}
 */
const tokenMatchesSlot = (element, token) => {
  if (element.prefix !== undefined) {
    if (!token.startsWith(element.prefix)) {
      return false;
    }
    return valueMatchesType(element.type, token.slice(element.prefix.length));
  }
  return valueMatchesType(element.type, token);
};

/**
 * @param {ShellOptionMember} member
 * @param {string} token
 * @returns {boolean}
 */
const tokenMatchesOptionMember = (member, token) => {
  if (typeof member === 'string') {
    return token === member;
  }
  return (
    token.startsWith(member.prefix) &&
    valueMatchesType(member.type, token.slice(member.prefix.length))
  );
};

/**
 * Advance a frontier of token positions across one element: for every
 * position in `positions`, add every position reachable after this element
 * consumed its tokens there.  Optional/repeat/group fall out of the set
 * algebra; a repeated group that can match empty makes no progress and so
 * terminates (only unseen positions are pursued).
 *
 * @param {ShellCommandElement} element
 * @param {readonly string[]} tokens
 * @param {ReadonlySet<number>} positions
 * @returns {Set<number>}
 */
const advance = (element, tokens, positions) => {
  /** @type {Set<number>} */
  const next = new Set();
  switch (element.kind) {
    case 'literal': {
      for (const i of positions) {
        if (i < tokens.length && tokens[i] === element.value) {
          next.add(i + 1);
        }
      }
      break;
    }
    case 'slot': {
      for (const i of positions) {
        if (element.optional) {
          next.add(i);
        }
        if (i < tokens.length && tokenMatchesSlot(element, tokens[i])) {
          next.add(i + 1);
        }
      }
      break;
    }
    case 'options': {
      const { options, optional = false, repeat = false } = element;
      /** @param {number} i */
      const matchesAt = i =>
        i < tokens.length &&
        options.some(member => tokenMatchesOptionMember(member, tokens[i]));
      for (const i of positions) {
        if (optional) {
          next.add(i);
        }
        let j = i;
        while (matchesAt(j)) {
          j += 1;
          next.add(j);
          if (!repeat) {
            break;
          }
        }
      }
      break;
    }
    case 'group': {
      const { elements, optional = false, repeat = false } = element;
      /** @param {ReadonlySet<number>} from */
      const matchOnce = from => {
        /** @type {ReadonlySet<number>} */
        let frontier = new Set(from);
        for (const inner of elements) {
          frontier = advance(inner, tokens, frontier);
          if (frontier.size === 0) {
            break;
          }
        }
        return frontier;
      };
      if (optional) {
        for (const i of positions) {
          next.add(i);
        }
      }
      let produced = matchOnce(positions);
      /** @type {Set<number>} */
      const known = new Set(produced);
      for (const j of produced) {
        next.add(j);
      }
      if (repeat) {
        while (produced.size > 0) {
          /** @type {Set<number>} */
          const fresh = new Set();
          for (const j of matchOnce(produced)) {
            if (!known.has(j)) {
              known.add(j);
              fresh.add(j);
              next.add(j);
            }
          }
          produced = fresh;
        }
      }
      break;
    }
    case 'rest': {
      for (const i of positions) {
        let ok = true;
        for (let j = i; j < tokens.length; j += 1) {
          if (!valueMatchesType(element.type, tokens[j])) {
            ok = false;
            break;
          }
        }
        if (ok) {
          next.add(tokens.length);
        }
      }
      break;
    }
    default:
      break;
  }
  return next;
};

/**
 * Does `[command, ...args]` belong to the grammar's accepted language?
 * `command` must equal `program` exactly, and `args` must be fully consumed
 * by the element sequence.
 *
 * @param {ShellCommandGrammar} grammar
 * @param {string} command
 * @param {readonly string[]} args
 * @returns {boolean}
 */
export const matchShellCommand = (grammar, command, args) => {
  if (command !== grammar.program) {
    return false;
  }
  if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
    return false;
  }
  /** @type {ReadonlySet<number>} */
  let frontier = new Set([0]);
  for (const element of grammar.args) {
    frontier = advance(element, args, frontier);
    if (frontier.size === 0) {
      return false;
    }
  }
  return frontier.has(args.length);
};
harden(matchShellCommand);

/**
 * @param {{ name: string, type: ShellSlotType }} slotLike
 * @returns {string}
 */
const renderSlotName = ({ name, type }) =>
  type === 'path' ? `<${name}:path>` : `<${name}>`;

/**
 * @param {ShellOptionMember} member
 * @returns {string}
 */
const renderOptionMember = member =>
  typeof member === 'string'
    ? member
    : `${member.prefix}${renderSlotName({ name: member.name ?? member.type, type: member.type })}`;

/**
 * @param {ShellCommandElement} element
 * @returns {string}
 */
const renderElement = element => {
  switch (element.kind) {
    case 'literal':
      return element.value;
    case 'slot': {
      const body =
        element.prefix !== undefined
          ? `${element.prefix}${renderSlotName(element)}`
          : renderSlotName(element);
      return element.optional ? `[${body}]` : body;
    }
    case 'options': {
      const body = element.options.map(renderOptionMember).join(' | ');
      let wrapped;
      if (element.optional) {
        wrapped = `[${body}]`;
      } else if (element.options.length > 1) {
        wrapped = `(${body})`;
      } else {
        wrapped = body;
      }
      return element.repeat ? `${wrapped}...` : wrapped;
    }
    case 'group': {
      const body = element.elements.map(renderElement).join(' ');
      let wrapped = body;
      if (element.optional) {
        wrapped = `[${body}]`;
      } else if (element.repeat) {
        wrapped = `(${body})`;
      }
      return element.repeat ? `${wrapped}...` : wrapped;
    }
    case 'rest':
      return `[${renderSlotName(element)} ...]`;
    default:
      return '';
  }
};

/**
 * Render one deterministic usage line for a grammar, e.g.
 * `grep [-r | -n | -i | --]... <pattern> [<paths:path> ...]`.  Exposed by
 * `inspect()` and embedded in agent-facing tool descriptions, so the accepted
 * language is legible up front rather than discovered by rejection.
 *
 * @param {ShellCommandGrammar} grammar
 * @returns {string}
 */
export const formatShellCommandUsage = grammar =>
  [grammar.program, ...grammar.args.map(renderElement)].join(' ');
harden(formatShellCommandUsage);
