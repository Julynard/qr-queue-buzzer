// Worker entry: serves the pages, runs accounts (/api/auth/*), and passes each queue's calls and live
// connections to that queue's Durable Object after checking who may make them.

import STAFF_HTML from "./pages/staff.html";
import POSTER_HTML from "./pages/poster.html";
import CUSTOMER_HTML from "./pages/customer.html";
import SW_JS from "./pages/sw.txt";
import ICON_SVG from "./pages/icon.svg";
import HOME_HTML from "./pages/home.html";
import LOGIN_HTML from "./pages/login.html";
import START_HTML from "./pages/start.html";
import APP_HTML from "./pages/app.html";
import PRIVACY_HTML from "./pages/privacy.html";

export { QueueDO } from "./queue-do.ts";
import { createAuth, getSession, signInMethods } from "./auth.ts";
import { handleAppApi } from "./app-api.ts";
import { classifyQueuePath } from "./access.ts";
import { findQueueBySlug, isMember, renameQueue } from "./queues.ts";
import type { QueueRow } from "./queues.ts";
import type { CustomerView, PublicTicket } from "./queue-core.ts";
import { safeJson, fill, escHtml } from "./html.ts";

interface QueueInfo { queueName: string; waiting: number; waitMin: number | null; nextNum: number }

const send = (body: BodyInit | null, type: string, extra: Record<string, string> = {}, status = 200): Response =>
  new Response(body, { status, headers: { "Content-Type": type, ...extra } });
const html = (body: string, status = 200): Response => send(body, "text/html; charset=utf-8", { "Cache-Control": "no-store" }, status);
const json = (obj: unknown, status = 200): Response => send(JSON.stringify(obj), "application/json", {}, status);
const redirect = (to: string): Response => new Response(null, { status: 302, headers: { Location: to } });
const notFound = (): Response => html("<!doctype html><meta charset=utf-8><title>Not found</title><p>This queue doesn't exist. Check the QR code or ask the staff.</p>", 404);

const isPage = (forward: string): boolean => !forward.startsWith("/api/") && !forward.startsWith("/ws/");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    // PUBLIC_URL lets local testing put a phone-reachable address in the QR (e.g. http://192.168.1.5:8787).
    const origin = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");
    let m: RegExpMatchArray | null;

    if (p.startsWith("/api/auth/")) return createAuth(env, request).handler(request);

    if (p === "/") return html(HOME_HTML);
    if (p === "/privacy") return html(PRIVACY_HTML);
    if (p === "/start") return html(fill(START_HTML, { METHODS: safeJson(signInMethods(env)) }));
    if (p === "/login" || p === "/app" || p.startsWith("/api/app/")) {
      const auth = createAuth(env, request);
      const session = await getSession(auth, request);
      if (p === "/login") {
        const next = url.searchParams.get("next") ?? "";
        if (session) return redirect(/^\/(?!\/)/.test(next) ? next : "/app");
        return html(fill(LOGIN_HTML, { METHODS: safeJson(signInMethods(env)), TURNSTILE_SITE: env.TURNSTILE_SITE_KEY }));
      }
      if (p === "/app") return session ? html(APP_HTML) : redirect("/login?next=/app");
      return handleAppApi(request, env, auth, session);
    }

    if (p === "/sw.js") return send(SW_JS, "application/javascript", { "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" });
    if (p === "/icon.svg") return send(ICON_SVG, "image/svg+xml");
    if (p === "/manifest.json") return send(manifest("/", "/"), "application/manifest+json");

    // The single public queue from before accounts is retired.
    if (p === "/staff") return redirect("/login");
    if (p === "/join" || /^\/t\/[a-f0-9]{12}$/.test(p)) return redirect("/");

    if ((m = p.match(/^\/q\/([a-z0-9-]{1,40})(\/.*)?$/))) {
      const row = await findQueueBySlug(env.DB, m[1]!);
      if (!row) return notFound(); // no Durable Object is created for an unknown address
      const route = classifyQueuePath(m[2] ?? "", request.method);
      if (!route) return notFound();
      if (route.kind === "member") {
        const session = await getSession(createAuth(env, request), request);
        if (!session) return isPage(route.forward) ? redirect("/login?next=" + encodeURIComponent(p)) : json({ error: "log in first" }, 401);
        if (!(await isMember(env.DB, session.user.id, row.workspace_id))) return isPage(route.forward) ? html("<!doctype html><meta charset=utf-8><p>You are not on this queue's team.</p>", 403) : json({ error: "not on this queue's team" }, 403);
      }
      return queueRoute(request, env, row, route.forward, origin);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

function manifest(startUrl: string, scope: string): string {
  return JSON.stringify({
    name: "Aqona", short_name: "Aqona", start_url: startUrl, scope,
    display: "standalone", background_color: "#E9EDF1", theme_color: "#E9EDF1",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  });
}

/** A request under /q/<slug>, already allowed. `forward` is the path inside the queue (e.g. /api/buzz/<id>). */
async function queueRoute(request: Request, env: Env, row: QueueRow, forward: string, origin: string): Promise<Response> {
  const stub = env.QUEUE.get(env.QUEUE.idFromName(row.id));
  const base = `/q/${row.slug}`;
  const internal = (path: string) => stub.fetch(new Request("https://queue" + path));
  let m: RegExpMatchArray | null;

  if (forward === "/staff") return html(fill(STAFF_HTML, { JOIN: origin + base, BASE: base }));
  if (forward === "/qr") {
    const info = (await (await internal("/api/info")).json()) as QueueInfo;
    return html(fill(POSTER_HTML, { JOIN: origin + base, QUEUE_NAME: escHtml(info.queueName) }));
  }
  if ((m = forward.match(/^\/manifest\/([a-f0-9]{12})\.json$/))) {
    return send(manifest(`${base}/t/${m[1]}`, `${base}/`), "application/manifest+json");
  }
  if (forward === "/join" || (m = forward.match(/^\/t\/([a-f0-9]{12})$/))) {
    let ticket: PublicTicket | null = null;
    let view: CustomerView | null = null;
    let info: QueueInfo;
    let notice = "";
    if (forward !== "/join" && m) {
      const d = (await (await internal(`/api/ticket/${m[1]}`)).json()) as { ticket: PublicTicket | null; status: string; view: CustomerView; info: QueueInfo };
      ticket = d.ticket;
      view = d.ticket ? d.view : null;
      info = d.info;
      if (d.status === "reset") notice = "The queue was reset for a new day. Please join again.";
      else if (d.status === "gone") notice = "That ticket is no longer in the queue. You can join again.";
    } else {
      info = (await (await internal("/api/info")).json()) as QueueInfo;
    }
    return html(fill(CUSTOMER_HTML, {
      TICKET: safeJson(ticket), VIEW: safeJson(view), QUEUE: safeJson(info), NOTICE: safeJson(notice), BASE: safeJson(base),
      VAPID: env.VAPID_PUBLIC_KEY || "", MANIFEST: ticket ? `${base}/manifest/${ticket.id}.json` : "/manifest.json",
    }));
  }

  // API calls and live connections: same request, path rewritten to the queue's own route.
  const target = new URL(request.url);
  target.pathname = forward;
  const res = await stub.fetch(new Request(target.toString(), request));
  // Keep the dashboard's queue name in step with the name customers see.
  if (forward === "/api/settings" && res.ok) {
    const d = (await res.clone().json()) as { settings?: { queueName?: string } };
    const name = d.settings?.queueName;
    if (name && name !== row.name) await renameQueue(env.DB, row.id, name);
  }
  return res;
}
