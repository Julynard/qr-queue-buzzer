import { test } from "node:test";
import assert from "node:assert/strict";
import { allows, canManage, classifyQueuePath, isSuperadmin } from "../src/access.ts";
import type { Need, Role } from "../src/access.ts";
import { FREE_LIMITS, MAX_LIMITS, PRO_LIMITS, isPlan, limitsFor } from "../src/plans.ts";

const ID = "abc123abc123";

test("customer pages and calls are public", () => {
  assert.deepEqual(classifyQueuePath("", "GET"), { need: "public", forward: "/join" });
  assert.deepEqual(classifyQueuePath("/", "GET"), { need: "public", forward: "/join" });
  assert.deepEqual(classifyQueuePath(`/t/${ID}`, "GET"), { need: "public", forward: `/t/${ID}` });
  assert.deepEqual(classifyQueuePath(`/manifest/${ID}.json`, "GET"), { need: "public", forward: `/manifest/${ID}.json` });
  for (const [p, m] of [["/api/join", "POST"], [`/api/status/${ID}`, "GET"], [`/api/subscribe/${ID}`, "POST"], [`/api/ack/${ID}`, "POST"], [`/ws/t/${ID}`, "GET"]] as const) {
    assert.deepEqual(classifyQueuePath(p, m), { need: "public", forward: p }, p);
  }
});

test("running the queue needs staff", () => {
  for (const [p, m] of [["/staff", "GET"], ["/qr", "GET"], ["/api/state", "GET"], [`/api/buzz/${ID}`, "POST"], [`/api/done/${ID}`, "POST"],
    [`/api/remove/${ID}`, "POST"], ["/ws/staff", "GET"]] as const) {
    assert.deepEqual(classifyQueuePath(p, m), { need: "staff", forward: p }, p);
  }
});

test("settings and Start new day need the owner", () => {
  for (const p of ["/api/settings", "/api/reset"]) assert.deepEqual(classifyQueuePath(p, "POST"), { need: "owner", forward: p }, p);
});

test("who passes each level", () => {
  const roles: (Role | null)[] = [null, "member", "admin", "owner", "superadmin"];
  const expect: Record<Need, boolean[]> = {
    public: [true, true, true, true, true],
    staff: [false, true, true, true, true],
    owner: [false, false, false, true, true],
  };
  for (const need of ["public", "staff", "owner"] as const) {
    roles.forEach((r, i) => assert.equal(allows(need, r), expect[need][i], `${need} / ${r}`));
  }
  assert.equal(canManage("owner"), true);
  assert.equal(canManage("superadmin"), true);
  assert.equal(canManage("member"), false);
  assert.equal(canManage(null), false);
});

test("superadmin list: comma-separated, case and spaces ignored, empty never matches", () => {
  const list = " Boss@Example.com , help@example.com";
  assert.equal(isSuperadmin("boss@example.com", list), true);
  assert.equal(isSuperadmin(" HELP@example.com ", list), true);
  assert.equal(isSuperadmin("someone@example.com", list), false);
  assert.equal(isSuperadmin("boss@example.com.evil", list), false);
  assert.equal(isSuperadmin("", list), false);
  assert.equal(isSuperadmin("", "a@b.c,,"), false, "an empty entry never lets an empty email in");
  assert.equal(isSuperadmin("boss@example.com", undefined), false);
  assert.equal(isSuperadmin("boss@example.com", ""), false);
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
  assert.equal(limitsFor(null), FREE_LIMITS);
});

test("Pro and Max limits", () => {
  assert.deepEqual(limitsFor("pro"), { queues: 5, people: 6, softTicketsPerDay: null });
  assert.equal(limitsFor("pro"), PRO_LIMITS);
  assert.deepEqual(limitsFor("max"), { queues: 10, people: null, softTicketsPerDay: null });
  assert.equal(limitsFor("max"), MAX_LIMITS);
});

test("only free, pro and max are plans", () => {
  for (const p of ["free", "pro", "max"]) assert.ok(isPlan(p), p);
  for (const p of ["Pro", "plus", "", null, 1, undefined]) assert.equal(isPlan(p), false, String(p));
});
