import { test } from "node:test";
import assert from "node:assert/strict";
import nodeCrypto from "node:crypto";
import ece from "http_ece";
import { encryptPayload, vapidAuthorization, buildPushRequest, b64urlEncode, b64urlDecode } from "../src/push.js";

// A fake "phone": its own P-256 key pair and auth secret, like a browser push subscription.
function fakeBrowser() {
  const ecdh = nodeCrypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return {
    ecdh, auth,
    keys: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) },
  };
}

async function vapidPair() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const publicKey = b64urlEncode(await crypto.subtle.exportKey("raw", pair.publicKey));
  const { d } = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey, privateKey: d, subject: "mailto:test@example.com" };
}

test("a browser can decrypt the push message (checked with the http_ece reference library)", async () => {
  const phone = fakeBrowser();
  const message = JSON.stringify({ title: "🔔 Order #7 is ready!", body: "Ana, please come to the counter." });
  const body = await encryptPayload(phone.keys, new TextEncoder().encode(message));
  const plain = ece.decrypt(Buffer.from(body), { version: "aes128gcm", privateKey: phone.ecdh, authSecret: phone.auth });
  assert.equal(plain.toString("utf8"), message);
});

test("each push is encrypted differently (fresh key and salt)", async () => {
  const phone = fakeBrowser();
  const a = await encryptPayload(phone.keys, new TextEncoder().encode("same"));
  const b = await encryptPayload(phone.keys, new TextEncoder().encode("same"));
  assert.notDeepEqual(a, b);
});

test("bad subscription keys are refused", async () => {
  await assert.rejects(encryptPayload({ p256dh: "AAAA", auth: "AAAA" }, new Uint8Array(1)));
});

test("the VAPID token is a valid ES256 JWT for the push service's origin", async () => {
  const vapid = await vapidPair();
  const now = Date.UTC(2026, 10, 20);
  const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", vapid, now);
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, header);
  const [, h, c, sig, k] = m;
  assert.equal(k, vapid.publicKey);
  assert.deepEqual(JSON.parse(Buffer.from(b64urlDecode(h)).toString()), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(b64urlDecode(c)).toString());
  assert.equal(claims.aud, "https://fcm.googleapis.com");
  assert.equal(claims.sub, vapid.subject);
  assert.equal(claims.exp, now / 1000 + 12 * 3600);

  const pub = b64urlDecode(vapid.publicKey);
  const key = nodeCrypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) }, format: "jwk" });
  const ok = nodeCrypto.verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(b64urlDecode(sig)));
  assert.equal(ok, true, "signature verifies with the public key");
});

test("the push request has the headers push services require", async () => {
  const vapid = await vapidPair();
  const phone = fakeBrowser();
  const { url, init } = await buildPushRequest({ endpoint: "https://push.example.com/x", keys: phone.keys }, "hi", vapid);
  assert.equal(url, "https://push.example.com/x");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Encoding"], "aes128gcm");
  assert.equal(init.headers.TTL, "300");
  assert.equal(init.headers.Urgency, "high");
  assert.match(init.headers.Authorization, /^vapid t=/);
});
