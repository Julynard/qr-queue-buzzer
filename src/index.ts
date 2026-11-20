// Worker entry: serves the pages and passes API calls and live connections to the shop's Durable Object.

import STAFF_HTML from "./pages/staff.html";
import POSTER_HTML from "./pages/poster.html";
import CUSTOMER_HTML from "./pages/customer.html";
import SW_JS from "./pages/sw.txt";
import ICON_SVG from "./pages/icon.svg";

export { QueueDO } from "./queue-do.ts";
import type { CustomerView, PublicTicket } from "./queue-core.ts";

interface QueueInfo { queueName: string; waiting: number; waitMin: number | null; nextNum: number }

// One shop for now. Multi-shop later = derive this name from the URL (e.g. /s/<shop>/...).
const SHOP = "default";

const send = (body: BodyInit | null, type: string, extra: Record<string, string> = {}): Response => new Response(body, { headers: { "Content-Type": type, ...extra } });
const html = (body: string): Response => send(body, "text/html; charset=utf-8", { "Cache-Control": "no-store" });

// Values are put into the page as JSON / plain text; escape "<" so a name can't close the <script> tag.
// Placeholders are filled with a replace function, because a plain replacement string treats "$'" / "$&" in a
// customer's name as special patterns and would paste other parts of the page into the script.
const safeJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");
// Fill every __NAME__ placeholder in one pass, so text pasted in (a customer's name, the queue name)
// is never scanned again: a name like "__VAPID__" stays a name.
const fill = (page: string, vals: Record<string, string>): string =>
  page.replace(/__([A-Z_]+?)__/g, (all, k: string) => (Object.hasOwn(vals, k) ? vals[k]! : all));
const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const p = url.pathname;
    // PUBLIC_URL lets local testing put a phone-reachable address in the QR (e.g. http://192.168.1.5:8787).
    const base = (env.PUBLIC_URL || url.origin).replace(/\/$/, "");
    const queue = env.QUEUE.get(env.QUEUE.idFromName(SHOP));
    let m: RegExpMatchArray | null = null;

    if (p === "/" || p === "/staff") return html(fill(STAFF_HTML, { JOIN: base + "/join" }));
    if (p === "/qr") {
      const info = (await (await queue.fetch(new Request(`${url.origin}/api/info`))).json()) as QueueInfo;
      return html(fill(POSTER_HTML, { JOIN: base + "/join", QUEUE_NAME: escHtml(info.queueName) }));
    }
    if (p === "/sw.js") return send(SW_JS, "application/javascript", { "Service-Worker-Allowed": "/", "Cache-Control": "no-cache" });
    if (p === "/icon.svg") return send(ICON_SVG, "image/svg+xml");

    // Per-ticket manifest so iPhone "Add to Home Screen" opens the right ticket
    if ((m = p.match(/^\/manifest(?:\/([a-f0-9]{12}))?\.json$/))) {
      return send(JSON.stringify({
        name: "Aqona", short_name: "Aqona", start_url: m[1] ? `/t/${m[1]}` : "/join", scope: "/",
        display: "standalone", background_color: "#E9EDF1", theme_color: "#E9EDF1",
        icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
      }), "application/manifest+json");
    }

    if (p === "/join" || (m = p.match(/^\/t\/([a-f0-9]{12})$/))) {
      let ticket: PublicTicket | null = null;
      let view: CustomerView | null = null;
      let info: QueueInfo;
      let notice = "";
      if (m) {
        const r = await queue.fetch(new Request(`${url.origin}/api/ticket/${m[1]}`));
        const d = (await r.json()) as { ticket: PublicTicket | null; status: string; view: CustomerView; info: QueueInfo };
        ticket = d.ticket;
        view = d.ticket ? d.view : null;
        info = d.info;
        if (d.status === "reset") notice = "The queue was reset for a new day. Please join again.";
        else if (d.status === "gone") notice = "That ticket is no longer in the queue. You can join again.";
      } else {
        info = (await (await queue.fetch(new Request(`${url.origin}/api/info`))).json()) as QueueInfo;
      }
      return html(fill(CUSTOMER_HTML, {
        TICKET: safeJson(ticket), VIEW: safeJson(view), QUEUE: safeJson(info), NOTICE: safeJson(notice),
        VAPID: env.VAPID_PUBLIC_KEY || "", MANIFEST: ticket ? `/manifest/${ticket.id}.json` : "/manifest.json",
      }));
    }

    if (p.startsWith("/api/") || p.startsWith("/ws/")) return queue.fetch(request);

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
