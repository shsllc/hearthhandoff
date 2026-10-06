// Local entry point: SQLite store + in-process worker. `npm start`.
import { serve } from '@hono/node-server';
import { config, ringMode } from './config.ts';
import { createStore } from './store/index.ts';
import { Repo } from './repo.ts';
import { buildApp } from './app.ts';
import { startLocalWorker } from './worker.ts';

const repo = new Repo(await createStore(), config.retentionDays);
const app = buildApp(repo);
startLocalWorker(repo, config.workerIntervalSeconds);

serve({ fetch: app.fetch, port: config.port }, () => {
  const base = config.publicBaseUrl;
  console.log(`HearthHandoff on http://localhost:${config.port}  (store: ${repo.store.kind}, ring: ${ringMode()}, demo: ${config.demoMode})`);
  console.log('Ring portal URLs (must be public HTTPS):');
  for (const [k, p] of [['Account Link URL', '/ring/link'], ['Token Exchange URL', '/ring/token-exchange'], ['Webhook URL', '/ring/webhook'], ['App Homepage / Default Redirect URL', '/']]) {
    console.log(`  ${k.padEnd(36)} ${base}${p}`);
  }
});
