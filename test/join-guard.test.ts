import { test } from "node:test";
import assert from "node:assert/strict";
import { JOIN_ACTION, guardJoin, verifyTurnstile } from "../src/join-guard.ts";

const SECRET = "real-secret";
const HOST = "aqona.app";

/** A fake siteverify: returns `body` (or throws) and records what it was sent. */
function fakeFetch(body: unknown, status = 200) {
  const calls: URLSearchParams[] = [];
  const fn = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(new URLSearchParams(String(init?.body)));
    if (body instanceof Error) throw body;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fn, calls };
}
const pass = { success: true, action: JOIN_ACTION, hostname: HOST };

test("a real token for this site and action passes, and its IP goes to siteverify", async () => {
  const f = fakeFetch(pass);
  assert.equal(await verifyTurnstile({ token: "tok", secret: SECRET, ip: "1.2.3.4", hostname: HOST, fetchFn: f.fn }), true);
  assert.equal(f.calls[0]!.get("secret"), SECRET);
  assert.equal(f.calls[0]!.get("response"), "tok");
  assert.equal(f.calls[0]!.get("remoteip"), "1.2.3.4");
});

test("a failed, wrong-action or wrong-site token is refused", async () => {
  for (const body of [
    { success: false },
    { success: true, action: "login", hostname: HOST },
    { success: true, action: JOIN_ACTION, hostname: "evil.example" },
  ]) {
    assert.equal(await verifyTurnstile({ token: "tok", secret: SECRET, ip: null, hostname: HOST, fetchFn: fakeFetch(body).fn }), false, JSON.stringify(body));
  }
});

test("Cloudflare's test keys skip the action and site checks (they always report example.com)", async () => {
  const f = fakeFetch({ success: true, hostname: "example.com", metadata: { result_with_testing_key: true } });
  assert.equal(await verifyTurnstile({ token: "tok", secret: SECRET, ip: null, hostname: HOST, fetchFn: f.fn }), true);
});

test("siteverify down or answering oddly: refused (fail closed)", async () => {
  for (const f of [fakeFetch(new Error("network")), fakeFetch(pass, 500), fakeFetch("not an object")]) {
    assert.equal(await verifyTurnstile({ token: "tok", secret: SECRET, ip: null, hostname: HOST, fetchFn: f.fn }), false);
  }
});

test("a missing or oversized token is refused without calling siteverify", async () => {
  for (const token of [null, "", "x".repeat(2049)]) {
    const f = fakeFetch(pass);
    assert.equal(await verifyTurnstile({ token, secret: SECRET, ip: null, hostname: HOST, fetchFn: f.fn }), false);
    assert.equal(f.calls.length, 0);
  }
});

/** A fake rate limiter that allows `n` calls, recording the keys. */
function limiter(n: number) {
  const keys: string[] = [];
  return { keys, limit: async ({ key }: { key: string }) => { keys.push(key); return { success: keys.length <= n }; } };
}

test("join: counted per queue and IP, then checked with Turnstile", async () => {
  const l = limiter(10);
  const f = fakeFetch(pass);
  const r = await guardJoin({ limiter: l, secret: SECRET, token: "tok", ip: "1.2.3.4", hostname: HOST, queueId: "q1", fetchFn: f.fn });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(l.keys, ["q1:1.2.3.4"]);
  assert.equal(f.calls.length, 1);
});

test("join: over the limit is 'busy' (429) and never reaches siteverify", async () => {
  const f = fakeFetch(pass);
  const r = await guardJoin({ limiter: limiter(0), secret: SECRET, token: "tok", ip: "1.2.3.4", hostname: HOST, queueId: "q1", fetchFn: f.fn });
  assert.deepEqual(r, { ok: false, status: 429, error: "busy" });
  assert.equal(f.calls.length, 0);
});

test("join: a failed Turnstile check is 'check' (403)", async () => {
  const r = await guardJoin({ limiter: limiter(10), secret: SECRET, token: "tok", ip: null, hostname: HOST, queueId: "q1", fetchFn: fakeFetch({ success: false }).fn });
  assert.deepEqual(r, { ok: false, status: 403, error: "check" });
});

test("join: no secret set means Turnstile is off (the rate limit still applies)", async () => {
  const f = fakeFetch(pass);
  assert.deepEqual(await guardJoin({ limiter: limiter(10), secret: undefined, token: null, ip: "1.2.3.4", hostname: HOST, queueId: "q1", fetchFn: f.fn }), { ok: true });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await guardJoin({ limiter: limiter(0), secret: "", token: null, ip: "1.2.3.4", hostname: HOST, queueId: "q1" }), { ok: false, status: 429, error: "busy" });
});

test("join: no IP known: all such calls share one count for the queue", async () => {
  const l = limiter(10);
  await guardJoin({ limiter: l, secret: undefined, token: null, ip: null, hostname: HOST, queueId: "q1" });
  assert.deepEqual(l.keys, ["q1:unknown"]);
});
