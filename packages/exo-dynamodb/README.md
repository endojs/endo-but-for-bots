# `@endo/exo-dynamodb`

`@endo/exo-dynamodb` turns a trusted DynamoDB client into recursively
attenuated object capabilities. A host selects one physical table and gives a
confined guest only an exo whose key space, indexes, item shape, operations,
and resource limits can shrink at every derivation and never grow.

The package deliberately does not proxy the AWS SDK. A capability exposes no
credentials, client, table name, raw expression, `Scan`, PartiQL, batch,
stream, or table-control operation. Conditions, filters, guards, and updates
use a closed data AST, and pagination keys are replaced with sealed,
broker-incarnation-local cursors.

## Host setup

```js
import {
  makeMemoryCursorSealer,
  makeMemoryGrantStore,
  reincarnateDynamoControl,
} from '@endo/exo-dynamodb';

const { control, named } = await reincarnateDynamoControl({
  // An AWS SDK v3 aggregated DynamoDB client, or a narrow adapter (below).
  // Keep it and its credential provider outside confinement.
  client,
  catalog: harden({
    coupons: harden({
      tableName: process.env.COUPON_TABLE,
      partitionKey: harden({ name: 'pk', type: 'string' }),
      indexes: harden({
        queue: harden({
          indexName: 'queue',
          partitionKey: harden({ name: 'queue', type: 'string' }),
          sortKey: harden({ name: 'due', type: 'number' }),
        }),
      }),
    }),
  }),
  audit,
  sealCursor: makeMemoryCursorSealer({ random: secureRandomToken }),
  grantStore, // durable recipes and tombstones; see "Restart"
  log: (message, error) => console.error(message, error),
});

const derived =
  named['coupon-ledger'] ??
  (await control.derive(couponRestriction, { name: 'coupon-ledger' }));
if (derived.type !== 'ok') throw Error(`grant refused: ${derived.type}`);
const { capability, grantId } = derived.value;
```

`makeDynamoControl(powers)` constructs a control directly when the host has no
named grants to rebuild. `secureRandomToken` must return a fresh,
cryptographically unpredictable string; it is a host power, not ambient
package authority.

The host retains `control`; the guest receives `capability` or, preferably, a
domain facet that closes over it. The control is host-only:

```ts
interface DynamoControl {
  derive(restriction: RootRestriction, options?: { name?: string; cancelled?: Promise<never> }):
    Promise<Result<{ capability: DynamoCapability; grantId: GrantId }>>;
  withdraw(grantId: GrantId): Promise<Result<void>>;
  lineage(grantId: GrantId): Promise<Result<readonly GrantRecord[]>>;
  retire(): Promise<Result<void>>; // closes every gate of this generation
}
```

A capability's `derive(restriction, { cancelled })` returns the same
`{ capability, grantId }` shape. Only the control accepts `name`.

## Results, not rejections

Every method resolves to a tagged `Result`: `ok`, `condition-failed`,
`transaction-canceled` (with one positional `Failure` per member: `none`,
`condition-failed`, `conflict`, or `unavailable`), `invalid-request` (with a
safe reason), `limit-exceeded` (naming `page`, `transaction`, `item-size`, or
`rate`; only `rate` is retryable), `revoked`, or `unavailable`. A malformed
argument, a widening or conflicting derivation, and a revoked grant are
results. A promise rejects only when the remote reference itself breaks.

Reasons name only the caller's own methods and logical fields. Physical table
names, ancestor restrictions, AWS request ids, and provider diagnostics never
cross; the optional host `log` power receives the full diagnostic.

## Restrictions

```ts
interface Restriction {
  keySpace?: readonly KeyRange[];
  indexes?: Readonly<Record<IndexName, readonly KeyRange[]>>;
  shape?: {
    readFields?: readonly Field[];
    writeFields?: readonly Field[];
    conditionFields?: readonly Field[];
    filterFields?: readonly Field[];
    fixed?: Readonly<Record<Field, Scalar>>;
    guard?: Condition;
  };
  operations?: readonly Operation[];
  limits?: { pageSize?: number; transactionSize?: number;
             itemBytes?: number; requestsPerSecond?: number };
}
```

An omitted part inherits the parent's effective value; an empty list means
none, so `{ indexes: {} }` removes every index. A child that names anything
outside its parent (a field, operation, index, range, or larger limit) gets
`invalid-request` rather than a silent clamp. A root restriction additionally
names a logical `table` from the catalog.

A `KeyRange` constrains one key schema, the base table's or one index's:
`{ partition, sort? }`, where each constraint is `{ exact }`, a byte-for-byte
`{ prefix }` for string or binary keys, or an inclusive `{ min?, max? }`
interval for a numeric sort key. A child narrows a prefix by appending or
replacing it with an exact value, and an interval by raising `min` or lowering
`max`. A family prefix should end with its delimiter, and a single item should
be isolated with an exact value: `{ prefix: 'COUPON#7' }` admits `COUPON#70`.

Point operations check their whole base-table key. A query states a
partition-key equality inside one allowed range of the schema it queries; its
sort-key condition (`eq`, `lt`, `lte`, `gt`, `gte`, `between`, or
`beginsWith`) is intersected with that range, and a condition outside it is
`invalid-request`.

**Index queries never widen the base key space.** Every item an index query
returns is rechecked against the base key space and guard of the grant and
every ancestor, exactly as if fetched by `get`. Items outside are dropped from
the page without a count. Global secondary indexes refuse consistent reads
(`invalid-request`); local indexes declared `global: false` permit them.

