import type { CopySet } from '@endo/patterns';

/** A DynamoDB scalar in the passable value domain. */
export type Scalar = string | number | bigint | boolean | null | Uint8Array;
export type DynamoValue =
  | Scalar
  | readonly DynamoValue[]
  | { readonly [name: string]: DynamoValue }
  | CopySet<string | number | bigint | Uint8Array>;
/** A logical attribute name. */
export type Field = string;
export type IndexName = string;
export type Item = Readonly<Record<Field, DynamoValue>>;
/** A complete base-table primary key. */
export type Key = Readonly<Record<Field, Scalar>>;
/** An opaque, passable grant identifier that carries no authority. */
export type GrantId = string;
/** An opaque, broker-sealed pagination token. */
export type Cursor = string;

export type Operation =
  | 'get'
  | 'put'
  | 'update'
  | 'delete'
  | 'query'
  | 'conditionCheck'
  | 'transactGet'
  | 'transactWrite';

/**
 * A constraint on one key attribute. `exact` admits one value. `prefix`
 * admits string or binary values that begin with it, byte for byte. An
 * interval admits numeric values between its inclusive bounds and is valid
 * only for a numeric sort key.
 */
export type KeyConstraint =
  | { readonly exact: string | number | bigint | Uint8Array }
  | { readonly prefix: string | Uint8Array }
  | { readonly min?: number | bigint; readonly max?: number | bigint };

/** A constraint on one key schema: the base table's or one index's. */
export type KeyRange = {
  readonly partition: KeyConstraint;
  readonly sort?: KeyConstraint;
};

/**
 * The typed condition AST used for conditions, filters, guards, and query
 * sort-key conditions. Exactly one operator key appears in each node.
 */
export type Condition =
  | { readonly and: readonly Condition[] }
  | { readonly or: readonly Condition[] }
  | { readonly not: Condition }
  | { readonly exists: Field }
  | { readonly field: Field; readonly eq: DynamoValue }
  | { readonly field: Field; readonly ne: DynamoValue }
  | { readonly field: Field; readonly lt: Scalar }
  | { readonly field: Field; readonly lte: Scalar }
  | { readonly field: Field; readonly gt: Scalar }
  | { readonly field: Field; readonly gte: Scalar }
  | { readonly field: Field; readonly between: readonly [Scalar, Scalar] }
  | { readonly field: Field; readonly beginsWith: string | Uint8Array };

/**
 * A guard is a `Condition` restricted to conjunctions of equality,
 * `beginsWith`, existence, and the negation of one such term.
 */
export type Guard = Condition;

export type Shape = {
  readonly readFields?: readonly Field[];
  readonly writeFields?: readonly Field[];
  readonly conditionFields?: readonly Field[];
  readonly filterFields?: readonly Field[];
  readonly fixed?: Readonly<Record<Field, Scalar>>;
  readonly guard?: Guard;
};

export type Limits = {
  readonly pageSize?: number;
  readonly transactionSize?: number;
  readonly itemBytes?: number;
  readonly requestsPerSecond?: number;
};

/**
 * A monotone restriction. Every omitted part inherits the parent's effective
 * value; an empty list means none.
 */
export type Restriction = {
  readonly keySpace?: readonly KeyRange[];
  readonly indexes?: Readonly<Record<IndexName, readonly KeyRange[]>>;
  readonly shape?: Shape;
  readonly operations?: readonly Operation[];
  readonly limits?: Limits;
};

/** A root restriction additionally selects a logical table from the catalog. */
export type RootRestriction = Restriction & { readonly table: string };

export type Patch = {
  readonly set?: Readonly<Record<Field, DynamoValue>>;
  readonly remove?: readonly Field[];
  readonly add?: Readonly<
    Record<
      Field,
      number | bigint | CopySet<string | number | bigint | Uint8Array>
    >
  >;
  readonly delete?: Readonly<
    Record<Field, CopySet<string | number | bigint | Uint8Array>>
  >;
};

export type ReadOptions = {
  /** A projection; must lie within the effective read fields. */
  readonly fields?: readonly Field[];
  readonly consistent?: boolean;
};
export type WriteOptions = {
  readonly condition?: Condition;
  /**
   * Makes the write idempotent for DynamoDB's client-request-token window.
   * An idempotent `update` or `delete` resolves `undefined` because the
   * idempotent DynamoDB path returns no attributes.
   */
  readonly idempotencyKey?: string;
};
export type TransactionOptions = { readonly idempotencyKey?: string };

export type Query = ReadOptions & {
  readonly index?: IndexName;
  /** Partition-key equality inside one allowed range of the queried schema. */
  readonly partition: string | number | bigint | Uint8Array;
  /**
   * A sort-key condition (`eq`, `lt`, `lte`, `gt`, `gte`, `between`, or
   * `beginsWith`) whose field is the queried schema's sort key.
   */
  readonly sort?: Condition;
  readonly filter?: Condition;
  readonly descending?: boolean;
  readonly limit?: number;
  readonly cursor?: Cursor;
};

export type Page<T> = {
  readonly items: readonly T[];
  readonly cursor?: Cursor;
};

