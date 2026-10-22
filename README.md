# HearthHandoff

**A consent-based caregiver handoff for someone living independently.**
The person who owns the Ring account schedules visits and deliveries and chooses which trusted people can see each one. Ring door events appear on a clearly labeled timeline. The visiting caregiver explicitly confirms the visit or reports a problem. If nobody confirms by a set time, a designated contact gets a calm, actionable follow-up.

Built for **Build, Ship, Shape: Amazon Developer Hackathon 2026**, Ring track, using AWS Lambda, DynamoDB, EventBridge Scheduler, Secrets Manager, and SES.

**Try it without signing in:** https://hearthhandoff.quirkworksllc.com/demo (read-only, fictional household, with aggregate proof from a real Ring account).

**Demo video (2:16):** https://youtu.be/_V57VzUkBcY

## Verified on real Ring hardware (2026-10-13 to 10-21)
- One-way account linking completed against a real Ring account through a private app: token exchange → nonce claim after sign-in → `POST`/`PATCH /v1/accounts/me/app-integrations` → signed `app_integration_added` webhook.
- **103 real motion events** from two Ring cameras. 92 arrived by HMAC-verified webhook (median delay about 1 s), and each was also confirmed by the Event History API and merged into one entry. 11 were found only by the history backstop. 77 were classified by Ring as a person.
- A real 4:00–5:30 PM visit matched the leaving and returning activity. With no confirmation, it opened a follow-up at the confirm-by time.
- Not yet exercised on hardware: `button_press` (the doorbell was offline). It's covered by tests built on Ring's documented payload.

## What HearthHandoff will and won't claim
- Door activity is shown as *"Ring recorded activity at the door. This does not show who it was or whether care happened."*
- Only a person's explicit confirmation resolves a visit.
- No door activity is never treated as an emergency, and nothing is dispatched automatically.
- No unlocking, no visitor identification, no video or images, no health inference.

## Run it locally (about 2 minutes, no AWS or Ring account needed)
Requires Node.js 24+.

```bash
npm install
cp .env.example .env        # optional: set APP_SECRET
npm run seed                # fictional demo household: June (owner), Dana, Sam, Priya
npm start                   # http://localhost:3000
```

Then follow the walkthrough in [docs/DEMO.md](docs/DEMO.md). Run `npm test` for the 39 unit and end-to-end tests. They cover signature vectors from Ring's own reference code, the full one-way account-linking flow against a fake Ring server, deduplication, late events, visibility, CSRF, deadlines, and the store contract. `npm run test:aws` (with `DYNAMO_TEST_TABLE`) runs that contract against real DynamoDB, and `npm run smoke:aws` checks Scheduler → Lambda → DynamoDB → SES on the deployed stack.

## Ring integration
| Path | What's real |
|---|---|
| Registered Ring app (private) | **Verified live.** One-way account linking (token exchange, nonce claim, `POST`+`PATCH /v1/accounts/me/app-integrations`). HMAC-verified `motion_detected` webhooks (and `button_press`, per the documented payload). Event History backstop polling past a per-device high-water mark. Webhook and history copies merged within 30 s |
| Ring Developer Playground token | Real calls to `/v1/users/me`, `/v1/devices`, device status, and Event History against Ring's virtual device |
| Local signed replay (demo only) | Documented-format payload, HMAC-signed, run through the same verifier and pipeline. Labeled **"Local replay, not from Ring"** everywhere it appears |

Evidence, gaps, and assumptions are in [docs/FEASIBILITY.md](docs/FEASIBILITY.md). **Connecting a private app:** after *Log in with Ring* in the developer console, open the Ring Appstore → **Staging Apps** → your app → **Connect**. The console button alone doesn't call your URLs (see the friction log). Developer-experience friction is in [docs/FRICTION_LOG.md](docs/FRICTION_LOG.md).

## Deploy to AWS
```bash
AWS_PROFILE=<your profile> npm run deploy:aws        # see docs/SETUP.md for SES_FROM / CUSTOM_DOMAIN
STORE=dynamodb TABLE_NAME=<from output> AWS_PROFILE=<your profile> npm run seed
```
The script prints the four URLs to register in the Ring Developer Console. Then add the Ring credentials and an `ACCESS_CODE` to the stack's Secrets Manager entry. Architecture and rationale are in [docs/PLAN.md](docs/PLAN.md).

## Layout
```
src/ring/        webhook verification + parsing, account-link nonce, API client, history normalizer, Ring routes
src/domain/      match-v1 rule, deadline/follow-up decision, ingestion (dedupe, merge, retention)
src/store/       item-store contract; DynamoDB and SQLite implementations
src/web/         server-rendered, accessible views
src/lambda.ts    AWS entry (Function URL + EventBridge Scheduler tick)
src/server.ts    local entry
infra/           CloudFormation/SAM template
```

## License
MIT
