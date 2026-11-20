import { test } from "node:test";
import assert from "node:assert/strict";
import { QueueCore, MAX_TICKETS_PER_DAY, pushPayload, queueGate } from "../src/queue-core.ts";
import type { Settings, Ticket } from "../src/queue-core.ts";

let counter = 0;
const newId = () => (++counter).toString(16).padStart(12, "0");
const NOW = Date.UTC(2026, 10, 20, 2, 0); // 2026-11-20 10:00 in Manila
const MIN = 60_000;
function join(q: QueueCore, body: { name?: unknown; key?: unknown } = {}): { ticket: Ticket; created: boolean } {
  const r = q.join(body, { now: NOW, newId });
  if ("error" in r) throw new Error("queue unexpectedly full");
  return r;
}
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
  assert.deepEqual(q.join({}, { now: NOW, newId }), { error: "full" });
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

test("re-notifying a notified ticket restarts its claim timer and is saved", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.act("buzz", id, NOW);
  q.takeChanges();
  const r = q.act("buzz", id, NOW + 60_000);
  assert.equal(r.ok, true);
  assert.equal(r.changed, true);
  assert.equal(q.tickets.get(id)?.claimBy, NOW + 60_000 + 5 * 60_000);
  assert.equal(q.tickets.get(id)?.calledAt, NOW, "first call time is kept for the wait estimate");
  assert.equal(q.takeChanges().put.length, 1);
});

test("notify starts a claim timer from the claim time setting (default 5 minutes)", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.act("buzz", id, NOW);
  assert.equal(q.tickets.get(id)?.claimBy, NOW + 5 * MIN);
  q.setSettings({ claimMinutes: 2 }, NOW);
  const b = join(q).ticket;
  q.act("buzz", b.id, NOW);
  assert.equal(q.tickets.get(b.id)?.claimBy, NOW + 2 * MIN);
  assert.equal(q.tickets.get(id)?.claimBy, NOW + 5 * MIN, "changing the setting leaves running timers alone");
});

test("when the claim timer runs out a notified ticket becomes No show", () => {
  const q = new QueueCore();
  const a = join(q).ticket;
  const b = join(q).ticket;
  q.act("buzz", a.id, NOW);
  assert.deepEqual(q.expireClaims(NOW + 5 * MIN - 1), []);
  assert.equal(q.status(a.id), "buzzing");
  q.takeChanges();
  assert.deepEqual(q.expireClaims(NOW + 5 * MIN), [a.id]);
  assert.equal(q.status(a.id), "noshow");
  assert.equal(q.status(b.id), "waiting", "waiting tickets have no timer");
  assert.equal(q.takeChanges().put.length, 1);
  assert.deepEqual(q.expireClaims(NOW + 10 * MIN), [], "expires once");
});

test("'On the way' still becomes No show if the customer doesn't arrive in time", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.act("buzz", id, NOW);
  q.act("ack", id, NOW + MIN);
  assert.deepEqual(q.expireClaims(NOW + 5 * MIN), [id]);
  assert.equal(q.status(id), "noshow");
});

test("a No show can be notified again or marked done, but not acknowledged", () => {
  const q = new QueueCore();
  const { id } = join(q).ticket;
  q.act("buzz", id, NOW);
  q.expireClaims(NOW + 5 * MIN);
  assert.equal(q.act("ack", id, NOW + 6 * MIN).ok, false);
  assert.equal(q.act("buzz", id, NOW + 6 * MIN).ok, true);
  assert.equal(q.status(id), "buzzing");
  assert.equal(q.tickets.get(id)?.claimBy, NOW + 11 * MIN);
  q.expireClaims(NOW + 11 * MIN);
  assert.equal(q.act("done", id, NOW + 12 * MIN).ok, true);
  assert.equal(q.status(id), "done");
  assert.equal(q.tickets.get(id)?.claimBy, null);
});