**Item shape.** Conditions may mention only `conditionFields`, filters only
`filterFields`, and writes only `writeFields` (key attributes are always
writable by `put`, bounded by the key space). Reads are projected to the
intersection of every ancestor's `readFields`. Fixed attributes are injected
on every write, including updates that create their item, and a write that
supplies a different value is refused. A guard is a `Condition` restricted to
conjunctions of equality, `beginsWith`, existence, and the negation of one
such term. It is evaluated against the complete item a `put` would write and
against every returned item. An `update` proves guard terms on fields it sets
or removes statically and enforces terms on untouched fields as a DynamoDB
condition on the stored item; a guard term over a field the update adds to or
deletes from is refused. `delete` and `conditionCheck` enforce every guard
term on the stored item.

## Conditions, updates, queries, and transactions

```js
await capability.update(
  harden({ pk: 'COUPON#7' }),
  harden({ set: harden({ status: 'redeeming' }), add: harden({ uses: 1 }) }),
  harden({
    condition: harden({
      and: harden([
        harden({ field: 'status', eq: 'issued' }),
        harden({ not: harden({ exists: 'leaseNonce' }) }),
      ]),
    }),
    idempotencyKey: 'redeem-7',
  }),
);
```

Condition nodes are `{ and }`, `{ or }`, `{ not }`, `{ exists: field }`, or
`{ field, <operator>: value }` with `eq`, `ne`, `lt`, `lte`, `gt`, `gte`,
`between`, or `beginsWith`. Patches have `set`, `remove`, `add`, and `delete`
parts. `ReturnValuesOnConditionCheckFailure`, consumed capacity, and
item-collection metrics are never requested.

`WriteOptions.idempotencyKey` sends an individual write through a one-member
DynamoDB transaction with a client request token; an idempotent `update` or
`delete` therefore resolves `undefined` instead of the item.
`transactWrite` accepts the same option. Tokens hash the grant id, the
normalized request, and the caller's key, so sibling grants cannot collide.

`query` takes `{ index?, partition, sort?, filter?, descending?, limit?,
cursor?, fields?, consistent? }` and resolves a page `{ items, cursor? }`. A
filter bounds results, not reads: DynamoDB bills the items the key condition
selects, so a filtered page can be empty and still carry a cursor. A cursor is
valid only for the same grant, restriction, query, and broker generation.

`transactGet` and `transactWrite` validate every member before sending any of
it. Each member uses the grant's one table and needs both the transaction
right and its own operation right. Mixed-table transactions are absent by
design.

## Client boundary

An AWS SDK v3 aggregated `DynamoDB` client supplies `getItem`, `putItem`,
`updateItem`, `deleteItem`, `query`, `transactGetItems`, and
`transactWriteItems`. A smaller trusted adapter may instead implement
`send({ operation, input })`, where `operation` is one of those method names.
The package never imports a credential-aware AWS package.

Items use DynamoDB's document value domain: strings, finite numbers, bigints,
booleans, null, passable byte arrays (frozen `Uint8Array`s backed by immutable
`ArrayBuffer`s, as from `frozenBytes` in `@endo/immutable-arraybuffer`),
pass-by-copy arrays and records, and homogeneous non-empty copy sets.
Remotables are rejected.

## Revocation, restart, and audit

| Path | Applies to | Survives restart |
| --- | --- | --- |
| reject the `cancelled` promise given to `derive` | that grant and its subtree, this generation | no; a named grant revoked only this way is rebuilt |
| `control.withdraw(grantId)` on a named grant | that grant and its subtree | yes; the tombstone is durable before `withdraw` resolves |
| `control.withdraw(grantId)` on an unnamed grant | that grant and its subtree, this generation | unnamed grants are never rebuilt |
| restart (`retire` the old control) | every grant and cursor of the old generation | old facets fail with `revoked` |

Every gate in the chain is checked in the same synchronous turn as the client
call. Revocation is prospective: a request already sent may commit, and the
audit event records `completedAfterRevocation`.

A `GrantStore` durably records named grant recipes and tombstones, never
credentials or cursors. `reincarnateDynamoControl` retires the previous
control, reads every tombstone before it creates the new generation, and
rebuilds only named grants without one. Bind those facets into powers
directories before starting confined caplets. `makeMemoryGrantStore` is the
in-memory reference implementation.

The mandatory audit sink has `record(event)` and `hashKey(key)`. Events carry
the grant id, parent id, restriction digest, operation, logical table alias,
keyed key hash, item count, outcome, timing, generation, and AWS request id.
They exclude item values, conditions, cursors, physical table names, and
credentials.

IAM remains an independent outer ceiling. The broker's role should permit no
more tables, leading keys, attributes, operations, or return values than the
catalog and deployed applications require.

## Integration tests

`test/integration/dynamodb-local.test.js` runs when
`EXO_DYNAMODB_LOCAL_ENDPOINT` names a DynamoDB Local endpoint.
`test/integration/isolated-iam.test.js` runs against real AWS when
`EXO_DYNAMODB_IAM_ALLOWED_TABLE`, `EXO_DYNAMODB_IAM_DENIED_TABLE`, and
`AWS_REGION` are set, under a role whose policy permits only the allowed
table, with `@aws-sdk/client-dynamodb` installed. Both skip otherwise.
