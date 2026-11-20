// Queue rules, with no I/O, so they can be unit-tested in plain Node.
// The Durable Object (queue-do.js) owns one QueueCore, saves what it changed, and tells connected screens.
//
// Concurrency: a Durable Object handles one event at a time, and every method here is synchronous.
// Two customers joining "at the same time" are processed one after the other and get different numbers.

import { nextResetAfter, isValidResetTime, isValidTimeZone } from "./reset-time.js";

export const NAME_MAX = 30;
export const MAX_TICKETS_PER_DAY = 999;
export const DEFAULT_SETTINGS = Object.freeze({ autoReset: true, resetTime: "00:00", timeZone: "Asia/Manila" });

// Which statuses each action may start from. Anything else is ignored, so a late "OK, coming"
// tap can't bring back a ticket staff already marked done.
const ALLOWED_FROM = {
  buzz: ["waiting", "buzzing", "coming"],
  ack: ["buzzing"],
  done: ["waiting", "buzzing", "coming"],
};
const RESULT = { buzz: "buzzing", ack: "coming", done: "done" };
export const ACTIONS = ["buzz", "ack", "done", "remove"];

const ID_RE = /^[a-f0-9]{12}$/;
const KEY_RE = /^[a-f0-9]{16,64}$/;
export const isTicketId = (s) => typeof s === "string" && ID_RE.test(s);

export class QueueCore {
  /**
   * @param {{ tickets?: object[], meta?: object }} saved  what was loaded from storage
   */
  constructor({ tickets = [], meta = {} } = {}) {
    this.tickets = new Map(tickets.map((t) => [t.id, t]));
    this.meta = {
      nextNum: 1,
      settings: { ...DEFAULT_SETTINGS },
      nextResetAt: null,
      dayStartedAt: null,
      lastResetIds: [],
      ...meta,
    };
    this.meta.settings = { ...DEFAULT_SETTINGS, ...this.meta.settings };
    this.#resetChanges();
  }

  #resetChanges() { this.changes = { put: new Set(), del: new Set(), clearAll: false, meta: false }; }
  #touch(t) { this.changes.put.add(t.id); }
  #touchMeta() { this.changes.meta = true; }

  /** Returns and clears what changed since the last call, for the storage layer to save. */
  takeChanges() {
    const c = this.changes;
    this.#resetChanges();
    return {
      clearAll: c.clearAll,
      put: [...c.put].filter((id) => this.tickets.has(id)).map((id) => this.tickets.get(id)),
      del: [...c.del],
      meta: c.meta ? this.meta : null,
    };
  }

  /**
   * A customer joins. `key` is a random value the phone sends with its join tap; repeating the same
   * key (double tap, retry after a network error) returns the same ticket instead of a second one.
   */
  join({ name, key } = {}, { now, newId }) {
    const cleanKey = typeof key === "string" && KEY_RE.test(key) ? key : null;
    if (cleanKey) {
      for (const t of this.tickets.values()) if (t.key === cleanKey) return { ticket: t, created: false };
    }
    if (this.meta.nextNum > MAX_TICKETS_PER_DAY) return { error: "full" };

    let id;
    do id = newId(); while (this.tickets.has(id) || !isTicketId(id));

    const t = {
      id, num: this.meta.nextNum++, name: String(name ?? "").trim().slice(0, NAME_MAX),
      status: "waiting", key: cleanKey, createdAt: now, subs: [],
    };
    this.tickets.set(id, t);
    if (this.meta.dayStartedAt == null) this.meta.dayStartedAt = now;
    this.#touch(t);
    this.#touchMeta();
    return { ticket: t, created: true };
  }

  /** Staff or customer action on a ticket. Returns { ok, changed, ticket?, removed? }. */
  act(action, id) {
    if (!ACTIONS.includes(action)) return { ok: false, changed: false };
    const t = this.tickets.get(id);
    if (!t) return { ok: false, changed: false };
    if (action === "remove") {
      this.tickets.delete(id);
      this.changes.put.delete(id);
      this.changes.del.add(id);
      return { ok: true, changed: true, removed: true, ticket: t };
    }
    if (!ALLOWED_FROM[action].includes(t.status)) return { ok: false, changed: false, ticket: t };
    const changed = t.status !== RESULT[action];
    t.status = RESULT[action];
    if (changed) this.#touch(t);
    // Re-buzzing an already buzzing ticket is allowed (sends the push again) but changes no data.
    return { ok: true, changed, ticket: t };
  }

