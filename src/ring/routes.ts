import { Hono } from 'hono';
import { html } from 'hono/html';
import { config } from '../config.ts';
import type { Repo } from '../repo.ts';
import { parseWebhook, signWebhookBody, verifyWebhookSignature } from './webhook.ts';
import { checkNonceFreshness, matchNonce } from './nonce.ts';
import { accountIdFromMe, completeLink, confirmLink, exchangeAuthCode, getMe, storeTokens, tokenForAccount, RingApiError } from './client.ts';
import { ingestDoorEvent, applyDeviceStatus, type EventSource } from '../domain/ingest.ts';
import { syncRingDevices } from '../worker.ts';
import { page, type Viewer } from '../web/layout.ts';

/** Key used to sign local replays when no Ring app is registered yet. Never accepted on /ring/webhook. */
export const LOCAL_REPLAY_KEY = 'carerelay-local-replay-only';

export interface WebhookOutcome { status: number; body: Record<string, unknown> }

/**
 * Shared by the real Ring endpoint and the demo replay, so the replay exercises the exact verify → parse →
 * dedupe → ingest path. Only the source label differs.
 */
export async function handleWebhook(repo: Repo, raw: Uint8Array, signature: string | null, key: string, source: EventSource): Promise<WebhookOutcome> {
  if (!key) return { status: 503, body: { error: 'webhook signing key not configured' } };
  if (!verifyWebhookSignature(key, raw, signature)) {
    await repo.audit(null, source, 'webhook.rejected', 'bad or missing X-Signature');
    return { status: 401, body: { error: 'invalid signature' } };
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { status: 400, body: { error: 'invalid JSON' } };
  }
  const parsed = parseWebhook(body);
  if (parsed.kind === 'invalid') {
    await repo.audit(null, source, 'webhook.invalid', parsed.reason);
    return { status: 400, body: { error: parsed.reason } };
  }
  const requestId = parsed.kind === 'door_event' ? parsed.event.requestId
    : parsed.kind === 'device_status' ? parsed.status.requestId : parsed.requestId;

  if (requestId && !(await repo.claimReceipt(`${source}:${requestId}`))) {
    await repo.audit(null, source, 'webhook.duplicate', `request ${requestId} already processed; acknowledged without reprocessing`);
    return { status: 200, body: { status: 'duplicate', request_id: requestId } };
  }
  try {
    switch (parsed.kind) {
      case 'door_event': {
        const r = await ingestDoorEvent(repo, parsed.event, source);
        return { status: 200, body: { status: r.outcome, matched_visits: r.matchedVisitIds.length } };
      }
      case 'device_status':
        await applyDeviceStatus(repo, parsed.status);
        return { status: 200, body: { status: 'device_status_applied' } };
      case 'integration':
        if (parsed.type === 'app_integration_removed' && parsed.accountId) await unlinkAccount(repo, parsed.accountId, 'Ring user removed the integration');
        else await repo.audit(null, 'ring', parsed.type, parsed.accountId ?? '');
        return { status: 200, body: { status: 'ok' } };
      default:
        return { status: 200, body: { status: 'ignored', type: parsed.type } };
    }
  } catch (e) {
    // Let Ring retry: forget the receipt so the retry isn't treated as a duplicate.
    if (requestId) await repo.releaseReceipt(`${source}:${requestId}`);
    console.error('[webhook]', e);
    return { status: 500, body: { error: 'processing failed; retry' } };
  }
}

/** Unlink: delete tokens and devices; visit history stays with the household. */
export async function unlinkAccount(repo: Repo, accountId: string, why: string) {
  const acct = await repo.getRing(accountId);
  if (!acct) return;
  await repo.putRing({ ...acct, status: 'removed', accessSealed: '', refreshSealed: '', accessExpiresAt: 0 });
  await repo.removeUnclaimed(accountId);
  if (acct.householdId) {
    for (const d of await repo.devices(acct.householdId)) if (d.origin === 'ring_app') await repo.removeDevice(acct.householdId, d.id);
    await repo.setHouseholdRingAccount(acct.householdId, null);
  }
  await repo.audit(acct.householdId, 'ring', 'account.unlinked', why);
}

