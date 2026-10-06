# HearthHandoff

**A consent-based caregiver handoff for someone living independently.**
The person who owns the Ring account schedules visits and deliveries and chooses which trusted people can see each one. Ring door events appear on a clearly labeled timeline. The visiting caregiver explicitly confirms the visit or reports a problem. If nobody confirms by a set time, a designated contact gets a calm, actionable follow-up.

Built for **Build, Ship, Shape: Amazon Developer Hackathon 2026**, Ring track, using AWS Lambda, DynamoDB, EventBridge Scheduler, Secrets Manager, and SES.

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

Then follow the walkthrough in [docs/DEMO.md](docs/DEMO.md). Run `npm test` for the 36 unit and end-to-end tests. They cover signature vectors from Ring's own reference code, the full one-way account-linking flow against a fake Ring server, deduplication, late events, visibility, CSRF, deadlines, and the store contract. `npm run test:aws` (with `DYNAMO_TEST_TABLE`) runs that contract against real DynamoDB, and `npm run smoke:aws` checks Scheduler → Lambda → DynamoDB → SES on the deployed stack.

## Ring integration
| Path | What's real |
|---|---|
| Registered Ring app (private or staging) | One-way account linking (token exchange, nonce claim, `POST`+`PATCH /v1/accounts/me/app-integrations`). HMAC-verified `button_press` / `motion_detected` webhooks. Event History backstop polling |
| Ring Developer Playground token | Real calls to `/v1/users/me`, `/v1/devices`, device status, and Event History against Ring's virtual device |
| Local signed replay (demo only) | Documented-format payload, HMAC-signed, run through the same verifier and pipeline. Labeled **"Local replay, not from Ring"** everywhere it appears |

Evidence, gaps, and assumptions are in [docs/FEASIBILITY.md](docs/FEASIBILITY.md). Developer-experience friction is in [docs/FRICTION_LOG.md](docs/FRICTION_LOG.md).

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
