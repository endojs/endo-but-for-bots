// @ts-check

/** @import { AuditSink, Condition, CursorSealer, DynamoCapability, DynamoControl, DynamoValue, Failure, Field, GrantRecord, GrantStore, Item, Key, Operation, Patch, Query, ReadOptions, Result, RootRestriction, TableCatalog, TableEntry, TransactionGet, TransactionOptions, TransactionWrite, WriteOptions } from '../types.js' */
/** @import { Effective } from './restriction.js' */

import { Fail } from '@endo/errors';
import { makeExo } from '@endo/exo';
import { passStyleOf } from '@endo/pass-style';
import { encodeUtf8 } from '@endo/utf8';

import {
  assertCondition,
  assertPatch,
  evaluateCondition,
  guardTerms,
  makeExpressionBuilder,
} from './condition.js';
import {
  assertKey,
  keyAllowed,
  keyOf,
  matchesKeyType,
  narrowSortSet,
  sortConditionSet,
  sortSetAdmits,
  sortSetCondition,
} from './keys.js';
import { marshalItem, marshalValue, unmarshalItem } from './marshal.js';
import {
  effectiveDigest,
  narrow,
  narrowRoot,
  projectItem,
} from './restriction.js';
import {
  LimitError,
  RequestError,
  RevokedError,
  invalid,
  limited,
  ok,
  reject,
  revoked,
  safeReason,
} from './results.js';
import { DynamoCapabilityInterface } from './type-guards.js';
import { digest, sameValue } from './value.js';

const clientMethods = harden({
  get: 'getItem',
  put: 'putItem',
  update: 'updateItem',
  delete: 'deleteItem',
  query: 'query',
  transactGet: 'transactGetItems',
  transactWrite: 'transactWriteItems',
});

const retryableErrors = harden([
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'TransactionInProgressException',
  'ServiceUnavailable',
]);

/** @param {DynamoValue} value */
const marshal = value => marshalValue(value, { binary: 'bytes' });
/** @param {Record<string, any>} item */
const marshalBytes = item => marshalItem(item, { binary: 'bytes' });
/** @param {Record<string, any>} item */
const unmarshalBytes = item => unmarshalItem(item, { binary: 'bytes' });

/**
 * @param {string | undefined} code
 * @returns {Failure}
 */
const memberFailure = code => {
  if (code === undefined || code === 'None') return harden({ type: 'none' });
  if (code === 'ConditionalCheckFailed') {
    return harden({ type: 'condition-failed' });
  }
  if (code === 'TransactionConflict') return harden({ type: 'conflict' });
  return harden({ type: 'unavailable' });
};

/**
 * Collapse a provider failure to a safe tagged result. The diagnostic itself
 * never crosses the boundary.
 *
 * @param {unknown} error
 * @returns {Result<never>}
 */
const classifyError = error => {
  const candidate =
    /** @type {{ name?: string, $retryable?: unknown, retryable?: boolean, CancellationReasons?: { Code?: string }[] }} */ (
      error ?? {}
    );
  if (candidate.name === 'ConditionalCheckFailedException') {
    return harden({ type: 'condition-failed' });
  }
  if (candidate.name === 'TransactionCanceledException') {
    return harden({
      type: 'transaction-canceled',
      failures: harden(
        (candidate.CancellationReasons ?? []).map(reason =>
          memberFailure(reason?.Code),
        ),
      ),
    });
  }
  return harden({
    type: 'unavailable',
    retryable:
      candidate.retryable === true ||
      candidate.$retryable !== undefined ||
      retryableErrors.includes(candidate.name ?? ''),
  });
};

/**
 * Approximate DynamoDB's item size accounting: attribute names plus values.
 *
 * @param {unknown} value
 * @returns {number}
 */
const valueSize = value => {
  if (typeof value === 'string') return encodeUtf8(value).length;
  if (typeof value === 'number' || typeof value === 'bigint') {
    return Math.ceil(`${value}`.length / 2) + 1;
  }
  if (value instanceof Uint8Array) return value.length;
  if (value === null || typeof value === 'boolean') return 1;
  if (Array.isArray(value)) {
    return 3 + value.reduce((sum, element) => sum + 1 + valueSize(element), 0);
  }
  if (typeof value === 'object') {
    if (passStyleOf(/** @type {any} */ (value)) === 'tagged') {
      return valueSize(/** @type {any} */ (value).payload);
    }
    return (
      3 +
      Object.entries(value).reduce(
        (sum, [name, element]) =>
          sum + 1 + encodeUtf8(name).length + valueSize(element),
        0,
      )
    );
  }
  return 0;
};

/**
 * @param {unknown} value
 * @param {string} label
 */
const assertOptions = (value, label) => {
  if (value === undefined) return /** @type {Record<string, any>} */ ({});
  (value !== null && typeof value === 'object' && !Array.isArray(value)) ||
    reject(`${label} must be a record`);
  return /** @type {Record<string, any>} */ (value);
};

