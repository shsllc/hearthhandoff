// Amazon DynamoDB implementation. Table: pk (S, HASH), sk (S, RANGE), TTL attribute `ttl`.
import { DynamoDBClient, ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, DeleteCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { type Item, type ItemStore, type PutCondition, type QueryOptions, isLive } from './types.ts';

export function dynamoStore(tableName: string, client = new DynamoDBClient({})): ItemStore {
  const doc = DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });

  return {
    kind: 'dynamodb',
    async get<T extends Item>(pk: string, sk: string) {
      const r = await doc.send(new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }));
      const item = r.Item as Item | undefined;
      return (isLive(item) ? item : undefined) as T | undefined;
    },
    async put<T extends Item>(item: T, cond?: PutCondition) {
      try {
        if (cond && 'ifNotExists' in cond) {
          // Expired items linger until TTL deletes them; treat them as absent.
          await doc.send(new PutCommand({
            TableName: tableName, Item: { ...item, version: 1 },
            ConditionExpression: 'attribute_not_exists(pk) OR (attribute_exists(#ttl) AND #ttl <= :now)',
            ExpressionAttributeNames: { '#ttl': 'ttl' },
            ExpressionAttributeValues: { ':now': Math.floor(Date.now() / 1000) },
          }));
        } else if (cond && 'ifVersion' in cond) {
          await doc.send(new PutCommand({
            TableName: tableName, Item: { ...item, version: cond.ifVersion + 1 },
            ConditionExpression: '#v = :v', ExpressionAttributeNames: { '#v': 'version' }, ExpressionAttributeValues: { ':v': cond.ifVersion },
          }));
        } else {
          await doc.send(new PutCommand({ TableName: tableName, Item: { ...item, version: (item.version ?? 0) + 1 } }));
        }
        return true;
      } catch (e) {
        if (e instanceof ConditionalCheckFailedException) return false;
        throw e;
      }
    },
    async delete(pk: string, sk: string) {
      await doc.send(new DeleteCommand({ TableName: tableName, Key: { pk, sk } }));
    },
    async query<T extends Item>(pk: string, opts: QueryOptions = {}) {
      const names: Record<string, string> = { '#pk': 'pk' };
      const values: Record<string, unknown> = { ':pk': pk };
      let key = '#pk = :pk';
      if (opts.prefix !== undefined) { key += ' AND begins_with(#sk, :p)'; names['#sk'] = 'sk'; values[':p'] = opts.prefix; }
      if (opts.between) { key += ' AND #sk BETWEEN :a AND :b'; names['#sk'] = 'sk'; values[':a'] = opts.between[0]; values[':b'] = opts.between[1]; }
      const out: T[] = [];
      let start: Record<string, unknown> | undefined;
      const now = Math.floor(Date.now() / 1000);
      do {
        const r = await doc.send(new QueryCommand({
          TableName: tableName, KeyConditionExpression: key, ExpressionAttributeNames: names, ExpressionAttributeValues: values,
          ScanIndexForward: !opts.reverse, ExclusiveStartKey: start, ConsistentRead: true,
        }));
        for (const it of (r.Items ?? []) as T[]) {
          if (isLive(it, now)) out.push(it);
          if (opts.limit && out.length >= opts.limit) return out;
        }
        start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async purgeExpired() {
      return 0; // DynamoDB TTL handles deletion.
    },
  };
}
