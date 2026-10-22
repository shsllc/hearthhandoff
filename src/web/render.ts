import { html } from 'hono/html';
import { describeEvent } from '../domain/matching.ts';
import { SOURCE_LABEL } from '../domain/ingest.ts';
import type { Visit, DoorEvent, Match, Followup, EventSource } from '../repo.ts';

export const DOOR_CAVEAT = 'Ring recorded activity at the door. This does not show who it was or whether care happened.';

export function statusPill(v: Visit, assignedName: string, now = Date.now()) {
  switch (v.status) {
    case 'confirmed': return html`<span class="pill ok">Confirmed by ${v.closedByLabel ?? assignedName}</span>`;
    case 'resolved': return html`<span class="pill ok">Resolved by ${v.closedByLabel ?? 'follow-up contact'}</span>`;
    case 'problem': return html`<span class="pill bad">Problem reported${v.closedByLabel ? ` by ${v.closedByLabel}` : ''}</span>`;
    case 'unconfirmed': return html`<span class="pill warn">Not confirmed · follow-up open</span>`;
    case 'cancelled': return html`<span class="pill plain">Cancelled</span>`;
    default:
      if (now > v.windowEnd) return html`<span class="pill warn">Awaiting confirmation</span>`;
      if (now >= v.windowStart) return html`<span class="pill info">In progress</span>`;
      return html`<span class="pill plain">Scheduled</span>`;
  }
}

export function sourceBadges(sources: EventSource[]) {
  return sources.map((s) => html`<span class="pill ${s === 'local_replay' ? 'demo' : 'info'}">${SOURCE_LABEL[s] ?? s}</span> `);
}

export const kindLabel = (kind: Visit['kind']) => (kind === 'delivery' ? 'Delivery' : 'Care visit');

export function eventItem(e: DoorEvent, m: Match, deviceName: string, t: (ms: number) => string) {
  const lagMin = Math.round((e.firstReceivedAt - e.occurredAt) / 60_000);
  return html`<li class="ring">
    <strong>${describeEvent(e)}</strong> · ${deviceName} · ${t(e.occurredAt)}
    <div>${sourceBadges(e.sources)}</div>
    <p class="caveat">${DOOR_CAVEAT}</p>
    <p class="caveat">Why it's shown here (${m.ruleVersion}): ${m.reason}.</p>
    ${lagMin >= 2 ? html`<p class="caveat">Arrived ${lagMin} min after it happened. Placed by the time Ring recorded it.</p>` : ''}
    ${e.deliveryCount > 1 ? html`<p class="caveat">Received ${e.deliveryCount} times (retries or a second source). Shown once.</p>` : ''}
  </li>`;
}

export interface FollowupCardOpts {
  canAct: boolean; contactName: string; ackName: string | null; resolvedName: string | null;
  caregiverName: string; caregiverPhone: string | null; residentName: string; residentPhone: string | null;
  t: (ms: number) => string; showVisitLink?: boolean;
  /** Use h2 where the card sits directly under the page h1 (visit page); h3 under a section h2. */
  topLevel?: boolean;
}

export function followupCard(f: Followup, v: Visit, o: FollowupCardOpts) {
  const open = f.resolvedAt === null;
  return html`<section class="card" aria-labelledby="fu-${f.id}">
    ${o.topLevel
      ? html`<h2 id="fu-${f.id}" style="margin-top:0">${open ? 'Follow-up needed' : 'Follow-up resolved'}: ${v.title}</h2>`
      : html`<h3 id="fu-${f.id}">${open ? 'Follow-up needed' : 'Follow-up resolved'}: ${v.title}</h3>`}
    <p>${f.reason}</p>
    <ul>${f.context.map((c) => html`<li>${c}</li>`)}</ul>
    <p class="small muted">Opened ${o.t(f.createdAt)} for ${o.contactName} (${f.notifiedVia.map((n) => (n === 'email' ? 'emailed via Amazon SES' : 'in app')).join(', ')}).
      ${f.acknowledgedAt ? html`${o.ackName} said they're checking in (${o.t(f.acknowledgedAt)}).` : ''}
      ${f.resolvedAt ? html`Resolved by ${o.resolvedName ?? 'caregiver confirmation'} at ${o.t(f.resolvedAt)}${f.resolutionNote ? html`: “${f.resolutionNote}”` : ''}.` : ''}</p>
    ${open && o.canAct ? html`
      <div class="actions">
        ${o.caregiverPhone ? html`<a class="btn" href="tel:${o.caregiverPhone}">Call ${o.caregiverName}</a>
          <a class="btn secondary" href="sms:${o.caregiverPhone}">Text ${o.caregiverName}</a>` : ''}
        ${o.residentPhone ? html`<a class="btn secondary" href="tel:${o.residentPhone}">Call ${o.residentName}</a>` : ''}
        ${f.acknowledgedAt ? '' : html`<form method="post" action="/visits/${v.id}/followups/${f.id}/ack"><button class="secondary" type="submit">I'm checking in</button></form>`}
      </div>
      <form method="post" action="/visits/${v.id}/followups/${f.id}/resolve">
        <label for="note-${f.id}">Resolve with a note</label>
        <input id="note-${f.id}" name="note" required maxlength="500" placeholder="e.g. Talked to Dana; she was running late and visited at 4:10">
        <div class="actions"><button type="submit">Mark resolved</button></div>
      </form>` : ''}
    ${o.showVisitLink ? html`<p><a href="/visits/${v.id}">Open visit</a></p>` : ''}
  </section>`;
}

export function visitSummary(v: Visit, assignedName: string, t: (ms: number) => string, d: (ms: number) => string) {
  return html`<div class="card visit-row">
    <div>
      <h3><a href="/visits/${v.id}">${v.title}</a></h3>
      <div class="small muted">${kindLabel(v.kind)} · ${d(v.windowStart)}–${t(v.windowEnd)} · ${assignedName}</div>
      <div class="small muted">Door activity near this time: ${v.matches.length === 0 ? 'none recorded' : v.matches.length}</div>
      ${v.scenarioLabel ? html`<div><span class="pill demo">${v.scenarioLabel}</span></div>` : ''}
    </div>
    <div>${statusPill(v, assignedName)}</div>
  </div>`;
}
