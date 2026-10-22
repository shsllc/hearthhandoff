import { Hono, type Context } from 'hono';
import { html } from 'hono/html';
import { csrf } from 'hono/csrf';
import { getSignedCookie, setSignedCookie, deleteCookie } from 'hono/cookie';
import { timingSafeEqual } from 'node:crypto';
import { config, ringMode } from './config.ts';
import { type Repo, type Visit, newId } from './repo.ts';
import { page, type Viewer } from './web/layout.ts';
import { canActOnFollowup, matchedEvents, openFollowupsFor, peopleById, unattachedEvents, visibleVisit, visibleVisits } from './web/queries.ts';
import { eventItem, followupCard, kindLabel, sourceBadges, statusPill, visitSummary, DOOR_CAVEAT } from './web/render.ts';
import { dateTimeFormatter, epochToZonedLocal, timeFormatter, zonedLocalToEpoch } from './time.ts';
import { matchVisitAgainstEvents } from './domain/ingest.ts';
import { describeEvent, MATCH_RULE_TEXT } from './domain/matching.ts';
import { ringRoutes, handleWebhook, buildReplayPayload, signReplay, replayKey } from './ring/routes.ts';
import { syncRingDevices, tick } from './worker.ts';
import { renderDemo } from './web/demo.ts';

const COOKIE = 'cr_session';
const SESSION_DAYS = 14;

