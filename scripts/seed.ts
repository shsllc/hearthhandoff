// Creates the labeled demo household. Safe to re-run: it overwrites only the demo records.
// Works against SQLite (default) or DynamoDB (STORE=dynamodb TABLE_NAME=...).
import { config } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { Repo, newId } from '../src/repo.ts';

const HID = 'hh_demo';
const repo = new Repo(await createStore(), config.retentionDays);
const now = Date.now();
const min = 60_000;

await repo.putHousehold({ id: HID, name: "June's home (demo household)", residentName: 'June', timezone: 'America/Los_Angeles', createdAt: now, ringAccountId: null });
const people = [
  { id: 'p_june', name: 'June', role: 'owner' as const, email: process.env.SEED_OWNER_EMAIL || 'june@example.test', phone: '+15555550100' },
  { id: 'p_dana', name: 'Dana', role: 'caregiver' as const, email: 'dana@example.test', phone: '+15555550101' },
  { id: 'p_sam', name: 'Sam', role: 'caregiver' as const, email: process.env.SEED_FOLLOWUP_EMAIL || 'sam@example.test', phone: '+15555550102' },
  { id: 'p_priya', name: 'Priya', role: 'caregiver' as const, email: 'priya@example.test', phone: null },
];
for (const p of people) await repo.putPerson({ ...p, householdId: HID, active: true });

// A clearly labeled stand-in so the replay works before any Ring device is connected.
await repo.putDevice({ id: 'demo.front-door', householdId: HID, name: 'Front Door (demo device)', kind: 'doorbell', online: true,
  offlineSince: null, origin: 'demo', updatedAt: now });

for (const v of await repo.visits(HID)) if (v.scenarioLabel) await repo.store.delete(v.pk, v.sk);

const base = { householdId: HID, notes: null, viewerIds: ['p_sam'], earlyGraceMin: 15, lateGraceMin: 30, createdBy: 'p_june',
  createdAt: now, matches: [], followups: [], scenarioLabel: 'Seeded example' };
await repo.putVisit({ ...base, id: newId('visit'), kind: 'care_visit', title: 'Morning check-in', assignedPersonId: 'p_dana', followupPersonId: 'p_sam',
  deviceId: 'demo.front-door', windowStart: now - 300 * min, windowEnd: now - 270 * min, confirmBy: now - 240 * min, status: 'confirmed',
  confirmations: [{ id: newId('cf'), personId: 'p_dana', outcome: 'completed', note: 'Breakfast done, meds taken from the organizer.', at: now - 268 * min }] });
await repo.putVisit({ ...base, id: newId('visit'), kind: 'delivery', title: 'Grocery delivery', assignedPersonId: 'p_priya', followupPersonId: 'p_june',
  viewerIds: [], deviceId: 'demo.front-door', windowStart: now + 120 * min, windowEnd: now + 180 * min, confirmBy: now + 200 * min, status: 'scheduled', confirmations: [] });

await repo.audit(HID, 'seed', 'seed', 'Demo household created (all people are fictional)');
console.log(`Seeded ${HID} into ${repo.store.kind}. Sign in as June (owner), Dana, Sam or Priya.`);
