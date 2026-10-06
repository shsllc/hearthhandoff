// Event-to-visit matching rule. Pure and versioned so every match on the timeline can cite the rule
// and the exact reason. A match means only "door activity was recorded near this visit's time".
// It never identifies who was at the door and never counts as confirmation that care happened.

export const MATCH_RULE_VERSION = 'match-v1';

export const MATCH_RULE_TEXT =
  'match-v1: a Ring door event is shown on a visit when (1) it came from the visit\'s chosen Ring device ' +
  '(or any linked device if none was chosen), (2) it is a doorbell press or a motion event whose type is not ' +
  '"vehicle", and (3) the time the device recorded it falls between the window start minus the early grace ' +
  'and the window end plus the late grace. Delivery time is ignored, so a delayed event still lands where it ' +
  'happened. One event may appear on more than one overlapping visit.';

export interface MatchableVisit {
  id: string;
  deviceId: string | null;
  windowStart: number;
  windowEnd: number;
  earlyGraceMin: number;
  lateGraceMin: number;
}

export interface MatchableEvent {
  id: string;
  deviceId: string;
  type: 'button_press' | 'motion';
  subType: string | null;
  occurredAt: number;
}

export type MatchResult =
  | { matched: true; ruleVersion: string; reason: string }
  | { matched: false; ruleVersion: string; reason: string };

// Motion classified as a vehicle is street activity, not someone at the door.
const EXCLUDED_MOTION_SUBTYPES = new Set(['vehicle']);

const minute = 60_000;

export function describeEvent(e: Pick<MatchableEvent, 'type' | 'subType'>): string {
  if (e.type === 'button_press') return 'Doorbell pressed';
  switch (e.subType) {
    case 'human': return 'Motion (Ring classified: person)';
    case 'package_delivery': return 'Motion (Ring classified: package delivery)';
    case 'vehicle': return 'Motion (Ring classified: vehicle)';
    case 'other_motion': return 'Motion (Ring could not classify)';
    case 'motion': case null: case undefined: return 'Motion';
    default: return `Motion (Ring classified: ${e.subType})`;
  }
}

export function matchEventToVisit(
  visit: MatchableVisit,
  event: MatchableEvent,
  fmt: (ms: number) => string = (ms) => new Date(ms).toISOString(),
): MatchResult {
  const r = (matched: boolean, reason: string): MatchResult => ({ matched, ruleVersion: MATCH_RULE_VERSION, reason } as MatchResult);

  if (visit.deviceId && visit.deviceId !== event.deviceId) {
    return r(false, 'different Ring device than the one chosen for this visit');
  }
  if (event.type === 'motion' && event.subType && EXCLUDED_MOTION_SUBTYPES.has(event.subType)) {
    return r(false, `motion classified as "${event.subType}" is not treated as door activity`);
  }
  const from = visit.windowStart - visit.earlyGraceMin * minute;
  const to = visit.windowEnd + visit.lateGraceMin * minute;
  if (event.occurredAt < from || event.occurredAt > to) {
    return r(false, `recorded at ${fmt(event.occurredAt)}, outside ${fmt(from)}–${fmt(to)}`);
  }
  return r(
    true,
    `${describeEvent(event)} recorded at ${fmt(event.occurredAt)}, inside the visit window ` +
      `${fmt(visit.windowStart)}–${fmt(visit.windowEnd)} (grace −${visit.earlyGraceMin}/+${visit.lateGraceMin} min)`,
  );
}
