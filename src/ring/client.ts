// Ring Partner API client. Server-side only; tokens never reach the browser.
import { config, ringMode } from '../config.ts';
import type { Repo, RingAccount } from '../repo.ts';
import { seal, unseal } from '../secrets.ts';

export class RingApiError extends Error {
  status: number;
  body: string;
  constructor(status: number, body: string, path: string) {
    super(`Ring API ${status} on ${path}: ${body.slice(0, 300)}`);
    this.status = status;
    this.body = body;
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

async function oauth(params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(config.ring.oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...params, client_id: config.ring.clientId, client_secret: config.ring.clientSecret }),
  });
  const text = await res.text();
  if (!res.ok) throw new RingApiError(res.status, text, 'oauth/token');
  return JSON.parse(text) as TokenResponse;
}

export const exchangeAuthCode = (code: string) => oauth({ grant_type: 'authorization_code', code });
const refresh = (refreshToken: string) => oauth({ grant_type: 'refresh_token', refresh_token: refreshToken });

export async function ringFetch(token: string, path: string, init: RequestInit = {}): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(config.ring.apiBase + path, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(init.headers ?? {}) },
    });
    if (res.status === 429 && attempt < 3) {
      const wait = Number(res.headers.get('Retry-After') ?? '1') * 1000 * 2 ** attempt;
      await new Promise((r) => setTimeout(r, Math.min(wait, 10_000)));
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new RingApiError(res.status, text, path);
    return text ? JSON.parse(text) : null;
  }
}

/** Stores freshly issued tokens. Ring rotates refresh tokens, so both are replaced together. */
export async function storeTokens(repo: Repo, accountId: string, t: TokenResponse, status: RingAccount['status']) {
  const prev = await repo.getRing(accountId);
  await repo.putRing({
    accountId, householdId: prev?.householdId ?? null,
    accessSealed: seal(t.access_token), refreshSealed: seal(t.refresh_token),
    accessExpiresAt: Date.now() + t.expires_in * 1000, scope: t.scope ?? null,
    status: prev && prev.status !== 'removed' ? prev.status : status,
    createdAt: prev?.createdAt ?? Date.now(), claimedAt: prev?.claimedAt ?? null, claimedBy: prev?.claimedBy ?? null,
  });
}

/** Access token for a linked account. Refreshes 5 minutes early. */
export async function tokenForAccount(repo: Repo, accountId: string): Promise<string> {
  const row = await repo.getRing(accountId);
  if (!row || row.status === 'removed') throw new Error(`no Ring tokens for ${accountId}`);
  if (row.accessExpiresAt - Date.now() > 5 * 60_000) return unseal(row.accessSealed);
  const t = await refresh(unseal(row.refreshSealed));
  await storeTokens(repo, accountId, t, row.status);
  return t.access_token;
}

export interface HouseholdRingAccess {
  mode: 'app' | 'playground';
  accountId: string | null;
  token: string;
}

/** Picks the Ring credential a household should use: its linked account, else the Playground token. */
export async function accessForHousehold(repo: Repo, householdId: string): Promise<HouseholdRingAccess | null> {
  if (ringMode() === 'app') {
    const h = await repo.getHousehold(householdId);
    const acct = h?.ringAccountId ? await repo.getRing(h.ringAccountId) : undefined;
    if (acct && (acct.status === 'awaiting' || acct.status === 'completed')) {
      return { mode: 'app', accountId: acct.accountId, token: await tokenForAccount(repo, acct.accountId) };
    }
  }
  if (config.ring.playgroundToken) return { mode: 'playground', accountId: null, token: config.ring.playgroundToken };
  return null;
}

// --- Thin endpoint wrappers (paths from the Ring API reference) ---
export const getMe = (token: string) => ringFetch(token, '/v1/users/me');
export const listDevices = (token: string) => ringFetch(token, '/v1/devices');
export const deviceStatus = (token: string, id: string) => ringFetch(token, `/v1/devices/${encodeURIComponent(id)}/status`);
export const eventHistory = (token: string, id: string, eventTypes?: string) =>
  ringFetch(token, `/v1/history/devices/${encodeURIComponent(id)}/events${eventTypes ? `?event_types=${encodeURIComponent(eventTypes)}` : ''}`);
export const confirmLink = (token: string, accountIdentifier: string, nonce: string) =>
  ringFetch(token, '/v1/accounts/me/app-integrations', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account_identifier: accountIdentifier, nonce }),
  });
export const completeLink = (token: string) =>
  ringFetch(token, '/v1/accounts/me/app-integrations', {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed' }),
  });

/** Extracts the account id from /v1/users/me without assuming one exact JSON:API nesting. */
export function accountIdFromMe(me: any): string | null {
  const candidates = [me?.data?.id, me?.data?.attributes?.account_id, me?.account_id, me?.id];
  return candidates.find((c) => typeof c === 'string' && c.length > 0) ?? null;
}

export interface RingDeviceSummary { id: string; name: string; kind: string | null }

export function devicesFromList(body: any): RingDeviceSummary[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  return rows
    .map((d) => ({
      id: String(d?.id ?? ''),
      name: String(d?.attributes?.name ?? d?.attributes?.description ?? d?.name ?? 'Ring device'),
      // `type` at the top level is the JSON:API resource type ("devices"), not the device kind.
      kind: (d?.attributes?.kind ?? d?.attributes?.device_type ?? d?.attributes?.type ?? null) as string | null,
    }))
    .filter((d) => d.id);
}
