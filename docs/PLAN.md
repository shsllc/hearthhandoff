# HearthHandoff plan

## Product in one line
The person who lives independently (the Ring account holder) schedules visits and deliveries, picks which trusted people can see each one, and gets a clear handoff record. The record has three parts: what was planned, what Ring saw at the door (clearly labeled as such), and what the caregiver explicitly confirmed. When a visit goes unconfirmed, a designated contact gets a calm, actionable follow-up.

## Architecture: AWS-native, and still runnable locally

```
                         ┌───────────────────────── AWS (us-west-2) ─────────────────────────┐
Ring cloud ── signed ──▶ │ Lambda Function URL (HTTPS) ─▶ Lambda nodejs24.x (Hono app)       │
  webhook, auth code     │   /ring/webhook  /ring/token-exchange  /ring/link  web UI         │
Browsers (owner, ──────▶ │          │                                   │                    │
  trusted people)        │          ▼                                   ▼                    │
                         │  DynamoDB single table (TTL = retention)   Secrets Manager        │
EventBridge Scheduler ─▶ │  every minute → same Lambda: confirm-by check + Event History poll│
                         │          └─ follow-up due ─▶ Amazon SES email to the contact      │
                         └────────────────────────────────────────────────────────────────────┘
Ring Partner API (api.amazonvision.com) ◀── devices, status, Event History, app-integrations
```

| AWS service | Why the product needs it |
|---|---|
| **Lambda + Function URL** | Ring needs four stable public HTTPS endpoints, and webhooks must be answered within 5 s. A Function URL provides that with no load balancer or certificates to manage. |
| **DynamoDB** (on demand, single table) | Durable household, visit, and event state. **TTL enforces retention**: unattached door events are deleted after 7 days, webhook receipts after 7 days, the audit log after 30 days, and unclaimed Ring tokens after 15 minutes. No cleanup job can be forgotten. |
| **EventBridge Scheduler** | Lambda has no background loop. A one-minute schedule runs the confirm-by check and the Event History backstop poll. |
| **Secrets Manager** | Holds the Ring Client Secret, the HMAC signing key, the generated `APP_SECRET`, and the access code. They're read at cold start and never placed in env vars or the template. |
| **SES** | The follow-up contact isn't watching the app, so the follow-up reaches them by email. The email includes no Ring activity details. |

Everything is defined in [`infra/template.yaml`](../infra/template.yaml) (CloudFormation with the SAM transform) and deployed by `npm run deploy:aws`, which needs only the AWS CLI.

**Locally**, `npm start` runs the same code against a SQLite implementation of the same item-store contract (`src/store/`), with an in-process timer standing in for the Scheduler. Judges can run it without an AWS account.

- **Runtime:** Node 24 with native TypeScript. esbuild bundles it for Lambda (about 190 KB; the AWS SDK comes from the runtime). Hono serves both the web app and the Ring endpoints.
- **Server-side only:** Ring tokens are encrypted with AES-256-GCM under `APP_SECRET` before they reach the database.
- **Webhook handler:** verifies the HMAC on the raw bytes, then parses. Dedupe has three layers:
  1. `meta.request_id`, via a conditional put.
  2. A per-event key.
  3. Across sources: a history `ding` within ±5 s of a webhook `button_press` merges into one event.

  The handler returns 4xx only for bad signatures or bad payloads, so Ring doesn't retry junk. If processing fails, it releases the receipt and returns 5xx so Ring's retry gets processed. Verified with Function URL events, including base64-encoded bodies.
- **Delayed events:** matched on the device timestamp, not delivery time. A late event can still land on a visit that is already unconfirmed. It adds context but never resolves the visit.
- **Matching rule `match-v1`:** an event matches when it's from the same device (or any device, if none was chosen), is a doorbell press or non-vehicle motion, and falls inside the window plus grace. Each match stores the rule version and a plain-language reason, which the UI shows. See `src/domain/matching.ts`.
- **Follow-up:** only an explicit caregiver confirmation or problem report resolves a visit. Ring activity changes the wording only. Nothing is framed as an emergency, and nothing is dispatched automatically.
- **Minimization:** door events are stored as metadata only, with no media and no raw payloads. Unattached events are visible only to the owner. Caregivers see only events matched to visits they're allowed to see. An `app_integration_removed` event from Ring purges tokens and devices.
- **Deployed sign-in:** a person picker gated by a shared `ACCESS_CODE` stored in Secrets Manager. Amazon Cognito is the upgrade path if time allows.

