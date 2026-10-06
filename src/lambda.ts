// AWS Lambda entry point. One function, two triggers:
//   - Lambda Function URL → Hono app (web UI + Ring webhook / token exchange / account link)
//   - EventBridge Scheduler (every minute) → tick(): deadlines, Ring history polling
// Secrets (Ring credentials, APP_SECRET, ACCESS_CODE) come from AWS Secrets Manager at cold start,
// so they never sit in Lambda environment variables or the template.
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretId = process.env.SECRET_ID;
if (secretId) {
  const sm = new SecretsManagerClient({});
  const r = await sm.send(new GetSecretValueCommand({ SecretId: secretId }));
  const values = JSON.parse(r.SecretString ?? '{}') as Record<string, string>;
  for (const [k, v] of Object.entries(values)) if (typeof v === 'string' && v && !process.env[k]) process.env[k] = v;
}

// Imported after secrets are in process.env, because config reads env at module load.
const { handle } = await import('hono/aws-lambda');
const { config } = await import('./config.ts');
const { createStore } = await import('./store/index.ts');
const { Repo } = await import('./repo.ts');
const { buildApp } = await import('./app.ts');
const { tick } = await import('./worker.ts');

const repo = new Repo(await createStore(), config.retentionDays);
const http = handle(buildApp(repo));

export const handler = async (event: any, context: any) => {
  if (event?.source === 'carerelay.tick' || event?.['detail-type'] === 'Scheduled Event') {
    const summary = await tick(repo);
    console.log(JSON.stringify({ tick: summary }));
    return summary;
  }
  return http(event, context);
};
