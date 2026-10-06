// Entities and key schema (single-table design).
//   HOUSEHOLDS              | <hid>                      household index for the scheduled worker
//   HH#<hid>                | META                       household
//   HH#<hid>                | PERSON#<pid>               person
//   HH#<hid>                | DEVICE#<did>               Ring device + polling state
//   HH#<hid>                | VISIT#<vid>                visit, with embedded viewers/matches/confirmations/follow-ups
//   HH#<hid>                | EVENT#<did>#<ms13>#<eid>   door event metadata (TTL while unattached)
//   HH#<hid>#AUDIT          | <ms13>#<rand>              audit trail (TTL 30 days)
//   DEVICE#<did>            | META                       device → household lookup for webhooks
//   RING#<accountId>        | META                       sealed Ring tokens and link status
//   RING#UNCLAIMED          | <accountId>                unclaimed-token pool for nonce matching (TTL 15 min)
//   RECEIPT#<requestId>     | META                       webhook idempotency (TTL 7 days)
import { randomUUID } from 'node:crypto';
import type { Item, ItemStore } from './store/types.ts';

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
const pad = (ms: number) => String(Math.max(0, Math.floor(ms))).padStart(13, '0');
const sec = (ms: number) => Math.floor(ms / 1000);

export type Role = 'owner' | 'caregiver';
export type VisitStatus = 'scheduled' | 'confirmed' | 'problem' | 'unconfirmed' | 'cancelled';
export type EventSource = 'ring_webhook' | 'ring_history' | 'local_replay';

export interface Household extends Item { id: string; name: string; residentName: string; timezone: string; createdAt: number; ringAccountId?: string | null }
export interface Person extends Item { id: string; householdId: string; name: string; email: string | null; phone: string | null; role: Role; active: boolean }
export interface Device extends Item {
  id: string; householdId: string; name: string; kind: string | null; online: boolean | null; offlineSince: number | null;
  origin: 'ring_app' | 'ring_playground' | 'demo'; updatedAt: number; lastPolledAt?: number | null; lastPollError?: string | null;
}
export interface Match { eventSk: string; eventId: string; ruleVersion: string; reason: string; matchedAt: number }
export interface Confirmation { id: string; personId: string; outcome: 'completed' | 'problem'; note: string | null; at: number }
export interface Followup {
  id: string; contactPersonId: string; reason: string; context: string[]; createdAt: number;
  acknowledgedAt: number | null; acknowledgedBy: string | null; resolvedAt: number | null; resolvedBy: string | null;
  resolutionNote: string | null; notifiedVia: string[];
}
export interface Visit extends Item {
  id: string; householdId: string; kind: 'care_visit' | 'delivery'; title: string; notes: string | null;
  assignedPersonId: string; followupPersonId: string; deviceId: string | null; viewerIds: string[];
  windowStart: number; windowEnd: number; confirmBy: number; earlyGraceMin: number; lateGraceMin: number;
  status: VisitStatus; scenarioLabel: string | null; createdBy: string; createdAt: number;
  matches: Match[]; confirmations: Confirmation[]; followups: Followup[];
}
export interface DoorEvent extends Item {
  id: string; householdId: string; deviceId: string; type: 'button_press' | 'motion'; subType: string | null;
  occurredAt: number; firstReceivedAt: number; lastReceivedAt: number; sources: EventSource[]; deliveryCount: number;
  ringEventId: string | null; attached: boolean;
}
export interface RingAccount extends Item {
  accountId: string; householdId: string | null; accessSealed: string; refreshSealed: string; accessExpiresAt: number;
  scope: string | null; status: 'unclaimed' | 'awaiting' | 'completed' | 'removed'; createdAt: number;
  claimedAt: number | null; claimedBy: string | null;
}
export interface AuditEntry extends Item { at: number; actor: string; action: string; detail: string }

export const keys = {
  household: (hid: string) => ({ pk: `HH#${hid}`, sk: 'META' }),
  person: (hid: string, pid: string) => ({ pk: `HH#${hid}`, sk: `PERSON#${pid}` }),
  device: (hid: string, did: string) => ({ pk: `HH#${hid}`, sk: `DEVICE#${did}` }),
  deviceLookup: (did: string) => ({ pk: `DEVICE#${did}`, sk: 'META' }),
  visit: (hid: string, vid: string) => ({ pk: `HH#${hid}`, sk: `VISIT#${vid}` }),
  event: (hid: string, did: string, at: number, eid: string) => ({ pk: `HH#${hid}`, sk: `EVENT#${did}#${pad(at)}#${eid}` }),
  ring: (accountId: string) => ({ pk: `RING#${accountId}`, sk: 'META' }),
  unclaimed: (accountId: string) => ({ pk: 'RING#UNCLAIMED', sk: accountId }),
  receipt: (requestId: string) => ({ pk: `RECEIPT#${requestId}`, sk: 'META' }),
};

export const UNATTACHED_EVENT_TTL_DAYS_DEFAULT = 7;

export class Repo {
  store: ItemStore;
  retentionDays: number;
  constructor(store: ItemStore, retentionDays = UNATTACHED_EVENT_TTL_DAYS_DEFAULT) {
    this.store = store;
    this.retentionDays = retentionDays;
  }

