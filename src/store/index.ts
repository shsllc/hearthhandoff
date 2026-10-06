import { config } from '../config.ts';
import type { ItemStore } from './types.ts';

export async function createStore(): Promise<ItemStore> {
  if (config.store === 'dynamodb') {
    const { dynamoStore } = await import('./dynamo.ts');
    return dynamoStore(config.tableName);
  }
  // Loaded lazily so the Lambda bundle never touches node:sqlite.
  const { sqliteStore } = await import('./sqlite.ts');
  return sqliteStore(config.dbPath);
}
