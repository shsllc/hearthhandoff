# Setup

## Local (no accounts needed)
```bash
npm install && npm run seed && npm start
```
Open http://localhost:3000. To call the real Ring API without a device, put a Developer Playground token in `.env` as `RING_ACCESS_TOKEN` (it expires after 30 minutes), then run `npm run ring:probe`.

## AWS deployment (account 246830848999, us-west-2)
| Resource | Value |
|---|---|
| App / Function URL | https://wldincr4byncbgjikszktgcra40twwka.lambda-url.us-west-2.on.aws |
| Secret | `carerelay/runtime` (Secrets Manager) |
| Table | `carerelay-Table-18U0R7QPB2H76` (DynamoDB, TTL on `ttl`) |
| Email sender | `carerelay@quirkworksllc.com` (SES, domain verified) |

```bash
aws sso login --sso-session aws-admin
AWS_PROFILE=AdministratorAccess-246830848999 SES_FROM=carerelay@quirkworksllc.com npm run deploy:aws
AWS_PROFILE=AdministratorAccess-246830848999 npm run aws:recycle     # after editing the secret
```

## Connecting a real Ring account (private app)
Do these in order. Never paste credentials into chat, git, or `.env` on a shared machine.

1. **Access code.** In the AWS console, go to Secrets Manager → `carerelay/runtime` → *Retrieve secret value* → *Edit*. Set `ACCESS_CODE` to a passphrase you'll share with demo testers. Leave `APP_SECRET` as it is.
2. **Create the Ring app.** In the Ring Developer Console, open the *Private Apps* tab and choose *Create New App*.
   - Name: CareRelay.
   - Scopes: **Cameras and Doorbells** only. Leave Sensors and Chimes off.
3. **Store the credentials.** The Client ID, Client Secret, and HMAC Signing Key appear **once**. Paste them straight into the same secret as `RING_CLIENT_ID`, `RING_CLIENT_SECRET`, and `RING_HMAC_SIGNING_KEY`, then save.
4. **Reload the secret.** Run `npm run aws:recycle` (or ask Claude to).
5. **Set the URLs.** In the Ring app, go to *Account linking* → **Staging settings** and enter:
   | Field | URL |
   |---|---|
   | Account Link URL | `https://wldincr4byncbgjikszktgcra40twwka.lambda-url.us-west-2.on.aws/ring/link` |
   | Default Redirect URL | `https://wldincr4byncbgjikszktgcra40twwka.lambda-url.us-west-2.on.aws/ring/home` |
   | Token Exchange URL | `https://wldincr4byncbgjikszktgcra40twwka.lambda-url.us-west-2.on.aws/ring/token-exchange` |
   | Webhook URL | `https://wldincr4byncbgjikszktgcra40twwka.lambda-url.us-west-2.on.aws/ring/webhook` |
6. **Connect.** Go to *Connect* → *Log in with Ring*, choose your camera and doorbell, and confirm. Ring then sends you to the CareRelay link page. Sign in as **June** (the owner) with the access code, and choose **Connect Ring**.
7. **Check it.** The household page should show *Connected*, list your devices, and record `ring.linked` in the Activity log.

Each connected device needs an active Ring Protection plan or trial. If motion events don't arrive, check:
- Motion recording is on for the device.
- Motion zones cover where people walk.
- Smart Alerts settings, which change the motion sub-types.