## Smallest credible MVP (the demo)
1. The owner schedules "Afternoon visit, Dana, 2:00–3:00 PM, confirm by 3:30 PM, Front Door," visible to Dana and Sam. Sam is the follow-up contact.
2. A Ring door event arrives, either by real webhook (Tier 2) or via history/replay (Tier 1). The visit timeline shows **"Doorbell pressed · Front Door · 2:04 PM · Ring webhook (signature verified)"** with the caveat that this doesn't show who it was.
3. Dana opens her view, sees only her visits, and taps **Visit done** or **There's a problem**, adding a note if needed.
4. A second visit gets no confirmation. At confirm-by, the Scheduler tick opens a follow-up for Sam. Sam gets an email via SES and, in the app, call/text links, an "I'm checking in" button, and resolve-with-note.
5. The activity log shows every step, including duplicate and late deliveries.

## Schedule (today is Mon Oct 5; submit Thu Oct 22; Oct 23 morning is buffer)

| Day | Work | Exit check |
|---|---|---|
| Mon 10/5 | Research and feasibility. Ring verify/nonce/parse, matching, follow-ups, DynamoDB/SQLite store, owner and caregiver views, signed replay, AWS template, Lambda bundle | 21 tests green; full loop on localhost; Lambda handler verified with Function URL events ✅ |
| Tue 10/6 | Accessibility pass. DynamoDB store contract test against a real table. README/DEMO polish | |
| Wed 10/7 | `ring:probe` against the Playground. Fix the device/history parsers to match real responses. Playground token entry in the owner UI (for AWS) | Real device listed and history read; logged in the friction log |
| Thu 10/8 | **First AWS deploy:** seed DynamoDB, then run the same walkthrough on the Function URL | Scheduler tick opens a follow-up on AWS |
| Fri 10/9 | **You:** create the private Ring app and fill in Secrets Manager. **Me:** register the 4 URLs (Staging tab) and test linking | Nonce claim succeeds and the link is completed |
| Sat–Sun 10/10–11 | Tier 2 end to end: press the real doorbell, the webhook arrives at Lambda, it matches, someone confirms | Real `button_press` on the timeline |
| Mon 10/12 | SES follow-up email; verify DynamoDB TTL deletions | Email received |
| Tue 10/13 | Mobile caregiver view; keyboard and screen-reader pass | axe clean |
| Wed 10/14 | Owner controls: revoke a person, edit visibility; activity log view | Visibility tests |
| Thu 10/15 | Hardening: 5 s budget under cold start, token-expiry UI, error states | |
| Fri 10/16 | README, SETUP, DEMO script, architecture diagram | A fresh clone runs in under 5 minutes |
| Sat–Sun 10/17–18 | Video draft; product feedback; final friction log | Draft under 3:00 |
| Mon–Tue 10/19–20 | Buffer for Ring-side surprises | |
| Wed 10/21 | Final video, public repo, Devpost text | |
| **Thu 10/22** | **Submit** | Submission confirmed |
| Fri 10/23 | Emergency buffer only (deadline 12:00 PM PT) | |

## What you need to do (no secrets in chat; put values in `.env` or Secrets Manager yourself)

1. **Devpost:** register at https://amazonappdev2026.devpost.com if you haven't already, and decide whether you're entering as an individual or under QuirkWorks LLC.
2. **Amazon Developer account and identity verification:** https://developer.amazon.com/ring/console. You'll need a government photo ID, and **the full legal name on the console Company Profile must match the ID exactly.** If your existing profile is under QuirkWorks LLC, check this before you verify. You get three attempts.
3. **Playground token (Wed 10/7):** go to https://developer.amazon.com/ring/console/playground and choose *Generate token*. Put the token in `HearthHandoff/.env` as `RING_ACCESS_TOKEN=`, then tell me "token saved." It expires in 30 minutes, so do this when I'm ready to probe.
4. **Ring hardware (decides Tier 2):** do you have a Ring doorbell or camera on your account with an active Ring Protection plan or trial?
5. **AWS (needed by Wed 10/7 for the first deploy):**
   - Request the $150 hackathon credits using the form on the resources page.
   - Choose the AWS account. Create a CLI profile named `hearthhandoff` that can deploy CloudFormation, Lambda, DynamoDB, Scheduler, Secrets Manager, IAM roles, S3 (artifact bucket), and SES. Run `aws configure sso --profile hearthhandoff` (or `aws login`) **yourself**. None of your current profiles has live credentials.
   - SES in us-west-2: verify a sender address and the demo recipients. Sandbox mode only delivers to verified addresses, which is fine for the demo.
   - After the first deploy: open the stack's secret in the Secrets Manager console and fill in `ACCESS_CODE`, and later the three Ring credentials.
6. **If Tier 2 (Fri 10/9):** in the Ring console, go to *Private Apps* → *Create New App* (name: HearthHandoff). The Client ID, Client Secret, and HMAC Signing Key are shown **once**. Put them straight into the Secrets Manager entry, never into chat or git. I'll give you the four URLs for the **Staging** tab.
7. **GitHub (by 10/16):** confirm the repo name and public visibility. I'll create it with `gh` only after you say so.
8. **Video (10/17–21):** you narrate or approve the script. It must be publicly visible on YouTube.
