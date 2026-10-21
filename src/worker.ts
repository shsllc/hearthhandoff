// One "tick": deadline follow-ups, Ring history polling, retention purge.
// Locally a timer calls it; on AWS an EventBridge Scheduler rule invokes the Lambda every minute.
// Steps are independent so a Ring outage never blocks follow-ups.
import { type Repo, newId } from './repo.ts';
import { evaluateDeadline } from './domain/followup.ts';
import { ingestDoorEvent } from './domain/ingest.ts';
import { accessForHousehold, deviceStatus, devicesFromList, eventHistory, listDevices, RingApiError } from './ring/client.ts';
import { HISTORY_EVENT_FILTER, normalizeHistoryEvents } from './ring/history.ts';
import { notifyFollowup } from './notify.ts';

export async function syncRingDevices(repo: Repo, hid: string): Promise<{ ok: boolean; message: string }> {
  try {
    const access = await accessForHousehold(repo, hid);
    if (!access) return { ok: false, message: 'Ring is not connected (no linked account and no Playground token).' };
    const raw = await listDevices(access.token);
    // Shape only (key names), never values: lets us align the parser with Ring's real response.
    const first = Array.isArray(raw?.data) ? raw.data[0] : undefined;
    console.log(JSON.stringify({ ring_devices_shape: { top: Object.keys(raw ?? {}), item: Object.keys(first ?? {}), attributes: Object.keys(first?.attributes ?? {}) } }));
    const found = devicesFromList(raw);
    for (const d of found) {
      let online: boolean | null = null;
      try {
        const s = await deviceStatus(access.token, d.id);
        const v = s?.data?.attributes?.online ?? s?.data?.attributes?.status ?? s?.online ?? s?.status;
        online = v === true || v === 'online' ? true : v === false || v === 'offline' ? false : null;
      } catch { /* status is best-effort context */ }
      const prev = await repo.getDevice(hid, d.id);
      await repo.putDevice({
        id: d.id, householdId: hid, name: prev?.nameSetByOwner ? prev.name : d.name, nameSetByOwner: prev?.nameSetByOwner ?? false, kind: d.kind, online: online ?? prev?.online ?? null,
        offlineSince: online === false ? (prev?.offlineSince ?? Date.now()) : online === true ? null : (prev?.offlineSince ?? null),
        origin: access.mode === 'app' ? 'ring_app' : 'ring_playground', updatedAt: Date.now(),
        lastPolledAt: prev?.lastPolledAt ?? null, lastPollError: prev?.lastPollError ?? null,
      });
    }
    await repo.audit(hid, 'ring', 'devices.synced', `${found.length} device(s) via ${access.mode}`);
    return { ok: true, message: `Synced ${found.length} Ring device(s) via ${access.mode === 'app' ? 'your linked Ring account' : 'the Ring Developer Playground'}.` };
  } catch (e) {
    const msg = e instanceof RingApiError && e.status === 401
      ? 'Ring rejected the token (401). Playground tokens last 30 minutes; generate a new one.'
      : String((e as Error).message);
    await repo.audit(hid, 'ring', 'devices.sync_failed', msg);
    return { ok: false, message: msg };
  }
}

/** On a device's first poll, look back this far (webhooks are the primary path). */
export const HISTORY_FIRST_LOOKBACK_MS = 15 * 60_000;
/** Re-check this much before the high-water mark, in case Ring indexes an event late. */
export const HISTORY_OVERLAP_MS = 5 * 60_000;

export async function pollHistory(repo: Repo, hid: string): Promise<{ fetched: number; stored: number; error?: string }> {
  const access = await accessForHousehold(repo, hid).catch(() => null);
  if (!access) return { fetched: 0, stored: 0 };
  let fetched = 0, stored = 0;
  for (const d of (await repo.devices(hid)).filter((x) => x.origin !== 'demo')) {
    try {
      // First page only (newest first); the tick runs every minute. History is a backstop for missed webhooks,
      // so only events past this device's high-water mark (minus a small overlap for late indexing) are considered.
      const all = normalizeHistoryEvents(await eventHistory(access.token, d.id, HISTORY_EVENT_FILTER), access.accountId);
      const floor = (d.historyHighWater ?? Date.now() - HISTORY_FIRST_LOOKBACK_MS) - HISTORY_OVERLAP_MS;
      const events = all.filter((ev) => ev.occurredAt > floor);
      fetched += events.length;
      for (const ev of events) if ((await ingestDoorEvent(repo, ev, 'ring_history')).outcome === 'stored') stored++;
      const newest = all.reduce((m, ev) => Math.max(m, ev.occurredAt), d.historyHighWater ?? 0);
      await repo.putDevice({ ...d, lastPolledAt: Date.now(), lastPollError: null, historyHighWater: newest || (d.historyHighWater ?? null) });
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 300);
      await repo.putDevice({ ...d, lastPolledAt: Date.now(), lastPollError: msg });
      return { fetched, stored, error: msg };
    }
  }
  return { fetched, stored };
}

export async function evaluateDeadlines(repo: Repo, hid: string, now = Date.now()): Promise<number> {
  const hh = await repo.getHousehold(hid);
  if (!hh) return 0;
  let opened = 0;
  for (const visit of (await repo.visits(hid)).filter((v) => v.status === 'scheduled' && v.confirmBy <= now)) {
    const caregiver = await repo.getPerson(hid, visit.assignedPersonId);
    const device = visit.deviceId ? await repo.getDevice(hid, visit.deviceId) : undefined;
    let followupId: string | null = null;
    await repo.updateVisit(hid, visit.id, (v) => {
      const decision = evaluateDeadline({
        status: v.status, confirmBy: v.confirmBy, hasConfirmation: v.confirmations.length > 0,
        hasOpenFollowup: v.followups.some((f) => f.resolvedAt === null), matchedEventCount: v.matches.length,
        deviceOfflineSince: device?.offlineSince ?? null, caregiverName: caregiver?.name ?? 'The caregiver', residentName: hh.residentName,
      }, now);
      if (decision.action !== 'open_followup') return false;
      followupId = newId('fu');
      v.followups.push({
        id: followupId, contactPersonId: v.followupPersonId, reason: decision.reason, context: decision.context, createdAt: now,
        acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, notifiedVia: ['in_app'],
      });
      v.status = 'unconfirmed';
    });
    if (followupId) {
      opened++;
      await repo.audit(hid, 'system', 'followup.opened', `${visit.title}: confirm-by passed without a confirmation`);
      try {
        await notifyFollowup(repo, hid, visit.id, followupId);
      } catch (e) {
        await repo.audit(hid, 'system', 'followup.notify_failed', String((e as Error).message));
      }
    }
  }
  return opened;
}

export async function tick(repo: Repo, now = Date.now()) {
  const summary: Record<string, unknown> = {};
  for (const hid of await repo.householdIds()) {
    const followups = await evaluateDeadlines(repo, hid, now).catch((e) => { console.error('[tick] deadlines', e); return -1; });
    const history = await pollHistory(repo, hid).catch((e) => ({ error: String(e) }));
    summary[hid] = { followups, history };
  }
  summary.purged = await repo.store.purgeExpired(Math.floor(now / 1000));
  return summary;
}

export function startLocalWorker(repo: Repo, intervalSeconds: number) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try { await tick(repo); } catch (e) { console.error('[worker]', e); } finally { running = false; }
  };
  const timer = setInterval(run, intervalSeconds * 1000);
  timer.unref();
  void run();
  return () => clearInterval(timer);
}
