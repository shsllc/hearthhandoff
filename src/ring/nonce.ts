// One-way account linking nonce.
// Spec: nonce = base64url_nopad(HMAC-SHA256(K_hmac, "<time_ms>:<account_id>")), valid for 600 s.
// Webhooks use hex with the same key; nonces use URL-safe Base64. Do not mix them.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const NONCE_WINDOW_MS = 600_000;

export function computeNonce(hmacKey: string, timeMs: string | number, accountId: string): string {
  return createHmac('sha256', hmacKey).update(`${timeMs}:${accountId}`).digest('base64url');
}

export function checkNonceFreshness(timeParam: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (!/^\d{10,16}$/.test(timeParam)) return { ok: false, reason: 'time must be epoch milliseconds' };
  const delta = now - Number(timeParam);
  if (delta < 0) return { ok: false, reason: 'link time is in the future' };
  if (delta > NONCE_WINDOW_MS) return { ok: false, reason: 'link request expired (older than 10 minutes)' };
  return { ok: true };
}

/** Returns the account id whose recomputed nonce matches, comparing in constant time. */
export function matchNonce(
  hmacKey: string,
  timeParam: string,
  receivedNonce: string,
  candidateAccountIds: string[],
): string | null {
  const received = Buffer.from(receivedNonce);
  for (const accountId of candidateAccountIds) {
    const expected = Buffer.from(computeNonce(hmacKey, timeParam, accountId));
    if (expected.length === received.length && timingSafeEqual(expected, received)) return accountId;
  }
  return null;
}
