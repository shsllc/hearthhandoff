import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWebhook, signWebhookBody, verifyWebhookSignature } from '../src/ring/webhook.ts';
import { checkNonceFreshness, computeNonce, matchNonce } from '../src/ring/nonce.ts';

// Vectors produced with the Python snippets in Ring's API documentation (see docs/FEASIBILITY.md).
const KEY = 'test-hmac-key';
const BODY = '{"meta":{"version":"1.1","request_id":"r1"},"data":{"type":"button_press"}}';
const PY_SIG = '03ac4bad05b95aab7ceae9f167071298e383ac1cd76d665041b40282fac81fd2';
const PY_NONCE = 'qexVypp7hnEZKz7jsI96n5DEp_jrbDeSKXSYWP5KHHE';

test('webhook signature matches Ring reference implementation', () => {
  assert.equal(signWebhookBody(KEY, BODY), `sha256=${PY_SIG}`);
  assert.ok(verifyWebhookSignature(KEY, Buffer.from(BODY), `sha256=${PY_SIG}`));
});

test('webhook signature rejects tampering, wrong key, re-serialized JSON and garbage', () => {
  assert.ok(!verifyWebhookSignature(KEY, BODY.replace('r1', 'r2'), `sha256=${PY_SIG}`));
  assert.ok(!verifyWebhookSignature('other', BODY, `sha256=${PY_SIG}`));
  const reserialized = JSON.stringify(JSON.parse(BODY), null, 1);
  assert.ok(!verifyWebhookSignature(KEY, reserialized, `sha256=${PY_SIG}`));
  assert.ok(!verifyWebhookSignature(KEY, BODY, 'sha256=nothex'));
  assert.ok(!verifyWebhookSignature(KEY, BODY, null));
  assert.ok(!verifyWebhookSignature('', BODY, `sha256=${PY_SIG}`));
});

test('nonce matches Ring reference implementation (base64url, no padding)', () => {
  const nonce = computeNonce(KEY, '1771130906289', 'ava1.ring.account.XXXYYY');
  assert.equal(nonce, PY_NONCE);
  assert.ok(!nonce.includes('='));
  assert.equal(matchNonce(KEY, '1771130906289', PY_NONCE, ['ava1.ring.account.other', 'ava1.ring.account.XXXYYY']), 'ava1.ring.account.XXXYYY');
  assert.equal(matchNonce(KEY, '1771130906290', PY_NONCE, ['ava1.ring.account.XXXYYY']), null);
});

test('nonce freshness window is 10 minutes and rejects the future', () => {
  const now = 1_771_130_906_289;
  assert.deepEqual(checkNonceFreshness(String(now - 599_000), now), { ok: true });
  assert.equal(checkNonceFreshness(String(now - 601_000), now).ok, false);
  assert.equal(checkNonceFreshness(String(now + 1000), now).ok, false);
  assert.equal(checkNonceFreshness('1771130906', now).ok, false); // seconds, not ms
});

test('parses documented motion_detected v1.1 payload', () => {
  const p = parseWebhook({
    meta: { version: '1.1', time: '2026-08-14T08:53:17Z', request_id: 'req-1', account_id: 'ava1.ring.account.A' },
    data: {
      id: 'dev1_human_1786715596787',
      type: 'motion_detected',
      attributes: { source: 'dev1', source_type: 'devices', timestamp: 1786715596787, sub_type: 'human', component_ids: ['0'] },
    },
  });
  assert.equal(p.kind, 'door_event');
  if (p.kind !== 'door_event') return;
  assert.deepEqual(p.event, {
    ringEventId: 'dev1_human_1786715596787', requestId: 'req-1', accountId: 'ava1.ring.account.A',
    deviceId: 'dev1', type: 'motion', subType: 'human', occurredAt: 1786715596787,
  });
});

test('parses button_press, device status, integration and unknown types', () => {
  const meta = { version: '1.1', time: '2026-08-14T08:53:17Z', request_id: 'x', account_id: 'acct' };
  const press = parseWebhook({ meta, data: { id: 'i', type: 'button_press', attributes: { source: 'd', timestamp: 5 } } });
  assert.equal(press.kind === 'door_event' && press.event.type, 'button_press');
  const off = parseWebhook({ meta, data: { id: 'i', type: 'device_offline', attributes: { source: 'd', timestamp: 5 } } });
  assert.equal(off.kind === 'device_status' && off.status.kind, 'device_offline');
  assert.equal(parseWebhook({ meta, data: { type: 'app_integration_removed', attributes: {} } }).kind, 'integration');
  assert.equal(parseWebhook({ meta, data: { type: 'subscription_activated', attributes: {} } }).kind, 'ignored');
  assert.equal(parseWebhook({ meta, data: { type: 'button_press', attributes: {} } }).kind, 'invalid');
  assert.equal(parseWebhook({ event_type: 'motion_detected' }).kind, 'invalid');
});
