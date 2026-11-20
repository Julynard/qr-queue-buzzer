import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueCore, MAX_TICKETS_PER_DAY } from "../src/queue-core.js";

let counter = 0;
const newId = () => (++counter).toString(16).padStart(12, "0");
const NOW = Date.UTC(2026, 10, 20, 2, 0); // 2026-11-20 10:00 in Manila
const join = (q, body = {}) => q.join(body, { now: NOW, newId });
const KEY = "a".repeat(32);
const sub = (n = 1) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: "x", auth: "y" } });

test("customers joining one after another get 1, 2, 3 with no duplicates", () => {
  const q = new QueueCore();
  const nums = Array.from({ length: 20 }, () => join(q).ticket.num);
  assert.deepEqual(nums, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(new Set(q.list().map((t) => t.id)).size, 20);
});

test("double tap / retry with the same join key returns the same ticket", () => {
  const q = new QueueCore();
  const a = join(q, { name: "Ana", key: KEY });
  const b = join(q, { name: "Ana", key: KEY });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.ticket.id, a.ticket.id);
  assert.equal(q.tickets.size, 1);
  assert.equal(join(q, { key: "b".repeat(32) }).ticket.num, 2);
});

test("a malformed join key is ignored instead of matching other tickets", () => {
  const q = new QueueCore();
  join(q, { key: "not-a-key" });
  assert.equal(join(q, { key: "not-a-key" }).created, true);
});

test("names are trimmed and cut to 30 characters", () => {
  const q = new QueueCore();
  assert.equal(join(q, { name: "  " + "x".repeat(50) + "  " }).ticket.name, "x".repeat(30));
  assert.equal(join(q, { name: 42 }).ticket.name, "42");
  assert.equal(join(q).ticket.name, "");
});

test("the queue refuses new tickets after 999 in one day", () => {
  const q = new QueueCore({ meta: { nextNum: MAX_TICKETS_PER_DAY } });
  assert.equal(join(q).ticket.num, MAX_TICKETS_PER_DAY);
  assert.deepEqual(join(q), { error: "full" });
});

test("buzz, ack, done follow the normal flow", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  assert.equal(q.act("buzz", id).ok, true);
  assert.equal(q.status(id), "buzzing");
  assert.equal(q.act("ack", id).ok, true);
  assert.equal(q.status(id), "coming");
  assert.equal(q.act("buzz", id).ok, true, "staff can buzz again if the customer said coming but didn't show");
  assert.equal(q.act("done", id).ok, true);
  assert.equal(q.status(id), "done");
});

test("a late 'OK, coming' after staff tapped Done does not bring the ticket back", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.act("buzz", id);
  q.act("done", id);
  assert.equal(q.act("ack", id).ok, false);
  assert.equal(q.status(id), "done");
});

test("ack only works while buzzing, and nothing re-opens a done ticket", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  assert.equal(q.act("ack", id).ok, false);
  assert.equal(q.status(id), "waiting");
  q.act("done", id);
  assert.equal(q.act("buzz", id).ok, false);
  assert.equal(q.act("done", id).ok, false);
});

test("re-buzzing a buzzing ticket is allowed but changes nothing to save", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.act("buzz", id);
  q.takeChanges();
  const r = q.act("buzz", id);
  assert.equal(r.ok, true);
  assert.equal(r.changed, false);
  assert.equal(q.takeChanges().put.length, 0);
});

test("actions on unknown or removed tickets do nothing", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  assert.equal(q.act("remove", id).removed, true);
  for (const a of ["buzz", "ack", "done", "remove"]) assert.equal(q.act(a, id).ok, false);
  assert.equal(q.act("explode", id).ok, false);
  assert.equal(q.status(id), "gone");
});

test("removing a ticket deletes it from storage, including its push addresses", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.subscribe(id, sub());
  q.takeChanges();
  q.act("remove", id);
  const c = q.takeChanges();
  assert.deepEqual(c.del, [id]);
  assert.equal(c.put.length, 0);
});

test("push subscriptions: validated, de-duplicated by address, dead ones dropped", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  assert.equal(q.subscribe(id, { endpoint: "http://insecure", keys: { p256dh: "x", auth: "y" } }), false);
  assert.equal(q.subscribe(id, { endpoint: "https://a" }), false);
  assert.equal(q.subscribe("000000000000", sub()), false);
  q.subscribe(id, sub(1));
  q.subscribe(id, sub(1));
  q.subscribe(id, sub(2));
  assert.equal(q.tickets.get(id).subs.length, 2);
  q.dropSub(id, sub(1).endpoint);
  assert.deepEqual(q.tickets.get(id).subs.map((s) => s.endpoint), [sub(2).endpoint]);
});

