// Public, read-only demo for judges and visitors: no sign-in, no writes.
// The household and its door events are fictional and built in memory relative to "now"; sample events
// carry the same "Local replay, not from Ring" label the app uses everywhere. The only real data shown is
// an aggregate from the household linked to a real Ring account: counts and delays, never times of day.
import { html } from 'hono/html';
import type { Repo, Visit, DoorEvent, Followup, Match } from '../repo.ts';
import { matchEventToVisit, MATCH_RULE_TEXT } from '../domain/matching.ts';
import { evaluateDeadline } from '../domain/followup.ts';
import { eventItem, followupCard, statusPill, kindLabel, DOOR_CAVEAT } from './render.ts';
import { dateTimeFormatter, timeFormatter, epochToZonedLocal, zonedLocalToEpoch } from '../time.ts';

const TZ = 'America/Los_Angeles';
const M = 60_000;

/** Wall-clock time in the demo time zone, `dayOffset` days from today (stable regardless of when the page loads). */
function clock(now: number, dayOffset: number, hhmm: string) {
  const day = epochToZonedLocal(now + dayOffset * 86_400_000, TZ).slice(0, 10);
  return zonedLocalToEpoch(`${day}T${hhmm}`, TZ);
}

function sampleHousehold(now: number) {
  const base = (over: Partial<Visit>): Visit => ({
    pk: 'DEMO', sk: 'DEMO', id: 'demo', householdId: 'demo', kind: 'care_visit', title: '', notes: null,
    assignedPersonId: 'dana', followupPersonId: 'sam', deviceId: 'front', viewerIds: ['sam'],
    windowStart: now, windowEnd: now, confirmBy: now, earlyGraceMin: 15, lateGraceMin: 30,
    status: 'scheduled', scenarioLabel: 'Sample household', createdBy: 'june', createdAt: now - 86_400_000,
    matches: [], confirmations: [], followups: [], ...over,
  });
  const ev = (id: string, at: number, type: DoorEvent['type'], subType: string | null, lagMin = 0, sources: DoorEvent['sources'] = ['local_replay']): DoorEvent => ({
    pk: 'DEMO', sk: `EVENT#front#${at}#${id}`, id, householdId: 'demo', deviceId: 'front', type, subType, occurredAt: at,
    firstReceivedAt: at + lagMin * M, lastReceivedAt: at + lagMin * M, sources, deliveryCount: 1, ringEventId: null, attached: true,
  });

  // 1) Morning visit: door activity + Dana confirmed.
  const morning = base({ id: 'm', title: 'Morning check-in', windowStart: clock(now, -1, '09:00'), windowEnd: clock(now, -1, '10:00'), confirmBy: clock(now, -1, '10:30'), status: 'confirmed' });
  morning.confirmations.push({ id: 'c1', personId: 'dana', outcome: 'completed', note: 'Breakfast done, pills taken from the weekly organizer.', at: clock(now, -1, '09:52') });
  const mEvents = [ev('e1', clock(now, -1, '09:04'), 'button_press', null), ev('e2', clock(now, -1, '09:49'), 'motion', 'human')];

  // 2) Afternoon visit: door activity, but no confirmation by confirm-by → calm follow-up for Sam.
  const afternoon = base({ id: 'a', title: 'Afternoon visit', windowStart: clock(now, -1, '14:00'), windowEnd: clock(now, -1, '15:00'), confirmBy: clock(now, -1, '15:30'), status: 'unconfirmed' });
  const aEvents = [ev('e3', clock(now, -1, '14:07'), 'motion', 'human', 12), ev('e4', clock(now, -1, '14:40'), 'motion', 'vehicle')];

  // 3) Grocery delivery later today, not yet due.
  const delivery = base({ id: 'd', kind: 'delivery', title: 'Grocery delivery', assignedPersonId: 'priya', followupPersonId: 'june', viewerIds: [],
    windowStart: clock(now, 1, '10:00'), windowEnd: clock(now, 1, '11:00'), confirmBy: clock(now, 1, '11:30') });

  const fmt = timeFormatter(TZ);
  const attach = (v: Visit, evs: DoorEvent[]) => evs.map((e) => ({ e, r: matchEventToVisit(v, e, fmt) }));
  const mMatched = attach(morning, mEvents), aMatched = attach(afternoon, aEvents);
  const toMatch = (x: { e: DoorEvent; r: ReturnType<typeof matchEventToVisit> }): Match => ({ eventSk: x.e.sk, eventId: x.e.id, ruleVersion: x.r.ruleVersion, reason: x.r.reason, matchedAt: now });
  morning.matches = mMatched.filter((x) => x.r.matched).map(toMatch);
  afternoon.matches = aMatched.filter((x) => x.r.matched).map(toMatch);

  const decision = evaluateDeadline({ status: 'scheduled', confirmBy: afternoon.confirmBy, hasConfirmation: false, hasOpenFollowup: false,
    matchedEventCount: afternoon.matches.length, deviceOfflineSince: null, caregiverName: 'Dana', residentName: 'June' }, afternoon.confirmBy + M);
  const fu: Followup = { id: 'f1', contactPersonId: 'sam', reason: decision.action === 'open_followup' ? decision.reason : '', context: decision.action === 'open_followup' ? decision.context : [],
    createdAt: afternoon.confirmBy + M, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, resolutionNote: null, notifiedVia: ['in_app', 'email'] };
  afternoon.followups.push(fu);

  return { morning, mMatched, afternoon, aMatched, delivery, fu };
}