export function buildReplayPayload(opts: { deviceId: string; accountId: string | null; type: 'button_press' | 'motion_detected'; subType?: string; occurredAt: number; requestId: string }) {
  const { deviceId, type, occurredAt } = opts;
  return JSON.stringify({
    meta: { version: '1.1', time: new Date().toISOString(), request_id: opts.requestId, account_id: opts.accountId ?? 'local-replay' },
    data: {
      id: `${deviceId}_${type === 'button_press' ? 'button_press' : opts.subType ?? 'motion'}_${occurredAt}`,
      type,
      attributes: { source: deviceId, source_type: 'devices', timestamp: occurredAt, ...(type === 'motion_detected' ? { sub_type: opts.subType ?? 'motion' } : {}) },
      relationships: { devices: { links: { self: `/v1/devices/${deviceId}` } } },
    },
  });
}

export const replayKey = () => config.ring.hmacKey || LOCAL_REPLAY_KEY;
export const signReplay = (body: string) => signWebhookBody(replayKey(), body);

const maskEmail = (email: string) => {
  const [user, domain] = email.split('@');
  if (!domain) return 'u***r@carerelay.app';
  return `${user.slice(0, 1)}***${user.length > 1 ? user.slice(-1) : ''}@${domain}`;
};

export function ringRoutes(repo: Repo, getViewer: (c: any) => Promise<Viewer | null>) {
  const r = new Hono();

  // Webhook URL. Respond within 5 s; 4xx only for requests Ring should not retry.
  r.post('/webhook', async (c) => {
    const raw = new Uint8Array(await c.req.arrayBuffer());
    const out = await handleWebhook(repo, raw, c.req.header('X-Signature') ?? null, config.ring.hmacKey, 'ring_webhook');
    return c.json(out.body, out.status as any);
  });

  // Token Exchange URL. Ring POSTs a one-time authorization code (valid 60 s), server to server.
  // The inbound body format isn't documented, so accept JSON or form and log only field names.
  r.post('/token-exchange', async (c) => {
    const ctype = c.req.header('content-type') ?? '';
    let fields: Record<string, unknown> = {};
    try {
      fields = ctype.includes('json') ? await c.req.json() : Object.fromEntries(Object.entries(await c.req.parseBody()));
    } catch { /* fall through */ }
    const query = c.req.query();
    const code = [fields.code, fields.authorization_code, fields.auth_code, query.code].find((v) => typeof v === 'string' && v) as string | undefined;
    await repo.audit(null, 'ring', 'token_exchange.received', `content-type=${ctype || 'none'} fields=[${Object.keys(fields).join(',')}] query=[${Object.keys(query).join(',')}]`);
    if (!code) return c.json({ error: 'missing authorization code' }, 400);
    try {
      const tokens = await exchangeAuthCode(code);
      const accountId = accountIdFromMe(await getMe(tokens.access_token));
      if (!accountId) throw new Error('could not read account id from /v1/users/me');
      await storeTokens(repo, accountId, tokens, 'unclaimed');
      await repo.addUnclaimed(accountId);
      await repo.audit(null, 'ring', 'token_exchange.ok', `unclaimed token stored for ${accountId.slice(0, 18)}…`);
      return c.json({ status: 'ok' });
    } catch (e) {
      const msg = e instanceof RingApiError ? `${e.status} ${e.body.slice(0, 200)}` : String((e as Error).message);
      await repo.audit(null, 'ring', 'token_exchange.failed', msg);
      return c.json({ error: 'token exchange failed' }, 502);
    }
  });

  // Account Link URL. Ring redirects the user here with ?nonce=&time=. Sign-in is mandatory before matching.
  r.get('/link', async (c) => {
    const nonce = c.req.query('nonce') ?? '';
    const time = c.req.query('time') ?? '';
    const fresh = checkNonceFreshness(time);
    const viewer = await getViewer(c);
    if (!fresh.ok || !nonce) {
      return c.html(page({ title: 'Link expired', viewer, body: html`<h1>This Ring link can't be used</h1>
        <p>${fresh.ok ? 'The link is missing its security code.' : fresh.reason}. Start again from the Ring app: open the Ring App Store, go to CareRelay, and choose Connect.</p>` }), 400);
    }
    if (!viewer) return c.redirect(`/signin?next=${encodeURIComponent(`/ring/link?nonce=${nonce}&time=${time}`)}&owner_only=1`);
    if (viewer.role !== 'owner') {
      return c.html(page({ title: 'Owner required', viewer, body: html`<h1>Only the household owner can connect Ring</h1>
        <p>You're signed in as ${viewer.name}. Sign out, then sign in as the person whose Ring account this is.</p>` }), 403);
    }
    const hh = await repo.getHousehold(viewer.householdId);
    return c.html(page({ title: 'Connect Ring', viewer, body: html`
      <h1>Connect your Ring account to ${hh?.name}</h1>
      <p>CareRelay will receive doorbell presses, motion events, and online/offline status from the Ring devices you chose in the Ring app. It does not download video or images, and it cannot unlock or control anything.</p>
      <p>Each trusted person only sees door activity that falls inside visits they are part of. Activity that isn't attached to a visit is visible only to you and is deleted after ${config.retentionDays} days.</p>
      <form method="post" action="/ring/link">
        <input type="hidden" name="nonce" value="${nonce}"><input type="hidden" name="time" value="${time}">
        <div class="actions"><button type="submit">Connect Ring</button><a class="btn secondary" href="/owner">Not now</a></div>
      </form>` }));
  });

  r.post('/link', async (c) => {
    const viewer = await getViewer(c);
    if (!viewer || viewer.role !== 'owner') return c.text('Sign in as the household owner first.', 403);
    const form = await c.req.parseBody();
    const nonce = String(form.nonce ?? ''), time = String(form.time ?? '');
    const fresh = checkNonceFreshness(time);
    if (!fresh.ok) return c.html(page({ title: 'Link expired', viewer, body: html`<h1>The link expired</h1><p>${fresh.reason}. Start again from the Ring app.</p>` }), 400);
    const accountId = matchNonce(config.ring.hmacKey, time, nonce, await repo.unclaimedAccountIds());
    if (!accountId) {
      await repo.audit(viewer.householdId, viewer.id, 'ring.link_failed', 'no unclaimed Ring token matched the nonce');
      return c.html(page({ title: 'Could not connect', viewer, body: html`<h1>We couldn't match this Ring connection</h1>
        <p>The connection request didn't match a pending Ring authorization. This usually means it took more than 10 minutes. Start again from the Ring app.</p>` }), 400);
    }
    const person = await repo.getPerson(viewer.householdId, viewer.id);
    try {
      const token = await tokenForAccount(repo, accountId);
      await confirmLink(token, maskEmail(person?.email ?? ''), nonce); // → awaiting
      await completeLink(token); // → completed (mandatory)
    } catch (e) {
      const msg = e instanceof RingApiError ? `${e.status} ${e.body.slice(0, 200)}` : String((e as Error).message);
      await repo.audit(viewer.householdId, viewer.id, 'ring.link_failed', msg);
      return c.html(page({ title: 'Could not connect', viewer, body: html`<h1>Ring didn't accept the connection</h1><p>${msg}</p>` }), 502);
    }
    const acct = (await repo.getRing(accountId))!;
    await repo.putRing({ ...acct, householdId: viewer.householdId, status: 'completed', claimedAt: Date.now(), claimedBy: viewer.id });
    await repo.removeUnclaimed(accountId);
    await repo.setHouseholdRingAccount(viewer.householdId, accountId);
    await repo.audit(viewer.householdId, viewer.id, 'ring.linked', 'Ring account connected (one-way account linking)');
    const sync = await syncRingDevices(repo, viewer.householdId);
    return c.redirect(`/ring/config?flash=${encodeURIComponent('Ring connected. ' + sync.message)}`);
  });

  // Older registrations pointed here; keep it working.
  r.get('/home', (c) => c.redirect('/'));

  return r;
}
