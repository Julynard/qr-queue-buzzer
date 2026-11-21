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
  /** Only people near the shop (or with today's code) may take a number. Needs shopLat/shopLng. */
  nearbyOnly: boolean;
  /** The shop's location, set from a staff phone at the counter. Never shown to customers. */
  shopLat: number | null;
  shopLng: number | null;
}

export interface Meta {
  nextNum: number;
  settings: Settings;
  nextResetAt: number | null;
  dayStartedAt: number | null;
  lastResetIds: string[];
  /** The queue's public address prefix, e.g. "/q/anas-milk-tea" (set by the Worker). "" for the old single queue. */
  base?: string;
  /** Today's 4-digit code: staff tell it to customers who can't share their location. New every day. */
  joinCode?: string;
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

/** What a "Now calling" TV shows: ticket numbers only, never names. */
export interface DisplayView {
  type: "display";
  queueName: string;
  calling: number[];   // notified or on the way, most recently notified first
  preparing: number[]; // waiting, next in line first
  waitMin: number | null;
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

export type JoinResult = { ticket: Ticket; created: boolean } | { error: "full" | "nearby" };
export interface ActResult { ok: boolean; changed: boolean; ticket?: Ticket; removed?: boolean }
export type SettingsResult = { ok: true } | { ok: false; error: string };

export const NAME_MAX = 30;
export const MAX_TICKETS_PER_DAY = 999;
export const QUEUE_NAME_MAX = 60;
export const CLAIM_MINUTES_MAX = 30;
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  autoReset: true, resetTime: "00:00", timeZone: "Asia/Manila", queueName: "", claimMinutes: 5,
  nearbyOnly: false, shopLat: null, shopLng: null,
});
/** "Near the shop": within this many metres of the shop's saved location... */
export const NEARBY_M = 300;
/** ...plus the phone's reported GPS accuracy, up to this much (indoor GPS can be off by hundreds of metres). */
export const ACCURACY_SLACK_MAX_M = 200;
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
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A random 4-digit code, e.g. "0482". */
export function newJoinCode(): string {
  return String(crypto.getRandomValues(new Uint32Array(1))[0]! % 10_000).padStart(4, "0");
}

/** Distance in metres between two points (haversine; plenty accurate at shop scale). */
export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(a)));
}

interface PendingChanges { put: Set<string>; del: Set<string>; clearAll: boolean; meta: boolean }

/** Lock-screen notification for a notified ticket. `base` is the queue's address prefix. */
export function pushPayload(t: Ticket, base: string, queueName: string): { title: string; body: string; url: string; tag: string } {
  const no = String(t.num).padStart(3, "0");
  return {
    title: `Your order is ready · No. ${no}`,
    body: (t.name ? t.name + ", c" : "C") + "ome to the counter" + (queueName ? " at " + queueName : "") + ".",
    url: `${base}/t/${t.id}`,
    tag: `ticket-${t.id}`,
  };
}

/**
 * What a queue's Durable Object may do with a request. An object with no saved state was never set up
 * (or was wiped and then restarted): it serves nothing, so it can't schedule a daily-reset alarm for a
 * queue that no longer exists. A deleted queue is never set up again.
 */
