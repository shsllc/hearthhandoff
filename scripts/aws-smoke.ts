// End-to-end smoke test of the deployed stack, with no Ring device and no real recipient:
//   plants an overdue visit → EventBridge Scheduler tick (Lambda) opens a follow-up → SES emails the
//   contact, who is pointed at the SES mailbox simulator → checks the audit trail → removes the visit.
//   STORE=dynamodb TABLE_NAME=... AWS_PROFILE=... npm run smoke:aws
import { config } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { Repo, newId } from '../src/repo.ts';

const HID = 'hh_demo';
const SIMULATOR = 'success@simulator.amazonses.com';
if (config.store !== 'dynamodb') throw new Error('Run with STORE=dynamodb TABLE_NAME=<stack TableName>');

const repo = new Repo(await createStore(), config.retentionDays);
const sam = await repo.getPerson(HID, 'p_sam');
if (!sam) throw new Error('Seed the demo household first (npm run seed with STORE=dynamodb).');
if (sam.email !== SIMULATOR) await repo.putPerson({ ...sam, email: SIMULATOR });

const now = Date.now();
const id = newId('visit');
await repo.putVisit({
  id, householdId: HID, kind: 'care_visit', title: 'AWS smoke test visit', notes: null,
  assignedPersonId: 'p_dana', followupPersonId: 'p_sam', deviceId: null, viewerIds: [],
  windowStart: now - 90 * 60_000, windowEnd: now - 60 * 60_000, confirmBy: now - 60_000, earlyGraceMin: 15, lateGraceMin: 30,
  status: 'scheduled', scenarioLabel: 'Automated smoke test', createdBy: 'p_june', createdAt: now, matches: [], confirmations: [], followups: [],
});
console.log(`Planted ${id}; waiting for the scheduled Lambda tick (runs every minute)…`);

let v = await repo.getVisit(HID, id);
for (let i = 0; i < 30 && !v?.followups[0]?.notifiedVia.includes('email'); i++) {
  await new Promise((r) => setTimeout(r, 5000));
  v = await repo.getVisit(HID, id);
}
const fu = v?.followups[0];
const audit = (await repo.auditLog(HID, 50)).filter((a) => a.at >= now).map((a) => `${a.action}: ${a.detail}`);
console.log(JSON.stringify({ status: v?.status, followupOpened: !!fu, notifiedVia: fu?.notifiedVia, audit }, null, 2));
await repo.store.delete(`HH#${HID}`, `VISIT#${id}`);

const ok = v?.status === 'unconfirmed' && fu?.notifiedVia.includes('email');
console.log(ok ? 'PASS: Scheduler → Lambda → DynamoDB → SES verified.' : 'FAIL: see output above.');
process.exit(ok ? 0 : 1);
