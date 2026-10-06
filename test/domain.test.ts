import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchEventToVisit, type MatchableVisit } from '../src/domain/matching.ts';
import { evaluateDeadline, type DeadlineInput } from '../src/domain/followup.ts';

const M = 60_000;
const T0 = Date.UTC(2026, 9, 20, 21, 0); // 2:00 PM PDT
const visit: MatchableVisit = { id: 'v', deviceId: 'front', windowStart: T0, windowEnd: T0 + 60 * M, earlyGraceMin: 15, lateGraceMin: 30 };
const ev = (over: Partial<Parameters<typeof matchEventToVisit>[1]> = {}) => ({
  id: 'e', deviceId: 'front', type: 'button_press' as const, subType: null, occurredAt: T0 + 5 * M, ...over,
});

test('matches inside window and inside grace edges', () => {
  assert.ok(matchEventToVisit(visit, ev()).matched);
  assert.ok(matchEventToVisit(visit, ev({ occurredAt: T0 - 15 * M })).matched);
  assert.ok(matchEventToVisit(visit, ev({ occurredAt: T0 + 90 * M })).matched);
});

test('rejects outside grace, other device, and vehicle motion with a reason', () => {
  const early = matchEventToVisit(visit, ev({ occurredAt: T0 - 16 * M }));
  assert.ok(!early.matched && early.reason.includes('outside'));
  assert.ok(!matchEventToVisit(visit, ev({ occurredAt: T0 + 91 * M })).matched);
  assert.ok(!matchEventToVisit(visit, ev({ deviceId: 'back' })).matched);
  const car = matchEventToVisit(visit, ev({ type: 'motion', subType: 'vehicle' }));
  assert.ok(!car.matched && car.reason.includes('vehicle'));
});

test('unknown motion subtypes pass through; visit with no device accepts any device', () => {
  assert.ok(matchEventToVisit(visit, ev({ type: 'motion', subType: 'something_new' })).matched);
  assert.ok(matchEventToVisit({ ...visit, deviceId: null }, ev({ deviceId: 'back' })).matched);
});

test('every result cites the rule version', () => {
  assert.equal(matchEventToVisit(visit, ev()).ruleVersion, 'match-v1');
});

const base: DeadlineInput = {
  status: 'scheduled', confirmBy: T0 + 120 * M, hasConfirmation: false, hasOpenFollowup: false,
  matchedEventCount: 0, deviceOfflineSince: null, caregiverName: 'Dana', residentName: 'June',
};

test('no follow-up before the deadline, after confirmation, or when one is already open', () => {
  assert.equal(evaluateDeadline(base, T0).action, 'none');
  assert.equal(evaluateDeadline({ ...base, hasConfirmation: true }, T0 + 200 * M).action, 'none');
  assert.equal(evaluateDeadline({ ...base, hasOpenFollowup: true }, T0 + 200 * M).action, 'none');
  assert.equal(evaluateDeadline({ ...base, status: 'cancelled' }, T0 + 200 * M).action, 'none');
});

test('door activity does not suppress the follow-up; absence is not framed as an emergency', () => {
  const withActivity = evaluateDeadline({ ...base, matchedEventCount: 2 }, T0 + 121 * M);
  assert.equal(withActivity.action, 'open_followup');
  const none = evaluateDeadline(base, T0 + 121 * M);
  assert.equal(none.action, 'open_followup');
  if (none.action !== 'open_followup') return;
  const text = none.context.join(' ').toLowerCase();
  assert.ok(text.includes('does not mean anything is wrong'));
  for (const word of ['emergency', 'fall', 'danger', '911']) assert.ok(!text.includes(word), word);
});

test('offline device adds context', () => {
  const d = evaluateDeadline({ ...base, deviceOfflineSince: T0 }, T0 + 121 * M);
  assert.ok(d.action === 'open_followup' && d.context.some((c) => c.includes('offline')));
});