  // --- households & people ---
  async putHousehold(h: Omit<Household, 'pk' | 'sk'>) {
    await this.store.put({ ...keys.household(h.id), ...h });
    await this.store.put({ pk: 'HOUSEHOLDS', sk: h.id });
  }
  getHousehold(hid: string) { return this.store.get<Household>(keys.household(hid).pk, 'META'); }
  async householdIds() { return (await this.store.query('HOUSEHOLDS')).map((i) => i.sk); }
  async setHouseholdRingAccount(hid: string, accountId: string | null) {
    const h = await this.getHousehold(hid);
    if (h) await this.store.put({ ...h, ringAccountId: accountId });
  }

  putPerson(p: Omit<Person, 'pk' | 'sk'>) { return this.store.put({ ...keys.person(p.householdId, p.id), ...p }); }
  getPerson(hid: string, pid: string) { return this.store.get<Person>(`HH#${hid}`, `PERSON#${pid}`); }
  async people(hid: string) {
    return (await this.store.query<Person>(`HH#${hid}`, { prefix: 'PERSON#' })).filter((p) => p.active)
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'owner' ? -1 : 1));
  }

  // --- devices ---
  async putDevice(d: Omit<Device, 'pk' | 'sk'>) {
    await this.store.put({ ...keys.device(d.householdId, d.id), ...d });
    await this.store.put({ ...keys.deviceLookup(d.id), householdId: d.householdId });
  }
  getDevice(hid: string, did: string) { return this.store.get<Device>(`HH#${hid}`, `DEVICE#${did}`); }
  devices(hid: string) { return this.store.query<Device>(`HH#${hid}`, { prefix: 'DEVICE#' }); }
  async deviceHousehold(did: string) {
    return (await this.store.get<Item & { householdId: string }>(keys.deviceLookup(did).pk, 'META'))?.householdId;
  }
  async removeDevice(hid: string, did: string) {
    await this.store.delete(`HH#${hid}`, `DEVICE#${did}`);
    await this.store.delete(`DEVICE#${did}`, 'META');
  }

  // --- visits ---
  putVisit(v: Omit<Visit, 'pk' | 'sk'>) { return this.store.put({ ...keys.visit(v.householdId, v.id), ...v }, { ifNotExists: true }); }
  getVisit(hid: string, vid: string) { return this.store.get<Visit>(`HH#${hid}`, `VISIT#${vid}`); }
  visits(hid: string) { return this.store.query<Visit>(`HH#${hid}`, { prefix: 'VISIT#' }); }

  /** Read-modify-write with optimistic concurrency; `fn` returns false to skip the write. */
  async updateVisit(hid: string, vid: string, fn: (v: Visit) => boolean | void): Promise<Visit | undefined> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const v = await this.getVisit(hid, vid);
      if (!v) return undefined;
      if (fn(v) === false) return v;
      if (await this.store.put(v, { ifVersion: v.version ?? 0 })) return v;
    }
    throw new Error(`visit ${vid} kept changing; gave up after 5 attempts`);
  }

  // --- door events ---
  eventsInRange(hid: string, did: string, from: number, to: number) {
    return this.store.query<DoorEvent>(`HH#${hid}`, { between: [`EVENT#${did}#${pad(from)}`, `EVENT#${did}#${pad(to)}#￿`] });
  }
  allEvents(hid: string) { return this.store.query<DoorEvent>(`HH#${hid}`, { prefix: 'EVENT#' }); }
  getEventBySk(hid: string, sk: string) { return this.store.get<DoorEvent>(`HH#${hid}`, sk); }
  eventTtl(occurredAt: number) { return sec(occurredAt + this.retentionDays * 86_400_000); }
  putEvent(e: DoorEvent) { return this.store.put(e); }
  deleteEvent(e: DoorEvent) { return this.store.delete(e.pk, e.sk); }

  // --- Ring accounts ---
  getRing(accountId: string) { return this.store.get<RingAccount>(`RING#${accountId}`, 'META'); }
  putRing(r: Omit<RingAccount, 'pk' | 'sk'>) { return this.store.put({ ...keys.ring(r.accountId), ...r }); }
  async addUnclaimed(accountId: string) {
    await this.store.put({ ...keys.unclaimed(accountId), ttl: sec(Date.now() + 15 * 60_000) });
  }
  async unclaimedAccountIds() { return (await this.store.query('RING#UNCLAIMED')).map((i) => i.sk); }
  removeUnclaimed(accountId: string) { return this.store.delete('RING#UNCLAIMED', accountId); }

  // --- idempotency & audit ---
  /** True the first time a request id is seen. */
  claimReceipt(requestId: string) {
    return this.store.put({ ...keys.receipt(requestId), ttl: sec(Date.now() + 7 * 86_400_000), at: Date.now() }, { ifNotExists: true });
  }
  releaseReceipt(requestId: string) { return this.store.delete(`RECEIPT#${requestId}`, 'META'); }

  async audit(hid: string | null, actor: string, action: string, detail = '') {
    const at = Date.now();
    await this.store.put({
      pk: hid ? `HH#${hid}#AUDIT` : 'SYS#AUDIT', sk: `${pad(at)}#${randomUUID().slice(0, 8)}`,
      ttl: sec(at + 30 * 86_400_000), at, actor, action, detail,
    });
  }
  auditLog(hid: string, limit = 200) { return this.store.query<AuditEntry>(`HH#${hid}#AUDIT`, { reverse: true, limit }); }
  async latestAuditAt(hid: string) { return (await this.auditLog(hid, 1))[0]?.at ?? 0; }
}
