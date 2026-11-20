// Queue rules, with no I/O, so they can be unit-tested in plain Node.
// The Durable Object (queue-do.ts) owns one QueueCore, saves what it changed, and tells connected screens.
//
// Concurrency: a Durable Object handles one event at a time, and every method here is synchronous.
// Two customers joining "at the same time" are processed one after the other and get different numbers.

import { nextResetAfter, isValidResetTime, isValidTimeZone } from "./reset-time.ts";

export type TicketStatus = "waiting" | "buzzing" | "coming" | "done";
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
  subs: PushSubscriptionJSON[];
}

export interface Settings {
  autoReset: boolean;
  resetTime: string; // "HH:MM", 24-hour
  timeZone: string; // IANA name
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
  online: boolean;
  push: boolean;
}

export interface PublicTicket {
  id: string;
  num: number;
  name: string;
  status: TicketStatus;
}

export type JoinResult = { ticket: Ticket; created: boolean } | { error: "full" };
export interface ActResult { ok: boolean; changed: boolean; ticket?: Ticket; removed?: boolean }
export type SettingsResult = { ok: true } | { ok: false; error: string };

export const NAME_MAX = 30;
export const MAX_TICKETS_PER_DAY = 999;
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({ autoReset: true, resetTime: "00:00", timeZone: "Asia/Manila" });

// Which statuses each action may start from. Anything else is ignored, so a late "OK, coming"
// tap can't bring back a ticket staff already marked done.
const ALLOWED_FROM: Record<Exclude<Action, "remove">, readonly TicketStatus[]> = {
  buzz: ["waiting", "buzzing", "coming"],
  ack: ["buzzing"],
  done: ["waiting", "buzzing", "coming"],
};
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
      status: "waiting", key: cleanKey, createdAt: now, subs: [],
    };
    this.tickets.set(id, t);
    if (this.meta.dayStartedAt == null) this.meta.dayStartedAt = now;
    this.#touch(t);
    this.#touchMeta();
    return { ticket: t, created: true };
  }

  /** Staff or customer action on a ticket. */
  act(action: string, id: string): ActResult {
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
    const changed = t.status !== RESULT[action];
    t.status = RESULT[action];
    if (changed) this.#touch(t);
    // Re-buzzing an already buzzing ticket is allowed (sends the push again) but changes no data.
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

  /** Validate and apply daily-reset settings, then work out the next reset time. */
  setSettings(input: { autoReset?: unknown; resetTime?: unknown; timeZone?: unknown }, now: number): SettingsResult {
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
      id: t.id, num: t.num, name: t.name, status: t.status, online: isOnline(t.id), push: t.subs.length > 0,
    }));
  }

  publicTicket(t: Ticket): PublicTicket { return { id: t.id, num: t.num, name: t.name, status: t.status }; }
}
