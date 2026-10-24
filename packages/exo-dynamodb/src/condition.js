// @ts-check

/** @import { Condition, DynamoValue, Field, Guard, Item, Patch } from '../types.js' */

import { reject } from './results.js';
import {
  compareScalars,
  isBytesLike,
  isNumeric,
  sameValue,
  startsWith,
} from './value.js';

const comparisonOperators = harden({
  eq: '=',
  ne: '<>',
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
});
const maxNodes = 128;
const maxDepth = 16;

/**
 * @param {object} node
 * @param {readonly string[]} expected
 */
const hasExactly = (node, expected) => {
  const keys = Object.keys(node);
  return keys.length === expected.length && expected.every(key => key in node);
};

/** @param {unknown} value */
const isComparable = value => isNumeric(value) || isBytesLike(value);

/**
 * Validate a condition AST and return the operator tag of its root. Throws a
 * `RequestError` for any unexpected structure.
 *
 * @param {unknown} node
 * @param {(field: Field) => void} [checkField]
 */
export const assertCondition = (node, checkField = () => {}) => {
  let count = 0;
  /**
   * @param {any} current
   * @param {number} depth
   */
  const visit = (current, depth) => {
    count += 1;
    count <= maxNodes || reject('condition is too large');
    depth <= maxDepth || reject('condition is too deep');
    (current !== null &&
      typeof current === 'object' &&
      !Array.isArray(current)) ||
      reject('condition node must be a record');
    if ('and' in current || 'or' in current) {
      const tag = 'and' in current ? 'and' : 'or';
      hasExactly(current, [tag]) || reject('condition node has extra fields');
      const terms = current[tag];
      (Array.isArray(terms) && terms.length > 0) ||
        reject(`${tag} requires a non-empty list`);
      for (const term of terms) visit(term, depth + 1);
      return;
    }
    if ('not' in current) {
      hasExactly(current, ['not']) || reject('condition node has extra fields');
      visit(current.not, depth + 1);
      return;
    }
    if ('exists' in current) {
      hasExactly(current, ['exists']) ||
        reject('condition node has extra fields');
      (typeof current.exists === 'string' && current.exists !== '') ||
        reject('exists requires a field name');
      checkField(current.exists);
      return;
    }
    (typeof current.field === 'string' && current.field !== '') ||
      reject('condition requires a field name');
    const operators = Object.keys(current).filter(key => key !== 'field');
    operators.length === 1 || reject('condition node needs one operator');
    const [operator] = operators;
    const value = current[operator];
    if (operator === 'eq' || operator === 'ne') {
      value !== undefined || reject(`${operator} requires a value`);
    } else if (operator in comparisonOperators) {
      isComparable(value) || reject(`${operator} requires a comparable value`);
    } else if (operator === 'between') {
      (Array.isArray(value) &&
        value.length === 2 &&
        isComparable(value[0]) &&
        isComparable(value[1]) &&
        compareScalars(value[0], value[1]) !== undefined &&
        /** @type {number} */ (compareScalars(value[0], value[1])) <= 0) ||
        reject('between requires an ordered pair');
    } else if (operator === 'beginsWith') {
      isBytesLike(value) || reject('beginsWith requires a string or bytes');
    } else {
      reject('unknown condition operator');
    }
    checkField(current.field);
  };
  visit(node, 0);
};
harden(assertCondition);

/**
 * Collect every field a condition mentions.
 *
 * @param {Condition} node
 * @returns {Field[]}
 */
export const conditionFields = node => {
  /** @type {Field[]} */
  const fields = [];
  /** @param {any} current */
  const visit = current => {
    if ('and' in current) current.and.forEach(visit);
    else if ('or' in current) current.or.forEach(visit);
    else if ('not' in current) visit(current.not);
    else if ('exists' in current) fields.push(current.exists);
    else fields.push(current.field);
  };
  visit(node);
  return fields;
};
harden(conditionFields);

/**
 * Evaluate a condition against a complete item in memory, with DynamoDB's
 * semantics: a comparison on a missing or differently typed attribute is
 * false.
 *
 * @param {Condition} node
 * @param {Item} item
 * @returns {boolean}
 */