test("next alarm is the earlier of the daily reset and the first claim deadline", () => {
  const q = new QueueCore();
  q.scheduleNextReset(NOW);
  assert.equal(q.nextAlarmAt(), q.meta.nextResetAt);
  const a = join(q).ticket;
  const b = join(q).ticket;
  q.act("buzz", b.id, NOW + MIN);
  q.act("buzz", a.id, NOW + 2 * MIN);
  assert.equal(q.nextAlarmAt(), NOW + 6 * MIN);
  q.act("done", b.id, NOW + 3 * MIN);
  assert.equal(q.nextAlarmAt(), NOW + 7 * MIN);
  q.setSettings({ autoReset: false }, NOW);
  q.act("done", a.id, NOW + 3 * MIN);
  assert.equal(q.nextAlarmAt(), null);
});

test("place in line counts waiting tickets ahead; called tickets have no place", () => {
  const q = new QueueCore();
  const [a, b, c] = [join(q).ticket, join(q).ticket, join(q).ticket];
  assert.equal(q.waitingCount(), 3);
  assert.deepEqual([a, b, c].map((t) => q.place(t.id)), [1, 2, 3]);
  q.act("buzz", b.id, NOW);
  assert.equal(q.place(b.id), null);
  assert.equal(q.place(c.id), 2, "staff serving out of order still moves everyone behind up");
  assert.equal(q.waitingCount(), 2);
  q.act("remove", a.id);
  assert.equal(q.place(c.id), 1);
});

test("wait estimate needs 3 called tickets, then uses the typical time per ticket", () => {
  const q = new QueueCore();
  const t = Array.from({ length: 6 }, () => join(q).ticket); // all joined at NOW
  assert.equal(q.waitMinutes(1), null);
  q.act("buzz", t[0]!.id, NOW + 4 * MIN);
  q.act("done", t[1]!.id, NOW + 6 * MIN); // served without a notify still counts
  assert.equal(q.waitMinutes(1), null, "two samples are not enough");
  q.act("buzz", t[2]!.id, NOW + 9 * MIN);
  // time at the front of the line: 4, 2, 3 minutes -> typical (median) 3 minutes
  assert.equal(q.waitMinutes(1), 3);
  assert.equal(q.waitMinutes(3), 9);
});

test("wait estimate ignores idle time before a customer arrived", () => {
  const q = new QueueCore();
  for (let i = 0; i < 3; i++) {
    // one customer an hour, each served 2 minutes after joining
    const r = q.join({}, { now: NOW + i * 60 * MIN, newId });
    if ("error" in r) throw new Error("full");
    q.act("buzz", r.ticket.id, NOW + i * 60 * MIN + 2 * MIN);
  }
  assert.equal(q.waitMinutes(1), 2);
});

test("customer view: status, place, wait and claim time left", () => {
  const q = new QueueCore();
  const a = join(q).ticket;
  const b = join(q).ticket;
  assert.deepEqual(q.customerView(b.id, NOW), { status: "waiting", place: 2, waitMin: null, claimLeftMs: null });
  q.act("buzz", a.id, NOW);
  assert.deepEqual(q.customerView(a.id, NOW + MIN), { status: "buzzing", place: null, waitMin: null, claimLeftMs: 4 * MIN });
  assert.deepEqual(q.customerView("ffffffffffff", NOW), { status: "gone", place: null, waitMin: null, claimLeftMs: null });
});

test("queue name and claim time settings are validated", () => {
  const q = new QueueCore();
  // (read through a function so TypeScript doesn't narrow the values between setSettings calls)
  const settings = (): Settings => q.meta.settings;
  assert.equal(settings().queueName, "");
  assert.equal(settings().claimMinutes, 5);
  assert.deepEqual(q.setSettings({ queueName: "  Ana's Milk Tea · Counter 1  ", claimMinutes: 10 }, NOW), { ok: true });
  assert.equal(settings().queueName, "Ana's Milk Tea · Counter 1");
  assert.equal(settings().claimMinutes, 10);
  q.setSettings({ queueName: "x".repeat(100) }, NOW);
  assert.equal(settings().queueName.length, 60);
  assert.equal(q.setSettings({ queueName: 5 }, NOW).ok, false);
  for (const bad of [0, 31, 2.5, "5"]) assert.equal(q.setSettings({ claimMinutes: bad }, NOW).ok, false);
  assert.equal(settings().claimMinutes, 10);
});

