// Worker entry: serves the pages, runs accounts (/api/auth/*), and passes each queue's calls and live
// connections to that queue's Durable Object after checking who may make them.

import STAFF_HTML from "./pages/staff.html";
import POSTER_HTML from "./pages/poster.html";
import CUSTOMER_HTML from "./pages/customer.html";
import SW_JS from "./pages/sw.txt";
import ICON_SVG from "./pages/icon.svg";
import HOME_HTML from "./pages/home.html";
import LOGIN_HTML from "./pages/login.html";
import APP_HTML from "./pages/app.html";
import PRIVACY_HTML from "./pages/privacy.html";
import INVITE_HTML from "./pages/invite.html";
import DISPLAY_HTML from "./pages/display.html";

export { QueueDO } from "./queue-do.ts";
import { createAuth, getSession, signInMethods } from "./auth.ts";
import { handleAppApi } from "./app-api.ts";
import { allows, canManage, classifyQueuePath } from "./access.ts";
import type { Role } from "./access.ts";
import { findQueueBySlug, renameQueue, roleIn } from "./queues.ts";
import type { QueueRow } from "./queues.ts";
import type { CustomerView, PublicTicket } from "./queue-core.ts";
import { safeJson, fill, escHtml, safeNext } from "./html.ts";
import { inviteById, isLive } from "./team.ts";

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

    // Signed-in visitors don't see "Log in" / "Start free": they get a link to their dashboard instead.
    if (p === "/") return (await signedIn(env, request)) ? forSignedIn(HOME_HTML) : html(HOME_HTML);
    if (p === "/privacy") return html(PRIVACY_HTML);
    // "Start free" and "Log in" are one page now; old /start links keep working.
    if (p === "/start") return redirect((await signedIn(env, request)) ? "/app" : "/login");
    if (p === "/login" || p === "/app" || p.startsWith("/api/app/")) {
      const auth = createAuth(env, request);
      const session = await getSession(auth, request);
      if (p === "/login") {
        const next = safeNext(url.searchParams.get("next"), url.origin);
        if (session) return redirect(next);
        return html(fill(LOGIN_HTML, { METHODS: safeJson(signInMethods(env)), TURNSTILE_SITE: env.TURNSTILE_SITE_KEY, NEXT: safeJson(next) }));
      }
      if (p === "/app") return session ? html(APP_HTML) : redirect("/login?next=/app");
      return handleAppApi(request, env, auth, session);
    }

    // A staff invite link. Anyone with the link sees which shop it's for; joining needs the invited email.
    if ((m = p.match(/^\/invite\/([a-f0-9]{24})$/))) {
      const inv = await inviteById(env.DB, m[1]!);
      const session = await getSession(createAuth(env, request), request);
      const names = inv ? await env.DB.prepare('select o.name as shop, u.name as inviter from "organization" o, "user" u where o.id = ? and u.id = ?')
        .bind(inv.organizationId, inv.inviterId).first<{ shop: string; inviter: string }>() : null;
      const state = !inv || !names ? "missing" : inv.status === "canceled" ? "canceled" : inv.status === "accepted" ? "used" : !isLive(inv, Date.now()) ? "expired" : "ok";
      const info = { id: inv?.id ?? "", state, shop: names?.shop ?? "", inviter: names?.inviter ?? "", email: inv?.email ?? "", me: session?.user.email ?? null };
      return html(fill(INVITE_HTML, { INVITE: safeJson(info) }));
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
      let role: Role | null = null;
      if (route.need !== "public") {
        const session = await getSession(createAuth(env, request), request);
        if (!session) return isPage(route.forward) ? redirect("/login?next=" + encodeURIComponent(p)) : json({ error: "log in first" }, 401);
        role = await roleIn(env, session.user, row.workspace_id);
        if (!allows(route.need, role)) {
          const why = role ? "Only the owner can do this." : "You are not on this queue's team.";
          return isPage(route.forward) ? html(`<!doctype html><meta charset=utf-8><p>${why}</p>`, 403) : json({ error: why }, 403);
        }
      }
      return queueRoute(request, env, row, route.forward, origin, role);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// Better Auth's session cookie ("__Secure-" in front on https). No cookie: skip the database lookup.
const hasSessionCookie = (request: Request): boolean => /(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get("Cookie") ?? "");
async function signedIn(env: Env, request: Request): Promise<boolean> {
  return hasSessionCookie(request) && !!(await getSession(createAuth(env, request), request));
}

/** The home page for a signed-in visitor: "Log in" links go, "Start free" links open the dashboard. */
function forSignedIn(page: string): Response {
  const res = html(page);
  return new HTMLRewriter()
    .on('a[href="/login"]', { element: (el) => { el.remove(); } })
    .on('a[href="/start"]', { element: (el) => { el.setAttribute("href", "/app"); el.setInnerContent("Open dashboard"); } })
    .transform(res);
}

function manifest(startUrl: string, scope: string): string {
  return JSON.stringify({
    name: "Aqona", short_name: "Aqona", start_url: startUrl, scope,
    display: "standalone", background_color: "#E9EDF1", theme_color: "#E9EDF1",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  });
}

/** A request under /q/<slug>, already allowed. `forward` is the path inside the queue (e.g. /api/buzz/<id>). */
async function queueRoute(request: Request, env: Env, row: QueueRow, forward: string, origin: string, role: Role | null): Promise<Response> {
  const stub = env.QUEUE.get(env.QUEUE.idFromName(row.id));
  const base = `/q/${row.slug}`;
  // Reads the queue's own data; null when the queue is gone (deleted moments ago, still in the slug cache).
  const internal = async <T>(path: string): Promise<T | null> => {
    const r = await stub.fetch(new Request("https://queue" + path));
    return r.ok ? ((await r.json()) as T) : null;
  };
  let m: RegExpMatchArray | null;

  if (forward === "/staff") return html(fill(STAFF_HTML, { JOIN: origin + base, BASE: base, CAN_MANAGE: String(canManage(role)) }));
  // The "Now calling" screen for a TV at the counter: public, ticket numbers only.
  if (forward === "/display") {
    const info = await internal<QueueInfo>("/api/info");
    if (!info) return notFound();
    return html(fill(DISPLAY_HTML, { JOIN: origin + base, BASE: base, QUEUE_NAME: escHtml(info.queueName || "Now calling") }));
  }
  if (forward === "/qr") {
    const info = await internal<QueueInfo>("/api/info");
    if (!info) return notFound();
    return html(fill(POSTER_HTML, { JOIN: origin + base, QUEUE_NAME: escHtml(info.queueName) }));
  }
  if ((m = forward.match(/^\/manifest\/([a-f0-9]{12})\.json$/))) {
    return send(manifest(`${base}/t/${m[1]}`, `${base}/`), "application/manifest+json");
  }
  if (forward === "/join" || (m = forward.match(/^\/t\/([a-f0-9]{12})$/))) {
    let ticket: PublicTicket | null = null;
    let view: CustomerView | null = null;
    let info: QueueInfo | null;
    let notice = "";
    if (forward !== "/join" && m) {
      const d = await internal<{ ticket: PublicTicket | null; status: string; view: CustomerView; info: QueueInfo }>(`/api/ticket/${m[1]}`);
      if (!d) return notFound();
      ticket = d.ticket;
      view = d.ticket ? d.view : null;
      info = d.info;
      if (d.status === "reset") notice = "The queue was reset for a new day. Please join again.";
      else if (d.status === "gone") notice = "That ticket is no longer in the queue. You can join again.";
    } else {
      info = await internal<QueueInfo>("/api/info");
      if (!info) return notFound();
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
  if (res.status === 410) return isPage(forward) ? notFound() : json({ error: "This queue doesn't exist" }, 404);
  // Keep the dashboard's queue name in step with the name customers see.
  if (forward === "/api/settings" && res.ok) {
    const d = (await res.clone().json()) as { settings?: { queueName?: string } };
    const name = d.settings?.queueName;
    if (name && name !== row.name) await renameQueue(env.DB, row.id, name);
  }
  return res;
}
