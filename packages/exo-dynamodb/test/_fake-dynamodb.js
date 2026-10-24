// @ts-check

/**
 * A recording, in-memory stand-in for the DynamoDB data plane. It parses the
 * expression strings the broker compiles, so tests exercise the real request
 * shapes rather than trusting the compiler. It implements only the subset of
 * DynamoDB the package emits.
 */

import { getCopySetKeys, makeCopySet } from '@endo/patterns';

import { marshalItem, unmarshalItem } from '../src/marshal.js';
import {
  compareScalars,
  isBytesLike,
  sameValue,
  startsWith,
} from '../src/value.js';

/**
 * @param {string} name
 * @param {Record<string, unknown>} [extra]
 */
const awsError = (name, extra = {}) =>
  Object.assign(new Error(`${name} from fake`), {
    name,
    $metadata: { requestId: `request-${name}` },
    ...extra,
  });

const tokenPattern =
  /\s*(\(|\)|,|<>|<=|>=|=|<|>|#[A-Za-z0-9_]+|:[A-Za-z0-9_]+|[A-Za-z_]+)/y;

/** @param {string} text */
const tokenize = text => {
  const tokens = [];
  tokenPattern.lastIndex = 0;
  let match;
  while (tokenPattern.lastIndex < text.trimEnd().length) {
    match = tokenPattern.exec(text);
    if (match === null) throw awsError('ValidationException');
    tokens.push(match[1]);
  }
  return tokens;
};

/**
 * Parse a condition expression into a predicate over an unmarshalled item.
 *
 * @param {string} text
 * @param {Record<string, string>} names
 * @param {Record<string, any>} values
 * @returns {(item: Record<string, any>) => boolean}
 */
export const parseCondition = (text, names, values) => {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => {
    const token = tokens[position];
    position += 1;
    return token;
  };
  /** @param {string} token */
  const expect = token => {
    if (next() !== token) throw awsError('ValidationException');
  };
  const name = () => {
    const token = next();
    if (!(token in names)) throw awsError('ValidationException');
    return names[token];
  };
  const value = () => {
    const token = next();
    if (!(token in values)) throw awsError('ValidationException');
    return /** @type {any} */ (
      unmarshalItem({ value: values[token] }, { binary: 'bytes' }).value
    );
  };
  /** @returns {(item: Record<string, any>) => boolean} */
  const primary = () => {
    const token = peek();
    if (token === '(') {
      next();
      const inner = or();
      expect(')');
      return inner;
    }
    if (token === 'NOT') {
      next();
      const inner = primary();
      return item => !inner(item);
    }
    if (token === 'attribute_exists' || token === 'attribute_not_exists') {
      next();
      expect('(');
      const field = name();
      expect(')');
      return token === 'attribute_exists'
        ? item => Object.hasOwn(item, field)
        : item => !Object.hasOwn(item, field);
    }
    if (token === 'begins_with') {
      next();
      expect('(');
      const field = name();
      expect(',');
      const prefix = value();
      expect(')');
      return item =>
        isBytesLike(item[field]) && startsWith(item[field], prefix);
    }
    const field = name();
    const operator = next();
    if (operator === 'BETWEEN') {
      const low = value();
      expect('AND');
      const high = value();
      return item => {
        const a = compareScalars(item[field], low);
        const b = compareScalars(item[field], high);
        return a !== undefined && b !== undefined && a >= 0 && b <= 0;
      };
    }
    const operand = value();
    return item => {
      if (!Object.hasOwn(item, field)) return operator === '<>';
      if (operator === '=') return sameValue(item[field], operand);
      if (operator === '<>') return !sameValue(item[field], operand);
      const order = compareScalars(item[field], operand);
      if (order === undefined) return false;
      return (
        (operator === '<' && order < 0) ||
        (operator === '<=' && order <= 0) ||
        (operator === '>' && order > 0) ||
        (operator === '>=' && order >= 0)
      );
    };
  };
  const and = () => {
    const terms = [primary()];
    while (peek() === 'AND') {
      next();
      terms.push(primary());
    }
    return item => terms.every(term => term(item));
  };
  const or = () => {
    const terms = [and()];
    while (peek() === 'OR') {
      next();
      terms.push(and());
    }
    return item => terms.some(term => term(item));
  };
  const predicate = or();
  if (position !== tokens.length) throw awsError('ValidationException');
  return predicate;
};

/**
 * @param {string} text
 * @param {Record<string, string>} names
 * @param {Record<string, any>} values
 * @returns {(item: Record<string, any>) => Record<string, any>}
 */
export const parseUpdate = (text, names, values) => {
  const tokens = tokenize(text);
  /** @type {((item: Record<string, any>) => void)[]} */
  const actions = [];
  let position = 0;
  let clause = '';
  /** @param {string} token */
  const decode = token =>
    /** @type {any} */ (
      unmarshalItem({ value: values[token] }, { binary: 'bytes' }).value
    );
  while (position < tokens.length) {
    const token = tokens[position];
    if (['SET', 'REMOVE', 'ADD', 'DELETE'].includes(token)) {
      clause = token;
      position += 1;
    } else if (token === ',') {
      position += 1;
    } else {
      const field = names[token];
      if (field === undefined) throw awsError('ValidationException');
      position += 1;
      if (clause === 'SET') {
        if (tokens[position] !== '=') throw awsError('ValidationException');
        const operand = decode(tokens[position + 1]);
        position += 2;
        actions.push(item => {
          item[field] = operand;
        });
      } else if (clause === 'REMOVE') {
        actions.push(item => {
          delete item[field];
        });
      } else {
        const operand = decode(tokens[position]);
        position += 1;
        actions.push(item => {
          if (clause === 'ADD' && typeof operand !== 'object') {
            item[field] = Number(item[field] ?? 0) + Number(operand);
          } else {
            const current = item[field] ? getCopySetKeys(item[field]) : [];
            const delta = getCopySetKeys(operand);
            const merged =
              clause === 'ADD'
                ? [
                    ...current,
                    ...delta.filter(v => !current.some(c => sameValue(c, v))),
                  ]
                : current.filter(v => !delta.some(d => sameValue(d, v)));
            if (merged.length === 0) delete item[field];
            else item[field] = makeCopySet(merged);
          }
        });
      }
    }
  }
  return item => {
    const result = { ...item };
    for (const action of actions) action(result);
    return result;
  };
};

/**
 * @typedef {{ name: string, type: string }} Attr
 * @typedef {{ partitionKey: Attr, sortKey?: Attr, global?: boolean }} Schema
 * @typedef {Schema & { indexes?: Record<string, Schema> }} TableSchema
 */

/**
 * @param {Record<string, TableSchema>} schemas physical table name to schema
 */
export const makeFakeDynamoDB = schemas => {
  /** @type {any[]} */
  const calls = [];
  /** @type {Map<string, Map<string, Record<string, any>>>} */
  const tables = new Map();
  /** @type {Set<string>} */
  const tokens = new Set();
  /** @type {((call: { operation: string, input: any }) => void) | undefined} */
  let beforeSend;
  /** @type {((response: any, call: any) => any) | undefined} */
  let transformResponse;

  /** @param {string} tableName */
  const tableOf = tableName => {
    if (!(tableName in schemas)) throw awsError('ResourceNotFoundException');
    let table = tables.get(tableName);
    if (table === undefined) {
      table = new Map();
      tables.set(tableName, table);
    }
    return table;
  };
  /**
   * @param {Schema} schema
   * @param {Record<string, any>} item
   */
  const keyString = (schema, item) => {
    const parts = [
      schema.partitionKey,
      ...(schema.sortKey ? [schema.sortKey] : []),
    ];
    return JSON.stringify(
      parts.map(part => {
        const value = item[part.name];
        return value instanceof Uint8Array ? [...value] : `${value}`;
      }),
    );
  };
  /** @param {any} input */
  const decodeKey = input => unmarshalItem(input, { binary: 'bytes' });
  /**
   * @param {any} input
   * @param {Record<string, any> | undefined} item
   */
  const conditionHolds = (input, item) =>
    input.ConditionExpression === undefined ||
    parseCondition(
      input.ConditionExpression,
      input.ExpressionAttributeNames ?? {},
      input.ExpressionAttributeValues ?? {},
    )(item ?? {});
  /** @param {Record<string, any>} item */
  const encode = item => marshalItem(item, { binary: 'bytes' });

  /**
   * @param {string} kind
   * @param {any} input
   * @param {boolean} apply
   */
  const write = (kind, input, apply) => {
    const schema = schemas[input.TableName];
    const table = tableOf(input.TableName);
    const key = kind === 'Put' ? decodeKey(input.Item) : decodeKey(input.Key);
    const id = keyString(schema, key);
    const old = table.get(id);
    if (!conditionHolds(input, old)) return { ok: false, old };
    if (!apply) return { ok: true, old };
    if (kind === 'Put') table.set(id, decodeKey(input.Item));
    else if (kind === 'Delete') table.delete(id);
    else if (kind === 'Update') {
      const updated = parseUpdate(
        input.UpdateExpression,
        input.ExpressionAttributeNames ?? {},
        input.ExpressionAttributeValues ?? {},
      )({ ...(old ?? {}), ...key });
      table.set(id, updated);
      return { ok: true, old, updated };
    }
    return { ok: true, old };
  };

  /**
   * @param {string} operation
   * @param {any} input
   */
  const execute = (operation, input) => {
    switch (operation) {
      case 'getItem': {
        const schema = schemas[input.TableName];
        const item = tableOf(input.TableName).get(
          keyString(schema, decodeKey(input.Key)),
        );
        return item === undefined ? {} : { Item: encode(item) };
      }
      case 'putItem':
      case 'deleteItem':
      case 'updateItem': {
        const kind =
          operation === 'putItem'
            ? 'Put'
            : operation === 'deleteItem'
              ? 'Delete'
              : 'Update';
        const result = write(kind, input, true);
        if (!result.ok) throw awsError('ConditionalCheckFailedException');
        if (input.ReturnValues === 'ALL_NEW' && result.updated) {
          return { Attributes: encode(result.updated) };
        }
        if (input.ReturnValues === 'ALL_OLD' && result.old) {
          return { Attributes: encode(result.old) };
        }
        return {};
      }
      case 'transactWriteItems': {
        if (input.ClientRequestToken !== undefined) {
          if (String(input.ClientRequestToken).length > 36) {
            throw awsError('ValidationException');
          }
          if (tokens.has(input.ClientRequestToken)) return {};
        }
        const members = input.TransactItems.map(member => {
          const [kind] = Object.keys(member);
          return { kind, input: member[kind] };
        });
        const reasons = members.map(member =>
          write(
            member.kind === 'ConditionCheck' ? 'Check' : member.kind,
            member.input,
            false,
          ).ok
            ? { Code: 'None' }
            : { Code: 'ConditionalCheckFailed' },
        );
        if (reasons.some(reason => reason.Code !== 'None')) {
          throw awsError('TransactionCanceledException', {
            CancellationReasons: reasons,
          });
        }
        for (const member of members) {
          if (member.kind !== 'ConditionCheck') {
            write(member.kind, member.input, true);
          }
        }
        if (input.ClientRequestToken !== undefined) {
          tokens.add(input.ClientRequestToken);
        }
        return {};
      }
      case 'transactGetItems':
        return {
          Responses: input.TransactItems.map(({ Get }) =>
            execute('getItem', Get),
          ),
        };
      case 'query': {
        const tableSchema = schemas[input.TableName];
        const schema =
          input.IndexName === undefined
            ? tableSchema
            : tableSchema.indexes?.[input.IndexName];
        if (schema === undefined) throw awsError('ValidationException');
        if (
          input.IndexName !== undefined &&
          input.ConsistentRead &&
          schema.global
        ) {
          throw awsError('ValidationException');
        }
        const names = input.ExpressionAttributeNames ?? {};
        const values = input.ExpressionAttributeValues ?? {};
        const keyCondition = parseCondition(
          input.KeyConditionExpression,
          names,
          values,
        );
        const filter =
          input.FilterExpression === undefined
            ? () => true
            : parseCondition(input.FilterExpression, names, values);
        const parts = [
          schema.partitionKey,
          ...(schema.sortKey ? [schema.sortKey] : []),
        ];
        let rows = [...tableOf(input.TableName).values()]
          .filter(item => parts.every(part => Object.hasOwn(item, part.name)))
          .filter(keyCondition);
        if (schema.sortKey) {
          const sortName = schema.sortKey.name;
          rows.sort((a, b) => compareScalars(a[sortName], b[sortName]) ?? 0);
        }
        if (input.ScanIndexForward === false) rows.reverse();
        if (input.ExclusiveStartKey !== undefined) {
          const start = decodeKey(input.ExclusiveStartKey);
          const index = rows.findIndex(
            row =>
              keyString(tableSchema, row) === keyString(tableSchema, start),
          );
          rows = rows.slice(index + 1);
        }
        const evaluated = rows.slice(0, input.Limit ?? rows.length);
        const more = rows.length > evaluated.length;
        const last = evaluated.at(-1);
        const lastKey =
          more && last
            ? encode(
                Object.fromEntries(
                  [
                    tableSchema.partitionKey,
                    ...(tableSchema.sortKey ? [tableSchema.sortKey] : []),
                    ...parts,
                  ].map(part => [part.name, last[part.name]]),
                ),
              )
            : undefined;
        return {
          Items: evaluated.filter(filter).map(encode),
          ...(lastKey === undefined ? {} : { LastEvaluatedKey: lastKey }),
        };
      }
      default:
        throw awsError('UnknownOperationException');
    }
  };

  const client = harden({
    /** @param {{ operation: string, input: any }} call */
    async send(call) {
      calls.push(call);
      beforeSend?.(call);
      const response = execute(call.operation, call.input);
      return transformResponse ? transformResponse(response, call) : response;
    },
  });

  return {
    client,
    calls,
    /**
     * @param {string} tableName
     * @param {Record<string, any>} item
     */
    seed(tableName, item) {
      tableOf(tableName).set(keyString(schemas[tableName], item), { ...item });
    },
    /**
     * @param {string} tableName
     * @param {Record<string, any>} key
     */
    peek(tableName, key) {
      return /** @type {any} */ (
        tableOf(tableName).get(keyString(schemas[tableName], key))
      );
    },
    /** @param {((call: any) => void) | undefined} hook */
    onSend(hook) {
      beforeSend = hook;
    },
    /** @param {((response: any, call: any) => any) | undefined} hook */
    onResponse(hook) {
      transformResponse = hook;
    },
  };
};
