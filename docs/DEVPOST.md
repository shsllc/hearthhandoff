# Devpost submission text (draft)

> Fill-in markers: **[verify]** lines must be confirmed against real Ring data before submitting.

## Name
HearthHandoff

## Tagline
A consent-based handoff record for people who live independently and the small circle who checks in on them.

## Inspiration
When someone lives on their own, a few people quietly share the work of showing up: a paid caregiver, a neighbor, a grown child two states away. The weak point is the handoff. Did the afternoon visit happen? Is anyone checking on it? Today that lives in group texts and assumptions. Ring cameras already see the door, but "motion at 2:04 PM" isn't the same as "Dana was here and Mom is fine." We wanted something that uses Ring's signal honestly, without overclaiming.

## What it does
- **The person whose home it is stays in charge.** They schedule visits and deliveries, choose who can see each one, and pick who follows up if something isn't confirmed.
- **Ring door events land on the visit timeline** through Ring's signed webhooks and Event History API. Every event is labeled for what it is: *"Ring recorded activity at the door. This does not show who it was or whether care happened."* Each match cites an auditable rule (`match-v1`) and its exact reason.
- **Only a person closes a visit.** The visiting caregiver taps *Visit done* or *There's a problem*, with an optional note.
- **Calm follow-ups, not alarms.** If nobody confirms by the confirm-by time, the designated contact gets an in-app notice and an email (Amazon SES), with call/text shortcuts. When Ring saw no activity, we say why that can be normal. Nothing is ever dispatched automatically.
- **Privacy by design.** Metadata only: no video, no images, no face or identity recognition, no unlocking. Door activity not attached to a visit is visible only to the owner and is deleted after 7 days (DynamoDB TTL). Unlinking in Ring purges tokens and devices.

## How we built it
- **Ring Partner API, private app with one-way account linking:** Token Exchange URL, HMAC nonce matching after a mandatory sign-in, then `POST` and `PATCH /v1/accounts/me/app-integrations`. Device discovery and status. Event History polling as a backstop. HMAC-verified webhooks (`motion_detected`, `button_press`, `device_*`, `app_integration_*`), deduplicated on `meta.request_id` and merged across sources. Late deliveries are placed by when they happened.
- **AWS:**
  - Lambda (Node 24) behind an API Gateway HTTP API on a custom domain with an ACM certificate.
  - DynamoDB single table, using TTL as the retention mechanism.
  - EventBridge Scheduler: a one-minute tick for deadlines and history polling.
  - Secrets Manager for Ring credentials, read at cold start.
  - SES for follow-up email.
  - Everything is defined in one CloudFormation/SAM template and deployed with the AWS CLI.
- **Runs locally with zero setup** (SQLite behind the same storage contract) so judges can try it without accounts.
- **36 automated tests:**
  - webhook signatures checked against Ring's own reference vectors
  - the full account-linking flow against a fake Ring server
  - dedupe, late events, visibility, CSRF, and deadlines
  - a storage contract that runs against real DynamoDB

  An AWS smoke test exercises Scheduler → Lambda → DynamoDB → SES.
- **Accessibility:** WCAG 2.1 AA in light and dark mode (axe-core), phone-first caregiver view, plain-language copy.

## Challenges we ran into
The hardest part was Ring onboarding, not the code. Highlights from our 13-entry friction log:
- The official starter sample verifies webhooks differently from the API reference.
- The portal's *Log in with Ring* only registers a test account. Real partner linking starts from a **"Staging Apps"** section of the Ring Appstore that the docs never mention.
- The Token Exchange request format is undocumented. We logged it live: form-encoded `code` and `client_id`.

## Accomplishments that we're proud of
- **Real Ring linking end to end:** token exchange, nonce claim, completed integration, and a signed `app_integration_added` webhook against a real Ring account with real cameras.
- **[verify]** A real motion event from the owner's camera matched onto a scheduled visit.
- A product that says exactly what the data can and can't prove.

## What we learned
Ring's metadata-only, consent-gated model is a strong fit for caretaking. The trust problem is in the wording, so we treated copy ("not proof of who it was") as a first-class feature.

## What's next for HearthHandoff
- Passkey sign-in (replacing the demo picker).
- Per-person notification preferences and SMS.
- Optional Ring contact sensors once they leave early access.
- A public Ring Appstore listing.

## Built with
ring-partner-api, aws-lambda, amazon-api-gateway, amazon-dynamodb, amazon-eventbridge-scheduler, aws-secrets-manager, amazon-ses, aws-certificate-manager, aws-cloudformation, node.js, typescript, hono, sqlite

## Links
- App: https://hearthhandoff.quirkworksllc.com
- Repo: **[pending: public GitHub repo]**
- Video: **[pending: YouTube]**