  /** Save a phone's push address for a ticket. Replaces an older copy of the same address. */
  subscribe(id, sub) {
    const t = this.tickets.get(id);
    if (!t || !sub || typeof sub.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint)) return false;
    if (!sub.keys || typeof sub.keys.p256dh !== "string" || typeof sub.keys.auth !== "string") return false;
    const clean = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    t.subs = t.subs.filter((s) => s.endpoint !== clean.endpoint).slice(-4); // a phone needs 1; cap junk
    t.subs.push(clean);
    this.#touch(t);
    return true;
  }

  /** Forget a push address the push service says is dead (HTTP 404/410). */
  dropSub(id, endpoint) {
    const t = this.tickets.get(id);
    if (!t) return;
    const before = t.subs.length;
    t.subs = t.subs.filter((s) => s.endpoint !== endpoint);
    if (t.subs.length !== before) this.#touch(t);
  }

  /** What the customer page should show for a ticket ID. */
  status(id) {
    const t = this.tickets.get(id);
    if (t) return t.status;
    return this.meta.lastResetIds.includes(id) ? "reset" : "gone";
  }

  /** Start a new day: every ticket is cleared and numbering restarts at #1. */
  reset(now) {
    const cleared = [...this.tickets.keys()];
    this.tickets.clear();
    this.meta.nextNum = 1;
    this.meta.dayStartedAt = now;
    this.meta.lastResetIds = cleared.slice(-MAX_TICKETS_PER_DAY);
    this.changes.put.clear();
    this.changes.del.clear();
    this.changes.clearAll = true;
    this.#touchMeta();
    return cleared;
  }

  /** Validate and apply daily-reset settings, then work out the next reset time. */
  setSettings(input, now) {
    const s = { ...this.meta.settings };
    if (input.autoReset !== undefined) {
      if (typeof input.autoReset !== "boolean") return { ok: false, error: "autoReset must be true or false" };
      s.autoReset = input.autoReset;
    }
    if (input.resetTime !== undefined) {
      if (!isValidResetTime(input.resetTime)) return { ok: false, error: "resetTime must be HH:MM (24-hour)" };
      s.resetTime = input.resetTime;
    }
    if (input.timeZone !== undefined) {
      if (!isValidTimeZone(input.timeZone)) return { ok: false, error: "Unknown time zone" };
      s.timeZone = input.timeZone;
    }
    this.meta.settings = s;
    this.scheduleNextReset(now);
    return { ok: true };
  }

  /** Recalculate nextResetAt from the settings (null when automatic reset is off). */
  scheduleNextReset(now) {
    const { autoReset, resetTime, timeZone } = this.meta.settings;
    const next = autoReset ? nextResetAfter(now, resetTime, timeZone) : null;
    if (next !== this.meta.nextResetAt) { this.meta.nextResetAt = next; this.#touchMeta(); }
    return next;
  }

  /**
   * Run the automatic reset if its time has passed. Called on every request and from the alarm,
   * so a missed or late alarm still resets before anyone sees yesterday's queue.
   * Returns the cleared ticket IDs, or null when nothing happened.
   */
  autoResetIfDue(now) {
    if (this.meta.nextResetAt == null) { if (this.meta.settings.autoReset) this.scheduleNextReset(now); return null; }
    if (!this.meta.settings.autoReset || now < this.meta.nextResetAt) return null;
    const cleared = this.reset(now);
    this.scheduleNextReset(now);
    return cleared;
  }

  /** Tickets newest first, in the shape the staff screen uses. `isOnline(id)` comes from the DO. */
  list(isOnline = () => false) {
    return [...this.tickets.values()].sort((a, b) => b.num - a.num).map((t) => ({
      id: t.id, num: t.num, name: t.name, status: t.status, online: isOnline(t.id), push: t.subs.length > 0,
    }));
  }

  publicTicket(t) { return { id: t.id, num: t.num, name: t.name, status: t.status }; }
}