export function buildApp(repo: Repo) {
  const app = new Hono();

  async function getViewer(c: Context): Promise<Viewer | null> {
    const raw = await getSignedCookie(c, config.appSecret, COOKIE);
    if (!raw) return null;
    const [hid, pid] = String(raw).split(':');
    const p = hid && pid ? await repo.getPerson(hid, pid) : undefined;
    return p ? { id: p.id, name: p.name, role: p.role, householdId: p.householdId } : null;
  }

  const flash = (c: Context) => c.req.query('flash') ?? null;
  // A public deployment (HTTPS base URL) never offers the open person picker: it needs ACCESS_CODE.
  const signinLocked = () => config.publicBaseUrl.startsWith('https://') && !config.accessCode;
  const safeNext = (n: unknown) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : '/');

  // Form posts from our own pages only. Ring's server-to-server calls are exempt (JSON or no Origin).
  app.use('*', async (c, next) => (c.req.path.startsWith('/ring/') || c.req.path.startsWith('/internal/') ? next() : csrf()(c, next)));
  app.use('*', async (c, next) => {
    const started = Date.now();
    await next();
    // Diagnostics for Ring-facing traffic: shape only, never bodies, query values, or tokens.
    if (c.req.path.startsWith('/ring') || c.req.path === '/') {
      console.log(JSON.stringify({ ring_http: { method: c.req.method, path: c.req.path, status: c.res.status, ms: Date.now() - started,
        ctype: c.req.header('content-type') ?? null, queryKeys: Object.keys(c.req.query()), ua: c.req.header('user-agent')?.slice(0, 60) ?? null } }));
    }
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'same-origin');
    c.header('X-Frame-Options', 'DENY');
  });

  const ringPromise = () => html`
      <section class="card">
        <h2 style="margin-top:0">What HearthHandoff does with your Ring devices</h2>
        <ul>
          <li>Receives doorbell presses, motion events, and online/offline status from the devices you chose in the Ring app.</li>
          <li>Shows that activity only on visits you schedule, and only to the people you share each visit with.</li>
          <li>Treats Ring activity as "something happened at the door", never as who it was or proof that care happened.</li>
          <li>Deletes activity that isn't attached to a visit after ${config.retentionDays} days.</li>
        </ul>
        <h3>What it never does</h3>
        <ul><li>Download video or images, watch a live stream, identify people, unlock anything, or call emergency services.</li></ul>
      </section>`;

  // Public, read-only demo for judges: no sign-in, no writes.
  app.get('/demo', async (c) => c.html(page({ title: 'Demo', body: await renderDemo(repo) })));

  // App Homepage URL and Default Redirect URL (registered with Ring as the site root).
  // Signed out: public landing. Signed in: the person's home (owner household or caregiver visits).
  app.get('/', async (c) => {
    // Ring's certification checklist expects the configuration URL to "return valid JSON".
    const accept = c.req.header('accept') ?? '';
    if (accept.includes('application/json') && !accept.includes('text/html')) {
      return c.json({ app: 'HearthHandoff', developer: 'QuirkWorks', status: 'ok', setup: `${config.publicBaseUrl}/ring/config` });
    }
    const who = await getViewer(c);
    if (who) return c.redirect(who.role === 'owner' ? '/owner' : '/me');
    return c.html(page({ title: 'Home', flash: flash(c), body: html`
      <h1>HearthHandoff</h1>
      <p>A shared, consent-based record of planned visits and deliveries for someone living independently.
        The person whose home it is decides who sees each visit. The visiting caregiver confirms what happened.
        If a visit isn't confirmed in time, a chosen contact gets a calm follow-up.</p>
      ${ringPromise()}
      <div class="actions"><a class="btn" href="/demo">See the demo (no sign-in)</a><a class="btn secondary" href="/signin">Sign in</a></div>
      <p class="small muted">Developed by QuirkWorks.</p>` }));
  });

  // Post-linking setup (Ring: "custom app configuration page for post-linking setup").
  const ringSetup = async (c: Context) => {
    const who = await getViewer(c);
    if (!who) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`);
    if (who.role === 'caregiver') return c.redirect('/me');
    const hh = (await repo.getHousehold(who.householdId))!;
    const d = dateTimeFormatter(hh.timezone);
    const acct = hh.ringAccountId ? await repo.getRing(hh.ringAccountId) : undefined;
    const devices = (await repo.devices(who.householdId)).filter((x) => x.origin !== 'demo');
    const linked = acct && (acct.status === 'completed' || acct.status === 'awaiting');
    return c.html(page({ title: 'Ring setup', viewer: who, flash: flash(c), body: html`
      <h1>Ring setup</h1>
      <section class="card">
        <h2 style="margin-top:0">Connection</h2>
        ${linked ? html`<p><span class="pill ok">Connected</span> since ${acct!.claimedAt ? d(acct!.claimedAt) : 'recently'}.</p>`
          : html`<p><span class="pill warn">Not connected</span> Connect from the Ring app: Ring App Store → HearthHandoff → Connect.</p>`}
        <p class="small">To change which devices HearthHandoff can use, or to remove its access, use Ring's own page:
          <a href="https://account.ring.com/account/integrations" rel="noopener">Ring → Account → Integrations</a>.</p>
      </section>
      <section class="card">
        <h2 style="margin-top:0">Name your doors</h2>
        <p class="small muted">Visitors see these names on visit timelines, so pick names that make sense to them.</p>
        ${devices.length === 0 ? html`<p class="muted">No Ring devices yet.</p>` : devices.map((x) => html`
          <form method="post" action="/owner/devices/rename" class="row" style="align-items:end">
            <input type="hidden" name="device_id" value="${x.id}">
            <div><label for="dn-${x.id}">Name for ${x.kind ?? 'device'} (${x.online === true ? 'online' : x.online === false ? 'offline' : 'status unknown'})</label>
              <input id="dn-${x.id}" name="name" value="${x.name}" required maxlength="40"></div>
            <div style="flex:0 0 auto"><button class="secondary" type="submit">Save name</button></div>
          </form>`)}
        ${linked ? html`<form method="post" action="/owner/ring/sync"><div class="actions"><button class="secondary" type="submit">Refresh devices from Ring</button></div></form>` : ''}
      </section>
      ${ringPromise()}
      <h2>Next steps</h2>
      <div class="actions"><a class="btn" href="/owner/visits/new">Schedule the first visit</a><a class="btn secondary" href="/owner">Go to your household</a></div>` }));
  };
  app.get('/ring', ringSetup);
  app.get('/ring/config', ringSetup);

  app.route('/ring', ringRoutes(repo, getViewer));

  app.get('/healthz', (c) => c.json({ ok: true, store: repo.store.kind, ring: ringMode() }));

  // --- sign-in (demo picker; deployed instances also require ACCESS_CODE) ---
  app.get('/signin', async (c) => {
    if (signinLocked()) {
      return c.html(page({ title: 'Sign in', body: html`<h1>Sign-in isn't set up yet</h1>
        <p>This deployment has no access code. The owner needs to add <code>ACCESS_CODE</code> to the app's secret in AWS Secrets Manager.</p>` }), 503);
    }
    const ownerOnly = c.req.query('owner_only') === '1';
    const hids = await repo.householdIds();
    const groups = [];
    for (const hid of hids) {
      const hh = await repo.getHousehold(hid);
      const ppl = (await repo.people(hid)).filter((p) => !ownerOnly || p.role === 'owner');
      groups.push(html`<fieldset><legend>${hh?.name}</legend>
        ${ppl.map((p) => html`<label class="check"><input type="radio" name="who" value="${hid}:${p.id}" required> ${p.name} · ${p.role === 'owner' ? 'Household owner' : 'Trusted person'}</label>`)}
      </fieldset>`);
    }
    return c.html(page({ title: 'Sign in', flash: flash(c), body: html`
      <h1>Sign in</h1>
      ${hids.length === 0 ? html`<p>No household yet. Run <code>npm run seed</code> to create the demo household.</p>` : html`
      <form method="post" action="/signin">
        <input type="hidden" name="next" value="${safeNext(c.req.query('next'))}">
        ${groups}
        ${config.accessCode ? html`<label for="code">Access code</label><input id="code" name="code" type="password" autocomplete="current-password" required>` : ''}
        <div class="actions"><button type="submit">Continue</button></div>
        <p class="small muted">This prototype uses a person picker instead of passwords${config.accessCode ? ', protected by a shared access code' : ''}. A production build would use passkeys or email links.</p>
      </form>`}` }));
  });

  app.post('/signin', async (c) => {
    if (signinLocked()) return c.text('Sign-in is disabled until ACCESS_CODE is set in Secrets Manager.', 503);
    const form = await c.req.parseBody();
    if (config.accessCode) {
      const given = Buffer.from(String(form.code ?? ''));
      const want = Buffer.from(config.accessCode);
      if (given.length !== want.length || !timingSafeEqual(given, want)) return c.redirect('/signin?flash=' + encodeURIComponent('That access code is not right.'));
    }
    const [hid, pid] = String(form.who ?? '').split(':');
    const p = hid && pid ? await repo.getPerson(hid, pid) : undefined;
    if (!p) return c.redirect('/signin');
    await setSignedCookie(c, COOKIE, `${hid}:${pid}`, config.appSecret, {
      httpOnly: true, sameSite: 'Lax', secure: config.publicBaseUrl.startsWith('https'), path: '/', maxAge: SESSION_DAYS * 86400,
    });
    await repo.audit(hid, p.id, 'signin', p.name);
    return c.redirect(safeNext(form.next));
  });

  app.post('/signout', (c) => {
    deleteCookie(c, COOKIE, { path: '/' });
    return c.redirect('/signin');
  });

  // Everything below requires a viewer.
  const authed = new Hono<{ Variables: { viewer: Viewer } }>();
  authed.use('*', async (c, next) => {
    const v = await getViewer(c);
    if (!v) return c.redirect(`/signin?next=${encodeURIComponent(c.req.path)}`);
    c.set('viewer', v);
    await next();
  });
  const ownerOnly = async (c: Context<{ Variables: { viewer: Viewer } }>, next: () => Promise<void>) => {
    if (c.get('viewer').role !== 'owner') return c.text('Only the household owner can do this.', 403);
    await next();
  };


  authed.get('/api/changes', async (c) => c.json({ latest: await repo.latestAuditAt(c.get('viewer').householdId) }));

  // --- owner dashboard ---
  authed.get('/owner', ownerOnly, async (c) => {
    const who = c.get('viewer');
    const hh = (await repo.getHousehold(who.householdId))!;
    const t = timeFormatter(hh.timezone), d = dateTimeFormatter(hh.timezone);
    const ppl = await peopleById(repo, who.householdId);
    const nameOf = (id: string) => ppl.get(id)?.name ?? 'Someone';
    const visits = await visibleVisits(repo, who, Date.now() - 3 * 86_400_000);
    const past = (await visibleVisits(repo, who, Date.now() - 30 * 86_400_000))
      .filter((v) => v.windowEnd < Date.now() - 3 * 86_400_000).sort((a, b) => b.windowStart - a.windowStart).slice(0, 10);
    const followups = await openFollowupsFor(repo, who);
    const devices = await repo.devices(who.householdId);
    const unattached = await unattachedEvents(repo, who.householdId);
    const acct = hh.ringAccountId ? await repo.getRing(hh.ringAccountId) : undefined;
    const mode = ringMode();
    const deviceName = (id: string) => devices.find((x) => x.id === id)?.name ?? 'Ring device';

    return c.html(page({ title: 'Household', viewer: who, flash: flash(c), since: await repo.latestAuditAt(who.householdId), body: html`
      <h1>${hh.name}</h1>
      <p class="muted">You decide who sees each visit. Trusted people only see door activity that falls inside visits they're part of.</p>
      <div class="actions"><a class="btn" href="/owner/visits/new">Schedule a visit or delivery</a><a class="btn secondary" href="/owner/audit">Activity log</a></div>

      ${followups.length ? html`<h2>Needs attention</h2>${followups.map(({ visit, followup }) => followupCard(followup, visit, {
        canAct: true, contactName: nameOf(followup.contactPersonId), ackName: followup.acknowledgedBy ? nameOf(followup.acknowledgedBy) : null,
        resolvedName: followup.resolvedBy ? nameOf(followup.resolvedBy) : null, caregiverName: nameOf(visit.assignedPersonId),
        caregiverPhone: ppl.get(visit.assignedPersonId)?.phone ?? null, residentName: hh.residentName, residentPhone: null, t: d, showVisitLink: true }))}` : ''}

      <h2>Visits</h2>
      ${visits.length === 0 ? html`<p class="muted">Nothing scheduled.</p>` : visits.map((v) => visitSummary(v, nameOf(v.assignedPersonId), t, d))}
      ${past.length ? html`<details><summary>Past visits (${past.length})</summary>${past.map((v) => visitSummary(v, nameOf(v.assignedPersonId), t, d))}</details>` : ''}

      <h2>Ring connection</h2>
      <section class="card">
        ${mode === 'app' && acct?.status === 'completed' ? html`<p><span class="pill ok">Connected</span> Linked Ring account via one-way account linking.
            Real-time events arrive by signed webhook, and the Event History API is polled as a backstop.</p>`
          : mode === 'app' ? html`<p><span class="pill warn">Not linked yet</span> The HearthHandoff Ring app is registered. Connect it from the Ring app: Ring App Store → HearthHandoff → Connect.</p>`
          : mode === 'playground' ? html`<p><span class="pill info">Developer Playground</span> Using a short-lived Ring Developer Playground token (read-only, 30 minutes). Device and Event History calls go to the real Ring API, but the Playground device does not produce doorbell or motion webhooks.</p>`
          : html`<p><span class="pill plain">Not connected</span> Add a Ring Playground token or register a Ring app (see SETUP.md).</p>`}
        ${devices.length ? html`<table><thead><tr><th scope="col">Device</th><th scope="col">Status</th><th scope="col">Source</th><th scope="col">History poll</th></tr></thead><tbody>
          ${devices.map((x) => html`<tr><td>${x.name}<div class="small muted">${x.kind ?? ''}</div></td>
            <td>${x.online === true ? 'Online' : x.online === false ? html`Offline${x.offlineSince ? html` since ${d(x.offlineSince)}` : ''}` : 'Unknown'}</td>
            <td>${x.origin === 'demo' ? html`<span class="pill demo">Demo device</span>` : x.origin === 'ring_playground' ? 'Ring Playground' : 'Ring'}</td>
            <td class="small">${x.lastPollError ? html`<span class="pill bad">Error</span> ${x.lastPollError}` : x.lastPolledAt ? d(x.lastPolledAt) : '—'}</td></tr>`)}
        </tbody></table>` : html`<p class="muted">No devices yet.</p>`}
        <div class="actions">${mode !== 'none' ? html`<form method="post" action="/owner/ring/sync"><button class="secondary" type="submit">Refresh devices from Ring</button></form>` : ''}
          <a class="btn secondary" href="/ring">Ring setup and door names</a></div>
      </section>

      <h2>Door activity not attached to a visit</h2>
      <p class="small muted">Only you can see this. It is deleted after ${config.retentionDays} days. ${DOOR_CAVEAT}</p>
      ${unattached.length === 0 ? html`<p class="muted">None.</p>` : html`<ul>${unattached.map((e) => html`<li>${describeEvent(e)} · ${deviceName(e.deviceId)} · ${d(e.occurredAt)} ${sourceBadges(e.sources)}</li>`)}</ul>`}

      ${config.demoMode ? html`<h2>Demo tools</h2>
      <section class="card">
        <p>Sends a Ring-format webhook, HMAC-signed, through the same verify → parse → dedupe → match path as real Ring deliveries. It is stored and shown as <span class="pill demo">Local replay, not from Ring</span>.</p>
        <form method="post" action="/owner/demo/replay">
          <div class="row">
            <div><label for="rdev">Device</label><select id="rdev" name="device_id" required>${devices.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select></div>
            <div><label for="rtype">Event</label><select id="rtype" name="kind">
              <option value="button_press">Doorbell press</option><option value="motion_human">Motion: person</option>
              <option value="motion_motion">Motion: unclassified</option><option value="motion_vehicle">Motion: vehicle (ignored by match-v1)</option></select></div>
            <div><label for="rago">Happened how long ago (minutes)</label><input id="rago" name="minutes_ago" type="number" min="0" max="1440" value="0"></div>
          </div>
          <label class="check"><input type="checkbox" name="duplicate" value="1"> Deliver twice with the same request id (simulates a Ring retry)</label>
          <div class="actions"><button type="submit">Send replay</button></div>
        </form>
        <form method="post" action="/owner/demo/tick"><div class="actions"><button class="secondary" type="submit">Run deadline check now</button></div></form>
      </section>` : ''}
      <h2>How door activity is matched</h2><p class="small">${MATCH_RULE_TEXT}</p>
    ` }));
  });

  authed.post('/owner/ring/sync', ownerOnly, async (c) => {
    const r = await syncRingDevices(repo, c.get('viewer').householdId);
    return c.redirect('/owner?flash=' + encodeURIComponent(r.message));
  });

  authed.post('/owner/devices/rename', ownerOnly, async (c) => {
    const who = c.get('viewer');
    const form = await c.req.parseBody();
    const dev = await repo.getDevice(who.householdId, String(form.device_id ?? ''));
    const name = String(form.name ?? '').trim().slice(0, 40);
    if (!dev || !name) return c.redirect('/ring/config?flash=' + encodeURIComponent('Enter a name for the device.'));
    await repo.putDevice({ ...dev, name, nameSetByOwner: true });
    await repo.audit(who.householdId, who.id, 'device.renamed', `${dev.name} → ${name}`);
    return c.redirect('/ring/config?flash=' + encodeURIComponent(`Saved “${name}”.`));
  });

  authed.post('/owner/demo/replay', ownerOnly, async (c) => {
    if (!config.demoMode) return c.text('Demo tools are off.', 404);
    const who = c.get('viewer');
    const form = await c.req.parseBody();
    const deviceId = String(form.device_id ?? '');
    if (!(await repo.getDevice(who.householdId, deviceId))) return c.redirect('/owner?flash=' + encodeURIComponent('Pick a device first.'));
    const kind = String(form.kind ?? 'button_press');
    const minutesAgo = Math.max(0, Math.min(1440, Number(form.minutes_ago ?? 0) || 0));
    const hh = await repo.getHousehold(who.householdId);
    const body = buildReplayPayload({
      deviceId, accountId: hh?.ringAccountId ?? null, type: kind === 'button_press' ? 'button_press' : 'motion_detected',
      subType: kind.startsWith('motion_') ? kind.slice(7) : undefined, occurredAt: Date.now() - minutesAgo * 60_000, requestId: newId('replay'),
    });
    const raw = new TextEncoder().encode(body);
    const first = await handleWebhook(repo, raw, signReplay(body), replayKey(), 'local_replay');
    const second = form.duplicate ? await handleWebhook(repo, raw, signReplay(body), replayKey(), 'local_replay') : null;
    await repo.audit(who.householdId, who.id, 'demo.replay', `${kind}, ${minutesAgo} min ago → ${JSON.stringify(first.body)}${second ? ` then ${JSON.stringify(second.body)}` : ''}`);
    const msg = `Replay sent: ${String(first.body.status)}${first.body.matched_visits ? `, shown on ${first.body.matched_visits} visit(s)` : ''}${second ? `; duplicate delivery → ${String(second.body.status)}` : ''}.`;
    return c.redirect('/owner?flash=' + encodeURIComponent(msg));
  });

  authed.post('/owner/demo/tick', ownerOnly, async (c) => {
    if (!config.demoMode) return c.text('Demo tools are off.', 404);
    await tick(repo);
    return c.redirect('/owner?flash=' + encodeURIComponent('Deadline check and Ring history poll ran.'));
  });

  authed.get('/owner/audit', ownerOnly, async (c) => {
    const who = c.get('viewer');
    const hh = (await repo.getHousehold(who.householdId))!;
    const d = dateTimeFormatter(hh.timezone);
    const showAll = c.req.query('all') === '1';
    const fullLog = await repo.auditLog(who.householdId);
    // Sign-ins are routine; hidden by default so Ring and visit activity stand out.
    const log = showAll ? fullLog : fullLog.filter((a) => a.action !== 'signin');
    // Show door and people names instead of internal / Ring identifiers.
    const deviceNames = new Map((await repo.devices(who.householdId)).map((x) => [x.id, x.name]));
    const ppl = await peopleById(repo, who.householdId);
    const actorName = (a: string) => ppl.get(a)?.name ?? ({ ring: 'Ring', system: 'HearthHandoff', seed: 'Setup' } as Record<string, string>)[a] ?? a;
    const readable = (text: string) => text
      .replace(/ava1\.ring\.device\.[A-Za-z0-9]+/g, (id) => deviceNames.get(id) ?? 'a Ring device')
      .replace(/ava1\.ring\.account\.[A-Za-z0-9]+/g, 'the linked Ring account');
    return c.html(page({ title: 'Activity log', viewer: who, body: html`
      <h1>Activity log</h1><p class="muted">The last 30 days of everything HearthHandoff did for this household, including duplicate and late Ring deliveries.
        ${showAll ? html`<a href="/owner/audit">Hide sign-ins</a>` : html`Sign-ins are hidden. <a href="/owner/audit?all=1">Show everything</a>`}</p>
      <table><thead><tr><th scope="col">When</th><th scope="col">Who</th><th scope="col">What</th></tr></thead><tbody>
      ${log.map((a) => html`<tr><td class="small" style="white-space:nowrap">${d(a.at)}</td><td class="small">${actorName(a.actor)}</td><td><strong>${a.action}</strong><div class="small">${readable(a.detail)}</div></td></tr>`)}
      </tbody></table>` }));
  });

  // --- schedule a visit ---
  authed.get('/owner/visits/new', ownerOnly, async (c) => {
    const who = c.get('viewer');
    const hh = (await repo.getHousehold(who.householdId))!;
    const ppl = await repo.people(who.householdId);
    const devices = await repo.devices(who.householdId);
    const start = Math.ceil(Date.now() / 1_800_000) * 1_800_000;
    const local = (ms: number) => epochToZonedLocal(ms, hh.timezone);
    const caregivers = ppl.filter((p) => p.role === 'caregiver');
    return c.html(page({ title: 'Schedule', viewer: who, flash: flash(c), body: html`
      <h1>Schedule a visit or delivery</h1>
      <form method="post" action="/owner/visits">
        <fieldset><legend>What</legend>
          <label class="check"><input type="radio" name="kind" value="care_visit" checked> Care visit</label>
          <label class="check"><input type="radio" name="kind" value="delivery"> Delivery</label>
          <label for="title">Title</label><input id="title" name="title" required maxlength="80" value="Afternoon visit">
          <label for="notes">Notes for the visitor (optional)</label><textarea id="notes" name="notes" rows="2" maxlength="500"></textarea>
        </fieldset>
        <fieldset><legend>Who</legend>
          <label for="assigned">Who is coming</label>
          <select id="assigned" name="assigned_person_id" required>${caregivers.map((p) => html`<option value="${p.id}">${p.name}</option>`)}</select>
          <p class="small muted">They will be asked to confirm the visit or report a problem.</p>
          <p><strong>Who else can see this visit</strong></p>
          ${caregivers.map((p) => html`<label class="check"><input type="checkbox" name="viewer_ids" value="${p.id}"> ${p.name}</label>`)}
          <label for="followup">If it isn't confirmed, who should follow up?</label>
          <select id="followup" name="followup_person_id" required>${ppl.map((p) => html`<option value="${p.id}">${p.name}${p.id === who.id ? ' (you)' : ''}</option>`)}</select>
        </fieldset>
        <fieldset><legend>When (${hh.timezone})</legend>
          <div class="row">
            <div><label for="ws">Window starts</label><input id="ws" name="window_start" type="datetime-local" required value="${local(start)}"></div>
            <div><label for="we">Window ends</label><input id="we" name="window_end" type="datetime-local" required value="${local(start + 3_600_000)}"></div>
          </div>
          <label for="cb">Confirm by</label><input id="cb" name="confirm_by" type="datetime-local" required value="${local(start + 5_400_000)}">
          <p class="small muted">If there's no confirmation by then, the follow-up person gets an actionable notice. Nothing is dispatched automatically.</p>
          <div class="row">
            <div><label for="eg">Count door activity from this many minutes early</label><input id="eg" name="early_grace_min" type="number" min="0" max="240" value="15"></div>
            <div><label for="lg">…and this many minutes late</label><input id="lg" name="late_grace_min" type="number" min="0" max="240" value="30"></div>
          </div>
        </fieldset>
        <fieldset><legend>Ring device</legend>
          <label for="dev">Which door</label>
          <select id="dev" name="device_id"><option value="">Any connected device</option>${devices.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select>
        </fieldset>
        <div class="actions"><button type="submit">Schedule</button><a class="btn secondary" href="/owner">Cancel</a></div>
      </form>` }));
  });

  authed.post('/owner/visits', ownerOnly, async (c) => {
    const who = c.get('viewer');
    const hh = (await repo.getHousehold(who.householdId))!;
    const form = await c.req.parseBody({ all: true });
    const bad = (m: string) => c.redirect('/owner/visits/new?flash=' + encodeURIComponent(m));
    const ppl = await peopleById(repo, who.householdId);
    let ws: number, we: number, cb: number;
    try {
      ws = zonedLocalToEpoch(String(form.window_start), hh.timezone);
      we = zonedLocalToEpoch(String(form.window_end), hh.timezone);
      cb = zonedLocalToEpoch(String(form.confirm_by), hh.timezone);
    } catch { return bad('Please enter valid dates and times.'); }
    if (we <= ws) return bad('The window must end after it starts.');
    if (cb < ws) return bad('Confirm-by cannot be before the window starts.');
    const assigned = ppl.get(String(form.assigned_person_id));
    const followup = ppl.get(String(form.followup_person_id));
    if (!assigned || assigned.role !== 'caregiver' || !followup) return bad('Choose a visitor and a follow-up person from your household.');
    const deviceId = String(form.device_id ?? '') || null;
    if (deviceId && !(await repo.getDevice(who.householdId, deviceId))) return bad('That Ring device is not connected.');
    const rawViewers = form.viewer_ids;
    const viewerIds = (Array.isArray(rawViewers) ? rawViewers : rawViewers ? [rawViewers] : []).map(String).filter((id) => ppl.has(id));
    const grace = (v: unknown) => Math.max(0, Math.min(240, Number(v) || 0));
    const visit: Omit<Visit, 'pk' | 'sk'> = {
      id: newId('visit'), householdId: who.householdId, kind: form.kind === 'delivery' ? 'delivery' : 'care_visit',
      title: String(form.title ?? '').trim().slice(0, 80) || 'Visit', notes: String(form.notes ?? '').trim().slice(0, 500) || null,
      assignedPersonId: assigned.id, followupPersonId: followup.id, deviceId, viewerIds,
      windowStart: ws, windowEnd: we, confirmBy: cb, earlyGraceMin: grace(form.early_grace_min), lateGraceMin: grace(form.late_grace_min),
      status: 'scheduled', scenarioLabel: null, createdBy: who.id, createdAt: Date.now(), matches: [], confirmations: [], followups: [],
    };
    await repo.putVisit(visit);
    await repo.audit(who.householdId, who.id, 'visit.created',
      `${visit.title} for ${assigned.name}; visible to ${[assigned.name, ...viewerIds.map((id) => ppl.get(id)!.name)].join(', ')}; follow-up: ${followup.name}`);
    const saved = (await repo.getVisit(who.householdId, visit.id))!;
    await matchVisitAgainstEvents(repo, saved);
    return c.redirect(`/visits/${visit.id}?flash=` + encodeURIComponent('Visit scheduled.'));
  });

  authed.post('/owner/visits/:id/cancel', ownerOnly, async (c) => {
    const who = c.get('viewer');
    const v = await repo.updateVisit(who.householdId, c.req.param('id') ?? '', (v) => {
      if (v.status === 'cancelled') return false;
      v.status = 'cancelled';
      for (const f of v.followups) if (f.resolvedAt === null) { f.resolvedAt = Date.now(); f.resolvedBy = who.id; f.resolutionNote = 'Visit cancelled'; }
    });
    if (v) await repo.audit(who.householdId, who.id, 'visit.cancelled', v.title);
    return c.redirect('/owner');
  });

  // --- caregiver home ---
  authed.get('/me', async (c) => {
    const who = c.get('viewer');
    const hh = (await repo.getHousehold(who.householdId))!;
    const t = timeFormatter(hh.timezone), d = dateTimeFormatter(hh.timezone);
    const ppl = await peopleById(repo, who.householdId);
    const nameOf = (id: string) => ppl.get(id)?.name ?? 'Someone';
    const visits = await visibleVisits(repo, who, Date.now() - 2 * 86_400_000);
    const mine = visits.filter((v) => v.assignedPersonId === who.id);
    const toConfirm = mine.filter((v) => (v.status === 'scheduled' || v.status === 'unconfirmed') && Date.now() >= v.windowStart);
    const others = visits.filter((v) => !toConfirm.includes(v));
    const followups = await openFollowupsFor(repo, who);
    return c.html(page({ title: 'Your visits', viewer: who, flash: flash(c), since: await repo.latestAuditAt(who.householdId), body: html`
      <h1>Hi ${who.name}</h1>
      <p class="muted">Visits ${hh.residentName} has shared with you.</p>
      ${followups.length ? html`<h2>Follow-ups for you</h2>${followups.map(({ visit, followup }) => followupCard(followup, visit, {
        canAct: true, contactName: nameOf(followup.contactPersonId), ackName: followup.acknowledgedBy ? nameOf(followup.acknowledgedBy) : null,
        resolvedName: followup.resolvedBy ? nameOf(followup.resolvedBy) : null, caregiverName: nameOf(visit.assignedPersonId),
        caregiverPhone: ppl.get(visit.assignedPersonId)?.phone ?? null, residentName: hh.residentName,
        residentPhone: [...ppl.values()].find((p) => p.role === 'owner')?.phone ?? null, t: d, showVisitLink: true }))}` : ''}
      ${toConfirm.length ? html`<h2>Please confirm</h2>${toConfirm.map((v) => html`<div class="card visit-row"><div><h3>${v.title}</h3>
        <div class="small muted">${d(v.windowStart)}–${t(v.windowEnd)} · confirm by ${t(v.confirmBy)}</div></div>
        <a class="btn" href="/visits/${v.id}">Confirm or report</a></div>`)}` : ''}
      <h2>Upcoming and recent</h2>
      ${others.length === 0 ? html`<p class="muted">Nothing else right now.</p>` : others.map((v) => visitSummary(v, nameOf(v.assignedPersonId), t, d))}
    ` }));
  });

  // --- visit detail & actions ---
  authed.get('/visits/:id', async (c) => {
    const who = c.get('viewer');
    const v = await visibleVisit(repo, who, c.req.param('id'));
    if (!v) return c.html(page({ title: 'Not found', viewer: who, body: html`<h1>Visit not found</h1><p>It may have been removed, or it isn't shared with you.</p>` }), 404);
    const hh = (await repo.getHousehold(who.householdId))!;
    const t = timeFormatter(hh.timezone), d = dateTimeFormatter(hh.timezone);
    const ppl = await peopleById(repo, who.householdId);
    const nameOf = (id: string) => ppl.get(id)?.name ?? 'Someone';
    const devices = await repo.devices(who.householdId);
    const deviceName = (id: string | null) => (id ? devices.find((x) => x.id === id)?.name ?? 'Ring device' : 'any connected device');
    const events = await matchedEvents(repo, v);
    const isAssigned = v.assignedPersonId === who.id;
    // The visitor confirms what they did; the person whose home it is can confirm what they saw.
    const canConfirm = (isAssigned || who.role === 'owner') && (v.status === 'scheduled' || v.status === 'unconfirmed');
    const roleOf = (id: string) => (id === v.assignedPersonId ? 'visitor' : ppl.get(id)?.role === 'owner' ? 'household owner' : 'trusted person');

    type Entry = { at: number; node: unknown };
    const entries: Entry[] = [
      { at: v.windowStart, node: html`<li><strong>Visit window opens</strong> · ${t(v.windowStart)}</li>` },
      { at: v.windowEnd, node: html`<li><strong>Visit window ends</strong> · ${t(v.windowEnd)}</li>` },
      ...events.map(({ event, match }) => ({ at: event.occurredAt, node: eventItem(event, match, deviceName(event.deviceId), t) })),
      ...v.confirmations.map((cf) => ({ at: cf.at, node: html`<li class="person"><strong>${cf.outcome === 'completed' ? `${nameOf(cf.personId)} (${roleOf(cf.personId)}) confirmed the visit` : `${nameOf(cf.personId)} (${roleOf(cf.personId)}) reported a problem`}</strong> · ${t(cf.at)}
        ${cf.note ? html`<p>“${cf.note}”</p>` : ''}<p class="caveat">Confirmed by a person, in HearthHandoff.</p></li>` })),
      ...v.followups.filter((f) => f.resolvedAt && f.resolvedBy && f.resolutionNote && !v.confirmations.some((cf) => cf.personId === f.resolvedBy && Math.abs(cf.at - f.resolvedAt!) < 5000))
        .map((f) => ({ at: f.resolvedAt!, node: html`<li class="person"><strong>${nameOf(f.resolvedBy!)} (${roleOf(f.resolvedBy!)}) resolved the follow-up</strong> · ${t(f.resolvedAt!)}
          <p>“${f.resolutionNote}”</p><p class="caveat">A second-hand resolution, not a confirmation by the visitor.</p></li>` })),
      ...v.followups.map((f) => ({ at: f.createdAt, node: html`<li class="alert"><strong>Follow-up opened for ${nameOf(f.contactPersonId)}</strong> · ${t(f.createdAt)}</li>` })),
    ];
    if (events.length === 0) entries.push({ at: v.windowEnd + 1, node: html`<li class="ring"><strong>No door activity recorded near this visit</strong><p class="caveat">This is not evidence of a problem. People may use another door, motion zones may not cover them, or events may arrive late.</p></li>` });
    entries.sort((a, b) => a.at - b.at);

    return c.html(page({ title: v.title, viewer: who, flash: flash(c), since: await repo.latestAuditAt(who.householdId), body: html`
      <p><a href="/">← Back</a></p>
      <h1>${v.title}</h1>
      <p>${statusPill(v, nameOf(v.assignedPersonId))} ${v.scenarioLabel ? html`<span class="pill demo">${v.scenarioLabel}</span>` : ''}</p>
      ${canConfirm ? html`<section class="card" aria-labelledby="confirm-h"><h2 id="confirm-h" style="margin-top:0">${isAssigned ? 'How did it go?' : `Did ${nameOf(v.assignedPersonId)}'s visit happen?`}</h2>
        ${isAssigned ? '' : html`<p class="small muted">As the household owner, you can close this visit yourself. It will show as confirmed by you, not by ${nameOf(v.assignedPersonId)}.</p>`}
        <form method="post" action="/visits/${v.id}/confirm">
          <label for="cnote">Note (optional for “done”, helpful for a problem)</label>
          <textarea id="cnote" name="note" rows="2" maxlength="500"></textarea>
          <div class="actions"><button type="submit" name="outcome" value="completed">${isAssigned ? 'Visit done' : 'Yes, the visit happened'}</button>
          <button type="submit" name="outcome" value="problem" class="danger">There's a problem</button></div>
        </form></section>` : ''}

      <section class="card"><table><tbody>
        <tr><th scope="row">Type</th><td>${kindLabel(v.kind)}</td></tr>
        <tr><th scope="row">When</th><td>${d(v.windowStart)}–${t(v.windowEnd)}</td></tr>
        <tr><th scope="row">Confirm by</th><td>${d(v.confirmBy)}</td></tr>
        <tr><th scope="row">Visitor</th><td>${nameOf(v.assignedPersonId)}</td></tr>
        <tr><th scope="row">Follow-up contact</th><td>${nameOf(v.followupPersonId)}</td></tr>
        <tr><th scope="row">Door</th><td>${deviceName(v.deviceId)} (activity counted from ${v.earlyGraceMin} min early to ${v.lateGraceMin} min late)</td></tr>
        <tr><th scope="row">Shared with</th><td>${[...new Set([v.assignedPersonId, v.followupPersonId, ...v.viewerIds])].filter((id) => ppl.get(id)?.role !== 'owner').map(nameOf).join(', ')} and the household owner</td></tr>
        ${v.notes ? html`<tr><th scope="row">Notes</th><td>${v.notes}</td></tr>` : ''}
      </tbody></table></section>



      ${v.followups.map((f) => followupCard(f, v, {
        canAct: canActOnFollowup(who, v, f), contactName: nameOf(f.contactPersonId), ackName: f.acknowledgedBy ? nameOf(f.acknowledgedBy) : null,
        resolvedName: f.resolvedBy ? nameOf(f.resolvedBy) : null, caregiverName: nameOf(v.assignedPersonId),
        caregiverPhone: ppl.get(v.assignedPersonId)?.phone ?? null, residentName: hh.residentName,
        residentPhone: [...ppl.values()].find((p) => p.role === 'owner')?.phone ?? null, t: d, topLevel: true }))}

      <h2>Timeline</h2>
      <p class="small muted">Blue entries come from Ring and only show activity at the door. Green entries are what a person confirmed.</p>
      <ol class="timeline">${entries.map((e) => e.node)}</ol>

      ${who.role === 'owner' && v.status !== 'cancelled' ? html`<form method="post" action="/owner/visits/${v.id}/cancel"><div class="actions"><button class="secondary" type="submit">Cancel this visit</button></div></form>` : ''}
    ` }));
  });

  authed.post('/visits/:id/confirm', async (c) => {
    const who = c.get('viewer');
    const form = await c.req.parseBody();
    const outcome = form.outcome === 'problem' ? 'problem' : 'completed';
    const note = String(form.note ?? '').trim().slice(0, 500) || null;
    let ok = false;
    const v = await repo.updateVisit(who.householdId, c.req.param('id'), (v) => {
      const isVisitor = v.assignedPersonId === who.id;
      if ((!isVisitor && who.role !== 'owner') || (v.status !== 'scheduled' && v.status !== 'unconfirmed')) return false;
      v.confirmations.push({ id: newId('cf'), personId: who.id, outcome, note, at: Date.now() });
      v.status = outcome === 'completed' ? 'confirmed' : 'problem';
      v.closedByLabel = isVisitor ? who.name : `${who.name} (household owner)`;
      for (const f of v.followups) if (f.resolvedAt === null) { f.resolvedAt = Date.now(); f.resolvedBy = who.id; f.resolutionNote = `${who.name} confirmed after the follow-up opened`; }
      ok = true;
    });
    if (!v || !ok) return c.redirect(`/visits/${c.req.param('id')}?flash=` + encodeURIComponent('Only the visitor or the household owner can close an open visit.'));
    await repo.audit(who.householdId, who.id, outcome === 'completed' ? 'visit.confirmed' : 'visit.problem', `${v.title}${note ? `: ${note}` : ''}`);
    return c.redirect(`/visits/${v.id}?flash=` + encodeURIComponent(outcome === 'completed' ? 'Thanks. The visit is marked done.' : 'Thanks. Your problem report was shared.'));
  });

  authed.post('/visits/:id/followups/:fid/ack', async (c) => {
    const who = c.get('viewer');
    const fid = c.req.param('fid');
    const v = await repo.updateVisit(who.householdId, c.req.param('id'), (v) => {
      const f = v.followups.find((x) => x.id === fid);
      if (!f || f.acknowledgedAt || f.resolvedAt || !canActOnFollowup(who, v, f)) return false;
      f.acknowledgedAt = Date.now(); f.acknowledgedBy = who.id;
    });
    if (v) await repo.audit(who.householdId, who.id, 'followup.acknowledged', v.title);
    return c.redirect(c.req.header('Referer')?.includes('/visits/') ? `/visits/${c.req.param('id')}` : '/');
  });

  authed.post('/visits/:id/followups/:fid/resolve', async (c) => {
    const who = c.get('viewer');
    const fid = c.req.param('fid');
    const note = String((await c.req.parseBody()).note ?? '').trim().slice(0, 500);
    if (!note) return c.redirect(`/visits/${c.req.param('id')}?flash=` + encodeURIComponent('Add a short note so others know what happened.'));
    const v = await repo.updateVisit(who.householdId, c.req.param('id'), (v) => {
      const f = v.followups.find((x) => x.id === fid);
      if (!f || f.resolvedAt || !canActOnFollowup(who, v, f)) return false;
      f.resolvedAt = Date.now(); f.resolvedBy = who.id; f.resolutionNote = note;
      // Resolving closes an unconfirmed visit, labeled as second-hand so it never reads as the visitor's confirmation.
      if (v.status === 'unconfirmed' && v.followups.every((x) => x.resolvedAt)) {
        v.status = 'resolved';
        v.closedByLabel = who.role === 'owner' ? `${who.name} (household owner)` : `${who.name} (follow-up contact)`;
      }
    });
    if (v) await repo.audit(who.householdId, who.id, 'followup.resolved', `${v.title}: ${note}`);
    return c.redirect(`/visits/${c.req.param('id')}?flash=` + encodeURIComponent('Follow-up resolved.'));
  });

  app.route('/', authed);
  return app;
}
