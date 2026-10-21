// Summarizes real Ring activity recorded on the deployed stack: sources, delivery lag, types, visit matches.
//   STORE=dynamodb TABLE_NAME=... AWS_PROFILE=... node scripts/ring-report.ts [householdId]
import { config } from '../src/config.ts';
import { createStore } from '../src/store/index.ts';
import { Repo } from '../src/repo.ts';
import { describeEvent } from '../src/domain/matching.ts';

const hid = process.argv[2] ?? 'hh_demo';
const repo = new Repo(await createStore(), config.retentionDays);
const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
const devices = await repo.devices(hid);
const name = new Map(devices.map((d) => [d.id, d.name]));
const real = (await repo.allEvents(hid)).filter((e) => !e.deviceId.startsWith('demo.')).sort((a, b) => a.occurredAt - b.occurredAt);

const count = (xs: string[]) => xs.reduce<Record<string, number>>((a, k) => ((a[k] = (a[k] ?? 0) + 1), a), {});
console.log('devices:', devices.filter((d) => d.origin === 'ring_app').map((d) => `${d.name}(${d.online === true ? 'online' : d.online === false ? 'offline' : '?'})`).join(', '));
console.log('real door events:', real.length, '| by source:', JSON.stringify(count(real.map((e) => e.sources.join('+')))));
console.log('types:', JSON.stringify(count(real.map((e) => describeEvent(e)))));
const lags = real.map((e) => Math.round((e.firstReceivedAt - e.occurredAt) / 1000)).sort((a, b) => a - b);
if (lags.length) console.log(`delivery lag (s): min ${lags[0]}, median ${lags[lags.length >> 1]}, max ${lags.at(-1)}`);
for (const e of real.slice(-40)) {
  console.log(`${f.format(e.occurredAt)} | ${name.get(e.deviceId) ?? '?'} | ${describeEvent(e)} | ${e.sources.join('+')} | x${e.deliveryCount}${e.attached ? ' | ATTACHED' : ''}`);
}
console.log('== visits (non-seeded)');
for (const v of (await repo.visits(hid)).filter((v) => !v.scenarioLabel)) {
  console.log(`${v.title} | ${f.format(v.windowStart)} - ${f.format(v.windowEnd)} | ${v.status} | matches ${v.matches.length} | follow-ups ${v.followups.length} ${v.followups.map((x) => x.notifiedVia.join('+')).join(';')}`);
  for (const m of v.matches) console.log('   ·', m.reason);
}
const audit = (await repo.auditLog(hid, 300)).filter((a) => /webhook|device\.|link|followup/.test(a.action));
console.log('== recent Ring/follow-up audit');
for (const a of audit.slice(0, 15)) console.log(`${f.format(a.at)} ${a.action}: ${a.detail.replace(/ava1\.ring\.account\.\S+/g, 'ava1.ring.account.…')}`);
