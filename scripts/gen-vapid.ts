// Prints a new VAPID key pair for push notifications.
// Public key -> VAPID_PUBLIC_KEY in wrangler.jsonc. Private key -> .dev.vars and `npx wrangler secret put VAPID_PRIVATE_KEY`.
// Changing keys stops pushes to phones that subscribed with the old key (they re-subscribe on their next visit).
import { b64urlEncode } from "../src/push.ts";

const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
const publicKey = b64urlEncode((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
const { d } = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${d}`);