test("starting a new day clears every ticket and restarts numbering at #1", () => {
  const q = new QueueCore();
  const a = join(q).ticket;
  const b = join(q).ticket;
  q.subscribe(b.id, sub());
  q.takeChanges();
  const cleared = q.reset(NOW + 1000);
  assert.deepEqual(cleared.sort(), [a.id, b.id].sort());
  assert.equal(q.tickets.size, 0);
  assert.equal(join(q).ticket.num, 1);
  const c = q.takeChanges();
  assert.equal(c.clearAll, true);
  assert.equal(c.meta.nextNum, 2);
});

test("yesterday's ticket reports 'reset', a removed one reports 'gone'", () => {
  const q = new QueueCore();
  const old = join(q).ticket;
  q.reset(NOW);
  assert.equal(q.status(old.id), "reset");
  const removed = join(q).ticket;
  q.act("remove", removed.id);
  assert.equal(q.status(removed.id), "gone");
});

test("a join key from yesterday makes a new ticket after the reset", () => {
  const q = new QueueCore();
  const a = join(q, { key: KEY }).ticket;
  q.reset(NOW);
  const b = join(q, { key: KEY });
  assert.equal(b.created, true);
  assert.notEqual(b.ticket.id, a.id);
});

test("automatic reset defaults to midnight Manila (16:00 UTC)", () => {
  const q = new QueueCore();
  assert.equal(q.autoResetIfDue(NOW), null);
  assert.equal(q.meta.nextResetAt, Date.UTC(2026, 10, 20, 16, 0));
});

test("automatic reset runs once its time has passed, then schedules the next day", () => {
  const q = new QueueCore();
  q.scheduleNextReset(NOW);
  join(q);
  join(q);
  assert.equal(q.autoResetIfDue(Date.UTC(2026, 10, 20, 15, 59)), null);
  const cleared = q.autoResetIfDue(Date.UTC(2026, 10, 20, 16, 0, 5));
  assert.equal(cleared.length, 2);
  assert.equal(q.tickets.size, 0);
  assert.equal(q.meta.nextResetAt, Date.UTC(2026, 10, 21, 16, 0));
  assert.equal(q.autoResetIfDue(Date.UTC(2026, 10, 20, 16, 1)), null, "does not reset twice");
});

test("a reset missed while nobody was around happens on the next request", () => {
  const q = new QueueCore();
  q.scheduleNextReset(NOW);
  join(q);
  const threeDaysLater = NOW + 3 * 86400_000;
  assert.equal(q.autoResetIfDue(threeDaysLater).length, 1);
  assert.ok(q.meta.nextResetAt > threeDaysLater);
});

test("turning automatic reset off stops it", () => {
  const q = new QueueCore();
  q.scheduleNextReset(NOW);
  assert.deepEqual(q.setSettings({ autoReset: false }, NOW), { ok: true });
  assert.equal(q.meta.nextResetAt, null);
  join(q);
  assert.equal(q.autoResetIfDue(NOW + 2 * 86400_000), null);
  assert.equal(q.tickets.size, 1);
});

test("reset time and time zone can be changed; bad values are refused", () => {
  const q = new QueueCore();
  assert.deepEqual(q.setSettings({ resetTime: "05:30" }, NOW), { ok: true });
  assert.equal(q.meta.nextResetAt, Date.UTC(2026, 10, 20, 21, 30)); // 05:30 Manila next day
  assert.deepEqual(q.setSettings({ timeZone: "Asia/Tokyo" }, NOW), { ok: true });
  assert.equal(q.meta.nextResetAt, Date.UTC(2026, 10, 20, 20, 30)); // 05:30 Tokyo
  assert.equal(q.setSettings({ resetTime: "24:00" }, NOW).ok, false);
  assert.equal(q.setSettings({ resetTime: "7pm" }, NOW).ok, false);
  assert.equal(q.setSettings({ timeZone: "Mars/Base" }, NOW).ok, false);
  assert.equal(q.setSettings({ autoReset: "yes" }, NOW).ok, false);
  assert.equal(q.meta.settings.resetTime, "05:30", "a refused change leaves settings as they were");
});

test("state saved and loaded again gives the same queue", () => {
  const q = new QueueCore();
  q.scheduleNextReset(NOW);
  const a = join(q, { name: "Ana" }).ticket;
  join(q);
  q.act("buzz", a.id);
  const c = q.takeChanges();
  const again = new QueueCore({ tickets: c.put.map((t) => JSON.parse(JSON.stringify(t))), meta: JSON.parse(JSON.stringify(c.meta)) });
  assert.deepEqual(again.list(), q.list());
  assert.equal(join(again).ticket.num, 3);
  assert.equal(again.meta.nextResetAt, q.meta.nextResetAt);
});
