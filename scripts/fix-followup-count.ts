// One-off (2026-10-22): follow-ups opened before the dedupe fix quote a door-event count that included
// webhook/history duplicates. Rewrite that one sentence to the visit's current (deduplicated) match count.
//   STORE=dynamodb TABLE_NAME=... node scripts/fix-followup-count.ts [householdId]
import { config } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { Repo } from '../src/repo.ts';

const hid = process.argv[2] ?? 'hh_demo';
const repo = new Repo(await createStore(), config.retentionDays);
let fixed = 0;
for (const v of await repo.visits(hid)) {
  const n = v.matches.length;
  const stale = v.followups.some((f) => f.context.some((c) => /^Ring recorded \d+ door event/.test(c) && !c.startsWith(`Ring recorded ${n} door event`)));
  if (!stale) continue;
  await repo.updateVisit(hid, v.id, (vv) => {
    for (const f of vv.followups) {
      f.context = f.context.map((c) => c.replace(/^Ring recorded \d+ door events?/, `Ring recorded ${n} door event${n === 1 ? '' : 's'}`));
    }
  });
  fixed++;
  console.log(`${v.title}: count corrected to ${n}`);
}
if (fixed) await repo.audit(hid, 'system', 'followups.recounted', `${fixed} follow-up(s) recounted after duplicate repair`);
console.log(`done: ${fixed} visit(s)`);
