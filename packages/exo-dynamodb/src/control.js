// @ts-check

/** @import { DynamoCapability, DynamoControl, DynamoResult, FieldCondition, Item, Key, Operation, Patch, Query, ReadOptions, Restriction, TableCatalog, TransactionGet, TransactionOptions, TransactionWrite, WriteOptions } from '../types.js' */

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { encodeUtf8 } from '@endo/utf8';

import {
  compileCondition,
  compilePatch,
  mergeExpression,
} from './expression.js';
import { marshalItem, marshalValue, unmarshalItem } from './marshal.js';
import {
  applyFixed,
  assertItem,
  assertKeyShape,
  attenuate,
  digest,
  keyAllowed,
  matchesConstraint,
  operationAllowed,
  projectItem,
  resolveTable,
} from './restriction.js';
import { DynamoCapabilityInterface } from './type-guards.js';

const ok = value => harden({ type: 'ok', value });
const invalid = reason => harden({ type: 'invalid-request', reason });
const revoked = harden({ type: 'revoked' });
const limited = harden({ type: 'limit-exceeded' });

class LimitError extends Error {}

const clientMethods = harden({
  get: 'getItem',
  put: 'putItem',
  update: 'updateItem',
  delete: 'deleteItem',
  query: 'query',
  transactGet: 'transactGetItems',
  transactWrite: 'transactWriteItems',
});

/**
 * @param {any} client
 * @param {keyof typeof clientMethods} operation
 * @param {Record<string, any>} input
 * @returns {Promise<any>}
 */
const send = async (client, operation, input) => {
  const method = clientMethods[operation];
  if (typeof client[method] === 'function') return client[method](input);
  if (typeof client.send === 'function') {
    return client.send(harden({ operation: method, input }));
  }
  return Fail`DynamoDB client does not implement the requested operation`;
};

/** @param {unknown} error */
const classifyError = error => {
  const candidate =
    /** @type {{ name?: string, retryable?: boolean, CancellationReasons?: any[] }} */ (
      error
    );
  if (candidate.name === 'ConditionalCheckFailedException') {
    return harden({ type: 'condition-failed' });
  }
  if (candidate.name === 'TransactionCanceledException') {
    return harden({
      type: 'transaction-canceled',
      failures: harden(
        (candidate.CancellationReasons ?? []).map(reason => {
          if (reason?.Code === 'ConditionalCheckFailed')
            return harden({ type: 'condition-failed' });
          if (reason?.Code === 'TransactionConflict')
            return harden({ type: 'conflict' });
          return harden({ type: 'unavailable' });
        }),
      ),
    });
  }
  return harden({
    type: 'unavailable',
    retryable:
      candidate.retryable === true ||
      candidate.name === 'ProvisionedThroughputExceededException' ||
      candidate.name === 'ThrottlingException' ||
      candidate.name === 'InternalServerError',
  });
};

/** @param {Record<string, any>} expression */
const omitEmptyExpressionMaps = expression => {
  const result = { ...expression };
  if (Object.keys(result.ExpressionAttributeNames ?? {}).length === 0) {
    delete result.ExpressionAttributeNames;
  }
  if (Object.keys(result.ExpressionAttributeValues ?? {}).length === 0) {
    delete result.ExpressionAttributeValues;
  }
  return harden(result);
};

/**
 * Construct the host-only root control. The client may be an AWS SDK v3
 * aggregated `DynamoDB` client (`getItem`, `putItem`, and peers), or an adapter
 * with `send({ operation, input })` for confinement and deterministic tests.
 *
 * @param {{
 *   client: any,
 *   catalog: TableCatalog,
 *   audit: { record: (event: Record<string, unknown>) => void | Promise<void>, hashKey: (key: Key) => string },
 *   sealCursor: { seal: (record: unknown) => string, unseal: (token: string) => unknown },
 *   generation?: string,
 *   makeGrantId?: () => string,
 *   now?: () => number,
 *   cursorLifetimeMs?: number,
 * }} powers
 * @returns {DynamoControl}
 */
