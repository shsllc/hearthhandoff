// One-off repair for events stored before the cross-source merge fix (2026-10-21):
//   - merges each history-only copy into its webhook-only partner (same device/type, ≤30 s apart)
//   - repoints visit matches from the removed copy to the kept one
//   - resets delivery counters inflated by per-minute history re-polls
// Dry run by default; pass --apply to write.
//   STORE=dynamodb TABLE_NAME=... AWS_PROFILE=... node scripts/repair-events.ts [householdId] [--apply]
import { config } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { Repo, type DoorEvent } from '../src/repo.ts';
import { CROSS_SOURCE_MERGE_MS, idsOf } from '../src/domain/ingest.ts';

const apply = process.argv.includes('--apply');
const hid = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? 'hh_demo';
const repo = new Repo(await createStore(), config.retentionDays);

const events = (await repo.allEvents(hid)).sort((a, b) => a.occurredAt - b.occurredAt);
const historyOnly = events.filter((e) => e.sources.length === 1 && e.sources[0] === 'ring_history');
const webhookOnly = new Set(events.filter((e) => e.sources.includes('ring_webhook') && !e.sources.includes('ring_history')));

const merges: Array<{ keep: DoorEvent; drop: DoorEvent }> = [];
for (const h of historyOnly) {
  const partner = [...webhookOnly]
    .filter((w) => w.deviceId === h.deviceId && w.type === h.type && Math.abs(w.occurredAt - h.occurredAt) <= CROSS_SOURCE_MERGE_MS)
    .sort((a, b) => Math.abs(a.occurredAt - h.occurredAt) - Math.abs(b.occurredAt - h.occurredAt))[0];
  if (!partner) continue;
  webhookOnly.delete(partner);
  merges.push({ keep: partner, drop: h });
}
const dropped = new Set(merges.map((m) => m.drop.id));
const inflated = events.filter((e) => !dropped.has(e.id) && e.deliveryCount > e.sources.length + 2);
console.log(`${events.length} events; ${merges.length} duplicate pairs to merge; ${inflated.length} inflated counters to reset. ${apply ? 'APPLYING' : 'dry run (pass --apply)'}`);
if (!apply) process.exit(0);

const repoint = new Map(merges.map((m) => [m.drop.id, m.keep]));
for (const { keep, drop } of merges) {
  keep.sources = [...new Set([...keep.sources, ...drop.sources])];
  keep.ringEventIds = [...new Set([...idsOf(keep), ...idsOf(drop)])];
  keep.deliveryCount = keep.sources.length;
  keep.subType ??= drop.subType;
  if (drop.attached && !keep.attached) { keep.attached = true; delete keep.ttl; }
  await repo.putEvent(keep);
  await repo.deleteEvent(drop);
}
for (const e of inflated) { e.deliveryCount = e.sources.length; e.ringEventIds = idsOf(e); await repo.putEvent(e); }

let visitsFixed = 0;
for (const v of await repo.visits(hid)) {
  if (!v.matches.some((m) => repoint.has(m.eventId))) continue;
  await repo.updateVisit(hid, v.id, (vv) => {
    const seen = new Set<string>();
    vv.matches = vv.matches.flatMap((m) => {
      const keep = repoint.get(m.eventId);
      const next = keep ? { ...m, eventId: keep.id, eventSk: keep.sk } : m;
      if (seen.has(next.eventId)) return [];
      seen.add(next.eventId);
      return [next];
    });
  });
  visitsFixed++;
}
await repo.audit(hid, 'system', 'events.repaired', `${merges.length} webhook/history duplicate pairs merged; ${inflated.length} counters reset; ${visitsFixed} visits updated`);
console.log(`Done: ${merges.length} merged, ${inflated.length} counters reset, ${visitsFixed} visits updated.`);
