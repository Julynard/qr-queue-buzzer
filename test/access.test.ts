import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyQueuePath } from "../src/access.ts";
import { FREE_LIMITS, limitsFor } from "../src/plans.ts";

const ID = "abc123abc123";

test("customer pages and calls are public", () => {
  assert.deepEqual(classifyQueuePath("", "GET"), { kind: "public", forward: "/join" });
  assert.deepEqual(classifyQueuePath("/", "GET"), { kind: "public", forward: "/join" });
  assert.deepEqual(classifyQueuePath(`/t/${ID}`, "GET"), { kind: "public", forward: `/t/${ID}` });
  assert.deepEqual(classifyQueuePath(`/manifest/${ID}.json`, "GET"), { kind: "public", forward: `/manifest/${ID}.json` });
  for (const [p, m] of [["/api/join", "POST"], [`/api/status/${ID}`, "GET"], [`/api/subscribe/${ID}`, "POST"], [`/api/ack/${ID}`, "POST"], [`/ws/t/${ID}`, "GET"]] as const) {
    assert.deepEqual(classifyQueuePath(p, m), { kind: "public", forward: p }, p);
  }
});

test("staff pages and calls need a member of the workspace", () => {
  for (const [p, m] of [["/staff", "GET"], ["/qr", "GET"], ["/api/state", "GET"], [`/api/buzz/${ID}`, "POST"], [`/api/done/${ID}`, "POST"],
    [`/api/remove/${ID}`, "POST"], ["/api/reset", "POST"], ["/api/settings", "POST"], ["/ws/staff", "GET"]] as const) {
    assert.deepEqual(classifyQueuePath(p, m), { kind: "member", forward: p }, p);
  }
});

test("unknown and internal paths are refused", () => {
  for (const p of ["/api/nope", "/internal/wipe", "/internal/init", "/api/buzz", `/api/buzz/${ID}/x`, "/../staff", "/t/XYZ"]) {
    assert.equal(classifyQueuePath(p, "POST"), null, p);
  }
  assert.equal(classifyQueuePath("/api/join", "GET"), null, "join is POST only");
  assert.equal(classifyQueuePath(`/api/buzz/${ID}`, "GET"), null, "actions are POST only");
});

test("Free plan limits", () => {
  assert.deepEqual(FREE_LIMITS, { queues: 1, people: 3, softTicketsPerDay: 300 });
  assert.equal(limitsFor("free"), FREE_LIMITS);
  assert.equal(limitsFor("something-else"), FREE_LIMITS, "unknown plans get the Free limits");
});
