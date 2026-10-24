# `@endo/exo-dynamodb`

`@endo/exo-dynamodb` turns a trusted DynamoDB client into recursively
attenuated object capabilities. A host selects one physical table and gives a
confined guest only an exo whose table, key ranges, fields, indexes, operations,
and resource limits can decrease at every derivation.

The package deliberately does not proxy the AWS SDK. Capabilities expose no
credentials, client, table name, raw expression, scan, PartiQL, batch, stream,
or table-control operation. Conditions and updates use a closed data AST, and
pagination keys are replaced with broker-incarnation-local sealed cursors.

## Host setup

```js
import { makeDynamoControl, makeMemoryCursorSealer } from '@endo/exo-dynamodb';

const control = makeDynamoControl({
  // An AWS SDK v3 aggregated DynamoDB client, or a narrow adapter documented
  // below. Keep this object and its credential provider outside confinement.
  client,
  catalog: harden({
    coupons: harden({
      tableName: process.env.COUPON_TABLE,
      partitionKey: harden({ name: 'pk', type: 'string' }),
      sortKey: harden({ name: 'sk', type: 'string' }),
    }),
  }),
  audit,
  sealCursor: makeMemoryCursorSealer({ random: secureRandomToken }),
});

const couponBacking = control.derive(
  harden({
    table: 'coupons',
    ranges: harden([
      harden({
        partition: harden({ exact: 'POOL' }),
        sort: harden({ prefix: 'COUPON#' }),
      }),
    ]),
    readFields: harden(['pk', 'sk', 'status', 'expiresAt']),
    writeFields: harden(['pk', 'sk', 'status', 'expiresAt']),
    conditionFields: harden(['status', 'expiresAt']),
    operations: harden(['get', 'put', 'update', 'query', 'transactWrite']),
    limits: harden({ pageSize: 25, transactionSize: 8 }),
  }),
  { name: 'coupon-ledger' },
);
```

`secureRandomToken` must return a fresh, cryptographically unpredictable string;
it is a host power, not ambient package authority.

The host retains `control`; the guest receives `couponBacking` or, preferably,
a domain facet that closes over it. Calling `derive()` on a capability creates a
child wrapper. Every request must pass that child and all of its ancestors, so a
permissive child restriction cannot recover parent authority.

`audit` has `record(event)` and `hashKey(key)` methods. Audit events include
grant lineage, restriction digest, operation, logical table alias, keyed key
hash, outcome, timing, generation, and provider request id when available.
They do not include item values, conditions, cursors, physical table names, or
credentials.

## Client boundary

An AWS SDK v3 aggregated `DynamoDB` client supplies `getItem`, `putItem`,
`updateItem`, `deleteItem`, `query`, `transactGetItems`, and
`transactWriteItems`. For a smaller trusted adapter or tests, the client may
instead implement:

```ts
send(call: { operation: string; input: object }): Promise<object>;
```

The adapter maps the named operation to SDK command constructors. This alternate
surface exists so `@endo/exo-dynamodb` does not itself import a credential-aware
AWS package and so a recording fake can prove denials happen before any send.

Items use DynamoDB's document value domain: strings, finite numbers, bigints,
booleans, null, byte arrays, pass-by-copy arrays and records, and homogeneous
non-empty copy sets. Remotables are rejected.

An `itemShape` is a complete-item guard. `put` and every returned item are
checked against every ancestor guard. Because an arbitrary pattern cannot be
proved against a partial update without a prior read (which would introduce a
race), `update` fails closed when any ancestor declares `itemShape`; use a
conditional `put` or a narrower domain facet for that protocol.

## Revocation, restart, and cursors

Supply a cancellation promise to `derive()` and retain its rejector, or call
`control.revoke(grantId)`. A request checks every ancestor's live gate before
calling the client, so parent revocation closes the subtree. A request already
admitted may still commit; revocation is prospective.

Persist named grant recipes and tombstones outside this package. On restart,
construct a new control generation and rederive only live recipes before
starting guests. The default cursor sealer is deliberately in-memory, so old
cursors fail closed across restart. A durable cryptographic sealer may be
injected, but its records are still bound to the generation, grant, query, and
effective restriction.

IAM remains an independent outer ceiling. The broker's role should permit no
more tables, leading keys, attributes, operations, or return values than the
catalog and deployed applications require.
