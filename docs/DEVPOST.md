# Devpost submission: HearthHandoff

Copy each section into the matching Devpost field. Every number here was measured on the live deployment on 2026-10-21.

---

## Project name
HearthHandoff

## Elevator pitch (tagline)
A consent-based handoff record for people who live independently, built on Ring door events that are honest about what they can't prove.

---

## About the project
*(Paste everything between the lines into "About the project". It's Markdown with LaTeX.)*

---

## Inspiration

When someone lives on their own, a small circle quietly shares the work of showing up: a paid caregiver, a neighbor, a grown child two states away. The weak point is the **handoff**. Did the afternoon visit happen? Is anyone checking? Today that lives in group texts and assumptions.

A Ring camera already watches the door, but "motion at 4:10 PM" is not the same as "Dana was here and Mom is fine." Most products in this space either ignore that gap or paper over it with surveillance. We wanted to use Ring's signal **honestly**: show what the door saw, never claim who it was, and let only a person confirm that care happened.

## What it does

- **The person whose home it is stays in charge.** They schedule visits and deliveries, choose who can see each one, and choose who follows up if a visit isn't confirmed.
- **Ring door events land on the visit timeline**, through Ring's HMAC-signed webhooks plus an Event History backstop. Every event carries the same caveat: *"Ring recorded activity at the door. This does not show who it was or whether care happened."*
- **Only a person closes a visit.** The caregiver taps **Visit done** or **There's a problem**, with an optional note.
- **Calm follow-ups, not alarms.** If no one confirms by the confirm-by time, the designated contact gets an in-app notice and an email, with call and text shortcuts. When Ring saw nothing, we explain why that can be normal. Nothing is dispatched automatically.
- **Privacy by design.** It stores metadata only: no video, no images, no identity recognition, no unlocking. Door activity that isn't attached to a visit is visible only to the owner and expires after 7 days. Unlinking in Ring purges tokens and devices.

### An auditable matching rule

A door event $e$ recorded at device time $t_e$ on device $d_e$ appears on visit $v$ (window $[s_v, f_v]$, early and late grace $g^-, g^+$) when:

$$
\text{match}(e, v) \iff (d_e = d_v \lor d_v = \varnothing) \;\land\; \text{type}(e) \ne \text{vehicle} \;\land\; s_v - g^- \le t_e \le f_v + g^+
$$

Each match stores the rule version (`match-v1`) and a plain-language reason that's shown on the timeline. Matching uses **device time**, not delivery time, so a late event still lands where it happened.

## How we built it

**Ring Partner API (private app, one-way account linking)**
- Token Exchange URL, then `GET /v1/users/me`, then an HMAC nonce match after a mandatory sign-in, then `POST` and `PATCH /v1/accounts/me/app-integrations`.
- Device discovery and status.
- Event History polling as a backstop.
- Webhooks verified as $\text{HMAC-SHA256}(k, \text{raw body})$ before parsing. Our verifier matches Ring's own reference implementation byte for byte.

**Deduplication, three layers deep**
1. Ring retries: `meta.request_id`, enforced with a conditional write.
2. History re-polls: Ring's event ID, skipped without a write.
3. Webhook and history copies of the same motion: merged when $|t_\text{hook} - t_\text{history}| \le 30\,\text{s}$, and only across sources, so two real motions seconds apart never collapse.

**AWS**
- **AWS Lambda** (Node 24) behind an **Amazon API Gateway** HTTP API, on a custom domain with an **ACM** certificate.
- **Amazon DynamoDB** single-table design, with **TTL as the data-retention mechanism**.
- **Amazon EventBridge Scheduler**: a one-minute tick for confirm-by deadlines and history polling.
- **AWS Secrets Manager** for Ring credentials, read at cold start.
- **Amazon SES** for follow-up email.
- One **CloudFormation/SAM** template, deployed with the AWS CLI.

**Quality**
- **Zero-setup local mode:** the same code runs on SQLite behind an identical storage contract, so anyone can run the demo with `npm start`.
- **38 automated tests:**
  - signature vectors from Ring's reference code
  - the full account-linking flow against a fake Ring server
  - dedupe patterns taken from real-device data
  - visibility, CSRF, and deadlines
  - a storage contract run against real DynamoDB

  An AWS smoke test drives Scheduler → Lambda → DynamoDB → SES.
- **Accessibility:** WCAG 2.1 AA in light and dark mode (checked with axe-core), a phone-first caregiver view, and plain-language copy.

**Real-world results:** in a week on two real Ring cameras, HearthHandoff received **126 motion events**. The median webhook delay was about **1 second**. Ring classified 77 events as a person. A scheduled 4:00 to 5:30 PM visit correctly picked up leaving and returning activity and, with no confirmation, opened a follow-up at the confirm-by time.

## Challenges we ran into

The hardest part was **Ring onboarding**, not the code. Our friction log has 13 entries. The biggest:

- **Undocumented entry point.** The developer portal's *Log in with Ring* only registers a test account; we proved it by capturing the redirect back to the console. Partner linking for a private app actually starts from a **"Staging Apps"** section of the Ring Appstore that the docs never mention.
- **Starter sample vs. API reference.** The official sample authenticates webhooks with a bearer token and its event schema omits `button_press`. The API reference specifies an HMAC `X-Signature`.
- **Undocumented Token Exchange request.** We logged the first live call: form-encoded `code` and `client_id`.
- **Real data broke our assumptions.** Event History timestamps run 6 to 10 seconds ahead of webhook timestamps for the same motion, so our first 5-second merge window doubled every event. Real-device data drove the fix, and the tests now encode that pattern.

## What we learned

Ring's metadata-only, consent-gated model fits caretaking well. The real trust problem is **wording**. A timeline that says "Dana arrived" is a lie; one that says "door activity near the visit time, not proof of who" is useful. We treated copy as a first-class feature.

## What's next

- Passkey sign-in (replacing the demo picker).
- Per-person notification preferences and SMS.
- Optional Ring contact sensors once they leave early access.
- A public Ring Appstore listing.

---

## Built with (25 tags)
```
ring, ring-partner-api, amazon-web-services, aws-lambda, amazon-api-gateway, amazon-dynamodb, amazon-eventbridge, aws-secrets-manager, amazon-ses, aws-certificate-manager, aws-cloudformation, aws-sam, node.js, typescript, hono, sqlite, esbuild, webhooks, oauth, hmac, cloudflare, html5, css3, wcag, axe-core
```

## Try it out (links)
1. **Live app:** https://hearthhandoff.quirkworksllc.com (public homepage; sign-in needs the judges' access code, see below)
2. **Source code:** https://github.com/<owner>/hearthhandoff **[pending your approval to publish]**
3. **Run locally in 2 minutes:** the repo README (`npm install && npm run seed && npm start`)

**Judge access:** the rules say that if a site needs a login, you must provide credentials. Options:
- **(a)** Put the access code in Devpost's private testing/judging instructions field, if the form has one.
- **(b)** Point judges to the local run, which needs no credentials.

We'd also want to switch the live site's people to a fictional demo household before judges sign in, so your real Ring data isn't exposed to them.

## Images and video
See the media plan in the reply. Gallery images: JPG/PNG, under 5 MB each, 3:2 ratio recommended.