export const evaluateCondition = (node, item) => {
  const current = /** @type {any} */ (node);
  if ('and' in current) {
    return current.and.every(term => evaluateCondition(term, item));
  }
  if ('or' in current) {
    return current.or.some(term => evaluateCondition(term, item));
  }
  if ('not' in current) return !evaluateCondition(current.not, item);
  if ('exists' in current) return Object.hasOwn(item, current.exists);
  if (!Object.hasOwn(item, current.field)) {
    return 'ne' in current;
  }
  const actual = item[current.field];
  if ('eq' in current) return sameValue(actual, current.eq);
  if ('ne' in current) return !sameValue(actual, current.ne);
  if ('beginsWith' in current) {
    return isBytesLike(actual) && startsWith(actual, current.beginsWith);
  }
  if ('between' in current) {
    const low = compareScalars(actual, current.between[0]);
    const high = compareScalars(actual, current.between[1]);
    return low !== undefined && high !== undefined && low >= 0 && high <= 0;
  }
  const operator = ['lt', 'lte', 'gt', 'gte'].find(name => name in current);
  if (operator === undefined) return false;
  const order = compareScalars(actual, current[operator]);
  if (order === undefined) return false;
  if (operator === 'lt') return order < 0;
  if (operator === 'lte') return order <= 0;
  if (operator === 'gt') return order > 0;
  return order >= 0;
};
harden(evaluateCondition);

/**
 * Validate that a condition lies in the guard language: conjunctions of
 * equality, `beginsWith`, existence, and the negation of one such term.
 *
 * @param {unknown} node
 * @param {(field: Field) => void} [checkField]
 */
export const assertGuard = (node, checkField) => {
  assertCondition(node, checkField);
  /**
   * @param {any} current
   * @param {boolean} negated
   */
  const visit = (current, negated) => {
    if ('and' in current) {
      negated && reject('a guard cannot negate a compound term');
      current.and.forEach(term => visit(term, false));
      return;
    }
    if ('or' in current) reject('a guard cannot use disjunction');
    if ('not' in current) {
      negated && reject('a guard cannot negate a negation');
      visit(current.not, true);
      return;
    }
    if ('exists' in current || 'beginsWith' in current) return;
    if ('eq' in current) {
      current.eq === null ||
        ['string', 'number', 'bigint', 'boolean'].includes(typeof current.eq) ||
        current.eq instanceof Uint8Array ||
        reject('a guard compares only scalars');
      return;
    }
    reject('a guard may use only equality, beginsWith, and existence');
  };
  visit(node, false);
};
harden(assertGuard);

/**
 * Flatten a guard into its conjunction of atomic terms.
 *
 * @param {Guard} guard
 * @returns {{ field: Field, negated: boolean, term: Condition }[]}
 */
export const guardTerms = guard => {
  /** @type {{ field: Field, negated: boolean, term: Condition }[]} */
  const terms = [];
  /**
   * @param {any} current
   * @param {boolean} negated
   */
  const visit = (current, negated) => {
    if ('and' in current) {
      current.and.forEach(term => visit(term, negated));
    } else if ('not' in current) {
      visit(current.not, !negated);
    } else {
      const field = 'exists' in current ? current.exists : current.field;
      terms.push(
        harden({
          field,
          negated,
          term: negated ? harden({ not: current }) : current,
        }),
      );
    }
  };
  visit(guard, false);
  return terms;
};
harden(guardTerms);

/**
 * Allocates placeholder names and values for one DynamoDB request, so key
 * conditions, filters, conditions, and updates can share one namespace.
 *
 * @param {(value: DynamoValue) => unknown} marshal
 */