/** Aggregate proof from the household linked to a real Ring account: no times of day, no identities. */
async function realRingSummary(repo: Repo) {
  for (const hid of await repo.householdIds()) {
    const hh = await repo.getHousehold(hid);
    const acct = hh?.ringAccountId ? await repo.getRing(hh.ringAccountId) : undefined;
    if (acct?.status !== 'completed') continue;
    const devices = (await repo.devices(hid)).filter((d) => d.origin === 'ring_app');
    const events = (await repo.allEvents(hid)).filter((e) => !e.sources.includes('local_replay') && !e.deviceId.startsWith('demo.'));
    const viaWebhook = events.filter((e) => e.sources.includes('ring_webhook'));
    const lags = viaWebhook.map((e) => (e.firstReceivedAt - e.occurredAt) / 1000).sort((a, b) => a - b);
    return {
      devices: devices.length,
      events: events.length,
      webhook: viaWebhook.length,
      both: events.filter((e) => e.sources.includes('ring_webhook') && e.sources.includes('ring_history')).length,
      person: events.filter((e) => e.subType === 'human').length,
      medianLagS: lags.length ? Math.max(1, Math.round(lags[lags.length >> 1])) : null,
      matchedVisits: (await repo.visits(hid)).filter((v) => !v.scenarioLabel && v.matches.length > 0).length,
    };
  }
  return null;
}

