// One Durable Object = one shop's queue. It stores the queue in its built-in SQLite database,
// holds the live connections of staff screens and customer phones, sends lock-screen pushes,
// and runs the automatic daily reset with a Durable Object alarm.

import { DurableObject } from "cloudflare:workers";
import { QueueCore, ACTIONS } from "./queue-core.js";
import { sendPush } from "./push.js";

const POLL_ONLINE_MS = 25_000; // phone counts as "page open" if it polled this recently (fallback mode)
const MAX_BODY = 10_000;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text || "{}"); } catch { return null; }
}

function newId() {
  return [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class QueueDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS tickets (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
    const tickets = this.sql.exec("SELECT data FROM tickets").toArray().map((r) => JSON.parse(r.data));
    const metaRow = this.sql.exec("SELECT v FROM meta WHERE k = 'state'").toArray()[0];
    this.core = new QueueCore({ tickets, meta: metaRow ? JSON.parse(metaRow.v) : {} });
    this.lastSeen = new Map(); // ticket id -> last poll time (memory only)

    // Phones send "ping" every 30s to keep the connection alive; answered without waking this object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.#applyReset(this.core.autoResetIfDue(Date.now()));
      await this.#syncAlarm();
    });
  }

  // ---------- storage ----------
  #save() {
    const c = this.core.takeChanges();
    if (c.clearAll) this.sql.exec("DELETE FROM tickets");
    for (const id of c.del) this.sql.exec("DELETE FROM tickets WHERE id = ?", id);
    for (const t of c.put) this.sql.exec("INSERT OR REPLACE INTO tickets (id, data) VALUES (?, ?)", t.id, JSON.stringify(t));
    if (c.meta) this.sql.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('state', ?)", JSON.stringify(c.meta));
  }

  async #syncAlarm() {
    const want = this.core.meta.nextResetAt;
    const have = await this.ctx.storage.getAlarm();
    if (want == null) { if (have != null) await this.ctx.storage.deleteAlarm(); }
    else if (have !== want) await this.ctx.storage.setAlarm(want);
  }

  // ---------- live updates ----------
  #isOnline = (id) =>
    this.ctx.getWebSockets("t:" + id).some((ws) => ws.readyState === WebSocket.OPEN) ||
    Date.now() - (this.lastSeen.get(id) || 0) < POLL_ONLINE_MS;

  staffState() {
    const { settings, nextResetAt, dayStartedAt } = this.core.meta;
    return { type: "state", tickets: this.core.list(this.#isOnline), settings, nextResetAt, dayStartedAt };
  }

  #send(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }
  #broadcastStaff() {
    const sockets = this.ctx.getWebSockets("staff");
    if (!sockets.length) return;
    const msg = this.staffState();
    for (const ws of sockets) this.#send(ws, msg);
  }
  #notifyTicket(id) {
    const msg = { type: "status", status: this.core.status(id) };
    for (const ws of this.ctx.getWebSockets("t:" + id)) this.#send(ws, msg);
  }

  /** After a reset: tell every waiting phone, then close their connections. */
  #applyReset(clearedIds) {
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
  async #pushTicket(t) {
    const vapid = { publicKey: this.env.VAPID_PUBLIC_KEY, privateKey: this.env.VAPID_PRIVATE_KEY, subject: this.env.VAPID_SUBJECT };
    if (!vapid.publicKey || !vapid.privateKey || !vapid.subject) { console.log("push skipped: VAPID keys not set"); return; }
    const payload = JSON.stringify({
      title: `🔔 Order #${t.num} is ready!`,
      body: (t.name ? t.name + ", p" : "P") + "lease come to the counter.",
      url: `/t/${t.id}`, tag: `ticket-${t.id}`,
    });
    let changed = false;
    for (const sub of [...t.subs]) {
      try {
        const r = await sendPush(sub, payload, vapid);
        if (!r.ok) console.log(`push failed for #${t.num}: ${r.status}`);
        if (r.gone) { this.core.dropSub(t.id, sub.endpoint); changed = true; }
      } catch (e) { console.log(`push error for #${t.num}: ${e.message}`); }
    }
    if (changed) { this.#save(); this.#broadcastStaff(); }
  }

  // ---------- requests ----------
  async fetch(request) {
    const now = Date.now();
    const cleared = this.core.autoResetIfDue(now);
    if (cleared) { this.#applyReset(cleared); await this.#syncAlarm(); }

    const url = new URL(request.url);
    const p = url.pathname;
    const post = request.method === "POST";
    let m;

    if (p === "/ws/staff") return this.#acceptSocket(request, "staff", () => this.staffState());
    if ((m = p.match(/^\/ws\/t\/([a-f0-9]{12})$/))) {
      const id = m[1];
      return this.#acceptSocket(request, "t:" + id, () => ({ type: "status", status: this.core.status(id) }), () => this.#broadcastStaff());
    }

    if (p === "/api/state") return json(this.staffState());

    if (p === "/api/join" && post) {
      const body = await readJson(request);
      if (!body) return json({ error: "bad request" }, 400);
      const r = this.core.join(body, { now, newId });
      if (r.error === "full") return json({ error: "full" }, 429);
      this.#save();
      if (r.created) this.#broadcastStaff();
      return json(this.core.publicTicket(r.ticket));
    }

    if ((m = p.match(/^\/api\/ticket\/([a-f0-9]{12})$/))) {
      const t = this.core.tickets.get(m[1]);
      return json({ ticket: t ? this.core.publicTicket(t) : null, status: this.core.status(m[1]) });
    }

    if ((m = p.match(/^\/api\/status\/([a-f0-9]{12})$/))) {
      const id = m[1];
      const status = this.core.status(id);
      if (this.core.tickets.has(id)) {
        const wasOnline = this.#isOnline(id);
        this.lastSeen.set(id, now);
        if (!wasOnline) this.#broadcastStaff();
      }
      return json({ status });
    }

    if ((m = p.match(/^\/api\/subscribe\/([a-f0-9]{12})$/)) && post) {
      const sub = await readJson(request);
      const ok = this.core.subscribe(m[1], sub);
      if (ok) { this.#save(); this.#broadcastStaff(); }
      return json({ ok });
    }

    if ((m = p.match(/^\/api\/([a-z]+)\/([a-f0-9]{12})$/)) && post && ACTIONS.includes(m[1])) {
      const [, action, id] = m;
      const r = this.core.act(action, id);
      if (r.ok) {
        this.#save();
        if (r.changed) this.#notifyTicket(id);
        if (r.removed) for (const ws of this.ctx.getWebSockets("t:" + id)) try { ws.close(1000, "removed"); } catch {}
        if (r.changed) this.#broadcastStaff();
        // Push goes out after the state is saved; a re-buzz sends it again even though nothing changed.
        if (action === "buzz" && r.ticket.subs.length) this.ctx.waitUntil(this.#pushTicket(r.ticket));
      }
      return json({ ok: r.ok, status: this.core.status(id) });
    }

    if (p === "/api/reset" && post) {
      this.#applyReset(this.core.reset(now));
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

  #acceptSocket(request, tag, firstMessage, onOpen) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [tag]);
    this.#send(server, firstMessage());
    if (onOpen) onOpen();
    return new Response(null, { status: 101, webSocket: client });
  }

  async alarm() {
    const now = Date.now();
    const cleared = this.core.autoResetIfDue(now);
    if (cleared) this.#applyReset(cleared);
    else { this.core.scheduleNextReset(now); this.#save(); }
    await this.#syncAlarm();
  }

  webSocketMessage() {} // only "ping", answered by the auto-response

  webSocketClose(ws) {
    try { ws.close(1000, "closing"); } catch {}
    if (this.ctx.getTags(ws).some((t) => t.startsWith("t:"))) this.#broadcastStaff();
  }

  webSocketError(ws) { this.webSocketClose(ws); }
}