/**
 * @param {Record<string, any>} record
 * @param {readonly string[]} allowed
 * @param {string} label
 */
const assertOnly = (record, allowed, label) => {
  for (const key of Object.keys(record)) {
    allowed.includes(key) || reject(`${label} has unexpected field ${key}`);
  }
};

/** @param {unknown} key */
const assertIdempotencyKey = key => {
  if (key === undefined) return undefined;
  (typeof key === 'string' && key.length > 0 && key.length <= 256) ||
    reject('idempotencyKey must be a non-empty string');
  return /** @type {string} */ (key);
};

/**
 * @typedef {{
 *   grantId: string,
 *   parent: Grant | undefined,
 *   name: string | undefined,
 *   live: boolean,
 *   effective: Effective,
 *   localGuard: Condition | undefined,
 *   restrictionDigest: string,
 *   windowStart: number,
 *   windowCount: number,
 *   chain: readonly Grant[],
 *   capability: DynamoCapability,
 * }} Grant
 */

/**
 * Construct the host-only root control of one broker generation. The client
 * may be an AWS SDK v3 aggregated `DynamoDB` client (`getItem`, `putItem`,
 * and peers), or a narrow adapter with `send({ operation, input })`.
 *
 * @param {{
 *   client: any,
 *   catalog: TableCatalog,
 *   audit: AuditSink,
 *   sealCursor: CursorSealer,
 *   grantStore?: GrantStore,
 *   tombstones?: Iterable<string>,
 *   generation?: string,
 *   makeGrantId?: () => string,
 *   now?: () => number,
 *   cursorLifetimeMs?: number,
 *   log?: (message: string, error: unknown) => void,
 * }} powers
 * @returns {DynamoControl}
 */
