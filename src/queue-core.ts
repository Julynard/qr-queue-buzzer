// Queue rules, with no I/O, so they can be unit-tested in plain Node.
// The Durable Object (queue-do.ts) owns one QueueCore, saves what it changed, and tells connected screens.
//
// Concurrency: a Durable Object handles one event at a time, and every method here is synchronous.
// Two customers joining "at the same time" are processed one after the other and get different numbers.

import { nextResetAfter, isValidResetTime, isValidTimeZone } from "./reset-time.ts";

export type TicketStatus = "waiting" | "buzzing" | "coming" | "done" | "noshow";
export type Action = "buzz" | "ack" | "done" | "remove";

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface Ticket {
  id: string;
  num: number;
  name: string;
  status: TicketStatus;
  key: string | null;
  createdAt: number;
  /** First time staff called this ticket (Notify, or Done straight from waiting). Feeds the wait estimate. */
  calledAt: number | null;
  /** Claim deadline while notified / on the way; at this time the ticket becomes No show. */
  claimBy: number | null;
  subs: PushSubscriptionJSON[];
}

export interface Settings {
  autoReset: boolean;
  resetTime: string; // "HH:MM", 24-hour
  timeZone: string; // IANA name
  queueName: string; // shown to customers, e.g. "Ana's Milk Tea · Counter 1"
  claimMinutes: number; // time to come after Notify before the ticket is a No show
}

export interface Meta {
  nextNum: number;
  settings: Settings;
  nextResetAt: number | null;
  dayStartedAt: number | null;
  lastResetIds: string[];
}

export interface Changes {
  clearAll: boolean;
  put: Ticket[];
  del: string[];
  meta: Meta | null;
}

export interface ListedTicket {
  id: string;
  num: number;
  name: string;
  status: TicketStatus;
  createdAt: number;
  online: boolean;
  push: boolean;
}

/** What a customer's phone is told about its ticket (WebSocket and polling use the same shape). */
export interface CustomerView {
  status: TicketStatus | "reset" | "gone";
  place: number | null; // 1 = next in line; only while waiting
  waitMin: number | null; // estimated minutes; null until there is enough history
  claimLeftMs: number | null; // time left to come to the counter after Notify
}

export interface PublicTicket {
  id: string;
  num: number;
  name: string;
  status: TicketStatus;
  createdAt: number;
}

export type JoinResult = { ticket: Ticket; created: boolean } | { error: "full" };
export interface ActResult { ok: boolean; changed: boolean; ticket?: Ticket; removed?: boolean }
export type SettingsResult = { ok: true } | { ok: false; error: string };

export const NAME_MAX = 30;
export const MAX_TICKETS_PER_DAY = 999;
export const QUEUE_NAME_MAX = 60;
export const CLAIM_MINUTES_MAX = 30;
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  autoReset: true, resetTime: "00:00", timeZone: "Asia/Manila", queueName: "", claimMinutes: 5,
});
const MIN_MS = 60_000;
// Wait estimate: typical (median) time each of the last few called tickets spent at the front of the line.
const WAIT_SAMPLES = 10;
const WAIT_MIN_SAMPLES = 3;

// Which statuses each action may start from. Anything else is ignored, so a late "On my way"
// tap can't bring back a ticket staff already marked done. A No show can still be notified again
// or marked done (late arrival).
const ALLOWED_FROM: Record<Exclude<Action, "remove">, readonly TicketStatus[]> = {
  buzz: ["waiting", "buzzing", "coming", "noshow"],
  ack: ["buzzing"],
  done: ["waiting", "buzzing", "coming", "noshow"],
};
// The claim timer runs while the customer is notified or on the way.
const CLAIMING: readonly TicketStatus[] = ["buzzing", "coming"];
const RESULT: Record<Exclude<Action, "remove">, TicketStatus> = { buzz: "buzzing", ack: "coming", done: "done" };
export const ACTIONS: readonly Action[] = ["buzz", "ack", "done", "remove"];
export const isAction = (s: string): s is Action => (ACTIONS as readonly string[]).includes(s);

const ID_RE = /^[a-f0-9]{12}$/;
const KEY_RE = /^[a-f0-9]{16,64}$/;
export const isTicketId = (s: unknown): s is string => typeof s === "string" && ID_RE.test(s);

interface PendingChanges { put: Set<string>; del: Set<string>; clearAll: boolean; meta: boolean }

export class QueueCore {
  tickets: Map<string, Ticket>;
  meta: Meta;
  changes!: PendingChanges;

