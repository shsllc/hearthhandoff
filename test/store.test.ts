// The same contract against both stores. SQLite always runs; DynamoDB runs when DYNAMO_TEST_TABLE is set
// (uses an isolated TEST#<uuid> partition and deletes everything it wrote).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sqliteStore } from '../src/store/sqlite.ts';
import type { ItemStore } from '../src/store/types.ts';

const stores: Array<[string, () => Promise<ItemStore>]> = [['sqlite', async () => sqliteStore(':memory:')]];
if (process.env.DYNAMO_TEST_TABLE) {
  stores.push(['dynamodb', async () => (await import('../src/store/dynamo.ts')).dynamoStore(process.env.DYNAMO_TEST_TABLE!)]);
}

for (const [name, make] of stores) {
  const pk = `TEST#${randomUUID()}`;
  const written: Array<[string, string]> = [];
  let store: ItemStore;
  const put = async (sk: string, extra: Record<string, unknown> = {}, cond?: Parameters<ItemStore['put']>[1]) => {
    written.push([pk, sk]);
    return store.put({ pk, sk, ...extra }, cond);
  };

  test(`[${name}] put/get round-trip and versioning`, async () => {
    store = await make();
    assert.equal(await put('A', { v: 1 }), true);
    const a = await store.get<any>(pk, 'A');
    assert.equal(a.v, 1);
    assert.equal(a.version, 1);
  });

  test(`[${name}] ifNotExists rejects an existing live item`, async () => {
    assert.equal(await put('B', {}, { ifNotExists: true }), true);
    assert.equal(await put('B', {}, { ifNotExists: true }), false);
  });

  test(`[${name}] ifVersion is optimistic concurrency`, async () => {
    const a = (await store.get<any>(pk, 'A'))!;
    assert.equal(await store.put({ ...a, v: 2 }, { ifVersion: a.version }), true);
    assert.equal(await store.put({ ...a, v: 3 }, { ifVersion: a.version }), false, 'stale writer loses');
    assert.equal((await store.get<any>(pk, 'A'))!.v, 2);
  });

  test(`[${name}] expired items are invisible and can be recreated`, async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    await put('C', { ttl: past });
    assert.equal(await store.get(pk, 'C'), undefined);
    assert.equal(await put('C', { fresh: true }, { ifNotExists: true }), true);
  });

  test(`[${name}] prefix, range, reverse and limit queries`, async () => {
    for (const sk of ['EVENT#d#0000000000010#a', 'EVENT#d#0000000000020#b', 'EVENT#d#0000000000030#c', 'EVENT#e#0000000000015#x']) await put(sk);
    const pre = await store.query<any>(pk, { prefix: 'EVENT#d#' });
    assert.deepEqual(pre.map((i) => i.sk.slice(-1)), ['a', 'b', 'c']);
    const range = await store.query<any>(pk, { between: ['EVENT#d#0000000000015', 'EVENT#d#0000000000025#￿'] });
    assert.deepEqual(range.map((i) => i.sk.slice(-1)), ['b']);
    const rev = await store.query<any>(pk, { prefix: 'EVENT#', reverse: true, limit: 2 });
    assert.deepEqual(rev.map((i) => i.sk.slice(-1)), ['x', 'c']);
  });

  after(async () => {
    for (const [p, s] of written) await store.delete(p, s);
    assert.equal((await store.query(pk)).length, 0, 'cleaned up');
  });
}
