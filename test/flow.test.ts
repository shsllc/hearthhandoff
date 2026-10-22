// End-to-end through the HTTP app with an in-memory SQLite store. Env must be set before config loads.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.APP_SECRET = 'test-secret-test-secret-test-secret';
process.env.RING_HMAC_SIGNING_KEY = 'test-hmac-key';
process.env.RING_ACCESS_TOKEN = '';
process.env.RING_CLIENT_ID = '';
process.env.RING_API_BASE = 'http://127.0.0.1:9';
process.env.DEMO_MODE = 'true';
process.env.ACCESS_CODE = '';
process.env.SES_FROM = '';

const { createStore } = await import('../src/store/index.ts');
const { Repo, newId } = await import('../src/repo.ts');
const { buildApp } = await import('../src/app.ts');
const { signWebhookBody } = await import('../src/ring/webhook.ts');
const { buildReplayPayload } = await import('../src/ring/routes.ts');
const { ingestDoorEvent, matchVisitAgainstEvents } = await import('../src/domain/ingest.ts');
const { tick } = await import('../src/worker.ts');

const HID = 'hh_t';
const M = 60_000;
let repo: InstanceType<typeof Repo>;
let app: ReturnType<typeof buildApp>;
const ORIGIN = 'http://localhost';

before(async () => {
  repo = new Repo(await createStore(), 7);
  app = buildApp(repo);
  await repo.putHousehold({ id: HID, name: 'Test home', residentName: 'June', timezone: 'America/Los_Angeles', createdAt: Date.now(), ringAccountId: null });
  for (const [id, name, role] of [['p_june', 'June', 'owner'], ['p_dana', 'Dana', 'caregiver'], ['p_sam', 'Sam', 'caregiver'], ['p_priya', 'Priya', 'caregiver']] as const) {
    await repo.putPerson({ id, householdId: HID, name, role, email: `${name.toLowerCase()}@example.test`, phone: null, active: true });
  }
  await repo.putDevice({ id: 'dev.front', householdId: HID, name: 'Front Door', kind: 'doorbell', online: true, offlineSince: null, origin: 'ring_app', updatedAt: Date.now() });
});

async function signIn(pid: string) {
  const res = await app.fetch(new Request(`${ORIGIN}/signin`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
    body: new URLSearchParams({ who: `${HID}:${pid}`, next: '/' }),
  }));
  const cookie = res.headers.get('set-cookie')!.split(';')[0];
  return (path: string, form?: Record<string, string>) => app.fetch(new Request(ORIGIN + path, form
    ? { method: 'POST', headers: { Cookie: cookie, Origin: ORIGIN, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) }
    : { headers: { Cookie: cookie } }));
}

async function makeVisit(over: Record<string, unknown> = {}) {
  const now = Date.now();
  const v = {
    id: newId('visit'), householdId: HID, kind: 'care_visit' as const, title: 'Afternoon visit', notes: null,
    assignedPersonId: 'p_dana', followupPersonId: 'p_sam', deviceId: 'dev.front', viewerIds: [] as string[],
    windowStart: now - 10 * M, windowEnd: now + 50 * M, confirmBy: now + 80 * M, earlyGraceMin: 15, lateGraceMin: 30,
    status: 'scheduled' as const, scenarioLabel: null, createdBy: 'p_june', createdAt: now, matches: [], confirmations: [], followups: [], ...over,
  };
  await repo.putVisit(v);
  return v.id;
}