export const makeDynamoControl = powers => {
  const {
    client,
    catalog,
    audit,
    sealCursor,
    generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    makeGrantId = () => Math.random().toString(36).slice(2),
    now = Date.now,
    cursorLifetimeMs = 15 * 60 * 1000,
  } = powers;
  client || Fail`makeDynamoControl requires a client`;
  audit?.record || Fail`makeDynamoControl requires an audit sink`;
  audit?.hashKey || Fail`makeDynamoControl requires an audit key hasher`;
  sealCursor?.seal || Fail`makeDynamoControl requires a cursor sealer`;
  sealCursor?.unseal || Fail`makeDynamoControl requires a cursor unsealer`;

  /** @typedef {{ grantId: string, parentId?: string, generation: string, live: boolean, restrictionDigest: string, restriction: Restriction, windowStart: number, windowCount: number }} Grant */
  /** @type {Map<string, Grant>} */
  const grants = new Map();

  /**
   * @param {Grant} grant
   * @param {string} outcome
   * @param {Operation | 'derive' | 'revoke'} operation
   * @param {Key | undefined} [key]
   * @param {number} [itemCount]
   * @param {number} [started]
   * @param {string} [requestId]
   */
  const record = async (
    grant,
    outcome,
    operation,
    key = undefined,
    itemCount = 0,
    started = now(),
    requestId = undefined,
  ) => {
    await audit.record(
      harden({
        grantId: grant.grantId,
        parentId: grant.parentId,
        restrictionDigest: grant.restrictionDigest,
        operation,
        logicalTable: grant.restriction.table,
        keyHash: key === undefined ? undefined : audit.hashKey(key),
        itemCount,
        outcome,
        elapsedMs: Math.max(0, now() - started),
        generation,
        requestId,
      }),
    );
  };

  /** @param {Grant} grant */
  const consumeRate = grant => {
    const limit = grant.restriction.limits?.ratePerSecond ?? Infinity;
    const time = now();
    if (time - grant.windowStart >= 1000) {
      grant.windowStart = time;
      grant.windowCount = 0;
    }
    if (grant.windowCount >= limit) throw new LimitError('rate limit exceeded');
    grant.windowCount += 1;
  };

  /**
   * @param {readonly Grant[]} chain
   * @param {Operation} operation
   */
  const admit = (chain, operation) => {
    for (const grant of chain) {
      if (!grant.live) return false;
      operationAllowed(operation, grant.restriction) ||
        Fail`Operation ${operation} is not allowed`;
      consumeRate(grant);
    }
    return true;
  };

  /**
   * @param {readonly Grant[]} chain
   * @param {Key} key
   * @param {any} table
   */
  const checkKey = (chain, key, table) => {
    assertKeyShape(key, table);
    for (const grant of chain) {
      keyAllowed(key, table, grant.restriction.ranges) ||
        Fail`Key is outside the grant`;
    }
  };

  /**
   * @param {readonly Grant[]} chain
   * @param {Item} item
   */
  const prepareItem = (chain, item) => {
    let result = item;
    for (const grant of chain) {
      result = applyFixed(result, grant.restriction);
      assertItem(result, grant.restriction, 'write');
    }
    const max = chain.at(-1)?.restriction.limits?.itemSize ?? 400 * 1024;
    const size = encodeUtf8(JSON.stringify(marshalItem(result))).length;
    if (size > max) throw new LimitError('item size exceeded');
    return result;
  };

  /**
   * @param {readonly Grant[]} chain
   * @param {Item} item
   * @param {readonly string[] | undefined} requestedFields
   */
  const receiveItem = (chain, item, requestedFields = undefined) => {
    for (const grant of chain) assertItem(item, grant.restriction, 'read');
    const effective = chain[chain.length - 1].restriction.readFields;
    const fields =
      requestedFields === undefined
        ? effective
        : effective === undefined
          ? requestedFields
          : requestedFields.filter(field => effective.includes(field));
    return projectItem(item, fields);
  };

  /**
   * @param {readonly Grant[]} chain
   * @param {Restriction} local
   * @param {{ cancelled?: Promise<never>, name?: string }} [deriveOptions]
   */
  const makeCapability = (chain, local, deriveOptions = {}) => {
    const parent = chain.at(-1);
    const restriction = attenuate(parent?.restriction, local);
    if (parent === undefined) resolveTable(catalog, restriction);
    const grant = /** @type {Grant} */ ({
      grantId: deriveOptions.name ?? makeGrantId(),
      parentId: parent?.grantId,
      generation,
      live: true,
      restrictionDigest: digest(restriction),
      restriction,
      windowStart: now(),
      windowCount: 0,
    });
    grants.has(grant.grantId) && Fail`Duplicate grant id`;
    grants.set(grant.grantId, grant);
    deriveOptions.cancelled?.catch(() => {
      grant.live = false;
      void record(grant, 'revoked', 'revoke');
    });
    const nextChain = [...chain, grant];
    const table = resolveTable(catalog, restriction);
    void record(grant, 'allowed', 'derive');

    /**
     * @param {Operation} operation
     * @param {Key | undefined} key
     * @param {() => Promise<any>} body
     */
    const perform = async (operation, key, body) => {
      const started = now();
      await null;
      try {
        if (!admit(nextChain, operation)) {
          await record(grant, 'revoked', operation, key, 0, started);
          return revoked;
        }
        const result = await body();
        await record(
          grant,
          result.type,
          operation,
          key,
          result.value?.length ?? 0,
          started,
        );
        return result;
      } catch (error) {
        if (error instanceof LimitError) {
          await record(grant, 'limit-exceeded', operation, key, 0, started);
          return limited;
        }
        if (error instanceof Error && error.name?.endsWith('Exception')) {
          const result = classifyError(error);
          const metadataError =
            /** @type {Error & { $metadata?: { requestId?: string } }} */ (
              error
            );
          await record(
            grant,
            result.type,
            operation,
            key,
            0,
            started,
            metadataError.$metadata?.requestId,
          );
          return result;
        }
        const reason =
          error instanceof Error ? error.message : 'request rejected';
        await record(grant, 'invalid-request', operation, key, 0, started);
        return invalid(reason);
      }
    };

    /** @param {FieldCondition | undefined} condition */
    const conditionExpression = condition =>
      compileCondition(condition, restriction.conditionFields, value =>
        marshalValue(value, { binary: 'bytes' }),
      );

    /** @param {Patch} patch */
    const assertPatchAllowed = patch => {
      for (const fixedField of Object.keys(restriction.fixed ?? {})) {
        if (
          fixedField in (patch.set ?? {}) ||
          (patch.remove ?? []).includes(fixedField) ||
          fixedField in (patch.add ?? {}) ||
          fixedField in (patch.delete ?? {})
        ) {
          Fail`A fixed field cannot be updated`;
        }
      }
      // An arbitrary pass-style pattern cannot be proved against a partial
      // update without reading the old row. Fail closed instead of committing
      // a row that an ancestor's complete-item guard might reject.
      nextChain.some(entry => entry.restriction.itemShape !== undefined) &&
        Fail`Partial updates are unavailable with a complete-item guard`;
    };

    /** @type {DynamoCapability} */
    const methods = {
      async derive(child, childOptions = {}) {
        if (!grant.live) throw Error('revoked');
        return makeCapability(nextChain, child, childOptions);
      },
      async get(key, options = {}) {
        return perform('get', key, async () => {
          checkKey(nextChain, key, table);
          const response = await send(client, 'get', {
            TableName: table.tableName,
            Key: marshalItem(key, { binary: 'bytes' }),
            ConsistentRead: options.consistent,
          });
          return ok(
            response.Item === undefined
              ? undefined
              : receiveItem(
                  nextChain,
                  unmarshalItem(response.Item, { binary: 'bytes' }),
                  options.fields,
                ),
          );
        });
      },
      async put(item, options = {}) {
        return perform('put', undefined, async () => {
          const prepared = prepareItem(nextChain, item);
          const key = /** @type {Key} */ (
            Object.fromEntries(
              [
                table.partitionKey,
                ...(table.sortKey ? [table.sortKey] : []),
              ].map(part => [part.name, prepared[part.name]]),
            )
          );
          checkKey(nextChain, key, table);
          const expression = conditionExpression(options.condition);
          await send(client, 'put', {
            TableName: table.tableName,
            Item: marshalItem(prepared, { binary: 'bytes' }),
            ...omitEmptyExpressionMaps(expression),
          });
          return ok(undefined);
        });
      },
      async update(key, patch, options = {}) {
        return perform('update', key, async () => {
          checkKey(nextChain, key, table);
          assertPatchAllowed(patch);
          const update = compilePatch(patch, restriction.writeFields, value =>
            marshalValue(value, { binary: 'bytes' }),
          );
          const condition = conditionExpression(options.condition);
          const response = await send(client, 'update', {
            TableName: table.tableName,
            Key: marshalItem(key, { binary: 'bytes' }),
            ...omitEmptyExpressionMaps(mergeExpression(update, condition)),
            ReturnValues: 'ALL_NEW',
          });
          return ok(
            response.Attributes === undefined
              ? undefined
              : receiveItem(
                  nextChain,
                  unmarshalItem(response.Attributes, { binary: 'bytes' }),
                ),
          );
        });
      },
      async delete(key, options = {}) {
        return perform('delete', key, async () => {
          checkKey(nextChain, key, table);
          const response = await send(client, 'delete', {
            TableName: table.tableName,
            Key: marshalItem(key, { binary: 'bytes' }),
            ...omitEmptyExpressionMaps(conditionExpression(options.condition)),
            ReturnValues: 'ALL_OLD',
          });
          return ok(
            response.Attributes === undefined
              ? undefined
              : receiveItem(
                  nextChain,
                  unmarshalItem(response.Attributes, { binary: 'bytes' }),
                ),
          );
        });
      },
      async query(request) {
        return perform('query', undefined, async () => {
          const selected =
            request.index === undefined
              ? table
              : table.indexes?.[request.index];
          if (selected === undefined) return Fail`Index is not in the catalog`;
          if (request.index !== undefined) {
            restriction.indexes?.includes(request.index) ||
              Fail`Index is not allowed`;
          }
          /** @type {FieldCondition | undefined} */
          let effectiveSort = request.sort;
          for (const ancestor of nextChain) {
            const ranges = ancestor.restriction.ranges;
            if (ranges !== undefined) {
              const matching = ranges.filter(range =>
                matchesConstraint(request.partition, range.partition),
              );
              matching.length > 0 || Fail`Query partition is outside the grant`;
              if (!matching.some(range => range.sort === undefined)) {
                const constraints = matching.map(range => range.sort);
                const first = constraints[0];
                constraints.every(
                  constraint => digest(constraint) === digest(first),
                ) || Fail`Query must select one allowed sort range`;
                if (selected.sortKey === undefined) {
                  return Fail`A sort-restricted grant cannot query an index without a sort key`;
                }
                if (first === undefined)
                  return Fail`Sort restriction is missing`;
                if ('exact' in first) {
                  if (effectiveSort === undefined) {
                    effectiveSort = harden({
                      op: 'eq',
                      field: selected.sortKey.name,
                      value: first.exact,
                    });
                  } else {
                    (effectiveSort.op === 'eq' &&
                      'value' in effectiveSort &&
                      matchesConstraint(
                        /** @type {any} */ (effectiveSort.value),
                        first,
                      )) ||
                      Fail`Sort condition exceeds the grant`;
                  }
                } else if (effectiveSort === undefined) {
                  effectiveSort = harden({
                    op: 'begins-with',
                    field: selected.sortKey.name,
                    value: first.prefix,
                  });
                } else {
                  ((effectiveSort.op === 'eq' ||
                    effectiveSort.op === 'begins-with') &&
                    'value' in effectiveSort &&
                    matchesConstraint(
                      /** @type {any} */ (effectiveSort.value),
                      first,
                    )) ||
                    Fail`Sort condition exceeds the grant`;
                }
              }
            }
          }
          const pageLimit = restriction.limits?.pageSize ?? 100;
          const limit = request.limit ?? pageLimit;
          if (!Number.isInteger(limit) || limit > pageLimit || limit < 1)
            throw new LimitError('page size exceeded');
          const queryIdentity = { ...request, cursor: undefined };
          let ExclusiveStartKey;
          if (request.cursor !== undefined) {
            const cursor =
              /** @type {{ grantId: string, generation: string, restrictionDigest: string, queryDigest: string, expiresAt: number, key: any } | undefined} */ (
                sealCursor.unseal(request.cursor)
              );
            if (cursor === undefined) return Fail`Cursor is invalid`;
            cursor.grantId === grant.grantId ||
              Fail`Cursor belongs to another grant`;
            cursor.generation === generation ||
              Fail`Cursor belongs to another broker generation`;
            cursor.restrictionDigest === grant.restrictionDigest ||
              Fail`Cursor policy changed`;
            cursor.queryDigest === digest(queryIdentity) ||
              Fail`Cursor belongs to another query`;
            cursor.expiresAt > now() || Fail`Cursor expired`;
            ExclusiveStartKey = cursor.key;
          }
          const keyCondition = compileCondition(
            harden({
              op: 'and',
              conditions: harden([
                harden({
                  op: 'eq',
                  field: selected.partitionKey.name,
                  value: request.partition,
                }),
                ...(effectiveSort ? [effectiveSort] : []),
              ]),
            }),
            harden([
              selected.partitionKey.name,
              ...(selected.sortKey ? [selected.sortKey.name] : []),
            ]),
            value => marshalValue(value, { binary: 'bytes' }),
            'k',
          );
          if (effectiveSort !== undefined) {
            if (selected.sortKey === undefined) {
              return Fail`This index has no sort key`;
            }
            ('field' in effectiveSort &&
              effectiveSort.field === selected.sortKey.name) ||
              Fail`Sort condition must name the index sort key`;
          }
          const filter = compileCondition(
            request.filter,
            restriction.filterFields,
            value => marshalValue(value, { binary: 'bytes' }),
            'f',
          );
          const expression = mergeExpression(
            {
              KeyConditionExpression: keyCondition.ConditionExpression,
              ExpressionAttributeNames: keyCondition.ExpressionAttributeNames,
              ExpressionAttributeValues: keyCondition.ExpressionAttributeValues,
            },
            {
              FilterExpression: filter.ConditionExpression,
              ExpressionAttributeNames: filter.ExpressionAttributeNames,
              ExpressionAttributeValues: filter.ExpressionAttributeValues,
            },
          );
          const queryExpression =
            expression.FilterExpression === undefined
              ? harden({
                  KeyConditionExpression: expression.KeyConditionExpression,
                  ExpressionAttributeNames: expression.ExpressionAttributeNames,
                  ExpressionAttributeValues:
                    expression.ExpressionAttributeValues,
                })
              : expression;
          const response = await send(client, 'query', {
            TableName: table.tableName,
            IndexName:
              request.index === undefined
                ? undefined
                : /** @type {any} */ (selected).indexName,
            ...omitEmptyExpressionMaps(queryExpression),
            Limit: limit,
            ScanIndexForward: request.reverse ? false : undefined,
            ConsistentRead: request.consistent,
            ExclusiveStartKey,
          });
          const items = harden(
            (response.Items ?? []).map(item => {
              const decoded = unmarshalItem(item, { binary: 'bytes' });
              const primaryKey = /** @type {Key} */ (
                Object.fromEntries(
                  [
                    table.partitionKey,
                    ...(table.sortKey ? [table.sortKey] : []),
                  ].map(part => [part.name, decoded[part.name]]),
                )
              );
              checkKey(nextChain, primaryKey, table);
              return receiveItem(nextChain, decoded, request.fields);
            }),
          );
          const cursor =
            response.LastEvaluatedKey === undefined
              ? undefined
              : sealCursor.seal(
                  harden({
                    key: response.LastEvaluatedKey,
                    grantId: grant.grantId,
                    generation,
                    restrictionDigest: grant.restrictionDigest,
                    queryDigest: digest(queryIdentity),
                    expiresAt: now() + cursorLifetimeMs,
                  }),
                );
          return ok(
            harden({ items, ...(cursor === undefined ? {} : { cursor }) }),
          );
        });
      },
      async transactGet(requests) {
        return perform('transactGet', undefined, async () => {
          const max = restriction.limits?.transactionSize ?? 25;
          if (requests.length < 1 || requests.length > max)
            throw new LimitError('transaction size exceeded');
          for (const request of requests)
            checkKey(nextChain, request.key, table);
          // Transaction permission supplements, rather than replaces, member permission.
          for (const ancestor of nextChain) {
            operationAllowed('get', ancestor.restriction) ||
              Fail`Transaction get member is not allowed`;
          }
          const response = await send(client, 'transactGet', {
            TransactItems: requests.map(request => ({
              Get: {
                TableName: table.tableName,
                Key: marshalItem(request.key, { binary: 'bytes' }),
              },
            })),
            ReturnConsumedCapacity: 'NONE',
          });
          return ok(
            harden(
              (response.Responses ?? []).map((entry, index) =>
                entry.Item === undefined
                  ? undefined
                  : receiveItem(
                      nextChain,
                      unmarshalItem(entry.Item, { binary: 'bytes' }),
                      requests[index].fields,
                    ),
              ),
            ),
          );
        });
      },
      async transactWrite(requests, options = {}) {
        return perform('transactWrite', undefined, async () => {
          const max = restriction.limits?.transactionSize ?? 25;
          if (requests.length < 1 || requests.length > max)
            throw new LimitError('transaction size exceeded');
          const members = requests.map(request => {
            const operation = request.operation;
            for (const ancestor of nextChain) {
              operationAllowed(operation, ancestor.restriction) ||
                Fail`Transaction member operation is not allowed`;
            }
            if (operation === 'put') {
              const item = prepareItem(nextChain, request.item);
              const key = /** @type {Key} */ (
                Object.fromEntries(
                  [
                    table.partitionKey,
                    ...(table.sortKey ? [table.sortKey] : []),
                  ].map(part => [part.name, item[part.name]]),
                )
              );
              checkKey(nextChain, key, table);
              return {
                Put: {
                  TableName: table.tableName,
                  Item: marshalItem(item, { binary: 'bytes' }),
                  ...omitEmptyExpressionMaps(
                    conditionExpression(request.condition),
                  ),
                },
              };
            }
            checkKey(nextChain, request.key, table);
            if (operation === 'update') {
              assertPatchAllowed(request.patch);
              const update = compilePatch(
                request.patch,
                restriction.writeFields,
                value => marshalValue(value, { binary: 'bytes' }),
              );
              return {
                Update: {
                  TableName: table.tableName,
                  Key: marshalItem(request.key, { binary: 'bytes' }),
                  ...omitEmptyExpressionMaps(
                    mergeExpression(
                      update,
                      conditionExpression(request.condition),
                    ),
                  ),
                },
              };
            }
            if (operation === 'delete') {
              return {
                Delete: {
                  TableName: table.tableName,
                  Key: marshalItem(request.key, { binary: 'bytes' }),
                  ...omitEmptyExpressionMaps(
                    conditionExpression(request.condition),
                  ),
                },
              };
            }
            return {
              ConditionCheck: {
                TableName: table.tableName,
                Key: marshalItem(request.key, { binary: 'bytes' }),
                ...omitEmptyExpressionMaps(
                  conditionExpression(request.condition),
                ),
              },
            };
          });
          const token =
            options.idempotencyKey === undefined
              ? undefined
              : digest({
                  grantId: grant.grantId,
                  request: requests,
                  key: options.idempotencyKey,
                });
          await send(client, 'transactWrite', {
            TransactItems: members,
            ClientRequestToken: token,
            ReturnConsumedCapacity: 'NONE',
            ReturnItemCollectionMetrics: 'NONE',
          });
          return ok(undefined);
        });
      },
    };
    const capability = /** @type {DynamoCapability} */ (
      /** @type {unknown} */ (
        makeExo(
          'DynamoCapability',
          DynamoCapabilityInterface,
          /** @type {any} */ (methods),
        )
      )
    );
    return capability;
  };

  return harden({
    derive(restriction, options = {}) {
      return makeCapability([], restriction, options);
    },
    revoke(grantId) {
      const grant = grants.get(grantId);
      if (grant === undefined || !grant.live) return false;
      grant.live = false;
      void record(grant, 'revoked', 'revoke');
      return true;
    },
    inspect(grantId) {
      const grant = grants.get(grantId);
      if (grant === undefined) return undefined;
      return harden({
        grantId: grant.grantId,
        parentId: grant.parentId,
        generation: grant.generation,
        live: grant.live,
        restrictionDigest: grant.restrictionDigest,
      });
    },
  });
};
harden(makeDynamoControl);
