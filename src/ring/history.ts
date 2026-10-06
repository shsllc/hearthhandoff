// Event History API → the same NormalizedDoorEvent the webhook path produces.
// Documented: event_type is `ding`, `motion` (subtypes human/vehicle/animal/other_motion via filter syntax),
// or `on_demand` (a live view, which is not door activity and is skipped).
import type { NormalizedDoorEvent } from './webhook.ts';

export const HISTORY_EVENT_FILTER = 'ding,motion';

export function normalizeHistoryEvents(body: any, accountId: string | null): NormalizedDoorEvent[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  const out: NormalizedDoorEvent[] = [];
  for (const row of rows) {
    const attrs = row?.attributes ?? {};
    const raw = typeof attrs.event_type === 'string' ? attrs.event_type : '';
    const [base, dotted] = raw.split('.');
    const deviceId = row?.relationships?.source?.data?.id;
    const start = typeof attrs.start === 'number' ? attrs.start : Number(attrs.start);
    if (typeof deviceId !== 'string' || !Number.isFinite(start)) continue;
    if (base === 'ding') {
      out.push({ ringEventId: row.id ?? null, requestId: null, accountId, deviceId, type: 'button_press', subType: null, occurredAt: start });
    } else if (base === 'motion') {
      const sub = dotted ?? (typeof attrs.sub_type === 'string' ? attrs.sub_type : null);
      out.push({ ringEventId: row.id ?? null, requestId: null, accountId, deviceId, type: 'motion', subType: sub, occurredAt: start });
    }
  }
  return out;
}
