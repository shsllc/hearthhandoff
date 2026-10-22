# Feasibility and Ring API access

> **Status 2026-10-22: Tier 2 achieved.** A real Ring account is linked through a private app, and real signed webhooks and Event History polling are live. In a week: 103 real motion events, 92 by webhook with a median delay of about 1 s, and a real visit matched and followed up. The no-device "Tier 1" path below remains for anyone running the code without hardware. What we learned that the docs don't say is in [FRICTION_LOG.md](FRICTION_LOG.md) (entries 9–13).

Checked 2026-10-05. **D** = documented by Amazon/Ring. **R** = reported by other hackathon entrants (not yet verified by us). **A** = our assumption, still to test.

## Hackathon constraints (D)
Source: [Official rules](https://amazonappdev2026.devpost.com/rules), [resources](https://amazonappdev2026.devpost.com/resources), [announcement](https://community.amazondeveloper.com/t/build-ship-shape-amazon-developer-hackathon/29099)

- Deadline **2026-10-23 12:00 PM PT**. Judging Nov 9–20.
- Ring track: "a working app or new feature that utilizes Ring APIs, SDKs, simulators, or devices, demonstrated through a simulator or an actual device." Caretaking and accessibility are listed priority areas.
- Submit: a video under 3 minutes (public on YouTube or Vimeo), a GitHub repo (public with an OSS license, or private and shared with testing@devpost.com), a text description, and product feedback.
- An optional **friction log** earns up to a **+10%** score bonus. We keep one in [FRICTION_LOG.md](FRICTION_LOG.md).
- Judging criteria, equally weighted: Tech implementation, Design, Potential impact, Quality of idea.
- **AWS Builder mini challenge:** any primary-track project that incorporates AWS services with documented integrations. Prize: $5k cash plus $5k credits. You can request $150 in AWS credits through the form on the resources page.
- Judges may judge from the video and description alone, so the video has to show the real Ring path working.

## What Ring actually offers

| Capability | Status | Evidence |
|---|---|---|
| Base API `https://api.amazonvision.com`, OAuth `https://oauth.ring.com/oauth/token` | D | [API docs](https://developer.amazon.com/docs/ring/api-documentation.html) |
| Webhook events: `button_press`, `motion_detected` (`attributes.sub_type`: `motion`, or with Smart Alerts on `human`, `vehicle`, `package_delivery`, `other_motion`), `device_online/offline/added/removed`, `app_integration_added/removed`, `subscription_*` | D | API docs › Notifications. Sub-type list clarified in the [2026-10-05 release note](https://developer.amazon.com/docs/ring/release-notes.html) |
| Webhook auth: `X-Signature: sha256=<hex HMAC-SHA256(signing key, raw body)>` | D | API docs › Webhook Authentication. Our implementation matches Ring's Python reference byte-for-byte (`test/ring.test.ts`) |
| Retries: 5xx or timeout over 5 s triggers retries (7 attempts over about 1 h 13 m), then a dead-letter queue for 72 h. Dedupe on `meta.request_id` | D | API docs › Retry Logic |
| Event History `GET /v1/history/devices/{id}/events`: `ding`, `motion[.human/.vehicle/.animal/.other_motion]`, `on_demand`. Newest first, cursor paging. **Only events after the user's consent** | D | API docs › Event History |
| Webhook URL "required even if you plan to poll". Event History is the documented polling alternative | D | API docs › Partner-Initiated OAuth › API polling alternative |
| One-way account linking: Ring POSTs the auth code to our Token Exchange URL (code valid 60 s). We exchange it, call `GET /v1/users/me` for the account ID, user signs in on our Account Link page, we match `nonce=base64url(HMAC(key,"time:account_id"))` within 600 s, then `POST` + `PATCH {status:"completed"}` `/v1/accounts/me/app-integrations` | D | API docs › Account Linking Flow |
| Access token about 4 h, refresh token about 30 days | D | API docs › Authentication |
| **Private apps**: Configure → Build → Connect. No certification. Visible to up to 10 Ring accounts you authorize | D | [Developer FAQ](https://developer.amazon.com/docs/ring/developer-faq.html) Q15, [Configure](https://developer.amazon.com/docs/ring/configure.html) |
| Staging users authorize with "Log in with Ring" on the app's Test page and "can immediately make API calls and receive webhooks", **but each needs an active Ring Protection plan or trial on their own devices** | D | Developer FAQ Q7, [release note 2026-09-11](https://developer.amazon.com/docs/ring/release-notes.html) |
| **Developers Playground**: one-click token (30 min), virtual device, "live event simulation for Package, Vehicle, and Motion" | D | [Release note 2026-05-28](https://developer.amazon.com/docs/ring/release-notes.html), [official sample README](https://github.com/AmazonAppDev/ring-api-helloworld) |
| Playground token is read-only (`ava.v1:read`). Its device logs only `on_demand` (live view) events in Event History. **Simulated motion does not show up in history and does not reach a partner webhook** | **R** | [threshold-ring](https://github.com/DrunkWiz/threshold-ring), [doorstep-ring](https://github.com/AtchayamG/doorstep-ring), [rhythm](https://github.com/Ivanemaeva/rhythm) |
| In July 2026, staging `motion_detected` was gated on a per-app trial with no self-service fix. The Sept 11 release appears to address this | D (forum) + **A** | [Forum thread, Ring DevRel answer](https://community.amazondeveloper.com/t/issue-testing-staging-app-with-motion-events/28731) |
| Webhook payloads carry no person identity, no face or name, and no media | D | Payload schema. Media needs separate download calls, which we never make |
| No lock/unlock, device control, or emergency dispatch API. Capability fields are read-only | D | Developer FAQ Q8 |

### Discrepancies in official material (logged as friction)
- The official sample treats `RING_WEBHOOK_SECRET` as a **Bearer token**, and its event schema lists `person_detected` and omits `button_press`. The API reference specifies an **HMAC `X-Signature`** and `button_press`. We follow the API reference.
- The sample links `docs/ring/notifications.html` and `docs/ring/authentication.html`. Both return 404.
- "Get started" says you need "at least one Ring device" to register. The hackathon says "no physical device required." Both are true only if the Playground counts as the simulator.
- "Sandbox environment with synthetic devices and events" is mentioned in the glossary and FAQ but nowhere explained.

## What this means for the critical path

Two tiers. Every Ring code path is shared between them, and only the event source differs.

**Tier 1, no hardware (the floor; can be verified as soon as you have a Playground token):**
Real calls to `/v1/users/me`, `/v1/devices`, `/v1/devices/{id}/status`, and `/v1/history/devices/{id}/events` with a Playground token. Device picker, online status, and history polling run against Ring's virtual device. If the Playground's simulated events ever appear in history, they flow through the matching pipeline unchanged. Door events for the walkthrough come from a **local signed replay**: documented-shape payloads, HMAC-signed, sent through the same verifier and parser. They're stored with `source = local_replay` and labeled **"Local replay, not from Ring"** everywhere they appear.

**Tier 2, real door events (the target; needs a Ring doorbell or camera on your account with Ring Protection):**
A private app in the Ring console. Public HTTPS endpoints for Token Exchange, Account Link, Webhook, and Homepage. Real one-way account linking, real signed `button_press` / `motion_detected` webhooks, and history backfill. The demo video presses the real doorbell and the event lands on the visit's timeline.

**Blocker check:** Tier 2 depends on you having a Ring doorbell or camera with a Protection plan or trial. Without one, the submission rests on Tier 1. That still uses the official API and simulator in executable code, but the door events in the walkthrough would be local replays. We should tell judges this up front, not hide it.

## Explicitly out of scope
Unlocking or access control, identifying visitors (face or person recognition), media download or storage, medical or wellness inference, and automatic emergency dispatch. None of these is needed for the handoff problem. The ones that are technically possible would weaken consent and privacy.
