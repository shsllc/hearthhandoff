# Product feedback (Devpost submission draft)

> Draft as of 2026-10-06. Sections marked **[pending]** are filled in only after we've exercised them against a real Ring account.

## Which developer tools, APIs and SDKs did you use, and for what?
- **Ring Partner API** (`api.amazonvision.com`):
  - One-way account linking: Token Exchange URL, HMAC nonce, `POST` + `PATCH /v1/accounts/me/app-integrations`.
  - `GET /v1/users/me`, to read the account ID over a trusted channel.
  - `GET /v1/devices` and `/status`, for the door picker and online/offline context.
  - `GET /v1/history/devices/{id}/events`, as a backstop poll.
  - Signed **webhooks** (`button_press`, `motion_detected`, `device_*`, `app_integration_*`) as the primary event source.
- **Ring Developer Console**: private app (Cameras and Doorbells scope), staging account linking settings, Connect.
- **Ring developer docs and the `ring-api-helloworld` sample**: as a reference. We wrote our own webhook verification from the API reference (see friction log #1–2).
- **Ring Appstore Knowledge MCP server**: documentation lookups from the coding assistant.
- **AWS**:
  - Lambda (Node 24) behind an API Gateway HTTP API custom domain.
  - DynamoDB, with TTL as our data-retention mechanism.
  - EventBridge Scheduler for confirm-by deadlines and the history poll.
  - Secrets Manager for Ring credentials.
  - SES for follow-up emails.
  - ACM for TLS.
  - CloudFormation/SAM for deployment.

## What worked well?
- **The webhook contract is precise once you find it.** It specifies HMAC over raw bytes, a hex `sha256=` prefix, `meta.request_id` for idempotency, an explicit retry schedule and a dead-letter queue. Our verifier matched Ring's Python reference byte for byte on the first try.
- **One-way account linking is a thoughtful design.** Ring releases tokens up front, the nonce binds them to the right user, and the docs explain *why* each step exists, which made it easy to implement correctly and to test (`test/linking.test.ts`).
- **Event History's `event_types` filter** (`ding,motion.human`) and its "only events after consent" rule are clear and privacy-respecting.
- **Private apps** (no certification, up to 10 accounts) are the right on-ramp for a hackathon.
- **[pending]** Live webhook latency and reliability with a real camera and doorbell.

## What needs work?
Full detail with expected vs. actual results is in [FRICTION_LOG.md](FRICTION_LOG.md).
1. **The official sample contradicts the API reference** on webhook authentication (Bearer token vs. HMAC `X-Signature`). Its event enum also omits `button_press`. Copying the canonical starter yields an insecure or broken webhook.
2. **"Log in with Ring" in the portal doesn't trigger partner account linking**, although FAQ Q16 says it does. Only the Ring mobile app's App Store flow calls the Token Exchange and Account Link URLs, and it requires a US-located device. We lost debugging time to a backend that was working correctly.
3. **The Token Exchange request Ring sends us is undocumented**: content type, field names, and whether it's signed.
4. **The no-device path doesn't produce door events.** The Playground simulates Package, Vehicle and Motion, but those events don't reach Event History or partner webhooks. The "sandbox with synthetic devices" in the glossary isn't explained anywhere.
5. **Docs discoverability.** The sample's links to `notifications.html` and `authentication.html` 404, and the reference is a single page of about 1 MB.
6. **Motion `sub_type` depends on Smart Alerts settings**, which no API exposes.

## How was your onboarding experience?
- Registration and private-app creation were quick. Credentials are shown once with a clear warning.
- Most of the time went into reconciling the sample, the FAQ and forum answers with the API reference, not into writing code. We built and tested the full integration against the documented shapes first, then verified against a real account.

## Would you build with these devices and services again?
Yes. The webhook and linking model fits caretaking use cases well because it's metadata-only and consent-gated. With the documentation gaps above closed (a single source of truth, a sample that matches the reference, and a simulator that emits real webhook events), onboarding would take hours, not days.
