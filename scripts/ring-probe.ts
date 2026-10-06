// Calls the real Ring API with RING_ACCESS_TOKEN (Playground) and prints response *shapes*, so our
// parsers can be checked against reality. Prints no token, and redacts ids to their first characters.
// Usage: npm run ring:probe
import { config } from '../src/config.ts';
import { getMe, listDevices, deviceStatus, eventHistory, accountIdFromMe, devicesFromList, RingApiError } from '../src/ring/client.ts';
import { normalizeHistoryEvents } from '../src/ring/history.ts';

const token = config.ring.playgroundToken;
if (!token) {
  console.error('Set RING_ACCESS_TOKEN in .env (Ring Developer Playground → Generate token). Do not paste it into chat.');
  process.exit(1);
}

const redact = (v: unknown): unknown => {
  if (typeof v === 'string') return v.length > 12 ? `${v.slice(0, 10)}…(${v.length})` : v;
  if (Array.isArray(v)) return v.slice(0, 3).map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x)]));
  return v;
};
const show = (label: string, v: unknown) => console.log(`\n=== ${label}\n${JSON.stringify(redact(v), null, 2)}`);

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const r = await fn();
    show(label, r);
    return r;
  } catch (e) {
    console.log(`\n=== ${label}\nFAILED: ${e instanceof RingApiError ? `${e.status} ${e.body.slice(0, 300)}` : (e as Error).message}`);
    return undefined;
  }
}

const me = await step('GET /v1/users/me', () => getMe(token));
console.log('accountIdFromMe →', accountIdFromMe(me) ? 'found' : 'NOT FOUND (parser needs updating)');
const devs = await step('GET /v1/devices', () => listDevices(token));
const parsed = devicesFromList(devs);
console.log('devicesFromList →', parsed.map((d) => ({ id: d.id.slice(0, 14) + '…', name: d.name, kind: d.kind })));
for (const d of parsed.slice(0, 2)) {
  await step(`GET /v1/devices/{id}/status (${d.name})`, () => deviceStatus(token, d.id));
  const all = await step(`GET /v1/history/devices/{id}/events (${d.name}, all types)`, () => eventHistory(token, d.id));
  const types = new Map<string, number>();
  for (const row of (all as any)?.data ?? []) types.set(row?.attributes?.event_type, (types.get(row?.attributes?.event_type) ?? 0) + 1);
  console.log('event_type counts →', Object.fromEntries(types));
  console.log('normalizeHistoryEvents(door types) →', normalizeHistoryEvents(all, null).length, 'door event(s)');
}