export const makeExpressionBuilder = marshal => {
  /** @type {Record<string, string>} */
  const names = {};
  /** @type {Map<string, string>} */
  const nameTokens = new Map();
  /** @type {Record<string, unknown>} */
  const values = {};
  let nextValue = 0;

  /** @param {Field} field */
  const name = field => {
    let token = nameTokens.get(field);
    if (token === undefined) {
      token = `#n${nameTokens.size}`;
      nameTokens.set(field, token);
      names[token] = field;
    }
    return token;
  };
  /** @param {DynamoValue} element */
  const value = element => {
    const token = `:v${nextValue}`;
    nextValue += 1;
    values[token] = marshal(element);
    return token;
  };

  /**
   * Compile an already validated condition.
   *
   * @param {Condition} node
   * @returns {string}
   */
  const condition = node => {
    const current = /** @type {any} */ (node);
    if ('and' in current || 'or' in current) {
      const tag = 'and' in current ? 'and' : 'or';
      const joined = current[tag]
        .map(condition)
        .join(tag === 'and' ? ' AND ' : ' OR ');
      return `(${joined})`;
    }
    if ('not' in current) return `(NOT ${condition(current.not)})`;
    if ('exists' in current) return `attribute_exists(${name(current.exists)})`;
    const field = name(current.field);
    if ('beginsWith' in current) {
      return `begins_with(${field}, ${value(current.beginsWith)})`;
    }
    if ('between' in current) {
      return `${field} BETWEEN ${value(current.between[0])} AND ${value(current.between[1])}`;
    }
    for (const [operator, symbol] of Object.entries(comparisonOperators)) {
      if (operator in current) {
        return `${field} ${symbol} ${value(current[operator])}`;
      }
    }
    return reject('unknown condition operator');
  };

  /**
   * Compile an already validated patch.
   *
   * @param {Patch} patch
   * @returns {string}
   */
  const update = patch => {
    const clauses = [];
    const sets = Object.entries(patch.set ?? {}).map(
      ([field, element]) => `${name(field)} = ${value(element)}`,
    );
    if (sets.length > 0) clauses.push(`SET ${sets.join(', ')}`);
    const removes = (patch.remove ?? []).map(name);
    if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);
    const adds = Object.entries(patch.add ?? {}).map(
      ([field, element]) => `${name(field)} ${value(element)}`,
    );
    if (adds.length > 0) clauses.push(`ADD ${adds.join(', ')}`);
    const deletes = Object.entries(patch.delete ?? {}).map(
      ([field, element]) => `${name(field)} ${value(element)}`,
    );
    if (deletes.length > 0) clauses.push(`DELETE ${deletes.join(', ')}`);
    return clauses.join(' ');
  };

  /** Expression attribute maps, omitted when empty. */
  const maps = () =>
    harden({
      ...(Object.keys(names).length > 0
        ? { ExpressionAttributeNames: harden({ ...names }) }
        : {}),
      ...(Object.keys(values).length > 0
        ? { ExpressionAttributeValues: harden({ ...values }) }
        : {}),
    });

  return harden({ name, value, condition, update, maps });
};
harden(makeExpressionBuilder);

/**
 * Validate the structure of a patch and return every field it touches.
 *
 * @param {unknown} patch
 * @returns {Field[]}
 */
export const assertPatch = patch => {
  (patch !== null && typeof patch === 'object' && !Array.isArray(patch)) ||
    reject('patch must be a record');
  const record = /** @type {Record<string, any>} */ (patch);
  const parts = ['set', 'remove', 'add', 'delete'];
  Object.keys(record).every(part => parts.includes(part)) ||
    reject('patch has unexpected fields');
  /** @type {Field[]} */
  const fields = [];
  for (const part of ['set', 'add', 'delete']) {
    if (record[part] !== undefined) {
      (typeof record[part] === 'object' && !Array.isArray(record[part])) ||
        reject(`patch ${part} must be a record`);
      fields.push(...Object.keys(record[part]));
    }
  }
  if (record.remove !== undefined) {
    (Array.isArray(record.remove) &&
      record.remove.every(field => typeof field === 'string')) ||
      reject('patch remove must list fields');
    fields.push(...record.remove);
  }
  for (const element of Object.values(record.add ?? {})) {
    isNumeric(element) ||
      (typeof element === 'object' && element !== null) ||
      reject('patch add requires a number or set');
  }
  fields.length > 0 || reject('patch must contain an operation');
  new Set(fields).size === fields.length ||
    reject('patch touches a field twice');
  return fields;
};
harden(assertPatch);
