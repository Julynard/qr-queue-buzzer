# QR Queue Buzzer – test setup

## 1. First time only
Put `server.js` and `package.json` in one folder, open a terminal there and run:

    npm install

## 2. Start the server

    node server.js

## 3. Get HTTPS (needed for lock-screen alerts + screen-awake)
Install cloudflared (free, no account needed):
- Windows: `winget install Cloudflare.cloudflared`
- Mac: `brew install cloudflared`

In a second terminal run:

    cloudflared tunnel --url http://localhost:3000

It prints an address like `https://random-words.trycloudflare.com`.
Open `https://random-words.trycloudflare.com/staff` on your laptop.
The QR on that page now points to the HTTPS address, and phones can use Wi-Fi or mobile data.

Note: the address changes every time you restart cloudflared, so reprint the QR each time.

## 4. Test
1. Scan the QR with your phone, enter a name (optional) and tap **Join queue**.
2. Tap **Allow** when it asks about notifications.
3. Lock your phone, then tap **🔔 Buzz** on the laptop.

- Android (Chrome): the notification shows up on the lock screen.
- iPhone: tap Share → Add to Home Screen, open **Buzzer** from the home screen,
  tap "Turn on buzzer" and allow notifications. Then lock alerts work.

The staff list shows "🔔 lock-screen alerts on" for each phone that allowed notifications.

`vapid.json` is created automatically: it is your server's push key. Keep it, and don't share it.
