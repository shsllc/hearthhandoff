// A deliberately small key-value contract shaped like DynamoDB (partition key + sort key, conditional
// writes, range queries, TTL). DynamoDB backs it on AWS; SQLite backs it locally so the demo runs with no setup.

export interface Item {
  pk: string;
  sk: string;
  /** Epoch seconds. Expired items are invisible immediately and deleted by DynamoDB TTL / the local purge. */
  ttl?: number;
  /** Optimistic-concurrency counter managed by the store. */
  version?: number;
}

export type PutCondition = { ifNotExists: true } | { ifVersion: number };

export interface QueryOptions {
  prefix?: string;
  /** Inclusive sort-key range. */
  between?: [string, string];
  reverse?: boolean;
  limit?: number;
}

export interface ItemStore {
  readonly kind: 'sqlite' | 'dynamodb';
  get<T extends Item>(pk: string, sk: string): Promise<T | undefined>;
  /** Returns false when the condition fails. Sets `version` (1 on create, previous + 1 on versioned update). */
  put<T extends Item>(item: T, cond?: PutCondition): Promise<boolean>;
  delete(pk: string, sk: string): Promise<void>;
  query<T extends Item>(pk: string, opts?: QueryOptions): Promise<T[]>;
  /** Local only: DynamoDB deletes expired items itself. */
  purgeExpired(nowSec: number): Promise<number>;
}

export const isLive = (item: Item | undefined, nowSec = Math.floor(Date.now() / 1000)) =>
  !!item && (item.ttl === undefined || item.ttl === null || item.ttl > nowSec);