export const makeDynamoControl = powers => {
  const {
    client,
    catalog,
    audit,
    sealCursor,
    grantStore,
    tombstones = [],
    generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    now = Date.now,
    cursorLifetimeMs = 15 * 60 * 1000,
    log = () => {},
  } = powers;
  client || Fail`makeDynamoControl requires a client`;
  catalog || Fail`makeDynamoControl requires a catalog`;
  audit?.record || Fail`makeDynamoControl requires an audit sink`;
  audit?.hashKey || Fail`makeDynamoControl requires an audit key hasher`;
  sealCursor?.seal || Fail`makeDynamoControl requires a cursor sealer`;
  sealCursor?.unseal || Fail`makeDynamoControl requires a cursor unsealer`;
  let grantCount = 0;
  const {
    makeGrantId = () => {
      grantCount += 1;
      return `${generation}/${grantCount}`;
    },
  } = powers;

  let retired = false;
  /** @type {Map<string, Grant>} */
  const grants = new Map();
  /** @type {Map<string, Grant>} */
  const named = new Map();
  const withdrawn = new Set(tombstones);

  /** @param {readonly Grant[]} chain */
  const chainLive = chain => !retired && chain.every(grant => grant.live);

  /**
   * @param {Grant} grant
   * @param {{ operation: string, outcome: string, key?: Key, itemCount?: number, started?: number, requestId?: string, completedAfterRevocation?: boolean }} event
   */
  const record = async (grant, event) => {
    const {
      operation,
      outcome,
      key,
      itemCount = 0,
      started = now(),
      requestId,
      completedAfterRevocation,
    } = event;
    await audit.record(
      harden({
        grantId: grant.grantId,
        ...(grant.parent ? { parentId: grant.parent.grantId } : {}),
        restrictionDigest: grant.restrictionDigest,
        operation: /** @type {any} */ (operation),
        logicalTable: grant.effective.table,
        ...(key === undefined ? {} : { keyHash: audit.hashKey(key) }),
        itemCount,
        outcome,
        elapsedMs: Math.max(0, now() - started),
        generation,
        ...(requestId === undefined ? {} : { requestId }),
        ...(completedAfterRevocation ? { completedAfterRevocation } : {}),
      }),
    );
  };

  /**
   * Check every gate and rate limit, then call the client, all in the same
   * synchronous turn.
   *
   * @param {readonly Grant[]} chain
   * @param {keyof typeof clientMethods} operation
   * @param {Record<string, any>} input
   * @returns {Promise<any>}
   */
  const dispatch = (chain, operation, input) => {
    if (!chainLive(chain)) throw new RevokedError();
    const time = now();
    for (const grant of chain) {
      if (time - grant.windowStart >= 1000) {
        grant.windowStart = time;
        grant.windowCount = 0;
      }
      if (grant.windowCount >= grant.effective.limits.requestsPerSecond) {
        throw new LimitError('rate');
      }
    }
    for (const grant of chain) grant.windowCount += 1;
    const request = harden(input);
    const method = clientMethods[operation];
    if (typeof client[method] === 'function') {
      return Promise.resolve(client[method](request));
    }
    return Promise.resolve(
      client.send(harden({ operation: method, input: request })),
    );
  };

  /**
   * @param {Grant} grant
   * @param {Grant | undefined} parent
   * @param {TableEntry} table
   */
  const makeFacet = (grant, parent, table) => {
    const { chain } = grant;
    const keyParts = [
      table.partitionKey,
      ...(table.sortKey ? [table.sortKey] : []),
    ];
    const keyFields = new Set(keyParts.map(part => part.name));
    const { effective } = grant;

    /** @param {Operation} operation */
    const assertOperation = operation => {
      for (const ancestor of chain) {
        ancestor.effective.operations.includes(operation) ||
          reject(`operation ${operation} is not allowed`);
      }
    };

    /** @param {unknown} key */
    const checkKey = key => {
      const checked = assertKey(key, table);
      for (const ancestor of chain) {
        keyAllowed(checked, table, ancestor.effective.keySpace) ||
          reject('key is outside the grant');
      }
      return checked;
    };

    /**
     * @param {unknown} fields
     * @returns {readonly Field[] | undefined}
     */
    const checkProjection = fields => {
      if (fields === undefined) return undefined;
      (Array.isArray(fields) &&
        fields.every(field => typeof field === 'string')) ||
        reject('fields must list field names');
      const { readFields } = effective.shape;
      for (const field of /** @type {string[]} */ (fields)) {
        readFields === undefined ||
          readFields.includes(field) ||
          reject(`field ${field} is not readable`);
      }
      return /** @type {readonly Field[]} */ (fields);
    };

    /**
     * Admit a returned item through every grant, root first, and project it
     * down to the holder. Returns undefined for an item a grant cannot see.
     *
     * @param {Item} item
     * @param {readonly Field[] | undefined} requested
     */
    const receive = (item, requested) => {
      const key = keyOf(item, table);
      if (key === undefined) return undefined;
      let visible = item;
      for (const ancestor of chain) {
        if (!keyAllowed(key, table, ancestor.effective.keySpace)) {
          return undefined;
        }
        if (
          ancestor.localGuard !== undefined &&
          !evaluateCondition(ancestor.localGuard, visible)
        ) {
          return undefined;
        }
        visible = projectItem(visible, ancestor.effective.shape.readFields);
      }
      return projectItem(visible, requested);
    };

    /**
     * @param {unknown} condition
     * @returns {Condition | undefined}
     */
    const checkCondition = condition => {
      if (condition === undefined) return undefined;
      assertCondition(condition, field => {
        for (const ancestor of chain) {
          const allowed = ancestor.effective.shape.conditionFields;
          allowed === undefined ||
            allowed.includes(field) ||
            reject(`condition field ${field} is not allowed`);
        }
      });
      return /** @type {Condition} */ (condition);
    };

    /**
     * Guard terms over fields a write leaves untouched, enforced by DynamoDB
     * against the stored item.
     *
     * @param {(field: Field) => 'static' | 'server'} classify
     * @param {Item} known values the write determines
     */
    const guardConditions = (classify, known) => {
      /** @type {Condition[]} */
      const server = [];
      for (const ancestor of chain) {
        if (ancestor.localGuard !== undefined) {
          for (const { field, term } of guardTerms(ancestor.localGuard)) {
            if (classify(field) === 'static') {
              evaluateCondition(term, known) ||
                reject(`write fails the guard on ${field}`);
            } else {
              server.push(term);
            }
          }
        }
      }
      return server;
    };

    /**
     * @param {Condition | undefined} caller
     * @param {readonly Condition[]} guards
     * @returns {Condition | undefined}
     */
    const combine = (caller, guards) => {
      const terms = [...(caller ? [caller] : []), ...guards];
      if (terms.length === 0) return undefined;
      if (terms.length === 1) return terms[0];
      return harden({ and: harden(terms) });
    };

    /**
     * @param {unknown} item
     */
    const preparePut = item => {
      (item !== null &&
        typeof item === 'object' &&
        passStyleOf(/** @type {any} */ (item)) === 'copyRecord') ||
        reject('item must be a record');
      const prepared = { .../** @type {Item} */ (item) };
      for (const [field, value] of Object.entries(effective.shape.fixed)) {
        if (Object.hasOwn(prepared, field)) {
          sameValue(prepared[field], value) ||
            reject(`field ${field} conflicts with a fixed value`);
        }
        prepared[field] = value;
      }
      for (const ancestor of chain) {
        const { writeFields, fixed } = ancestor.effective.shape;
        if (writeFields !== undefined) {
          for (const field of Object.keys(prepared)) {
            writeFields.includes(field) ||
              keyFields.has(field) ||
              Object.hasOwn(fixed, field) ||
              reject(`field ${field} is not writable`);
          }
        }
      }
      const key = checkKey(
        keyOf(prepared, table) ?? reject('item lacks its key'),
      );
      const complete = harden(prepared);
      guardConditions(() => 'static', complete);
      if (valueSize(complete) > effective.limits.itemBytes) {
        throw new LimitError('item-size');
      }
      return { key, item: complete };
    };

    /**
     * @param {unknown} key
     * @param {unknown} patch
     */
    const prepareUpdate = (key, patch) => {
      const checkedKey = checkKey(key);
      const touched = assertPatch(patch);
      const patchRecord = /** @type {Patch} */ (patch);
      const { fixed } = effective.shape;
      for (const field of touched) {
        keyFields.has(field) && reject(`key field ${field} cannot be updated`);
        if (Object.hasOwn(fixed, field)) {
          (Object.hasOwn(patchRecord.set ?? {}, field) &&
            sameValue(
              /** @type {any} */ (patchRecord.set)[field],
              fixed[field],
            )) ||
            reject(`fixed field ${field} cannot be changed`);
        }
        for (const ancestor of chain) {
          const { writeFields } = ancestor.effective.shape;
          writeFields === undefined ||
            writeFields.includes(field) ||
            reject(`field ${field} is not writable`);
        }
      }
      // Fixed attributes are injected on every write, including an update
      // that creates its item.
      const set = harden({ ...(patchRecord.set ?? {}), ...fixed });
      const effectivePatch = harden({ ...patchRecord, set });
      const removed = new Set(patchRecord.remove ?? []);
      const arithmetic = new Set([
        ...Object.keys(patchRecord.add ?? {}),
        ...Object.keys(patchRecord.delete ?? {}),
      ]);
      const known = harden({ ...checkedKey, ...set });
      const server = guardConditions(field => {
        if (arithmetic.has(field)) {
          return reject(`update cannot prove the guard on ${field}`);
        }
        return keyFields.has(field) ||
          Object.hasOwn(set, field) ||
          removed.has(field)
          ? 'static'
          : 'server';
      }, known);
      if (valueSize(effectivePatch) > effective.limits.itemBytes) {
        throw new LimitError('item-size');
      }
      return { key: checkedKey, patch: effectivePatch, server };
    };

    /**
     * Build one validated write as a transaction member shape. The same
     * builder serves single writes and transactions.
     *
     * @param {Operation} operation
     * @param {Record<string, any>} request
     */
    const buildWrite = (operation, request) => {
      const builder = makeExpressionBuilder(marshal);
      const condition = checkCondition(request.condition);
      /** @param {Condition | undefined} combined */
      const conditionPart = combined =>
        combined === undefined
          ? {}
          : { ConditionExpression: builder.condition(combined) };
      if (operation === 'put') {
        const { key, item } = preparePut(request.item);
        return {
          key,
          kind: 'Put',
          member: harden({
            TableName: table.tableName,
            Item: marshalBytes(item),
            ...conditionPart(condition),
            ...builder.maps(),
          }),
        };
      }
      if (operation === 'update') {
        const { key, patch, server } = prepareUpdate(
          request.key,
          request.patch,
        );
        const UpdateExpression = builder.update(patch);
        return {
          key,
          kind: 'Update',
          member: harden({
            TableName: table.tableName,
            Key: marshalBytes(key),
            UpdateExpression,
            ...conditionPart(combine(condition, server)),
            ...builder.maps(),
          }),
        };
      }
      const key = checkKey(request.key);
      // Delete and condition-check act on the stored item, so every guard
      // term is a condition on it.
      const server = guardConditions(() => 'server', harden({}));
      if (operation === 'conditionCheck') {
        condition !== undefined ||
          reject('conditionCheck requires a condition');
      }
      return {
        key,
        kind: operation === 'delete' ? 'Delete' : 'ConditionCheck',
        member: harden({
          TableName: table.tableName,
          Key: marshalBytes(key),
          ...conditionPart(combine(condition, server)),
          ...builder.maps(),
        }),
      };
    };

    /**
     * @param {string | undefined} idempotencyKey
     * @param {unknown} normalized
     */
    const requestToken = (idempotencyKey, normalized) =>
      idempotencyKey === undefined
        ? undefined
        : digest({
            grantId: grant.grantId,
            request: normalized,
            idempotencyKey,
          }).slice(0, 36);

    /**
     * Run one operation: check gates and rights, validate, dispatch once,
     * classify, and audit.
     *
     * @template T
     * @param {Operation} operation
     * @param {(send: (op: keyof typeof clientMethods, input: Record<string, any>) => Promise<any>, note: (key: Key) => void) => Promise<Result<T>>} body
     * @returns {Promise<Result<T>>}
     */
    const perform = async (operation, body) => {
      const started = now();
      let sent = false;
      /** @type {Key | undefined} */
      let auditKey;
      /** @type {string | undefined} */
      let requestId;
      /** @type {Result<T>} */
      let result;
      try {
        if (!chainLive(chain)) throw new RevokedError();
        assertOperation(operation);
        result = await body(
          (op, input) => {
            const pending = dispatch(chain, op, input);
            sent = true;
            return pending.then(
              response => {
                requestId = response?.$metadata?.requestId;
                return response;
              },
              error => {
                requestId = error?.$metadata?.requestId;
                throw error;
              },
            );
          },
          key => {
            auditKey = key;
          },
        );
      } catch (error) {
        if (error instanceof RevokedError) result = revoked;
        else if (error instanceof LimitError) {
          result = limited(/** @type {any} */ (error).limit);
        } else if (!sent) {
          if (!(error instanceof RequestError)) {
            log(
              `exo-dynamodb ${operation} rejected a malformed request`,
              error,
            );
          }
          result = invalid(safeReason(error));
        } else {
          // The full provider diagnostic stays in the host log.
          log(`exo-dynamodb ${operation} failed`, error);
          result = classifyError(error);
        }
      }
      const value = /** @type {any} */ (result).value;
      await record(grant, {
        operation,
        outcome: result.type,
        key: auditKey,
        itemCount: Array.isArray(value)
          ? value.length
          : Array.isArray(value?.items)
            ? value.items.length
            : value === undefined
              ? 0
              : 1,
        started,
        requestId,
        completedAfterRevocation: sent && !chainLive(chain),
      });
      return result;
    };

    /**
     * Send one write, through a one-member transaction when the caller asks
     * for idempotency.
     *
     * @param {(op: keyof typeof clientMethods, input: Record<string, any>) => Promise<any>} send
     * @param {Operation & ('put' | 'update' | 'delete')} operation
     * @param {ReturnType<typeof buildWrite>} built
     * @param {string | undefined} idempotencyKey
     * @param {'ALL_NEW' | 'ALL_OLD' | undefined} returnValues
     * @returns {Promise<Result<Item | undefined>>}
     */
    const sendWrite = async (
      send,
      operation,
      built,
      idempotencyKey,
      returnValues,
    ) => {
      if (idempotencyKey !== undefined) {
        try {
          await send('transactWrite', {
            TransactItems: [{ [built.kind]: built.member }],
            ClientRequestToken: requestToken(idempotencyKey, {
              operation,
              member: built.member,
            }),
            ReturnConsumedCapacity: 'NONE',
            ReturnItemCollectionMetrics: 'NONE',
          });
        } catch (error) {
          const classified = classifyError(error);
          if (classified.type !== 'transaction-canceled') throw error;
          const [failure] = classified.failures;
          if (failure?.type === 'condition-failed') {
            return harden({ type: 'condition-failed' });
          }
          return harden({
            type: 'unavailable',
            retryable: failure?.type === 'conflict',
          });
        }
        return ok(undefined);
      }
      const clientOperation =
        operation === 'put'
          ? 'put'
          : operation === 'update'
            ? 'update'
            : 'delete';
      const response = await send(clientOperation, {
        ...built.member,
        ...(returnValues === undefined ? {} : { ReturnValues: returnValues }),
      });
      if (returnValues === undefined || response?.Attributes === undefined) {
        return ok(undefined);
      }
      return ok(receive(unmarshalBytes(response.Attributes), undefined));
    };

    /** @type {DynamoCapability} */
    const methods = {
      async derive(restriction, options) {
        const started = now();
        if (!chainLive(chain)) {
          await record(grant, {
            operation: 'derive',
            outcome: 'revoked',
            started,
          });
          return revoked;
        }
        try {
          const { cancelled, ...rest } = assertOptions(options, 'options');
          assertOnly(rest, [], 'options');
          const next = narrow(effective, restriction, table);
          // eslint-disable-next-line no-use-before-define
          const child = addGrant(grant, next, restriction, table, {
            cancelled,
          });
          return ok(
            harden({ capability: child.capability, grantId: child.grantId }),
          );
        } catch (error) {
          await record(grant, {
            operation: 'derive',
            outcome: 'invalid-request',
            started,
          });
          return invalid(safeReason(error));
        }
      },

      async get(key, options) {
        return perform('get', async (send, note) => {
          const opts = assertOptions(options, 'options');
          assertOnly(opts, ['fields', 'consistent'], 'options');
          const checked = checkKey(key);
          note(checked);
          const fields = checkProjection(opts.fields);
          const response = await send('get', {
            TableName: table.tableName,
            Key: marshalBytes(checked),
            ...(opts.consistent === true ? { ConsistentRead: true } : {}),
          });
          return ok(
            response?.Item === undefined
              ? undefined
              : receive(unmarshalBytes(response.Item), fields),
          );
        });
      },

      async put(item, options) {
        return perform('put', async (send, note) => {
          const opts = assertOptions(options, 'options');
          assertOnly(opts, ['condition', 'idempotencyKey'], 'options');
          const idempotencyKey = assertIdempotencyKey(opts.idempotencyKey);
          const built = buildWrite('put', { item, condition: opts.condition });
          note(built.key);
          const result = await sendWrite(
            send,
            'put',
            built,
            idempotencyKey,
            undefined,
          );
          return result.type === 'ok' ? ok(undefined) : result;
        });
      },

      async update(key, patch, options) {
        return perform('update', async (send, note) => {
          const opts = assertOptions(options, 'options');
          assertOnly(opts, ['condition', 'idempotencyKey'], 'options');
          const idempotencyKey = assertIdempotencyKey(opts.idempotencyKey);
          const built = buildWrite('update', {
            key,
            patch,
            condition: opts.condition,
          });
          note(built.key);
          return sendWrite(send, 'update', built, idempotencyKey, 'ALL_NEW');
        });
      },

      async delete(key, options) {
        return perform('delete', async (send, note) => {
          const opts = assertOptions(options, 'options');
          assertOnly(opts, ['condition', 'idempotencyKey'], 'options');
          const idempotencyKey = assertIdempotencyKey(opts.idempotencyKey);
          const built = buildWrite('delete', {
            key,
            condition: opts.condition,
          });
          note(built.key);
          return sendWrite(send, 'delete', built, idempotencyKey, 'ALL_OLD');
        });
      },

      async query(request) {
        return perform('query', async (send, note) => {
          const query = /** @type {Query} */ (
            assertOptions(
              request ?? reject('query requires a request'),
              'query',
            )
          );
          assertOnly(
            query,
            [
              'index',
              'partition',
              'sort',
              'filter',
              'descending',
              'limit',
              'cursor',
              'fields',
              'consistent',
            ],
            'query',
          );
          const { index } = query;
          let schema = /** @type {import('../types.js').KeySchema} */ (table);
          if (index !== undefined) {
            typeof index === 'string' || reject('index must be a name');
            for (const ancestor of chain) {
              Object.hasOwn(ancestor.effective.indexes, index) ||
                reject(`index ${index} is outside the grant`);
            }
            const entry =
              table.indexes?.[index] ??
              reject(`index ${index} is outside the grant`);
            if (query.consistent === true && entry.global !== false) {
              reject('consistent reads are unavailable on a global index');
            }
            schema = entry;
          }
          query.consistent === undefined ||
            typeof query.consistent === 'boolean' ||
            reject('consistent must be a boolean');
          query.descending === undefined ||
            typeof query.descending === 'boolean' ||
            reject('descending must be a boolean');
          matchesKeyType(query.partition, schema.partitionKey.type) ||
            reject('partition has the wrong type');
          note(harden({ [schema.partitionKey.name]: query.partition }));

          if (query.sort !== undefined) {
            assertCondition(query.sort);
            schema.sortKey !== undefined ||
              reject('this schema has no sort key');
          }
          let sortSet = schema.sortKey
            ? sortConditionSet(query.sort, schema.sortKey)
            : harden({});
          for (const ancestor of chain) {
            sortSet = narrowSortSet(
              sortSet,
              query.partition,
              index === undefined
                ? ancestor.effective.keySpace
                : ancestor.effective.indexes[index],
            );
          }

          const schemaKeys = new Set([
            schema.partitionKey.name,
            ...(schema.sortKey ? [schema.sortKey.name] : []),
          ]);
          if (query.filter !== undefined) {
            assertCondition(query.filter, field => {
              schemaKeys.has(field) &&
                reject(`filter cannot name key field ${field}`);
              for (const ancestor of chain) {
                const allowed = ancestor.effective.shape.filterFields;
                allowed === undefined ||
                  allowed.includes(field) ||
                  reject(`filter field ${field} is not allowed`);
              }
            });
          }
          const fields = checkProjection(query.fields);

          const pageSize = effective.limits.pageSize;
          const limit = query.limit ?? pageSize;
          (Number.isSafeInteger(limit) && limit >= 1) ||
            reject('limit must be a positive integer');
          if (limit > pageSize) throw new LimitError('page');

          const identity = digest({
            index,
            partition: query.partition,
            sort: query.sort,
            filter: query.filter,
            descending: query.descending === true,
            fields,
            consistent: query.consistent === true,
          });
          let startKey;
          if (query.cursor !== undefined) {
            typeof query.cursor === 'string' || reject('cursor is invalid');
            const sealed =
              /** @type {{ grantId: string, generation: string, restrictionDigest: string, queryDigest: string, expiresAt: number, key: unknown } | undefined} */ (
                sealCursor.unseal(query.cursor)
              );
            if (sealed === undefined) return reject('cursor is invalid');
            sealed.grantId === grant.grantId ||
              reject('cursor belongs to another grant');
            sealed.generation === generation ||
              reject('cursor belongs to another generation');
            sealed.restrictionDigest === grant.restrictionDigest ||
              reject('cursor belongs to another restriction');
            sealed.queryDigest === identity ||
              reject('cursor belongs to another query');
            sealed.expiresAt > now() || reject('cursor expired');
            startKey = sealed.key;
          }

          const builder = makeExpressionBuilder(marshal);
          const sortCondition = schema.sortKey
            ? sortSetCondition(sortSet, schema.sortKey.name)
            : undefined;
          const partitionCondition = harden({
            field: schema.partitionKey.name,
            eq: query.partition,
          });
          const KeyConditionExpression = builder.condition(
            sortCondition === undefined
              ? partitionCondition
              : harden({ and: harden([partitionCondition, sortCondition]) }),
          );
          const FilterExpression =
            query.filter === undefined
              ? undefined
              : builder.condition(query.filter);
          const response = await send('query', {
            TableName: table.tableName,
            ...(index === undefined
              ? {}
              : {
                  IndexName: /** @type {any} */ (schema).indexName,
                }),
            KeyConditionExpression,
            ...(FilterExpression === undefined ? {} : { FilterExpression }),
            ...builder.maps(),
            Limit: limit,
            ...(query.descending === true ? { ScanIndexForward: false } : {}),
            ...(query.consistent === true ? { ConsistentRead: true } : {}),
            ...(startKey === undefined ? {} : { ExclusiveStartKey: startKey }),
          });

          /** @type {Item[]} */
          const items = [];
          for (const raw of response?.Items ?? []) {
            const decoded = unmarshalBytes(raw);
            // Items outside the query's own range or any grant's base key
            // space and guards are dropped without a count.
            if (
              sameValue(decoded[schema.partitionKey.name], query.partition) &&
              (schema.sortKey === undefined ||
                sortSetAdmits(sortSet, decoded[schema.sortKey.name]))
            ) {
              const visible = receive(decoded, fields);
              if (visible !== undefined) items.push(visible);
            }
          }
          const cursor =
            response?.LastEvaluatedKey === undefined
              ? undefined
              : sealCursor.seal(
                  harden({
                    key: response.LastEvaluatedKey,
                    grantId: grant.grantId,
                    generation,
                    restrictionDigest: grant.restrictionDigest,
                    queryDigest: identity,
                    expiresAt: now() + cursorLifetimeMs,
                  }),
                );
          return ok(
            harden({
              items: harden(items),
              ...(cursor === undefined ? {} : { cursor }),
            }),
          );
        });
      },

      async transactGet(requests) {
        return perform('transactGet', async send => {
          Array.isArray(requests) || reject('transactGet requires a list');
          if (
            requests.length < 1 ||
            requests.length > effective.limits.transactionSize
          ) {
            throw new LimitError('transaction');
          }
          assertOperation('get');
          const members = requests.map(request => {
            const member = assertOptions(request, 'transaction member');
            assertOnly(member, ['key', 'fields'], 'transaction member');
            return {
              key: checkKey(member.key),
              fields: checkProjection(member.fields),
            };
          });
          const response = await send('transactGet', {
            TransactItems: members.map(member => ({
              Get: {
                TableName: table.tableName,
                Key: marshalBytes(member.key),
              },
            })),
            ReturnConsumedCapacity: 'NONE',
          });
          const responses = response?.Responses ?? [];
          return ok(
            harden(
              members.map((member, index) =>
                responses[index]?.Item === undefined
                  ? undefined
                  : receive(
                      unmarshalBytes(responses[index].Item),
                      member.fields,
                    ),
              ),
            ),
          );
        });
      },

      async transactWrite(requests, options) {
        return perform('transactWrite', async send => {
          Array.isArray(requests) || reject('transactWrite requires a list');
          const opts = assertOptions(options, 'options');
          assertOnly(opts, ['idempotencyKey'], 'options');
          const idempotencyKey = assertIdempotencyKey(opts.idempotencyKey);
          if (
            requests.length < 1 ||
            requests.length > effective.limits.transactionSize
          ) {
            throw new LimitError('transaction');
          }
          const members = requests.map(request => {
            const member = assertOptions(request, 'transaction member');
            const { operation } = member;
            ['put', 'update', 'delete', 'conditionCheck'].includes(operation) ||
              reject('transaction member operation is unknown');
            assertOnly(
              member,
              operation === 'put'
                ? ['operation', 'item', 'condition']
                : operation === 'update'
                  ? ['operation', 'key', 'patch', 'condition']
                  : ['operation', 'key', 'condition'],
              'transaction member',
            );
            // Transaction permission supplements member permission.
            assertOperation(operation);
            const built = buildWrite(operation, member);
            return harden({ [built.kind]: built.member });
          });
          await send('transactWrite', {
            TransactItems: members,
            ...(idempotencyKey === undefined
              ? {}
              : { ClientRequestToken: requestToken(idempotencyKey, members) }),
            ReturnConsumedCapacity: 'NONE',
            ReturnItemCollectionMetrics: 'NONE',
          });
          return ok(undefined);
        });
      },
    };
    void parent;
    return /** @type {DynamoCapability} */ (
      /** @type {unknown} */ (
        makeExo(
          'DynamoCapability',
          DynamoCapabilityInterface,
          /** @type {any} */ (methods),
        )
      )
    );
  };

  /**
   * @param {Grant} grant
   * @param {string} operation
   */
  const close = (grant, operation) => {
    const wasLive = grant.live;
    grant.live = false;
    if (wasLive) void record(grant, { operation, outcome: 'revoked' });
  };

  /**
   * @param {Grant | undefined} parent
   * @param {Effective} effective
   * @param {unknown} restriction the caller's own restriction
   * @param {TableEntry} table
   * @param {{ cancelled?: unknown, name?: string }} options
   * @returns {Grant}
   */
  const addGrant = (parent, effective, restriction, table, options) => {
    const { cancelled, name } = options;
    cancelled === undefined ||
      typeof (/** @type {any} */ (cancelled)?.then) === 'function' ||
      reject('cancelled must be a promise');
    const grantId = makeGrantId();
    !grants.has(grantId) || Fail`Duplicate grant id`;
    const localGuard = /** @type {any} */ (restriction)?.shape?.guard;
    /** @type {Grant} */
    const grant = /** @type {any} */ ({
      grantId,
      parent,
      name,
      live: true,
      effective,
      localGuard: localGuard === undefined ? undefined : harden(localGuard),
      restrictionDigest: effectiveDigest(effective),
      windowStart: now(),
      windowCount: 0,
    });
    // Freeze shallowly: grants carry mutable gate and rate state.
    grant.chain = Object.freeze([...(parent?.chain ?? []), grant]);
    grant.capability = makeFacet(grant, parent, table);
    grants.set(grantId, grant);
    if (cancelled !== undefined) {
      Promise.resolve(cancelled).then(
        () => {},
        () => close(grant, 'revoke'),
      );
    }
    void record(grant, { operation: 'derive', outcome: 'ok' });
    return grant;
  };

  /** @param {Grant} grant */
  const lineageOf = grant =>
    harden(
      grant.chain.map(
        entry =>
          /** @type {GrantRecord} */ (
            harden({
              grantId: entry.grantId,
              ...(entry.parent ? { parentId: entry.parent.grantId } : {}),
              ...(entry.name === undefined ? {} : { name: entry.name }),
              generation,
              live: !retired && entry.live,
              restrictionDigest: entry.restrictionDigest,
            })
          ),
      ),
    );

  /** @type {DynamoControl} */
  const control = {
    async derive(restriction, options) {
      if (retired) return revoked;
      /** @type {string | undefined} */
      let reserved;
      try {
        const { name, cancelled, ...rest } = assertOptions(options, 'options');
        assertOnly(rest, [], 'options');
        const { effective, table } = narrowRoot(catalog, restriction);
        if (name !== undefined) {
          (typeof name === 'string' && name !== '') ||
            reject('name must be a non-empty string');
          grantStore !== undefined ||
            reject('named grants require a grant store');
          !withdrawn.has(name) || reject(`grant ${name} was withdrawn`);
          !named.has(name) || reject(`grant ${name} is already bound`);
          reserved = name;
        }
        const grant = addGrant(undefined, effective, restriction, table, {
          cancelled,
          name,
        });
        if (reserved !== undefined) {
          named.set(reserved, grant);
          try {
            await /** @type {GrantStore} */ (grantStore).putRecipe(
              reserved,
              /** @type {RootRestriction} */ (harden(restriction)),
            );
          } catch {
            named.delete(reserved);
            close(grant, 'revoke');
            return harden({ type: 'unavailable', retryable: true });
          }
        }
        return ok(
          harden({ capability: grant.capability, grantId: grant.grantId }),
        );
      } catch (error) {
        return invalid(safeReason(error));
      }
    },
    async withdraw(grantId) {
      const grant =
        typeof grantId === 'string' ? grants.get(grantId) : undefined;
      if (grant === undefined) return invalid('unknown grant');
      /** @type {Result<void>} */
      let result = ok(undefined);
      if (grant.name !== undefined) {
        try {
          await /** @type {GrantStore} */ (grantStore).putTombstone(grant.name);
          withdrawn.add(grant.name);
        } catch {
          result = harden({ type: 'unavailable', retryable: true });
        }
      }
      // Closing the gate never waits on durability: a failed tombstone still
      // stops this generation.
      const wasLive = grant.live;
      grant.live = false;
      await record(grant, {
        operation: 'withdraw',
        outcome: wasLive ? result.type : 'already-closed',
      });
      return result;
    },
    async lineage(grantId) {
      const grant =
        typeof grantId === 'string' ? grants.get(grantId) : undefined;
      if (grant === undefined) return invalid('unknown grant');
      return ok(lineageOf(grant));
    },
    async retire() {
      retired = true;
      return ok(undefined);
    },
  };
  return harden(control);
};
harden(makeDynamoControl);
