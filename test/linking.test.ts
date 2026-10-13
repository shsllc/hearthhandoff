// One-way account linking end to end, against a local fake of Ring's OAuth and partner API.
// Exercises: token exchange → /v1/users/me → unclaimed pool → mandatory sign-in → nonce match →
// POST + PATCH app-integrations → device sync → webhook for a new device → token refresh → unlink.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';

const ACCOUNT = 'ava1.ring.account.TEST123';
const calls: Array<{ method: string; path: string; body: string; auth?: string }> = [];
let issued = 0;

const ring: Server = createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const path = (req.url ?? '').split('?')[0];
    calls.push({ method: req.method!, path, body, auth: req.headers.authorization });
    const json = (code: number, v: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
    if (path === '/oauth/token') {
      const f = new URLSearchParams(body);
      if (f.get('client_secret') !== 'test-client-secret') return json(401, { error: 'invalid_client' });
      if (f.get('grant_type') === 'authorization_code' && f.get('code') !== 'good-code') return json(400, { error: 'invalid_grant' });
      issued++;
      return json(200, { access_token: `at${issued}`, refresh_token: `rt${issued}`, expires_in: 14400, token_type: 'Bearer', scope: 'ava' });
    }
    if (!req.headers.authorization?.startsWith('Bearer at')) return json(401, { error: 'unauthorized' });
    if (path === '/v1/users/me') return json(200, { data: { type: 'users', id: ACCOUNT, attributes: {} } });
    if (path === '/v1/accounts/me/app-integrations') return json(200, { data: { attributes: { status: req.method === 'PATCH' ? 'completed' : 'awaiting' } } });
    if (path === '/v1/devices') return json(200, { data: [{ type: 'devices', id: 'dev.real', attributes: { name: 'Front Camera', kind: 'stickup_cam' } }] });
    if (path === '/v1/devices/dev.real/status') return json(200, { data: { attributes: { online: true } } });
    if (path.startsWith('/v1/history/')) return json(200, { data: [] });
    json(404, { error: 'not found' });
  });
});
await new Promise<void>((r) => ring.listen(0, '127.0.0.1', () => r()));
const port = (ring.address() as { port: number }).port;

process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'link-test-secret-link-test-secret';
process.env.RING_API_BASE = `http://127.0.0.1:${port}`;
process.env.RING_OAUTH_URL = `http://127.0.0.1:${port}/oauth/token`;
process.env.RING_CLIENT_ID = 'test-client';
process.env.RING_CLIENT_SECRET = 'test-client-secret';
process.env.RING_HMAC_SIGNING_KEY = 'test-hmac-key';
process.env.RING_ACCESS_TOKEN = '';
process.env.ACCESS_CODE = '';
process.env.PUBLIC_BASE_URL = 'http://localhost';

const { createStore } = await import('../src/store/index.ts');
const { Repo } = await import('../src/repo.ts');
const { buildApp } = await import('../src/app.ts');
const { computeNonce } = await import('../src/ring/nonce.ts');
const { signWebhookBody } = await import('../src/ring/webhook.ts');
const { tokenForAccount } = await import('../src/ring/client.ts');
const { unseal } = await import('../src/secrets.ts');

const HID = 'hh_link';
const ORIGIN = 'http://localhost';
let repo: InstanceType<typeof Repo>;
let app: ReturnType<typeof buildApp>;

before(async () => {
  repo = new Repo(await createStore(), 7);
  app = buildApp(repo);
  await repo.putHousehold({ id: HID, name: 'Link home', residentName: 'June', timezone: 'America/Los_Angeles', createdAt: Date.now(), ringAccountId: null });
  await repo.putPerson({ id: 'p_june', householdId: HID, name: 'June', role: 'owner', email: 'june@example.test', phone: null, active: true });
  await repo.putPerson({ id: 'p_dana', householdId: HID, name: 'Dana', role: 'caregiver', email: null, phone: null, active: true });
});
after(() => ring.close());

const req = (path: string, init: RequestInit = {}) => app.fetch(new Request(ORIGIN + path, init));
async function cookieFor(pid: string) {
  const res = await req('/signin', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams({ who: `${HID}:${pid}`, next: '/' }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}
const postLink = (cookie: string, nonce: string, time: string) => req('/ring/link', {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce, time }),
});

test('token exchange accepts a form-encoded code, stores sealed tokens as unclaimed', async () => {
  const bad = await req('/ring/token-exchange', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=wrong' });
  assert.equal(bad.status, 502);
  const res = await req('/ring/token-exchange', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'code=good-code' });
  assert.equal(res.status, 200);
  const acct = (await repo.getRing(ACCOUNT))!;
  assert.equal(acct.status, 'unclaimed');
  assert.ok(!acct.accessSealed.includes('at'), 'access token is not stored in plaintext');
  assert.equal(unseal(acct.accessSealed), 'at1');
  assert.deepEqual(await repo.unclaimedAccountIds(), [ACCOUNT]);
});

test('token exchange also accepts JSON bodies', async () => {
  const res = await req('/ring/token-exchange', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'good-code' }) });
  assert.equal(res.status, 200);
});

test('link page requires sign-in, and only the owner may link', async () => {
  const time = String(Date.now());
  const nonce = computeNonce('test-hmac-key', time, ACCOUNT);
  const anon = await req(`/ring/link?nonce=${nonce}&time=${time}`);
  assert.equal(anon.status, 302);
  assert.ok(anon.headers.get('location')!.startsWith('/signin?next='));
  assert.equal((await postLink(await cookieFor('p_dana'), nonce, time)).status, 403);
  assert.equal((await repo.getRing(ACCOUNT))!.status, 'unclaimed', 'nothing claimed by the caregiver attempt');
});