export type TransactionGet = {
  readonly key: Key;
  readonly fields?: readonly Field[];
};
export type TransactionWrite =
  | {
      readonly operation: 'put';
      readonly item: Item;
      readonly condition?: Condition;
    }
  | {
      readonly operation: 'update';
      readonly key: Key;
      readonly patch: Patch;
      readonly condition?: Condition;
    }
  | {
      readonly operation: 'delete';
      readonly key: Key;
      readonly condition?: Condition;
    }
  | {
      readonly operation: 'conditionCheck';
      readonly key: Key;
      readonly condition: Condition;
    };

/** A safe, caller-derived explanation. Never names physical resources. */
export type SafeReason = string;

/** Per-member outcome inside `transaction-canceled`. */
export type Failure =
  | { readonly type: 'none' }
  | { readonly type: 'condition-failed' }
  | { readonly type: 'conflict' }
  | { readonly type: 'unavailable' };

export type Result<T> =
  | { readonly type: 'ok'; readonly value: T }
  | { readonly type: 'condition-failed' }
  | {
      readonly type: 'transaction-canceled';
      readonly failures: readonly Failure[];
    }
  | { readonly type: 'invalid-request'; readonly reason: SafeReason }
  | {
      readonly type: 'limit-exceeded';
      readonly limit: 'page' | 'transaction' | 'item-size' | 'rate';
      readonly retryable: boolean;
    }
  | { readonly type: 'revoked' }
  | { readonly type: 'unavailable'; readonly retryable: boolean };

/** @deprecated use `Result`. */
export type DynamoResult<T> = Result<T>;

export type Derived = {
  readonly capability: DynamoCapability;
  readonly grantId: GrantId;
};

export interface DynamoCapability {
  derive(
    restriction: Restriction,
    options?: { readonly cancelled?: Promise<never> },
  ): Promise<Result<Derived>>;
  get(key: Key, options?: ReadOptions): Promise<Result<Item | undefined>>;
  put(item: Item, options?: WriteOptions): Promise<Result<void>>;
  update(
    key: Key,
    patch: Patch,
    options?: WriteOptions,
  ): Promise<Result<Item | undefined>>;
  delete(key: Key, options?: WriteOptions): Promise<Result<Item | undefined>>;
  query(request: Query): Promise<Result<Page<Item>>>;
  transactGet(
    requests: readonly TransactionGet[],
  ): Promise<Result<readonly (Item | undefined)[]>>;
  transactWrite(
    requests: readonly TransactionWrite[],
    options?: TransactionOptions,
  ): Promise<Result<void>>;
}

export type ControlDeriveOptions = {
  /** Makes the grant durable: its recipe is recorded and rebuilt on restart. */
  readonly name?: string;
  readonly cancelled?: Promise<never>;
};

export type GrantRecord = {
  readonly grantId: GrantId;
  readonly parentId?: GrantId;
  readonly name?: string;
  readonly generation: string;
  readonly live: boolean;
  readonly restrictionDigest: string;
};

export interface DynamoControl {
  derive(
    restriction: RootRestriction,
    options?: ControlDeriveOptions,
  ): Promise<Result<Derived>>;
  withdraw(grantId: GrantId): Promise<Result<void>>;
  lineage(grantId: GrantId): Promise<Result<readonly GrantRecord[]>>;
  /** Close every gate of this generation. The supervisor calls this on restart. */
  retire(): Promise<Result<void>>;
}

export type KeyType = 'string' | 'number' | 'binary';
export type KeyAttribute = { readonly name: Field; readonly type: KeyType };
export type KeySchema = {
  readonly partitionKey: KeyAttribute;
  readonly sortKey?: KeyAttribute;
};
export type IndexEntry = KeySchema & {
  /** The physical index name. */
  readonly indexName: string;
  /** Global secondary indexes refuse consistent reads. Defaults to true. */
  readonly global?: boolean;
};
export type TableEntry = KeySchema & {
  /** The physical table name. Never crosses the capability boundary. */
  readonly tableName: string;
  readonly indexes?: Readonly<Record<IndexName, IndexEntry>>;
};
export type TableCatalog = Readonly<Record<string, TableEntry>>;

export type AuditEvent = {
  readonly grantId: GrantId;
  readonly parentId?: GrantId;
  readonly restrictionDigest: string;
  readonly operation: Operation | 'derive' | 'revoke' | 'withdraw';
  readonly logicalTable: string;
  readonly keyHash?: string;
  readonly itemCount: number;
  readonly outcome: string;
  readonly elapsedMs: number;
  readonly generation: string;
  readonly requestId?: string;
  readonly completedAfterRevocation?: boolean;
};
export type AuditSink = {
  record(event: AuditEvent): void | Promise<void>;
  /** A keyed hash; key values never enter the event stream. */
  hashKey(key: Key): string;
};

export type CursorSealer = {
  seal(record: unknown): Cursor;
  unseal(token: Cursor): unknown;
};

/** Durable storage for named grant recipes and revocation tombstones. */
export type GrantStore = {
  putRecipe(name: string, restriction: RootRestriction): void | Promise<void>;
  putTombstone(name: string): void | Promise<void>;
  listRecipes():
    | Iterable<readonly [string, RootRestriction]>
    | Promise<Iterable<readonly [string, RootRestriction]>>;
  listTombstones(): Iterable<string> | Promise<Iterable<string>>;
};
