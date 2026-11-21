# Aqona (QR Queue Buzzer)

Shops sign up, print one QR code, and customers scan it to take a number. When staff tap **Notify**, the
customer's phone beeps, vibrates and (if allowed) shows a lock-screen alert. Customers need no app,
no sign-up and no phone number. Shop owners log in with Google or a 6-digit email code (no passwords).

Runs on Cloudflare Workers: accounts and the list of queues in D1 (via Better Auth), each queue's live
data in its own Durable Object. Server code is TypeScript; pages are plain HTML and JavaScript.

## Pages
- `/` – home page; `/start` – Start free; `/login` – log in; `/privacy` – privacy notice
- `/app` – owner dashboard: the queue's QR, staff page link, delete a queue, delete the account
- `/q/<slug>` – customer join page (what the QR opens); `/q/<slug>/t/<id>` – a customer's ticket
- `/q/<slug>/staff` – staff page (log-in needed); `/q/<slug>/qr` – printable poster (log-in needed)

## Run it locally

    npm install
    cp .dev.vars.example .dev.vars     # then fill in BETTER_AUTH_SECRET and the VAPID private key (see below)
    npm run db:migrate:local           # create the local D1 tables
    npm run dev                        # http://127.0.0.1:8787

Locally, "Email me a code" prints the 6-digit code in the `npm run dev` terminal (`EMAIL_MODE=console`).
Go to `/start`, name a shop, enter any email, and copy the code from the terminal.

To let phones on the same Wi-Fi join, run `npm run dev:lan` and set `PUBLIC_URL` in `.dev.vars`
to your computer's Wi-Fi address (for example `http://192.168.1.10:8787`) so the QR points there.
Lock-screen alerts and keeping the screen on need HTTPS, so test those on the deployed site.

## Push keys (VAPID)
Lock-screen alerts need a key pair. Make one with:

    npm run vapid

- Public key → `VAPID_PUBLIC_KEY` in `wrangler.jsonc`
- Private key → `.dev.vars` for local runs, and `npx wrangler secret put VAPID_PRIVATE_KEY` for the deployed site.
  Keep it private.
- Set `VAPID_SUBJECT` in `wrangler.jsonc` to a real `mailto:` or `https:` contact before going live.

## Deploy

First time (owner):

    npx wrangler login
    npx wrangler d1 create aqona          # put the printed database_id in wrangler.jsonc
    npx wrangler secret put VAPID_PRIVATE_KEY
    npx wrangler secret put BETTER_AUTH_SECRET      # openssl rand -base64 32
    npx wrangler secret put GOOGLE_CLIENT_ID        # Google sign-in (see below)
    npx wrangler secret put GOOGLE_CLIENT_SECRET
    npx wrangler secret put BETTER_AUTH_API_KEY     # optional: Better Auth dashboard
    npx wrangler secret put SUPERADMIN_EMAILS       # optional: Aqona staff who may open any queue (emails, comma-separated)

Then every time:

    npm run deploy                         # applies D1 migrations, then deploys

The live site offers **Google sign-in only** until email sending is set up on `aqona.app`
(`EMAIL_MODE` stays `"off"` in `wrangler.jsonc`). Google OAuth client: a Web application with the
authorized redirect `https://<your-worker-address>/api/auth/callback/google`
(and `http://127.0.0.1:8787/api/auth/callback/google` for local testing).

Log in at `https://<your-worker>.workers.dev/app` and print the QR from there.

## Daily reset
The queue starts a new day automatically at 00:00 Asia/Manila: every ticket is cleared and numbering
starts again at #1. Customers still waiting are told to join again. On the staff page you can change
the time and time zone, turn the automatic reset off, or tap **Start new day now**.

## Test

    npm test          # unit tests (node --test, TypeScript run directly by Node)
    npm run check     # type check (wrangler types + tsc)
    npm run smoke     # end-to-end checks; needs `npm run dev` running in another terminal

`npm run smoke` signs up throwaway accounts using codes read from the **local** database, so it only works
against `npm run dev`. Login codes are limited to 3 per minute, so wait a minute between runs.
After changing `wrangler.jsonc`, run `npm run types` to refresh `worker-configuration.d.ts`.

## Testing on phones
1. Scan the QR with your phone, enter a name (optional) and tap **Take a number**.
2. Tap **Allow** when it asks about notifications.
3. Lock your phone, then tap **Notify** on the staff page.

- Android (Chrome): the notification shows on the lock screen.
- iPhone: tap Share → Add to Home Screen, open **Aqona** from the home screen,
  tap "Turn on alerts" and allow notifications. Then lock-screen alerts work.

## Claim time and No show
After **Notify**, the customer has a few minutes (default 5, set under Settings → Claim time) to come to the
counter. When the time runs out the ticket shows **No show**. Staff can still notify it again or mark it done.