export async function renderDemo(repo: Repo, now = Date.now()) {
  const s = sampleHousehold(now);
  const t = timeFormatter(TZ), d = dateTimeFormatter(TZ);
  const names: Record<string, string> = { june: 'June', dana: 'Dana', sam: 'Sam', priya: 'Priya' };
  const real = await realRingSummary(repo).catch(() => null);

  const timeline = (v: Visit, matched: Array<{ e: DoorEvent; r: ReturnType<typeof matchEventToVisit> }>) => {
    const entries: Array<{ at: number; node: unknown }> = [
      { at: v.windowStart, node: html`<li><strong>Visit window opens</strong> · ${t(v.windowStart)}</li>` },
      { at: v.windowEnd, node: html`<li><strong>Visit window ends</strong> · ${t(v.windowEnd)}</li>` },
      ...matched.filter((x) => x.r.matched).map((x) => ({ at: x.e.occurredAt, node: eventItem(x.e, v.matches.find((m) => m.eventId === x.e.id)!, 'Front door', t) })),
      ...matched.filter((x) => !x.r.matched).map((x) => ({ at: x.e.occurredAt, node: html`<li class="ring"><strong>Not shown on this visit</strong> · ${t(x.e.occurredAt)}
        <p class="caveat">Ring-format motion classified as vehicle: ${x.r.reason}. Owners still see it in their private list, deleted after 7 days.</p></li>` })),
      ...v.confirmations.map((c) => ({ at: c.at, node: html`<li class="person"><strong>${names[c.personId]} confirmed the visit</strong> · ${t(c.at)}<p>“${c.note}”</p><p class="caveat">Confirmed by the person, in HearthHandoff.</p></li>` })),
      ...v.followups.map((f) => ({ at: f.createdAt, node: html`<li class="alert"><strong>Follow-up opened for ${names[f.contactPersonId]}</strong> · ${t(f.createdAt)}</li>` })),
    ];
    return html`<ol class="timeline">${entries.sort((a, b) => a.at - b.at).map((x) => x.node)}</ol>`;
  };

  const visitCard = (v: Visit, matched: Array<{ e: DoorEvent; r: ReturnType<typeof matchEventToVisit> }>, note: string) => html`
    <section class="card">
      <div class="visit-row"><div><h3>${v.title}</h3>
        <div class="small muted">${kindLabel(v.kind)} · ${d(v.windowStart)}–${t(v.windowEnd)} · ${names[v.assignedPersonId]} · confirm by ${t(v.confirmBy)}</div>
        <div class="small muted">Shared with ${[names[v.assignedPersonId], ...v.viewerIds.map((x) => names[x])].join(', ')} and June (owner)</div></div>
        <div>${statusPill(v, names[v.assignedPersonId], now)}</div></div>
      <p class="small">${note}</p>
      ${matched.length ? timeline(v, matched) : html`<p class="small muted">Not due yet.</p>`}
    </section>`;

  return html`
    <h1>HearthHandoff demo</h1>
    <p>A read-only tour of one household. No sign-in needed and nothing here can be changed. <span class="pill demo">Sample household</span></p>
    <p class="small muted">June lives on her own. She owns the Ring account and decides who sees each visit. Dana is her caregiver, Sam is her son, Priya delivers groceries. All the people are fictional, and so are the door events on this page, which use Ring's real webhook format, run through the same code, and are labeled as replays wherever they appear.</p>

    ${real ? html`<section class="card" aria-labelledby="real-h">
      <h2 id="real-h" style="margin-top:0">Verified with a real Ring account</h2>
      <p>Separately, HearthHandoff is linked to a real Ring account through Ring's one-way account linking. Over the last 7 days it has received:</p>
      <ul>
        <li><strong>${real.events}</strong> real door events from <strong>${real.devices}</strong> Ring devices, <strong>${real.person}</strong> of them classified by Ring as a person</li>
        <li><strong>${real.webhook}</strong> delivered by HMAC-signed webhook${real.both === real.webhook ? ', every one of them also confirmed by the Event History API and merged into a single entry' : html`, ${real.both} of them also confirmed by the Event History API and merged into a single entry`}</li>
        ${real.events > real.webhook ? html`<li><strong>${real.events - real.webhook}</strong> more found only by the Event History backstop poll</li>` : ''}
        ${real.medianLagS !== null ? html`<li>Median webhook delay: about <strong>${real.medianLagS} s</strong> after the motion</li>` : ''}
        ${real.matchedVisits ? html`<li><strong>${real.matchedVisits}</strong> real visit${real.matchedVisits === 1 ? '' : 's'} matched to real door activity</li>` : ''}
      </ul>
      <p class="small muted">Only totals are shown, never times or patterns from that home.</p>
    </section>` : ''}

    <h2>A day at June's</h2>
    ${visitCard(s.morning, s.mMatched, 'Door activity lined up with the visit, and Dana confirmed it. Only her confirmation closed the visit.')}
    ${visitCard(s.afternoon, s.aMatched, 'Ring saw activity, but Dana never confirmed, so Sam got a follow-up. Motion classified as a vehicle stays off the visit.')}
    ${followupCard(s.fu, s.afternoon, { canAct: false, contactName: 'Sam', ackName: null, resolvedName: null, caregiverName: 'Dana', caregiverPhone: null, residentName: 'June', residentPhone: null, t: d })}
    <p class="small muted">In the real app Sam gets this in the app and by email (Amazon SES), with buttons to call or text Dana, say "I'm checking in", or resolve with a note.</p>
    ${visitCard(s.delivery, [], 'Priya can see only this delivery, not June\'s other visits or any door activity outside it.')}

    <h2>What a caregiver sees</h2>
    <section class="card">
      <h3 style="margin-bottom:.4rem">How did it go?</h3>
      <p class="small muted">Dana's phone view after a visit: two large buttons and an optional note.</p>
      <div class="actions" aria-hidden="true"><span class="btn">Visit done</span><span class="btn" style="background:var(--bad);border-color:var(--bad);color:var(--bad-fg)">There's a problem</span></div>
    </section>

    <h2>The rules it follows</h2>
    <ul>
      <li>${DOOR_CAVEAT}</li>
      <li>Only a person's confirmation closes a visit. Missing Ring activity is never treated as an emergency, and nothing is dispatched automatically.</li>
      <li>No video, images, identity recognition, or unlocking. Unattached door activity is owner-only and deleted after 7 days.</li>
      <li class="small">${MATCH_RULE_TEXT}</li>
    </ul>
    <div class="actions"><a class="btn secondary" href="https://github.com/shsllc/hearthhandoff">Source code</a><a class="btn secondary" href="/">HearthHandoff home</a></div>`;
}
