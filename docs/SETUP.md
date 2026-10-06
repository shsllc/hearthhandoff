# Setup

## Local (no accounts needed)
```bash
npm install && npm run seed && npm start
```
Open http://localhost:3000. To call the real Ring API without a device, put a Developer Playground token in `.env` as `RING_ACCESS_TOKEN` (it expires after 30 minutes), then run `npm run ring:probe`.

## AWS deployment (account 246830848999, us-west-2)
| Resource | Value |
|---|---|
| App URL (API Gateway custom domain) | https://hearthhandoff.quirkworksllc.com |
| Stack | `hearthhandoff` (CloudFormation) |
| Secret | `hearthhandoff/runtime` (Secrets Manager) |
| Table | see the stack's `TableName` output (DynamoDB, TTL on `ttl`) |
| DNS (Cloudflare, DNS only) | `CNAME hearthhandoff → <RegionalDomainTarget output>` |
| Certificate | ACM `813a61c9-…` (DNS-validated) |
| Email sender | `hearthhandoff@quirkworksllc.com` (SES, domain verified) |

```bash
aws sso login --sso-session aws-admin
AWS_PROFILE=AdministratorAccess-246830848999 SES_FROM=hearthhandoff@quirkworksllc.com \
  CUSTOM_DOMAIN=hearthhandoff.quirkworksllc.com \
  CERTIFICATE_ARN=arn:aws:acm:us-west-2:246830848999:certificate/813a61c9-c9b0-43ae-93e8-e1a8d9b17a71 npm run deploy:aws
AWS_PROFILE=AdministratorAccess-246830848999 npm run aws:recycle     # after editing the secret
```

## Connecting a real Ring account (private app)
Do these in order. Never paste credentials into chat or git.

1. **Access code.** In the AWS console, open Secrets Manager → `hearthhandoff/runtime` → *Retrieve secret value* → *Edit*. Set `ACCESS_CODE` to a passphrase you'll share with demo testers. Leave `APP_SECRET` as it is.
2. **Ring app.** The private app in the Ring Developer Console should be named HearthHandoff. Its scope is **Cameras and Doorbells** only.
3. **Credentials.** Put the Client ID, Client Secret, and HMAC Signing Key into the same secret as `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, and `RING_HMAC_SIGNING_KEY`.
4. **Reload.** Run `npm run aws:recycle` (or ask Claude to).
5. **URLs.** In the Ring app, go to *Account linking* → **Staging settings** and enter:
   | Field | URL |
   |---|---|
   | Account Link URL | `https://hearthhandoff.quirkworksllc.com/ring/link` |
   | App Homepage URL | `https://hearthhandoff.quirkworksllc.com/` |
   | Default Redirect URL | `https://hearthhandoff.quirkworksllc.com/` |
   | Token Exchange URL | `https://hearthhandoff.quirkworksllc.com/ring/token-exchange` |
   | Webhook URL | `https://hearthhandoff.quirkworksllc.com/ring/webhook` |
6. **Connect.** Choose *Connect* → *Log in with Ring*, pick your camera and doorbell, and confirm. On the HearthHandoff link page, sign in as **June** (the owner) with the access code and choose **Connect Ring**.
7. **Check.** The household page should show *Connected* and list your devices. The Activity log should record `ring.linked`.

Each connected device needs an active Ring Protection plan or trial. If motion events don't arrive, check:
- Motion recording is on for the device.
- Motion zones cover where people walk.
- Smart Alerts settings, which change the motion sub-types.
