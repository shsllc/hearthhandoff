import { type Repo, type DoorEvent, type Visit, type EventSource, newId, keys } from '../repo.ts';
import { matchEventToVisit, describeEvent } from './matching.ts';
import { timeFormatter } from '../time.ts';
import type { NormalizedDoorEvent, NormalizedDeviceStatus } from '../ring/webhook.ts';

export type { EventSource };

export const SOURCE_LABEL: Record<EventSource, string> = {
  ring_webhook: 'Ring webhook (signature verified)',
  ring_history: 'Ring Event History API',
  local_replay: 'Local replay, not from Ring',
};

/** Two records of the same device+type this close together are the same press/motion seen via two paths. */
export const CROSS_SOURCE_MERGE_MS = 5_000;

export interface IngestResult {
  outcome: 'stored' | 'merged' | 'unknown_device';
  eventId?: string;
  matchedVisitIds: string[];
}

async function resolveHousehold(repo: Repo, ev: NormalizedDoorEvent): Promise<string | undefined> {
  const viaDevice = await repo.deviceHousehold(ev.deviceId);
  if (viaDevice) return viaDevice;
  if (ev.accountId) {
    const acct = await repo.getRing(ev.accountId);
    if (acct?.householdId && (acct.status === 'awaiting' || acct.status === 'completed')) {
      // First sighting of a device on a linked account: register it under that household only.
      await repo.putDevice({ id: ev.deviceId, householdId: acct.householdId, name: 'Ring device', kind: null, online: null,
        offlineSince: null, origin: 'ring_app', updatedAt: Date.now() });
      return acct.householdId;
    }
  }
  return undefined;
}

export async function ingestDoorEvent(repo: Repo, ev: NormalizedDoorEvent, source: EventSource, now = Date.now()): Promise<IngestResult> {
  const hid = await resolveHousehold(repo, ev);
  if (!hid) {
    await repo.audit(null, 'ring', 'event.dropped', `unknown device ${ev.deviceId} (${ev.type}) from ${source}`);
    return { outcome: 'unknown_device', matchedVisitIds: [] };
  }

  const nearby = (await repo.eventsInRange(hid, ev.deviceId, ev.occurredAt - CROSS_SOURCE_MERGE_MS, ev.occurredAt + CROSS_SOURCE_MERGE_MS))
    .filter((e) => e.type === ev.type)
    .sort((a, b) => Math.abs(a.occurredAt - ev.occurredAt) - Math.abs(b.occurredAt - ev.occurredAt));

  if (nearby[0]) {
    const existing = nearby[0];
    existing.sources = [...new Set([...existing.sources, source])];
    existing.deliveryCount += 1;
    existing.lastReceivedAt = now;
    existing.subType ??= ev.subType;
    await repo.putEvent(existing);
    await repo.audit(hid, 'ring', 'event.merged', `${describeEvent(ev)} on ${ev.deviceId} also seen via ${SOURCE_LABEL[source]}`);
    return { outcome: 'merged', eventId: existing.id, matchedVisitIds: [] };
  }

  const id = newId('evt');
  const event: DoorEvent = {
    ...keys.event(hid, ev.deviceId, ev.occurredAt, id),
    id, householdId: hid, deviceId: ev.deviceId, type: ev.type, subType: ev.subType, occurredAt: ev.occurredAt,
    firstReceivedAt: now, lastReceivedAt: now, sources: [source], deliveryCount: 1, ringEventId: ev.ringEventId,
    attached: false, ttl: repo.eventTtl(ev.occurredAt),
  };
  await repo.putEvent(event);
  const lagMin = Math.round((now - ev.occurredAt) / 60_000);
  await repo.audit(hid, 'ring', 'event.stored',
    `${describeEvent(ev)} on ${ev.deviceId} via ${SOURCE_LABEL[source]}${lagMin >= 2 ? `, arrived ${lagMin} min after it happened` : ''}`);

  const matched: string[] = [];
  for (const v of await repo.visits(hid)) {
    if (await linkMatch(repo, v, event)) matched.push(v.id);
  }
  return { outcome: 'stored', eventId: id, matchedVisitIds: matched };
}

async function linkMatch(repo: Repo, visit: Visit, event: DoorEvent): Promise<boolean> {
  if (visit.status === 'cancelled') return false;
  const hh = await repo.getHousehold(visit.householdId);
  const res = matchEventToVisit(visit, event, timeFormatter(hh?.timezone ?? 'UTC'));
  if (!res.matched) return false;
  let added = false;
  await repo.updateVisit(visit.householdId, visit.id, (v) => {
    if (v.matches.some((m) => m.eventId === event.id)) return false;
    v.matches.push({ eventSk: event.sk, eventId: event.id, ruleVersion: res.ruleVersion, reason: res.reason, matchedAt: Date.now() });
    added = true;
  });
  if (!event.attached) {
    // Attached events follow the visit's lifetime instead of the short unattached retention.
    event.attached = true;
    delete event.ttl;
    await repo.putEvent(event);
  }
  if (added) await repo.audit(visit.householdId, 'system', 'event.matched', `${visit.title}: ${res.reason}`);
  return true;
}

/** Run when a visit is created, so events received before it existed are considered too. */
export async function matchVisitAgainstEvents(repo: Repo, visit: Visit): Promise<number> {
  const from = visit.windowStart - visit.earlyGraceMin * 60_000;
  const to = visit.windowEnd + visit.lateGraceMin * 60_000;
  const deviceIds = visit.deviceId ? [visit.deviceId] : (await repo.devices(visit.householdId)).map((d) => d.id);
  let n = 0;
  for (const did of deviceIds) {
    for (const e of await repo.eventsInRange(visit.householdId, did, from, to)) if (await linkMatch(repo, visit, e)) n++;
  }
  return n;
}

export async function applyDeviceStatus(repo: Repo, s: NormalizedDeviceStatus) {
  const hid = await repo.deviceHousehold(s.deviceId);
  if (!hid) return;
  const dev = await repo.getDevice(hid, s.deviceId);
  if (!dev) return;
  if (s.kind === 'device_offline') {
    await repo.putDevice({ ...dev, online: false, offlineSince: dev.offlineSince ?? s.occurredAt, updatedAt: Date.now() });
  } else if (s.kind === 'device_online') {
    await repo.putDevice({ ...dev, online: true, offlineSince: null, updatedAt: Date.now() });
  } else if (s.kind === 'device_removed') {
    // Access revoked by the user: forget the device and its unattached activity.
    for (const e of await repo.eventsInRange(hid, s.deviceId, 0, Date.now() + 86_400_000)) if (!e.attached) await repo.deleteEvent(e);
    await repo.removeDevice(hid, s.deviceId);
  }
  await repo.audit(hid, 'ring', `device.${s.kind}`, dev.name);
}
