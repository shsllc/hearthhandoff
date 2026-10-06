import { randomBytes } from 'node:crypto';

try {
  process.loadEnvFile();
} catch {
  // No .env file; rely on the process environment.
}

const env = (k: string, d = '') => (process.env[k] ?? d).trim();

let appSecret = env('APP_SECRET');
if (!appSecret) {
  // Ephemeral secret keeps local demos working; sessions and stored tokens won't survive a restart.
  appSecret = randomBytes(32).toString('base64');
  console.warn('[config] APP_SECRET not set; using an ephemeral secret for this process.');
}

export const config = {
  port: Number(env('PORT', '3000')),
  publicBaseUrl: env('PUBLIC_BASE_URL', 'http://localhost:3000').replace(/\/$/, ''),
  appSecret,
  demoMode: env('DEMO_MODE', 'true') === 'true',
  retentionDays: Number(env('RETENTION_DAYS', '7')),
  workerIntervalSeconds: Number(env('WORKER_INTERVAL_SECONDS', '30')),
  // 'sqlite' for local runs; 'dynamodb' on AWS (set by the CloudFormation template).
  store: (env('STORE', 'sqlite') === 'dynamodb' ? 'dynamodb' : 'sqlite') as 'sqlite' | 'dynamodb',
  dbPath: env('DB_PATH', 'data/hearthhandoff.db'),
  tableName: env('TABLE_NAME', 'hearthhandoff'),
  // Shared access code required to sign in on a deployed instance. Empty means open picker (local demo only).
  accessCode: env('ACCESS_CODE'),
  ses: {
    from: env('SES_FROM'),
    region: env('SES_REGION', env('AWS_REGION', 'us-west-2')),
  },
  ring: {
    apiBase: env('RING_API_BASE', 'https://api.amazonvision.com'),
    oauthUrl: env('RING_OAUTH_URL', 'https://oauth.ring.com/oauth/token'),
    playgroundToken: env('RING_ACCESS_TOKEN'),
    clientId: env('RING_CLIENT_ID'),
    clientSecret: env('RING_CLIENT_SECRET'),
    hmacKey: env('RING_HMAC_SIGNING_KEY'),
  },
};

export type RingMode = 'app' | 'playground' | 'none';

export function ringMode(): RingMode {
  if (config.ring.clientId && config.ring.clientSecret && config.ring.hmacKey) return 'app';
  if (config.ring.playgroundToken) return 'playground';
  return 'none';
}