test('expired and forged nonces are refused without contacting Ring', async () => {
  const june = await cookieFor('p_june');
  const before = calls.length;
  const old = String(Date.now() - 11 * 60_000);
  assert.equal((await postLink(june, computeNonce('test-hmac-key', old, ACCOUNT), old)).status, 400);
  const now = String(Date.now());
  assert.equal((await postLink(june, computeNonce('wrong-key', now, ACCOUNT), now)).status, 400);
  assert.equal(calls.slice(before).filter((c) => c.path.includes('app-integrations')).length, 0);
});

test('owner sign-in + valid nonce: POST then PATCH app-integrations, claim, and device sync', async () => {
  const june = await cookieFor('p_june');
  const time = String(Date.now());
  const nonce = computeNonce('test-hmac-key', time, ACCOUNT);
  const res = await postLink(june, nonce, time);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')!.startsWith('/ring/config?flash='));

  const integ = calls.filter((c) => c.path === '/v1/accounts/me/app-integrations');
  assert.deepEqual(integ.map((c) => c.method), ['POST', 'PATCH'], 'POST (nonce) must precede PATCH (completed)');
  const posted = JSON.parse(integ[0].body);
  assert.equal(posted.nonce, nonce);
  assert.equal(posted.account_identifier, 'j***e@example.test', 'email is masked');
  assert.deepEqual(JSON.parse(integ[1].body), { status: 'completed' });

  const acct = (await repo.getRing(ACCOUNT))!;
  assert.equal(acct.status, 'completed');
  assert.equal(acct.householdId, HID);
  assert.deepEqual(await repo.unclaimedAccountIds(), []);
  assert.equal((await repo.getHousehold(HID))!.ringAccountId, ACCOUNT);
  const dev = (await repo.getDevice(HID, 'dev.real'))!;
  assert.equal(dev.name, 'Front Camera');
  assert.equal(dev.online, true);
  assert.equal(dev.origin, 'ring_app');
});

test('a second link page after the claim claims nothing and says it is already connected', async () => {
  const june = await cookieFor('p_june');
  const time = String(Date.now());
  const before = calls.filter((c) => c.path === '/v1/accounts/me/app-integrations').length;
  const res = await postLink(june, computeNonce('test-hmac-key', time, ACCOUNT), time);
  assert.equal(res.status, 302);
  assert.ok(res.headers.get('location')!.includes('already%20connected'));
  assert.equal(calls.filter((c) => c.path === '/v1/accounts/me/app-integrations').length, before, 'Ring not contacted again');
});

test('owner rename survives a Ring device sync', async () => {
  const june = await cookieFor('p_june');
  await req('/owner/devices/rename', { method: 'POST', headers: { Cookie: june, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ device_id: 'dev.real', name: 'Front door' }) });
  await req('/owner/ring/sync', { method: 'POST', headers: { Cookie: june, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal((await repo.getDevice(HID, 'dev.real'))!.name, 'Front door');
});

test('webhook from a device first seen via the linked account registers it to that household', async () => {
  const body = JSON.stringify({
    meta: { version: '1.1', time: new Date().toISOString(), request_id: 'link-r1', account_id: ACCOUNT },
    data: { id: 'dev.new_motion_1', type: 'motion_detected', attributes: { source: 'dev.new', source_type: 'devices', timestamp: Date.now(), sub_type: 'human' } },
  });
  const res = await req('/ring/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signWebhookBody('test-hmac-key', body) }, body });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'stored');
  assert.equal(await repo.deviceHousehold('dev.new'), HID);
});

test('expired access token is refreshed with the rotated refresh token', async () => {
  const acct = (await repo.getRing(ACCOUNT))!;
  await repo.putRing({ ...acct, accessExpiresAt: Date.now() - 1000 });
  const before = issued;
  const token = await tokenForAccount(repo, ACCOUNT);
  assert.equal(issued, before + 1);
  assert.equal(token, `at${issued}`);
  const refreshCall = calls.filter((c) => c.path === '/oauth/token').at(-1)!;
  const f = new URLSearchParams(refreshCall.body);
  assert.equal(f.get('grant_type'), 'refresh_token');
  assert.equal(f.get('refresh_token'), 'rt2');
  assert.equal(unseal((await repo.getRing(ACCOUNT))!.refreshSealed), `rt${issued}`);
});

test('app_integration_removed purges tokens and Ring devices but keeps visit history', async () => {
  const body = JSON.stringify({
    meta: { version: '1.1', time: new Date().toISOString(), request_id: 'link-r2', account_id: ACCOUNT },
    data: { id: 'x', type: 'app_integration_removed', attributes: {} },
  });
  const res = await req('/ring/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': signWebhookBody('test-hmac-key', body) }, body });
  assert.equal(res.status, 200);
  const acct = (await repo.getRing(ACCOUNT))!;
  assert.equal(acct.status, 'removed');
  assert.equal(acct.accessSealed, '');
  assert.equal(acct.refreshSealed, '');
  assert.equal((await repo.devices(HID)).filter((d) => d.origin === 'ring_app').length, 0);
  assert.equal((await repo.getHousehold(HID))!.ringAccountId, null);
});
