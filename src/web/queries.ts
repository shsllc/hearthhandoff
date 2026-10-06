// Read models. Visibility is decided here, and every route goes through these helpers.
import type { Repo, Visit, DoorEvent, Match, Person, Followup } from '../repo.ts';
import type { Viewer } from './layout.ts';

/** Owner sees all; others see visits they're assigned to, invited to view, or named as follow-up contact. */
export function canSeeVisit(who: Viewer, v: Visit): boolean {
  if (v.householdId !== who.householdId) return false;
  return who.role === 'owner' || v.assignedPersonId === who.id || v.followupPersonId === who.id || v.viewerIds.includes(who.id);
}

export const canActOnFollowup = (who: Viewer, v: Visit, f: Followup) =>
  v.householdId === who.householdId && (who.role === 'owner' || f.contactPersonId === who.id);

export async function visibleVisits(repo: Repo, who: Viewer, endedAfter: number) {
  return (await repo.visits(who.householdId))
    .filter((v) => canSeeVisit(who, v) && v.windowEnd >= endedAfter)
    .sort((a, b) => a.windowStart - b.windowStart);
}

export async function visibleVisit(repo: Repo, who: Viewer, id: string) {
  const v = await repo.getVisit(who.householdId, id);
  return v && canSeeVisit(who, v) ? v : undefined;
}

export async function peopleById(repo: Repo, hid: string) {
  return new Map<string, Person>((await repo.people(hid)).map((p) => [p.id, p]));
}

export async function matchedEvents(repo: Repo, v: Visit): Promise<Array<{ event: DoorEvent; match: Match }>> {
  const out: Array<{ event: DoorEvent; match: Match }> = [];
  for (const m of v.matches) {
    const event = await repo.getEventBySk(v.householdId, m.eventSk);
    if (event) out.push({ event, match: m });
  }
  return out.sort((a, b) => a.event.occurredAt - b.event.occurredAt);
}

export async function openFollowupsFor(repo: Repo, who: Viewer) {
  const out: Array<{ visit: Visit; followup: Followup }> = [];
  for (const v of await repo.visits(who.householdId)) {
    for (const f of v.followups) if (f.resolvedAt === null && canActOnFollowup(who, v, f)) out.push({ visit: v, followup: f });
  }
  return out.sort((a, b) => a.followup.createdAt - b.followup.createdAt);
}

/** Owner only: door activity that isn't attached to any visit (auto-deleted after the retention window). */
export async function unattachedEvents(repo: Repo, hid: string) {
  return (await repo.allEvents(hid)).filter((e) => !e.attached).sort((a, b) => b.occurredAt - a.occurredAt).slice(0, 25);
}