  /** `saved` is what was loaded from storage. */
  constructor({ tickets = [], meta = {} }: { tickets?: Ticket[]; meta?: Partial<Meta> } = {}) {
    // Tickets saved before the claim timer existed have no calledAt / claimBy.
    this.tickets = new Map(tickets.map((t) => [t.id, { ...t, calledAt: t.calledAt ?? null, claimBy: t.claimBy ?? null }]));
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

  #resetChanges(): void { this.changes = { put: new Set(), del: new Set(), clearAll: false, meta: false }; }
  #touch(t: Ticket): void { this.changes.put.add(t.id); }
  #touchMeta(): void { this.changes.meta = true; }

  /** Returns and clears what changed since the last call, for the storage layer to save. */
  takeChanges(): Changes {
    const c = this.changes;
    this.#resetChanges();
    const put: Ticket[] = [];
    for (const id of c.put) {
      const t = this.tickets.get(id);
      if (t) put.push(t);
    }
    return { clearAll: c.clearAll, put, del: [...c.del], meta: c.meta ? this.meta : null };
  }

  /**
   * A customer joins. `key` is a random value the phone sends with its join tap; repeating the same
   * key (double tap, retry after a network error) returns the same ticket instead of a second one.
   */
  join({ name, key }: { name?: unknown; key?: unknown } = {}, { now, newId }: { now: number; newId: () => string }): JoinResult {
    const cleanKey = typeof key === "string" && KEY_RE.test(key) ? key : null;
    if (cleanKey) {
      for (const t of this.tickets.values()) if (t.key === cleanKey) return { ticket: t, created: false };
    }
    if (this.meta.nextNum > MAX_TICKETS_PER_DAY) return { error: "full" };

    let id: string;
    do id = newId(); while (this.tickets.has(id) || !isTicketId(id));

    const t: Ticket = {
      id, num: this.meta.nextNum++, name: String(name ?? "").trim().slice(0, NAME_MAX),
      status: "waiting", key: cleanKey, createdAt: now, calledAt: null, claimBy: null, subs: [],
    };
    this.tickets.set(id, t);
    if (this.meta.dayStartedAt == null) this.meta.dayStartedAt = now;
    this.#touch(t);
    this.#touchMeta();
    return { ticket: t, created: true };
  }

  /** Staff or customer action on a ticket. */
  act(action: string, id: string, now: number = Date.now()): ActResult {
    if (!isAction(action)) return { ok: false, changed: false };
    const t = this.tickets.get(id);
    if (!t) return { ok: false, changed: false };
    if (action === "remove") {
      this.tickets.delete(id);
      this.changes.put.delete(id);
      this.changes.del.add(id);
      return { ok: true, changed: true, removed: true, ticket: t };
    }
    if (!ALLOWED_FROM[action].includes(t.status)) return { ok: false, changed: false, ticket: t };
    let changed = t.status !== RESULT[action];
    t.status = RESULT[action];
    if (action !== "ack" && t.calledAt == null) { t.calledAt = now; changed = true; }
    // Every Notify (including a repeat) restarts the claim timer; Done stops it.
    if (action === "buzz") { t.claimBy = now + this.meta.settings.claimMinutes * MIN_MS; changed = true; }
    if (action === "done" && t.claimBy != null) { t.claimBy = null; changed = true; }
    if (changed) this.#touch(t);
    return { ok: true, changed, ticket: t };
  }

  /** Save a phone's push address for a ticket. Replaces an older copy of the same address. */
  subscribe(id: string, sub: unknown): boolean {
    const t = this.tickets.get(id);
    if (!t || !sub || typeof sub !== "object") return false;
    const { endpoint, keys } = sub as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    if (typeof endpoint !== "string" || !/^https:\/\//.test(endpoint)) return false;
    if (!keys || typeof keys.p256dh !== "string" || typeof keys.auth !== "string") return false;
    const clean: PushSubscriptionJSON = { endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } };
    t.subs = t.subs.filter((s) => s.endpoint !== clean.endpoint).slice(-4); // a phone needs 1; cap junk
    t.subs.push(clean);
    this.#touch(t);
    return true;
  }

  /** Forget a push address the push service says is dead (HTTP 404/410). */
  dropSub(id: string, endpoint: string): void {
    const t = this.tickets.get(id);
    if (!t) return;
    const before = t.subs.length;
    t.subs = t.subs.filter((s) => s.endpoint !== endpoint);
    if (t.subs.length !== before) this.#touch(t);
  }

  /** Notified / on-the-way tickets whose claim time has run out become No show. Returns their IDs. */
  expireClaims(now: number): string[] {
    const expired: string[] = [];
    for (const t of this.tickets.values()) {
      if (t.claimBy == null || now < t.claimBy || !CLAIMING.includes(t.status)) continue;
      t.status = "noshow";
      t.claimBy = null;
      this.#touch(t);
      expired.push(t.id);
    }
    return expired;
  }

  /** When the Durable Object alarm should next fire: daily reset or first claim deadline, whichever is first. */
  nextAlarmAt(): number | null {
    let next = this.meta.settings.autoReset ? this.meta.nextResetAt : null;
    for (const t of this.tickets.values()) {
      if (t.claimBy != null && CLAIMING.includes(t.status) && (next == null || t.claimBy < next)) next = t.claimBy;
    }
    return next;
  }

  /** How many customers are waiting (not yet called). A new customer would be this + 1. */
  waitingCount(): number {
    let n = 0;
    for (const t of this.tickets.values()) if (t.status === "waiting") n++;
    return n;
  }

  /** Place in line for a waiting ticket (1 = next), or null once it has been called. */
  place(id: string): number | null {
    const me = this.tickets.get(id);
    if (!me || me.status !== "waiting") return null;
    let ahead = 0;
    for (const t of this.tickets.values()) if (t.status === "waiting" && t.num < me.num) ahead++;
    return ahead + 1;
  }

  /**
   * Estimated minutes until a customer at `place` is called, or null without enough history.
   * For each called ticket, its time at the front of the line runs from when the previous ticket was
   * called (or from when it joined, if it joined later), to when it was called. This ignores quiet
   * spells with nobody waiting. The median of the last few is the typical time per ticket.
   */
  waitMinutes(place: number): number | null {
    const called = [...this.tickets.values()].filter((t) => t.calledAt != null).sort((a, b) => a.calledAt! - b.calledAt!);
    const gaps: number[] = [];
    let prev = -Infinity;
    for (const t of called) {
      gaps.push(t.calledAt! - Math.max(t.createdAt, prev));
      prev = t.calledAt!;
    }
    const recent = gaps.slice(-WAIT_SAMPLES).sort((a, b) => a - b);
    if (recent.length < WAIT_MIN_SAMPLES) return null;
    const mid = recent.length >> 1;
    const median = recent.length % 2 ? recent[mid]! : (recent[mid - 1]! + recent[mid]!) / 2;
    return Math.max(1, Math.round((place * median) / MIN_MS));
  }

  /** Everything a customer's phone shows about its ticket. */
  customerView(id: string, now: number): CustomerView {
    const t = this.tickets.get(id);
    const place = this.place(id);
    return {
      status: this.status(id),
      place,
      waitMin: place == null ? null : this.waitMinutes(place),
      claimLeftMs: t && t.claimBy != null && CLAIMING.includes(t.status) ? Math.max(0, t.claimBy - now) : null,
    };
  }

  /** What the customer page should show for a ticket ID. */
  status(id: string): TicketStatus | "reset" | "gone" {
    const t = this.tickets.get(id);
    if (t) return t.status;
    return this.meta.lastResetIds.includes(id) ? "reset" : "gone";
  }

  /** Start a new day: every ticket is cleared and numbering restarts at #1. */
  reset(now: number): string[] {
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

  /** Validate and apply settings, then work out the next reset time. A refused change applies nothing. */
  setSettings(input: { autoReset?: unknown; resetTime?: unknown; timeZone?: unknown; queueName?: unknown; claimMinutes?: unknown }, now: number): SettingsResult {
    const s: Settings = { ...this.meta.settings };
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
    if (input.queueName !== undefined) {
      if (typeof input.queueName !== "string") return { ok: false, error: "queueName must be text" };
      s.queueName = input.queueName.trim().slice(0, QUEUE_NAME_MAX);
    }
    if (input.claimMinutes !== undefined) {
      const m = input.claimMinutes;
      if (typeof m !== "number" || !Number.isInteger(m) || m < 1 || m > CLAIM_MINUTES_MAX) {
        return { ok: false, error: `claimMinutes must be a whole number from 1 to ${CLAIM_MINUTES_MAX}` };
      }
      s.claimMinutes = m;
    }
    this.meta.settings = s;
    this.scheduleNextReset(now);
    return { ok: true };
  }

  /** Recalculate nextResetAt from the settings (null when automatic reset is off). */
  scheduleNextReset(now: number): number | null {
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
  autoResetIfDue(now: number): string[] | null {
    if (this.meta.nextResetAt == null) { if (this.meta.settings.autoReset) this.scheduleNextReset(now); return null; }
    if (!this.meta.settings.autoReset || now < this.meta.nextResetAt) return null;
    const cleared = this.reset(now);
    this.scheduleNextReset(now);
    return cleared;
  }

  /** Tickets newest first, in the shape the staff screen uses. `isOnline(id)` comes from the DO. */
  list(isOnline: (id: string) => boolean = () => false): ListedTicket[] {
    return [...this.tickets.values()].sort((a, b) => b.num - a.num).map((t) => ({
      id: t.id, num: t.num, name: t.name, status: t.status, createdAt: t.createdAt, online: isOnline(t.id), push: t.subs.length > 0,
    }));
  }

  publicTicket(t: Ticket): PublicTicket { return { id: t.id, num: t.num, name: t.name, status: t.status, createdAt: t.createdAt }; }
}