export function queueGate(state: { initialized: boolean; deleted: boolean }, path: string): "serve" | "init" | "wipe" | "gone" {
  if (state.deleted) return "gone";
  if (path === "/internal/init") return "init";
  if (!state.initialized) return "gone";
  if (path === "/internal/wipe") return "wipe";
  return "serve";
}

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
    // Queues saved before today's code existed get one now (and it is saved with the next change).
    if (!this.meta.joinCode) { this.meta.joinCode = newJoinCode(); this.#touchMeta(); }
  }

  #resetChanges(): void { this.changes = { put: new Set(), del: new Set(), clearAll: false, meta: false }; }
  #touch(t: Ticket): void { this.changes.put.add(t.id); }
  #touchMeta(): void { this.changes.meta = true; }
  /** Mark meta as changed after setting a field directly (e.g. `base`). */
  touchMeta(): void { this.#touchMeta(); }

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
  join(
    { name, key, lat, lng, acc, code }: { name?: unknown; key?: unknown; lat?: unknown; lng?: unknown; acc?: unknown; code?: unknown } = {},
    { now, newId }: { now: number; newId: () => string },
  ): JoinResult {
    const cleanKey = typeof key === "string" && KEY_RE.test(key) ? key : null;
    if (cleanKey) {
      for (const t of this.tickets.values()) if (t.key === cleanKey) return { ticket: t, created: false };
    }
    if (!this.#mayJoin(lat, lng, acc, code)) return { error: "nearby" };
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

  /**
   * With "only people at the shop" on: the phone's location must be near the shop, or it must send today's
   * code. The location is the phone's own claim (it can be faked); it stops people joining from a photo of the QR.
   */
  #mayJoin(lat: unknown, lng: unknown, acc: unknown, code: unknown): boolean {
    const { nearbyOnly, shopLat, shopLng } = this.meta.settings;
    if (!nearbyOnly || shopLat == null || shopLng == null) return true;
    if (typeof code === "string" && code.replace(/\s/g, "") === this.meta.joinCode) return true;
    if (!isNum(lat) || !isNum(lng)) return false;
    const slack = isNum(acc) ? Math.min(Math.max(acc, 0), ACCURACY_SLACK_MAX_M) : 0;
    return distanceM(lat, lng, shopLat, shopLng) <= NEARBY_M + slack;
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

  /** Start a new day: every ticket is cleared, numbering restarts at #1, and today's code changes. */
  reset(now: number, joinCode: string = newJoinCode()): string[] {
    const cleared = [...this.tickets.keys()];
    this.tickets.clear();
    this.meta.nextNum = 1;
    this.meta.dayStartedAt = now;
    this.meta.lastResetIds = cleared.slice(-MAX_TICKETS_PER_DAY);
    this.meta.joinCode = joinCode;
    this.changes.put.clear();
    this.changes.del.clear();
    this.changes.clearAll = true;
    this.#touchMeta();
    return cleared;
  }

  /** Validate and apply settings, then work out the next reset time. A refused change applies nothing. */
  setSettings(
    input: { autoReset?: unknown; resetTime?: unknown; timeZone?: unknown; queueName?: unknown; claimMinutes?: unknown; nearbyOnly?: unknown; shopLat?: unknown; shopLng?: unknown },
    now: number,
  ): SettingsResult {
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
    if (input.shopLat !== undefined || input.shopLng !== undefined) {
      const { shopLat: la, shopLng: ln } = input;
      if (la === null && ln === null) { s.shopLat = null; s.shopLng = null; }
      else if (isNum(la) && isNum(ln) && Math.abs(la) <= 90 && Math.abs(ln) <= 180) { s.shopLat = la; s.shopLng = ln; }
      else return { ok: false, error: "The shop's location must be a latitude and longitude" };
    }
    if (input.nearbyOnly !== undefined) {
      if (typeof input.nearbyOnly !== "boolean") return { ok: false, error: "nearbyOnly must be true or false" };
      s.nearbyOnly = input.nearbyOnly;
    }
    if (s.nearbyOnly && (s.shopLat == null || s.shopLng == null)) return { ok: false, error: "Set the shop's location first" };
    this.meta.settings = s;
    this.#touchMeta();
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

  /** The display screen's view: numbers only, so a TV in a public place never shows names. */
  displayView(): DisplayView {
    const all = [...this.tickets.values()];
    const calledAt = (t: Ticket) => t.claimBy ?? t.calledAt ?? 0; // every Notify restarts claimBy, so a repeat call moves to the front
    const calling = all.filter((t) => t.status === "buzzing" || t.status === "coming").sort((a, b) => calledAt(b) - calledAt(a)).map((t) => t.num);
    const preparing = all.filter((t) => t.status === "waiting").sort((a, b) => a.num - b.num).map((t) => t.num);
    return { type: "display", queueName: this.meta.settings.queueName, calling, preparing, waitMin: this.waitMinutes(preparing.length + 1) };
  }

  publicTicket(t: Ticket): PublicTicket { return { id: t.id, num: t.num, name: t.name, status: t.status, createdAt: t.createdAt }; }
}