const postWebhook = (body: string, sig = signWebhookBody('test-hmac-key', body)) =>
  app.fetch(new Request(`${ORIGIN}/ring/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Signature': sig }, body }));

test('signed Ring webhook lands on the visit; retries and forgeries are handled', async () => {
  const vid = await makeVisit();
  const body = buildReplayPayload({ deviceId: 'dev.front', accountId: 'acct', type: 'button_press', occurredAt: Date.now() - 2 * M, requestId: 'req-1' });

  assert.equal((await postWebhook(body, 'sha256=' + '0'.repeat(64))).status, 401);
  assert.equal((await postWebhook(body + ' ')).status, 200, 'any valid signature over the exact bytes is accepted');

  const dup = await postWebhook(body);
  assert.equal((await dup.json()).status, 'duplicate', 'same request_id is acknowledged, not reprocessed');

  const v = (await repo.getVisit(HID, vid))!;
  assert.equal(v.matches.length, 1);
  assert.equal(v.matches[0].ruleVersion, 'match-v1');
});

test('the same press seen again via Event History merges instead of duplicating', async () => {
  const at = Date.now() - 5 * M;
  const vid = await makeVisit();
  const body = buildReplayPayload({ deviceId: 'dev.front', accountId: 'acct', type: 'button_press', occurredAt: at, requestId: 'req-merge' });
  await postWebhook(body);
  const r = await ingestDoorEvent(repo, { ringEventId: 'hist-1', requestId: null, accountId: null, deviceId: 'dev.front', type: 'button_press', subType: null, occurredAt: at + 1200 }, 'ring_history');
  assert.equal(r.outcome, 'merged');
  const v = (await repo.getVisit(HID, vid))!;
  const ev = (await repo.getEventBySk(HID, v.matches.find((m) => m.eventId === r.eventId)!.eventSk))!;
  assert.deepEqual(ev.sources.sort(), ['ring_history', 'ring_webhook']);
});

test('a late delivery is placed by when it happened, not when it arrived', async () => {
  const now = Date.now();
  const vid = await makeVisit({ windowStart: now - 120 * M, windowEnd: now - 60 * M, confirmBy: now + 60 * M });
  const body = buildReplayPayload({ deviceId: 'dev.front', accountId: 'acct', type: 'motion_detected', subType: 'human', occurredAt: now - 90 * M, requestId: 'req-late' });
  await postWebhook(body);
  assert.equal((await repo.getVisit(HID, vid))!.matches.length, 1);
});

test('visibility: an unrelated caregiver cannot see the visit; the follow-up contact can', async () => {
  const vid = await makeVisit();
  const before = await (await (await signIn('p_sam'))(`/visits/${vid}`)).text();
  assert.ok(before.includes('not evidence of a problem'), 'empty state explains absence calmly');
  // Events received before the visit existed are matched retroactively.
  assert.ok((await matchVisitAgainstEvents(repo, (await repo.getVisit(HID, vid))!)) > 0);
  const priya = await signIn('p_priya');
  assert.equal((await priya(`/visits/${vid}`)).status, 404);
  const sam = await signIn('p_sam');
  const page = await (await sam(`/visits/${vid}`)).text();
  assert.ok(page.includes('Afternoon visit'));
  assert.ok(page.includes('does not show who it was'), 'door caveat is shown');
});

test('only the assigned caregiver can confirm; confirmation resolves the visit', async () => {
  const vid = await makeVisit();
  const sam = await signIn('p_sam');
  await sam(`/visits/${vid}/confirm`, { outcome: 'completed' });
  assert.equal((await repo.getVisit(HID, vid))!.status, 'scheduled');
  const dana = await signIn('p_dana');
  await dana(`/visits/${vid}/confirm`, { outcome: 'problem', note: 'No answer at the door' });
  const v = (await repo.getVisit(HID, vid))!;
  assert.equal(v.status, 'problem');
  assert.equal(v.confirmations[0].note, 'No answer at the door');
});

test('missed deadline opens one calm follow-up; a late confirmation resolves it', async () => {
  const now = Date.now();
  const vid = await makeVisit({ windowStart: now - 90 * M, windowEnd: now - 60 * M, confirmBy: now - 1 * M });
  await tick(repo);
  await tick(repo);
  let v = (await repo.getVisit(HID, vid))!;
  assert.equal(v.status, 'unconfirmed');
  assert.equal(v.followups.length, 1, 'no duplicate follow-ups on repeated ticks');
  assert.ok(!/emergency|911/i.test(v.followups[0].context.join(' ')));

  const sam = await signIn('p_sam');
  const page = await (await sam('/me')).text();
  assert.ok(page.includes('Follow-up needed'));
  await sam(`/visits/${vid}/followups/${v.followups[0].id}/ack`, {});

  const dana = await signIn('p_dana');
  await dana(`/visits/${vid}/confirm`, { outcome: 'completed', note: 'Ran late, visited at 4:10' });
  v = (await repo.getVisit(HID, vid))!;
  assert.equal(v.status, 'confirmed');
  assert.ok(v.followups[0].resolvedAt);
  assert.equal(v.followups[0].acknowledgedBy, 'p_sam');
});

test('form posts without a matching Origin are rejected (CSRF)', async () => {
  const vid = await makeVisit();
  const res = await app.fetch(new Request(`${ORIGIN}/visits/${vid}/confirm`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://evil.example' }, body: 'outcome=completed',
  }));
  assert.equal(res.status, 403);
});

test('unattached events expire under the retention window; attached ones do not', async () => {
  const at = Date.now() - 3 * 86_400_000;
  const r = await ingestDoorEvent(repo, { ringEventId: null, requestId: null, accountId: null, deviceId: 'dev.front', type: 'motion', subType: 'motion', occurredAt: at }, 'ring_history');
  assert.equal(r.matchedVisitIds.length, 0);
  const events = await repo.allEvents(HID);
  const stored = events.find((e) => e.id === r.eventId)!;
  assert.equal(stored.ttl, Math.floor((at + 7 * 86_400_000) / 1000));
  assert.ok(events.filter((e) => e.attached).every((e) => e.ttl === undefined));
});

test('real-device pattern: history copy 8 s ahead of the webhook merges; re-polls are skipped without writes', async () => {
  const t = Date.now() - 20 * M;
  const vid = await makeVisit({ windowStart: t - 10 * M, windowEnd: t + 10 * M, confirmBy: t + 60 * M });
  const hook = await ingestDoorEvent(repo, { ringEventId: 'dev.front_human_x', requestId: 'r-real', accountId: null, deviceId: 'dev.front', type: 'motion', subType: 'human', occurredAt: t + 8000 }, 'ring_webhook');
  assert.equal(hook.outcome, 'stored');
  const hist = { ringEventId: 'hist-real-1', requestId: null, accountId: null, deviceId: 'dev.front', type: 'motion' as const, subType: null, occurredAt: t };
  assert.equal((await ingestDoorEvent(repo, hist, 'ring_history')).outcome, 'merged');
  const before = (await repo.getEventBySk(HID, (await repo.getVisit(HID, vid))!.matches.find((m) => m.eventId === hook.eventId)!.eventSk))!;
  for (let i = 0; i < 3; i++) assert.equal((await ingestDoorEvent(repo, hist, 'ring_history')).outcome, 'already_seen');
  const after = (await repo.getEventBySk(HID, before.sk))!;
  assert.equal(after.version, before.version, 'no write on re-poll');
  assert.equal(after.deliveryCount, 2);
  assert.equal(after.subType, 'human', 'webhook classification kept');
  assert.equal((await repo.getVisit(HID, vid))!.matches.filter((m) => m.eventId === hook.eventId).length, 1);
});

test('two genuine webhook motions 29 s apart stay separate', async () => {
  const t = Date.now() - 40 * M;
  const a = await ingestDoorEvent(repo, { ringEventId: 'w1', requestId: 'r-w1', accountId: null, deviceId: 'dev.front', type: 'motion', subType: 'human', occurredAt: t }, 'ring_webhook');
  const b = await ingestDoorEvent(repo, { ringEventId: 'w2', requestId: 'r-w2', accountId: null, deviceId: 'dev.front', type: 'motion', subType: 'human', occurredAt: t + 29_000 }, 'ring_webhook');
  assert.equal(a.outcome, 'stored');
  assert.equal(b.outcome, 'stored');
  assert.notEqual(a.eventId, b.eventId);
});

test('public demo is reachable without sign-in, read-only, and labels sample data', async () => {
  const res = await app.fetch(new Request(`${ORIGIN}/demo`));
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.includes('Sample household'));
  assert.ok(body.includes('Local replay, not from Ring'), 'sample events carry the replay label');
  assert.ok(!/<form/i.test(body), 'no forms: nothing can be changed');
  assert.ok(body.includes('does not show who it was'));
});

test('the household owner can close a visit; it is labeled as hers, not the visitor\'s', async () => {
  const vid = await makeVisit();
  const priya = await signIn('p_priya');
  await priya(`/visits/${vid}/confirm`, { outcome: 'completed' });
  assert.equal((await repo.getVisit(HID, vid))!.status, 'scheduled', 'an unrelated trusted person cannot close it');
  const june = await signIn('p_june');
  await june(`/visits/${vid}/confirm`, { outcome: 'completed', note: 'Dana came at 4:05, all good' });
  const v = (await repo.getVisit(HID, vid))!;
  assert.equal(v.status, 'confirmed');
  assert.equal(v.closedByLabel, 'June (household owner)');
  const page = await (await june(`/visits/${vid}`)).text();
  assert.ok(page.includes('Confirmed by June (household owner)'));
});

test('the follow-up contact resolving with a note closes an unconfirmed visit as second-hand', async () => {
  const now = Date.now();
  const vid = await makeVisit({ windowStart: now - 90 * M, windowEnd: now - 60 * M, confirmBy: now - M });
  await tick(repo);
  const fu = (await repo.getVisit(HID, vid))!.followups[0];
  const sam = await signIn('p_sam');
  await sam(`/visits/${vid}/followups/${fu.id}/resolve`, { note: 'Called Dana, she visited at 4:10' });
  const v = (await repo.getVisit(HID, vid))!;
  assert.equal(v.status, 'resolved');
  assert.equal(v.closedByLabel, 'Sam (follow-up contact)');
  const page = await (await sam(`/visits/${vid}`)).text();
  assert.ok(page.includes('Resolved by Sam (follow-up contact)'));
  assert.ok(page.includes('second-hand resolution'));
});

test('owner manages the circle: add a trusted person, remove access (signs them out), restore', async () => {
  const june = await signIn('p_june');
  const dana = await signIn('p_dana');
  const before = (await repo.allPeople(HID)).length;
  await june('/owner/people', { name: 'Rosa', email: 'rosa@example.test', phone: '+1 555 0199' });
  const rosa = (await repo.allPeople(HID)).find((p) => p.name === 'Rosa')!;
  assert.equal((await repo.allPeople(HID)).length, before + 1);
  assert.equal(rosa.role, 'caregiver');
  assert.ok((await (await signIn(rosa.id))('/me')).status === 200, 'new person can sign in');

  assert.equal((await dana('/owner/people')).status, 403, 'caregivers cannot manage people');

  await june(`/owner/people/p_dana/revoke`, {});
  const blocked = await dana('/me');
  assert.equal(blocked.status, 302, 'removed person is signed out immediately');
  assert.ok(blocked.headers.get('location')!.startsWith('/signin'));
  const vid = await makeVisit();
  const page = await (await june(`/visits/${vid}`)).text();
  assert.ok(page.includes('Dana'), 'past visits still show the name');

  await june(`/owner/people/p_june/revoke`, {});
  assert.equal((await repo.getPerson(HID, 'p_june'))!.active, true, 'owner cannot remove themselves');
  await june(`/owner/people/p_dana/restore`, {});
  assert.equal((await (await signIn('p_dana'))('/me')).status, 200, 'restored person can sign in again');
});
