// One Durable Object = one shop's queue. It stores the queue in its built-in SQLite database,
// holds the live connections of staff screens and customer phones, sends lock-screen pushes,
// and runs the automatic daily reset with a Durable Object alarm.

import { DurableObject } from "cloudflare:workers";
import { QueueCore, isAction, MAX_TICKETS_PER_DAY } from "./queue-core.ts";
import type { Meta, Ticket } from "./queue-core.ts";
import { sendPush } from "./push.ts";
import type { VapidKeys } from "./push.ts";

const POLL_ONLINE_MS = 25_000; // phone counts as "page open" if it polled this recently (fallback mode)
const MAX_BODY = 10_000;

const json = (obj: unknown, status = 200): Response => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    const v: unknown = JSON.parse(text || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class QueueDO extends DurableObject<Env> {
  sql: SqlStorage;
  core: QueueCore;
  lastSeen = new Map<string, number>(); // ticket id -> last poll time (memory only)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const tickets = this.sql.exec<{ data: string }>("SELECT data FROM tickets").toArray().map((r) => JSON.parse(r.data) as Ticket);
    const metaRow = this.sql.exec<{ v: string }>("SELECT v FROM meta WHERE k = 'state'").toArray()[0];
    this.core = new QueueCore({ tickets, meta: metaRow ? (JSON.parse(metaRow.v) as Meta) : {} });

    // Phones send "ping" every 30s to keep the connection alive; answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      const now = Date.now();
      this.#applyReset(this.core.autoResetIfDue(now));
      this.#applyExpiry(this.core.expireClaims(now));
      await this.#syncAlarm();
    });
  }

  // ---------- storage ----------
  #save(): void {
    const c = this.core.takeChanges();
    if (c.clearAll) this.sql.exec("DELETE FROM tickets");
    for (const id of c.del) this.sql.exec("DELETE FROM tickets WHERE id = ?", id);
    for (const t of c.put) this.sql.exec("INSERT OR REPLACE INTO tickets (id, data) VALUES (?, ?)", t.id, JSON.stringify(t));
    if (c.meta) this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('state', ?)", JSON.stringify(c.meta));
  }

  /** One alarm covers both the daily reset and the earliest claim deadline. */
  async #syncAlarm(): Promise<void> {
    const want = this.core.nextAlarmAt();
    const have = await this.ctx.storage.getAlarm();
    if (want == null) { if (have != null) await this.ctx.storage.deleteAlarm(); }
    else if (have !== want) await this.ctx.storage.setAlarm(want);
  }

  // ---------- live updates ----------
  #isOnline = (id: string): boolean =>
    this.ctx.getWebSockets("t:" + id).some((ws) => ws.readyState === WebSocket.OPEN) ||
    Date.now() - (this.lastSeen.get(id) || 0) < POLL_ONLINE_MS;

  staffState() {
    const { settings, nextResetAt, dayStartedAt, nextNum } = this.core.meta;
    return {
      type: "state", tickets: this.core.list(this.#isOnline), settings, nextResetAt, dayStartedAt,
      ticketsToday: nextNum - 1, maxTickets: MAX_TICKETS_PER_DAY,
    };
  }

  #send(ws: WebSocket, msg: unknown): void { try { ws.send(JSON.stringify(msg)); } catch {} }
  #broadcastStaff(): void {
    const sockets = this.ctx.getWebSockets("staff");
    if (!sockets.length) return;
    const msg = this.staffState();
    for (const ws of sockets) this.#send(ws, msg);
  }
  #customerMsg(id: string) { return { type: "status", ...this.core.customerView(id, Date.now()) }; }

  /**
   * Any change can move everyone's place in line or wait estimate, so every connected phone gets its
   * current view. (Outgoing WebSocket messages are free; phones never need to poll while connected.)
   */
  #notifyCustomers(): void {
    for (const ws of this.ctx.getWebSockets()) {
      const tag = this.ctx.getTags(ws).find((t) => t.startsWith("t:"));
      if (tag) this.#send(ws, this.#customerMsg(tag.slice(2)));
    }
  }

  /** After claim timers ran out: save, then tell the phones and staff screens. */
  #applyExpiry(expiredIds: string[]): void {
    if (!expiredIds.length) return;
    this.#save();
    this.#notifyCustomers();
    this.#broadcastStaff();
  }

  /** After a reset: tell every waiting phone, then close their connections. */
  #applyReset(clearedIds: string[] | null): void {
    if (!clearedIds) { this.#save(); return; }
    this.#save();
    for (const id of clearedIds) {
      for (const ws of this.ctx.getWebSockets("t:" + id)) {
        this.#send(ws, { type: "status", status: "reset" });
        try { ws.close(1000, "reset"); } catch {}
      }
    }
    this.lastSeen.clear();
    this.#broadcastStaff();
  }

  // ---------- push ----------
  async #pushTicket(t: Ticket): Promise<void> {
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = this.env;
    if (!publicKey || !privateKey || !subject) { console.log("push skipped: VAPID keys not set"); return; }
    const vapid: VapidKeys = { publicKey, privateKey, subject };
    const no = String(t.num).padStart(3, "0");
    const shop = this.core.meta.settings.queueName;
    const payload = JSON.stringify({
      title: `Your order is ready · No. ${no}`,
      body: (t.name ? t.name + ", c" : "C") + "ome to the counter" + (shop ? " at " + shop : "") + ".",
      url: `/t/${t.id}`, tag: `ticket-${t.id}`,
    });
    let changed = false;
    for (const sub of [...t.subs]) {
      try {
        const r = await sendPush(sub, payload, vapid);
        if (!r.ok) console.log(`push failed for #${t.num}: ${r.status}`);
        if (r.gone) { this.core.dropSub(t.id, sub.endpoint); changed = true; }
      } catch (e) { console.log(`push error for #${t.num}: ${e instanceof Error ? e.message : String(e)}`); }
    }
    if (changed) { this.#save(); this.#broadcastStaff(); }
  }

  // ---------- requests ----------
  async fetch(request: Request): Promise<Response> {
    const now = Date.now();
    const cleared = this.core.autoResetIfDue(now);
    const expired = this.core.expireClaims(now);
    if (cleared) this.#applyReset(cleared);
    this.#applyExpiry(expired);
    if (cleared || expired.length) await this.#syncAlarm();

    const url = new URL(request.url);
    const p = url.pathname;
    const post = request.method === "POST";
    let m: RegExpMatchArray | null;

    if (p === "/ws/staff") return this.#acceptSocket(request, "staff", () => this.staffState());
    if ((m = p.match(/^\/ws\/t\/([a-f0-9]{12})$/))) {
      const id = m[1]!;
      return this.#acceptSocket(request, "t:" + id, () => this.#customerMsg(id), () => this.#broadcastStaff());
    }

    if (p === "/api/state") return json(this.staffState());

    // For the join page: queue name, people waiting, and the wait a new customer can expect.
    if (p === "/api/info") return json(this.#queueInfo());

    if (p === "/api/join" && post) {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const r = this.core.join(body, { now, newId });
      if ("error" in r) return json({ error: "full" }, 429);
      this.#save();
      if (r.created) { this.#broadcastStaff(); this.#notifyCustomers(); }
      return json(this.core.publicTicket(r.ticket));
    }

    if ((m = p.match(/^\/api\/ticket\/([a-f0-9]{12})$/))) {
      const id = m[1]!;
      const t = this.core.tickets.get(id);
      return json({ ticket: t ? this.core.publicTicket(t) : null, status: this.core.status(id), view: this.core.customerView(id, now), info: this.#queueInfo() });
    }

    if ((m = p.match(/^\/api\/status\/([a-f0-9]{12})$/))) {
      const id = m[1]!;
      if (this.core.tickets.has(id)) {
        const wasOnline = this.#isOnline(id);
        this.lastSeen.set(id, now);
        if (!wasOnline) this.#broadcastStaff();
      }
      return json(this.core.customerView(id, now));
    }

    if ((m = p.match(/^\/api\/subscribe\/([a-f0-9]{12})$/)) && post) {
      const sub = await readJson(request);
      const ok = this.core.subscribe(m[1]!, sub);
      if (ok) { this.#save(); this.#broadcastStaff(); }
      return json({ ok });
    }

    if ((m = p.match(/^\/api\/([a-z]+)\/([a-f0-9]{12})$/)) && post && isAction(m[1]!)) {
      const action = m[1]!;
      const id = m[2]!;
      const r = this.core.act(action, id, now);
      if (r.ok) {
        this.#save();
        if (r.changed) this.#notifyCustomers();
        if (r.removed) for (const ws of this.ctx.getWebSockets("t:" + id)) try { ws.close(1000, "removed"); } catch {}
        if (r.changed) this.#broadcastStaff();
        // Push goes out after the state is saved; every Notify (also a repeat) sends it.
        if (action === "buzz" && r.ticket?.subs.length) this.ctx.waitUntil(this.#pushTicket(r.ticket));
        await this.#syncAlarm();
      }
      return json({ ok: r.ok, status: this.core.status(id) });
    }

    if (p === "/api/reset" && post) {
      this.#applyReset(this.core.reset(now));
      await this.#syncAlarm();
      return json({ ok: true });
    }

    if (p === "/api/settings" && post) {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const r = this.core.setSettings(body, now);
      if (!r.ok) return json(r, 400);
      this.#save();
      await this.#syncAlarm();
      this.#broadcastStaff();
      return json({ ok: true, settings: this.core.meta.settings, nextResetAt: this.core.meta.nextResetAt });
    }

    return new Response("Not found", { status: 404 });
  }

  #acceptSocket(request: Request, tag: string, firstMessage: () => unknown, onOpen?: () => void): Response {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [tag]);
    this.#send(server, firstMessage());
    if (onOpen) onOpen();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const cleared = this.core.autoResetIfDue(now);
    if (cleared) this.#applyReset(cleared);
    else { this.core.scheduleNextReset(now); this.#save(); }
    this.#applyExpiry(this.core.expireClaims(now));
    await this.#syncAlarm();
  }

  #queueInfo() {
    const waiting = this.core.waitingCount();
    return {
      queueName: this.core.meta.settings.queueName, waiting, waitMin: this.core.waitMinutes(waiting + 1), nextNum: this.core.meta.nextNum,
    };
  }

  webSocketMessage(): void {} // only "ping", answered by the auto-response

  webSocketClose(ws: WebSocket): void {
    try { ws.close(1000, "closing"); } catch {}
    if (this.ctx.getTags(ws).some((t) => t.startsWith("t:"))) this.#broadcastStaff();
  }

  webSocketError(ws: WebSocket): void { this.webSocketClose(ws); }
}
