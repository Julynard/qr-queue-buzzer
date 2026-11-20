# QR Queue Buzzer

Customers scan one QR code at the counter, get a queue number, and their phone flashes, beeps,
vibrates and (if allowed) shows a lock-screen alert when staff tap **Buzz**. No app, no sign-up,
no phone number.

Runs on Cloudflare Workers with a Durable Object holding the queue (free plan is enough). Server code is TypeScript; the customer and staff pages are plain HTML and JavaScript.

## Pages
- `/staff` – staff dashboard: QR code, queue, Buzz / Done / Remove, daily reset settings
- `/qr` – printable QR poster
- `/join` – customer join page (what the QR opens)
- `/t/<id>` – a customer's ticket

## Run it locally

    npm install
    cp .dev.vars.example .dev.vars     # then put your VAPID private key in it (see below)
    npm run dev                        # http://127.0.0.1:8787/staff

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

    npx wrangler login
    npx wrangler secret put VAPID_PRIVATE_KEY
    npm run deploy

Open `https://<your-worker>.workers.dev/staff` and print the QR from there.

## Daily reset
The queue starts a new day automatically at 00:00 Asia/Manila: every ticket is cleared and numbering
starts again at #1. Customers still waiting are told to join again. On the staff page you can change
the time and time zone, turn the automatic reset off, or tap **Start new day now**.

## Test

    npm test          # unit tests (node --test, TypeScript run directly by Node)
    npm run check     # type check (wrangler types + tsc)
    npm run smoke     # end-to-end checks; needs `npm run dev` running in another terminal

`npm run smoke` starts a new day on the queue it talks to, so only point it at your local server.
After changing `wrangler.jsonc`, run `npm run types` to refresh `worker-configuration.d.ts`.

## Testing on phones
1. Scan the QR with your phone, enter a name (optional) and tap **Join queue**.
2. Tap **Allow** when it asks about notifications.
3. Lock your phone, then tap **🔔 Buzz** on the staff page.

- Android (Chrome): the notification shows on the lock screen.
- iPhone: tap Share → Add to Home Screen, open **Buzzer** from the home screen,
  tap "Turn on buzzer" and allow notifications. Then lock-screen alerts work.
