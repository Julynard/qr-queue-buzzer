import { test } from "node:test";
import assert from "node:assert/strict";
import { acceptProblem, inviteProblem, isEmail, isInviteId, isLive, newInviteId, normEmail, seatsLeft } from "../src/team.ts";
import type { InviteRow } from "../src/team.ts";

const NOW = Date.parse("2026-11-22T10:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const invite = (over: Partial<InviteRow> = {}): InviteRow => ({
  id: "a".repeat(24), organizationId: "org1", email: "marco@example.com", role: "member", status: "pending",
  expiresAt: new Date(NOW + 7 * DAY).toISOString(), createdAt: new Date(NOW).toISOString(), inviterId: "u1", ...over,
});

test("emails are trimmed and lower-cased; only real-looking emails pass", () => {
  assert.equal(normEmail("  Marco@Example.COM "), "marco@example.com");
  assert.equal(normEmail(42), "");
  assert.ok(isEmail("marco@example.com"));
  for (const bad of ["", "bea@", "bea@example", "no spaces@x.com", "@example.com"]) assert.equal(isEmail(bad), false, bad);
});

test("invite ids are 24 hex characters and random", () => {
  const a = newInviteId(), b = newInviteId();
  assert.ok(isInviteId(a)); assert.notEqual(a, b);
  assert.equal(isInviteId("zz"), false);
  assert.equal(isInviteId("A".repeat(24)), false);
});

test("an invite is live only while pending and before it expires", () => {
  assert.ok(isLive(invite(), NOW));
  assert.equal(isLive(invite({ expiresAt: new Date(NOW - 1).toISOString() }), NOW), false);
  assert.equal(isLive(invite({ status: "canceled" }), NOW), false);
  assert.equal(isLive(invite({ status: "accepted" }), NOW), false);
});

test("seats: owner + staff + live invites count against the plan; null means no limit", () => {
  assert.equal(seatsLeft(3, 1, 0), 2, "Free: owner alone leaves 2");
  assert.equal(seatsLeft(3, 2, 1), 0, "owner + 1 staff + 1 invite fills Free");
  assert.equal(seatsLeft(3, 4, 0), 0, "over the limit (plan moved down) never goes negative");
  assert.equal(seatsLeft(null, 50, 9), null);
});

test("invite checks, in the order the owner sees them", () => {
  const ok = { ownEmail: "ana@example.com", memberEmails: ["ana@example.com", "marco@example.com"], liveInviteEmails: ["bea@example.com"], seatsLeft: 1 };
  assert.equal(inviteProblem("", ok), "Enter their email.");
  assert.match(inviteProblem("bea@", ok)!, /doesn't look like an email/);
  assert.match(inviteProblem("ana@example.com", { ...ok, memberEmails: [] })!, /That's you/);
  assert.equal(inviteProblem("marco@example.com", ok), "marco@example.com is already on your team.");
  assert.match(inviteProblem("bea@example.com", ok)!, /already invited/);
  assert.match(inviteProblem("joy@example.com", { ...ok, seatsLeft: 0 })!, /team is full/);
  assert.equal(inviteProblem("joy@example.com", ok), null);
  assert.equal(inviteProblem("joy@example.com", { ...ok, seatsLeft: null }), null, "no limit on the plan");
});

test("accepting: right email, live invite, seat free; accepting twice is fine", () => {
  assert.match(acceptProblem(null, "marco@example.com", NOW, false, 1)!, /doesn't exist/);
  assert.match(acceptProblem(invite({ status: "canceled" }), "marco@example.com", NOW, false, 1)!, /cancelled/);
  assert.match(acceptProblem(invite({ expiresAt: new Date(NOW - 1).toISOString() }), "marco@example.com", NOW, false, 1)!, /expired/);
  assert.match(acceptProblem(invite(), "someone@else.com", NOW, false, 1)!, /This invite is for marco@example.com/);
  assert.match(acceptProblem(invite(), "marco@example.com", NOW, false, 0)!, /team is full/);
  assert.equal(acceptProblem(invite(), "Marco@Example.com", NOW, false, 1), null, "email case doesn't matter");
  assert.equal(acceptProblem(invite({ status: "accepted" }), "marco@example.com", NOW, true, 0), null, "already joined: no-op");
  assert.match(acceptProblem(invite({ status: "accepted" }), "marco@example.com", NOW, false, 1)!, /already used/);
});
