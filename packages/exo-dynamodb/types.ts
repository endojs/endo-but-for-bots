import type { CopySet, Pattern } from '@endo/patterns';

export type DynamoScalar =
  string | number | bigint | boolean | null | Uint8Array;
export type DynamoValue =
  | DynamoScalar
  | readonly DynamoValue[]
  | { readonly [name: string]: DynamoValue }
  | CopySet<string | number | bigint | Uint8Array>;
export type Item = Readonly<Record<string, DynamoValue>>;
export type Key = Readonly<Record<string, DynamoScalar>>;
export type Operation =
  | 'get'
  | 'put'
  | 'update'
  | 'delete'
  | 'query'
  | 'conditionCheck'
  | 'transactGet'
  | 'transactWrite';
export type KeyConstraint =
  { readonly exact: DynamoScalar } | { readonly prefix: string | Uint8Array };
export type KeyRange = {
  readonly partition: KeyConstraint;
  readonly sort?: KeyConstraint;
};
export type Restriction = {
  readonly table?: string;
  readonly ranges?: readonly KeyRange[];
  readonly indexes?: readonly string[];
  readonly readFields?: readonly string[];
  readonly writeFields?: readonly string[];
  readonly conditionFields?: readonly string[];
  readonly filterFields?: readonly string[];
  readonly fixed?: Readonly<Record<string, DynamoValue>>;
  readonly itemShape?: Pattern;
  readonly operations?: readonly Operation[];
  readonly limits?: {
    readonly pageSize?: number;
    readonly transactionSize?: number;
    readonly itemSize?: number;
    readonly ratePerSecond?: number;
  };
};
export type FieldCondition =
  | {
      readonly op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
      readonly field: string;
      readonly value: DynamoValue;
    }
  | { readonly op: 'exists' | 'not-exists'; readonly field: string }
  | {
      readonly op: 'begins-with';
      readonly field: string;
      readonly value: string | Uint8Array;
    }
  | {
      readonly op: 'and' | 'or';
      readonly conditions: readonly FieldCondition[];
    }
  | { readonly op: 'not'; readonly condition: FieldCondition };
export type Patch = {
  readonly set?: Readonly<Record<string, DynamoValue>>;
  readonly remove?: readonly string[];
  readonly add?: Readonly<
    Record<
      string,
      number | bigint | CopySet<string | number | bigint | Uint8Array>
    >
  >;
  readonly delete?: Readonly<
    Record<string, CopySet<string | number | bigint | Uint8Array>>
  >;
};
export type WriteOptions = { readonly condition?: FieldCondition };
export type ReadOptions = {
  readonly fields?: readonly string[];
  readonly consistent?: boolean;
};
export type Query = ReadOptions & {
  readonly partition: DynamoScalar;
  readonly sort?: FieldCondition;
  readonly filter?: FieldCondition;
  readonly index?: string;
  readonly reverse?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
};
export type Page<T> = {
  readonly items: readonly T[];
  readonly cursor?: string;
};
export type Failure = {
  readonly type: 'condition-failed' | 'conflict' | 'unavailable';
};
export type DynamoResult<T> =
  | { readonly type: 'ok'; readonly value: T }
  | { readonly type: 'condition-failed' }
  | {
      readonly type: 'transaction-canceled';
      readonly failures: readonly Failure[];
    }
  | { readonly type: 'invalid-request'; readonly reason: string }
  | { readonly type: 'limit-exceeded' }
  | { readonly type: 'revoked' }
  | { readonly type: 'unavailable'; readonly retryable: boolean };
export type TransactionGet = {
  readonly key: Key;
  readonly fields?: readonly string[];
};
export type TransactionWrite =
  | {
      readonly operation: 'put';
      readonly item: Item;
      readonly condition?: FieldCondition;
    }
  | {
      readonly operation: 'update';
      readonly key: Key;
      readonly patch: Patch;
      readonly condition?: FieldCondition;
    }
  | {
      readonly operation: 'delete';
      readonly key: Key;
      readonly condition?: FieldCondition;
    }
  | {
      readonly operation: 'conditionCheck';
      readonly key: Key;
      readonly condition: FieldCondition;
    };
export type TransactionOptions = { readonly idempotencyKey?: string };
export interface DynamoCapability {
  derive(
    restriction: Restriction,
    options?: { readonly cancelled?: Promise<never> },
  ): Promise<DynamoCapability>;
  get(key: Key, options?: ReadOptions): Promise<DynamoResult<Item | undefined>>;
  put(item: Item, options?: WriteOptions): Promise<DynamoResult<void>>;
  update(
    key: Key,
    patch: Patch,
    options?: WriteOptions,
  ): Promise<DynamoResult<Item | undefined>>;
  delete(
    key: Key,
    options?: WriteOptions,
  ): Promise<DynamoResult<Item | undefined>>;
  query(request: Query): Promise<DynamoResult<Page<Item>>>;
  transactGet(
    requests: readonly TransactionGet[],
  ): Promise<DynamoResult<readonly (Item | undefined)[]>>;
  transactWrite(
    requests: readonly TransactionWrite[],
    options?: TransactionOptions,
  ): Promise<DynamoResult<void>>;
}
export type TableCatalog = Readonly<
  Record<
    string,
    {
      readonly tableName: string;
      readonly partitionKey: {
        readonly name: string;
        readonly type: 'string' | 'number' | 'binary';
      };
      readonly sortKey?: {
        readonly name: string;
        readonly type: 'string' | 'number' | 'binary';
      };
      readonly indexes?: Readonly<
        Record<
          string,
          {
            readonly indexName: string;
            readonly partitionKey: {
              readonly name: string;
              readonly type: 'string' | 'number' | 'binary';
            };
            readonly sortKey?: {
              readonly name: string;
              readonly type: 'string' | 'number' | 'binary';
            };
          }
        >
      >;
    }
  >
>;
export interface DynamoControl {
  derive(
    restriction: Restriction,
    options?: { readonly cancelled?: Promise<never>; readonly name?: string },
  ): DynamoCapability;
  revoke(grantId: string): boolean;
  inspect(grantId: string):
    | {
        readonly grantId: string;
        readonly parentId?: string;
        readonly generation: string;
        readonly live: boolean;
        readonly restrictionDigest: string;
      }
    | undefined;
}
