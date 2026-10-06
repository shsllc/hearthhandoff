import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type Item, type ItemStore, type PutCondition, type QueryOptions, isLive } from './types.ts';

export function sqliteStore(path: string): ItemStore {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS items (pk TEXT NOT NULL, sk TEXT NOT NULL, data TEXT NOT NULL, ttl INTEGER, version INTEGER NOT NULL,
      PRIMARY KEY (pk, sk)) WITHOUT ROWID;`);

  const decode = (row: any): Item => JSON.parse(row.data);
  const nowSec = () => Math.floor(Date.now() / 1000);

  return {
    kind: 'sqlite',
    async get<T extends Item>(pk: string, sk: string) {
      const row = db.prepare('SELECT data FROM items WHERE pk = ? AND sk = ?').get(pk, sk);
      const item = row ? decode(row) : undefined;
      return (isLive(item) ? item : undefined) as T | undefined;
    },
    async put<T extends Item>(item: T, cond?: PutCondition) {
      const write = (version: number) => JSON.stringify({ ...item, version });
      const ttl = item.ttl ?? null;
      if (cond && 'ifNotExists' in cond) {
        // An expired-but-unpurged row counts as absent, matching DynamoDB semantics once TTL runs.
        db.prepare('DELETE FROM items WHERE pk = ? AND sk = ? AND ttl IS NOT NULL AND ttl <= ?').run(item.pk, item.sk, nowSec());
        const r = db.prepare('INSERT OR IGNORE INTO items (pk, sk, data, ttl, version) VALUES (?,?,?,?,1)').run(item.pk, item.sk, write(1), ttl);
        return Number(r.changes) === 1;
      }
      if (cond && 'ifVersion' in cond) {
        const next = cond.ifVersion + 1;
        const r = db.prepare('UPDATE items SET data = ?, ttl = ?, version = ? WHERE pk = ? AND sk = ? AND version = ?')
          .run(write(next), ttl, next, item.pk, item.sk, cond.ifVersion);
        return Number(r.changes) === 1;
      }
      const v = (item.version ?? 0) + 1;
      db.prepare(`INSERT INTO items (pk, sk, data, ttl, version) VALUES (?,?,?,?,?)
        ON CONFLICT(pk, sk) DO UPDATE SET data = excluded.data, ttl = excluded.ttl, version = excluded.version`)
        .run(item.pk, item.sk, write(v), ttl, v);
      return true;
    },
    async delete(pk: string, sk: string) {
      db.prepare('DELETE FROM items WHERE pk = ? AND sk = ?').run(pk, sk);
    },
    async query<T extends Item>(pk: string, opts: QueryOptions = {}) {
      let sql = 'SELECT data FROM items WHERE pk = ? AND (ttl IS NULL OR ttl > ?)';
      const params: any[] = [pk, nowSec()];
      if (opts.prefix !== undefined) { sql += ' AND sk >= ? AND sk < ?'; params.push(opts.prefix, opts.prefix + '￿'); }
      if (opts.between) { sql += ' AND sk BETWEEN ? AND ?'; params.push(...opts.between); }
      sql += ` ORDER BY sk ${opts.reverse ? 'DESC' : 'ASC'}`;
      if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
      return db.prepare(sql).all(...params).map(decode) as T[];
    },
    async purgeExpired(now: number) {
      return Number(db.prepare('DELETE FROM items WHERE ttl IS NOT NULL AND ttl <= ?').run(now).changes);
    },
  };
}
