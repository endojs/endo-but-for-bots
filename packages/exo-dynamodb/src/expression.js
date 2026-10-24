// @ts-check

/** @import { FieldCondition, Patch } from '../types.js' */

import { Fail, q } from '@endo/errors';

/**
 * Compile the closed condition AST into a DynamoDB expression. Names and
 * values are allocated rather than interpolated.
 *
 * @param {FieldCondition | undefined} condition
 * @param {readonly string[] | undefined} allowedFields
 * @param {(value: any) => any} marshal
 * @param {string} [prefix]
 * @returns {{ ConditionExpression?: string, ExpressionAttributeNames?: Record<string, string>, ExpressionAttributeValues?: Record<string, any> }}
 */
export const compileCondition = (
  condition,
  allowedFields,
  marshal,
  prefix = '',
) => {
  if (condition === undefined) return harden({});
  const assertKeys = (record, expected) => {
    const actual = Object.keys(record).sort();
    const wanted = [...expected].sort();
    (actual.length === wanted.length &&
      actual.every((key, index) => key === wanted[index])) ||
      Fail`Condition node has unexpected fields`;
  };
  /** @type {Record<string, string>} */
  const names = {};
  /** @type {Record<string, any>} */
  const values = {};
  let nextName = 0;
  let nextValue = 0;
  const fieldName = field => {
    allowedFields === undefined ||
      allowedFields.includes(field) ||
      Fail`Condition field ${q(field)} is not allowed`;
    const token = `#${prefix}n${nextName}`;
    nextName += 1;
    names[token] = field;
    return token;
  };
  const fieldValue = value => {
    const token = `:${prefix}v${nextValue}`;
    nextValue += 1;
    values[token] = marshal(value);
    return token;
  };
  /**
   * @param {FieldCondition} node
   * @returns {string}
   */
  const visit = node => {
    if (node.op === 'and' || node.op === 'or') {
      assertKeys(node, ['op', 'conditions']);
      Array.isArray(node.conditions) || Fail`Conditions must be an array`;
      if (node.conditions.length === 0)
        return Fail`${q(node.op)} requires conditions`;
      return `(${node.conditions.map(visit).join(node.op === 'and' ? ' AND ' : ' OR ')})`;
    }
    if (node.op === 'not') {
      assertKeys(node, ['op', 'condition']);
      return `(NOT ${visit(node.condition)})`;
    }
    const leaf = /** @type {any} */ (node);
    'field' in leaf || Fail`Invalid condition node`;
    typeof leaf.field === 'string' || Fail`Condition field must be a string`;
    const name = fieldName(leaf.field);
    if (leaf.op === 'exists' || leaf.op === 'not-exists') {
      assertKeys(leaf, ['op', 'field']);
      return leaf.op === 'exists'
        ? `attribute_exists(${name})`
        : `attribute_not_exists(${name})`;
    }
    if (leaf.op === 'begins-with') {
      assertKeys(leaf, ['op', 'field', 'value']);
      return `begins_with(${name}, ${fieldValue(leaf.value)})`;
    }
    'value' in leaf || Fail`Comparison requires a value`;
    const operators = {
      eq: '=',
      ne: '<>',
      lt: '<',
      lte: '<=',
      gt: '>',
      gte: '>=',
    };
    leaf.op in operators || Fail`Unknown condition operation`;
    assertKeys(leaf, ['op', 'field', 'value']);
    return `${name} ${operators[leaf.op]} ${fieldValue(leaf.value)}`;
  };
  return harden({
    ConditionExpression: visit(condition),
    ExpressionAttributeNames: harden(names),
    ExpressionAttributeValues: harden(values),
  });
};
harden(compileCondition);

/**
 * @param {Patch} patch
 * @param {readonly string[] | undefined} allowedFields
 * @param {(value: any) => any} marshal
 */
export const compilePatch = (patch, allowedFields, marshal) => {
  const allowedParts = new Set(['set', 'remove', 'add', 'delete']);
  Object.keys(patch).every(part => allowedParts.has(part)) ||
    Fail`Patch has unexpected fields`;
  const names = {};
  const values = {};
  let nextName = 0;
  let nextValue = 0;
  const fieldName = field => {
    allowedFields === undefined ||
      allowedFields.includes(field) ||
      Fail`Patch field ${q(field)} is not writable`;
    const token = `#u${nextName}`;
    nextName += 1;
    names[token] = field;
    return token;
  };
  const fieldValue = value => {
    const token = `:u${nextValue}`;
    nextValue += 1;
    values[token] = marshal(value);
    return token;
  };
  const clauses = [];
  const sets = Object.entries(patch.set ?? {}).map(
    ([field, value]) => `${fieldName(field)} = ${fieldValue(value)}`,
  );
  if (sets.length > 0) clauses.push(`SET ${sets.join(', ')}`);
  const removes = (patch.remove ?? []).map(fieldName);
  if (removes.length > 0) clauses.push(`REMOVE ${removes.join(', ')}`);
  const adds = Object.entries(patch.add ?? {}).map(
    ([field, value]) => `${fieldName(field)} ${fieldValue(value)}`,
  );
  if (adds.length > 0) clauses.push(`ADD ${adds.join(', ')}`);
  const deletes = Object.entries(patch.delete ?? {}).map(
    ([field, value]) => `${fieldName(field)} ${fieldValue(value)}`,
  );
  if (deletes.length > 0) clauses.push(`DELETE ${deletes.join(', ')}`);
  clauses.length > 0 || Fail`Patch must contain an operation`;
  return harden({
    UpdateExpression: clauses.join(' '),
    ExpressionAttributeNames: harden(names),
    ExpressionAttributeValues: harden(values),
  });
};
harden(compilePatch);

/**
 * @param {Record<string, any>} first
 * @param {Record<string, any>} second
 * @returns {Record<string, any>}
 */
export const mergeExpression = (first, second) =>
  harden({
    ...first,
    ...second,
    ExpressionAttributeNames: harden({
      ...(first.ExpressionAttributeNames ?? {}),
      ...(second.ExpressionAttributeNames ?? {}),
    }),
    ExpressionAttributeValues: harden({
      ...(first.ExpressionAttributeValues ?? {}),
      ...(second.ExpressionAttributeValues ?? {}),
    }),
  });
harden(mergeExpression);
