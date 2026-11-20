// Web Push using only WebCrypto, so it runs on Cloudflare Workers (the `web-push` npm package needs Node).
// - VAPID (RFC 8292): an ES256-signed JWT tells the push service which server is sending.
// - Payload encryption (RFC 8291, "aes128gcm"): only the customer's browser can read the message.

const te = new TextEncoder();

export function b64urlEncode(bytes) {
  let s = "";
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob((str + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) { out.set(p, i); i += p.length; }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/**
 * Encrypt `plaintext` for one browser subscription (RFC 8291 / RFC 8188, single record).
 * Returns the request body: header (salt, record size, sender public key) + ciphertext.
 */
export async function encryptPayload(keys, plaintext) {
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error("bad subscription keys");

  const local = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, new Uint8Array([2])); // 0x02 = last (and only) record, no padding
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record));

  const recordSize = new Uint8Array(4);
  new DataView(recordSize.buffer).setUint32(0, 4096);
  return concat(salt, recordSize, new Uint8Array([asPublic.length]), asPublic, ciphertext);
}

const signingKeys = new Map();
async function vapidSigningKey(publicKey, privateKey) {
  const cacheKey = publicKey + privateKey;
  if (!signingKeys.has(cacheKey)) {
    const pub = b64urlDecode(publicKey);
    if (pub.length !== 65) throw new Error("VAPID public key must be a 65-byte uncompressed P-256 point");
    const jwk = { kty: "EC", crv: "P-256", d: privateKey, x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)) };
    signingKeys.set(cacheKey, crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]));
  }
  return signingKeys.get(cacheKey);
}

/** `vapid t=<jwt>, k=<public key>` header for a push endpoint. */
export async function vapidAuthorization(endpoint, { publicKey, privateKey, subject }, now = Date.now()) {
  const header = b64urlEncode(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject };
  const body = b64urlEncode(te.encode(JSON.stringify(claims)));
  const key = await vapidSigningKey(publicKey, privateKey);
  // WebCrypto ECDSA output is already raw r||s, which is what JWT ES256 expects.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(`${header}.${body}`));
  return `vapid t=${header}.${body}.${b64urlEncode(sig)}, k=${publicKey}`;
}

/** Build the HTTP request that delivers `payload` (a string) to one subscription. */
export async function buildPushRequest(sub, payload, vapid, { ttl = 300, urgency = "high" } = {}) {
  const body = await encryptPayload(sub.keys, te.encode(payload));
  return {
    url: sub.endpoint,
    init: {
      method: "POST",
      headers: {
        Authorization: await vapidAuthorization(sub.endpoint, vapid),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
    },
  };
}

/** Send one push. Returns { ok, status, gone } where gone = the subscription no longer exists. */
export async function sendPush(sub, payload, vapid, options) {
  const { url, init } = await buildPushRequest(sub, payload, vapid, options);
  // A push service that never answers must not hold up the other phones' alerts.
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