test("a queue saved before these features loads with defaults", () => {
  const legacy = { id: "0000000000aa", num: 1, name: "", status: "buzzing", key: null, createdAt: NOW, subs: [] };
  const q = new QueueCore({
    tickets: [legacy as unknown as Ticket],
    meta: { nextNum: 2, settings: { autoReset: true, resetTime: "00:00", timeZone: "Asia/Manila" } as Settings },
  });
  assert.equal(q.meta.settings.claimMinutes, 5);
  assert.equal(q.meta.settings.queueName, "");
  assert.equal(q.tickets.get("0000000000aa")?.claimBy, null);
  assert.deepEqual(q.expireClaims(NOW + 60 * MIN), [], "an old notified ticket without a timer never expires on its own");
  assert.equal(q.nextAlarmAt(), null);
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
  assert.equal(q.tickets.get(id)?.subs.length, 2);
  q.dropSub(id, sub(1).endpoint);
  assert.deepEqual(q.tickets.get(id)?.subs.map((s) => s.endpoint), [sub(2).endpoint]);
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
  assert.equal(c.meta?.nextNum, 2);
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
  assert.equal(cleared?.length, 2);
  assert.equal(q.tickets.size, 0);
  assert.equal(q.meta.nextResetAt, Date.UTC(2026, 10, 21, 16, 0));
  assert.equal(q.autoResetIfDue(Date.UTC(2026, 10, 20, 16, 1)), null, "does not reset twice");
});

test("a reset missed while nobody was around happens on the next request", () => {
  const q = new QueueCore();
  q.scheduleNextReset(NOW);
  join(q);
  const threeDaysLater = NOW + 3 * 86400_000;
  assert.equal(q.autoResetIfDue(threeDaysLater)?.length, 1);
  assert.ok((q.meta.nextResetAt ?? 0) > threeDaysLater);
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

test("push payload links to the ticket under its queue's address", () => {
  const q = new QueueCore();
  const t = join(q, { name: "Ana" }).ticket;
  assert.deepEqual(pushPayload(t, "/q/anas-milk-tea", "Ana's Milk Tea"), {
    title: "Your order is ready · No. 001",
    body: "Ana, come to the counter at Ana's Milk Tea.",
    url: `/q/anas-milk-tea/t/${t.id}`,
    tag: `ticket-${t.id}`,
  });
  const nameless = join(q).ticket;
  assert.equal(pushPayload(nameless, "", "").body, "Come to the counter.");
  assert.equal(pushPayload(nameless, "", "").url, `/t/${nameless.id}`);
});

test("a queue object that was never set up, or was deleted, only accepts set-up", () => {
  assert.equal(queueGate({ initialized: true, deleted: false }, "/api/join"), "serve");
  assert.equal(queueGate({ initialized: false, deleted: false }, "/api/join"), "gone", "an empty object (e.g. after a wipe and restart) serves nothing");
  assert.equal(queueGate({ initialized: false, deleted: false }, "/ws/staff"), "gone");
  assert.equal(queueGate({ initialized: false, deleted: false }, "/internal/init"), "init");
  assert.equal(queueGate({ initialized: true, deleted: false }, "/internal/init"), "init");
  assert.equal(queueGate({ initialized: true, deleted: false }, "/internal/wipe"), "wipe");
  assert.equal(queueGate({ initialized: true, deleted: true }, "/api/state"), "gone");
  assert.equal(queueGate({ initialized: true, deleted: true }, "/internal/init"), "gone", "a deleted queue is never set up again");
});
