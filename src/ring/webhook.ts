// Ring webhook verification and normalization.
// Spec: https://developer.amazon.com/docs/ring/api-documentation.html (Notifications)
//   - Header `X-Signature: sha256=<hex>` = HMAC-SHA256(signing key, raw body bytes).
//   - Verify before parsing; never re-serialize the JSON.
//   - `meta.request_id` is the documented idempotency key. Ring retries 5xx/timeouts up to 7 attempts.
import { createHmac, timingSafeEqual } from 'node:crypto';

export function signWebhookBody(signingKey: string, rawBody: Uint8Array | string): string {
  return 'sha256=' + createHmac('sha256', signingKey).update(rawBody).digest('hex');
}

export function verifyWebhookSignature(
  signingKey: string,
  rawBody: Uint8Array | string,
  header: string | null | undefined,
): boolean {
  if (!signingKey || !header) return false;
  const received = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = createHmac('sha256', signingKey).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, 'hex'));
}

/** The door-relevant subset of Ring activity HearthHandoff stores. Anything else is acknowledged and dropped. */
export type DoorEventType = 'button_press' | 'motion';

export interface NormalizedDoorEvent {
  ringEventId: string | null;
  requestId: string | null;
  accountId: string | null;
  deviceId: string;
  type: DoorEventType;
  /** Open vocabulary from Ring (motion, human, vehicle, package_delivery, other_motion, ...). Null for button presses. */
  subType: string | null;
  occurredAt: number; // epoch ms, from the device timestamp, not delivery time
}

export interface NormalizedDeviceStatus {
  requestId: string | null;
  accountId: string | null;
  deviceId: string;
  kind: 'device_online' | 'device_offline' | 'device_added' | 'device_removed';
  occurredAt: number;
}

export type ParsedWebhook =
  | { kind: 'door_event'; event: NormalizedDoorEvent }
  | { kind: 'device_status'; status: NormalizedDeviceStatus }
  | { kind: 'integration'; type: string; accountId: string | null; requestId: string | null }
  | { kind: 'ignored'; type: string; requestId: string | null }
  | { kind: 'invalid'; reason: string };

function toEpochMs(value: unknown, fallbackIso: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
    const d = Date.parse(value);
    if (!Number.isNaN(d)) return d;
  }
  if (typeof fallbackIso === 'string') {
    const d = Date.parse(fallbackIso);
    if (!Number.isNaN(d)) return d;
  }
  return null;
}

export function parseWebhook(body: unknown): ParsedWebhook {
  if (!body || typeof body !== 'object') return { kind: 'invalid', reason: 'body is not an object' };
  const { meta, data } = body as { meta?: any; data?: any };
  if (!meta || !data || typeof data.type !== 'string') {
    return { kind: 'invalid', reason: 'missing meta/data/type (expected Ring webhook v1.1 shape)' };
  }
  const requestId = typeof meta.request_id === 'string' ? meta.request_id : null;
  const accountId = typeof meta.account_id === 'string' ? meta.account_id : null;
  const attrs = data.attributes ?? {};
  const type: string = data.type;

  if (type === 'app_integration_added' || type === 'app_integration_removed') {
    return { kind: 'integration', type, accountId, requestId };
  }

  const deviceId = typeof attrs.source === 'string' ? attrs.source : null;
  const occurredAt = toEpochMs(attrs.timestamp, meta.time);

  if (type === 'button_press' || type === 'motion_detected') {
    if (!deviceId) return { kind: 'invalid', reason: `${type} without attributes.source` };
    if (occurredAt === null) return { kind: 'invalid', reason: `${type} without a usable timestamp` };
    return {
      kind: 'door_event',
      event: {
        ringEventId: typeof data.id === 'string' ? data.id : null,
        requestId,
        accountId,
        deviceId,
        type: type === 'button_press' ? 'button_press' : 'motion',
        subType: type === 'motion_detected' && typeof attrs.sub_type === 'string' ? attrs.sub_type : null,
        occurredAt,
      },
    };
  }

  if (type === 'device_online' || type === 'device_offline' || type === 'device_added' || type === 'device_removed') {
    if (!deviceId) return { kind: 'invalid', reason: `${type} without attributes.source` };
    return {
      kind: 'device_status',
      status: { requestId, accountId, deviceId, kind: type, occurredAt: occurredAt ?? Date.now() },
    };
  }

  // subscription_* and future types: acknowledge, do not store.
  return { kind: 'ignored', type, requestId };
}
