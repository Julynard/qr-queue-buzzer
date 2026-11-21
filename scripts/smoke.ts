// End-to-end check against a running local server. Start `npm run dev` first, then:
//   npm run smoke                      (default http://127.0.0.1:8787)
//   npm run smoke -- http://host:port
// It signs up throwaway accounts with email codes read from the LOCAL database, so it only works
// against `wrangler dev` (EMAIL_MODE=console). Never point it at the live site.
import { devLogin } from "./dev-login.ts";

interface TicketJson { id: string; num: number; name: string; status: string }
interface StateJson { type: "state"; tickets: { id: string; num: number; online: boolean }[] }
interface StatusJson { status: string }
interface StatusMsg { type: "status"; status: string; place: number | null; waitMin: number | null; claimLeftMs: number | null }
type Msg = StateJson | StatusMsg;

const B = process.argv[2] ?? "http://127.0.0.1:8787";
// Set once the owner has signed up: the queue's address and the owner's session cookie.
let Q = "";
let COOKIE = "";
let fails = 0;
let passes = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) passes++;
  else fails++;
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " " + extra));
}
// Queue calls (paths inside the queue, e.g. "/api/join"), made as the owner.
const post = (p: string, body?: unknown): Promise<Response> =>
  fetch(B + Q + p, { method: "POST", headers: { "Content-Type": "application/json", Cookie: COOKIE }, body: body === undefined ? undefined : JSON.stringify(body) });
const getJson = async <T>(p: string): Promise<T> => (await (await fetch(B + Q + p, { headers: { Cookie: COOKIE } })).json()) as T;
const postJson = async <T>(p: string, body?: unknown): Promise<T> => (await (await post(p, body)).json()) as T;
const pageText = async (p: string): Promise<string> => (await fetch(B + Q + p, { headers: { Cookie: COOKIE } })).text();
// Site calls (full paths), with a given cookie (or none).
const site = (p: string, cookie = "", init: RequestInit = {}): Promise<Response> =>
  fetch(B + p, { redirect: "manual", ...init, headers: { "Content-Type": "application/json", Origin: B, ...(cookie ? { Cookie: cookie } : {}), ...(init.headers as Record<string, string> | undefined) } });
const scripts = (html: string): string => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
function parses(js: string): boolean {
  try { new Function(js); return true; } catch { return false; }
}

class Socket {
  ws: WebSocket;
  msgs: Msg[] = [];
  waiters: ((m: Msg) => boolean)[] = [];
  opened: Promise<void>;
  closed: Promise<number>;
  constructor(path: string, cookie = COOKIE) {
    // Node's WebSocket accepts extra headers (the session cookie for the staff connection).
    this.ws = new WebSocket(B.replace(/^http/, "ws") + Q + path, { headers: cookie ? { Cookie: cookie } : {} } as unknown as string[]);
    this.ws.addEventListener("message", (e: MessageEvent) => {
      const d = JSON.parse(String(e.data)) as Msg;
      this.msgs.push(d);
      this.waiters = this.waiters.filter((w) => !w(d));
    });
    this.opened = new Promise<void>((res, rej) => {
      this.ws.addEventListener("open", () => res());
      this.ws.addEventListener("error", () => rej(new Error("socket error")));
    });
    this.closed = new Promise<number>((res) => this.ws.addEventListener("close", (e: CloseEvent) => res(e.code)));
  }
  next<T extends Msg>(pred: (m: Msg) => boolean, ms = 3000): Promise<T> {
    return new Promise((res, rej) => {
      const found = this.msgs.find(pred);
      if (found) { this.msgs.splice(this.msgs.indexOf(found), 1); res(found as T); return; }
      const timer = setTimeout(() => rej(new Error("timeout waiting for message")), ms);
      this.waiters.push((d) => {
        if (!pred(d)) return false;
        clearTimeout(timer);
        this.msgs.splice(this.msgs.indexOf(d), 1);
        res(d as T);
        return true;
      });
    });
  }
  close(): void { this.ws.close(); }
}
const isState = (m: Msg): m is StateJson => m.type === "state";
const isStatus = (status?: string) => (m: Msg): boolean => m.type === "status" && (status === undefined || m.status === status);

// ---------- public site, old addresses ----------
for (const p of ["/", "/login", "/privacy", "/sw.js", "/icon.svg", "/manifest.json"]) {
  const r = await site(p);
  check(`GET ${p} -> 200`, r.status === 200, String(r.status));
}
check("unknown path -> 404", (await site("/nope")).status === 404);
check("unknown queue -> 404", (await site("/q/does-not-exist-zz")).status === 404);
check("dashboard needs log-in", (await site("/app")).headers.get("location") === "/login?next=/app");
check("old staff page -> log-in", (await site("/staff")).headers.get("location") === "/login");
check("old join page -> home", (await site("/join")).headers.get("location") === "/");
check("old ticket page -> home", (await site("/t/abc123abc123")).headers.get("location") === "/");
check("old queue API is gone", (await site("/api/state")).status === 404);

// ---------- sign up two shops ----------
const run = Date.now().toString(36);
const cookieA = await devLogin(`smoke-a-${run}@example.com`, B);
const cookieB = await devLogin(`smoke-b-${run}@example.com`, B);
check("email-code sign-in gives a session", !!cookieA && !!cookieB);
const meEmpty = await (await site("/api/app/me", cookieA)).json() as { workspaces: unknown[] };
check("a new account has no workspace yet", meEmpty.workspaces.length === 0);
const onboardA = await (await site("/api/app/onboard", cookieA, { method: "POST", body: JSON.stringify({ businessName: `Smoke Shop ${run}`, yourName: "Ana" }) })).json() as { slug: string; workspaceId: string };
check("Start free creates a workspace and its queue", /^smoke-shop-/.test(onboardA.slug ?? ""), JSON.stringify(onboardA));
await site("/api/app/onboard", cookieB, { method: "POST", body: JSON.stringify({ businessName: `Other Shop ${run}` }) });
Q = `/q/${onboardA.slug}`;
COOKIE = cookieA;
check("onboarding twice is refused", (await site("/api/app/onboard", cookieA, { method: "POST", body: JSON.stringify({ businessName: "Again" }) })).status === 409);
const second = await site("/api/app/queues", cookieA, { method: "POST", body: JSON.stringify({ workspaceId: onboardA.workspaceId, name: "Counter 2" }) });
check("Free plan: a second queue needs an upgrade (402)", second.status === 402, String(second.status));
check("Better Auth's own create-organization is switched off", (await site("/api/auth/organization/create", cookieA, { method: "POST", body: JSON.stringify({ name: "x", slug: `x-${run}` }) })).status === 404);

// ---------- who may do what ----------
check("customer join page is public", (await site(Q)).status === 200);
check("logged-out staff page -> log-in", (await site(Q + "/staff")).headers.get("location") === "/login?next=" + encodeURIComponent(Q + "/staff"));
check("logged-out staff list -> 401", (await site(Q + "/api/state")).status === 401);
check("logged-out notify -> 401", (await site(Q + "/api/buzz/abc123abc123", "", { method: "POST" })).status === 401);
check("logged-out poster -> log-in", (await site(Q + "/qr")).status === 302);
check("another shop's owner can't open the staff page (403)", (await site(Q + "/staff", cookieB)).status === 403);
check("another shop's owner can't notify (403)", (await site(Q + "/api/buzz/abc123abc123", cookieB, { method: "POST" })).status === 403);
check("internal queue routes are not reachable from outside", (await site(Q + "/internal/wipe", cookieA, { method: "POST" })).status === 404);
const anonStaff = new Socket("/ws/staff", "");
check("logged-out staff live connection is refused", await anonStaff.opened.then(() => false, () => true));
check("owner opens the staff page", (await site(Q + "/staff", cookieA)).status === 200);
check("owner's staff page shows Team and Settings", (await (await site(Q + "/staff", cookieA)).text()).includes("const CAN_MANAGE = true;"));
const homeOut = await (await site("/")).text();
check("logged-out home shows Log in and Start free", homeOut.includes('href="/login"') && homeOut.includes('href="/start"'));
const homeIn = await (await site("/", cookieA)).text();
check("signed-in home hides Log in and Start free", !homeIn.includes('href="/login"') && !homeIn.includes('href="/start"') && homeIn.includes("Open dashboard"));
check("signed-in Start free -> dashboard", (await site("/start", cookieA)).headers.get("location") === "/app");
check("logged-out Start free -> sign-in page", (await site("/start")).headers.get("location") === "/login");
check("another shop's owner can't change settings (403)", (await site(Q + "/api/settings", cookieB, { method: "POST", body: "{}" })).status === 403);

// ---------- team: invites (B owns "Other Shop" and joins A's shop as staff) ----------
const WS = onboardA.workspaceId;
const emailB = `smoke-b-${run}@example.com`;
const invite = (cookie: string, email: string) => site("/api/app/invites", cookie, { method: "POST", body: JSON.stringify({ workspaceId: WS, email }) });
check("Better Auth's own invite-member is switched off", (await site("/api/auth/organization/invite-member", cookieA, { method: "POST", body: JSON.stringify({ email: emailB, role: "member", organizationId: WS }) })).status === 404);
check("someone else's owner can't see the team (403)", (await site("/api/app/team?workspaceId=" + WS, cookieB)).status === 403);
check("someone else's owner can't invite (403)", (await invite(cookieB, "x@example.com")).status === 403);
check("invite: not an email -> 400", (await invite(cookieA, "bea@")).status === 400);
check("invite: your own email -> 400", (await invite(cookieA, `smoke-a-${run}@example.com`)).status === 400);
const inv1 = await (await invite(cookieA, emailB.toUpperCase())).json() as { id: string; email: string; link: string };
check("owner invites by email (stored lower-case, link returned)", inv1.email === emailB && /\/invite\/[a-f0-9]{24}$/.test(inv1.link ?? ""), JSON.stringify(inv1));
check("invite: same email again -> 400", (await invite(cookieA, emailB)).status === 400);
const invPage = await (await site("/invite/" + inv1.id)).text();
check("invite page opens logged out and names the shop", invPage.includes(`Smoke Shop ${run}`) && invPage.includes('"state":"ok"'));
check("invite page scripts parse", parses(scripts(invPage)));
const meB0 = await (await site("/api/app/me", cookieB)).json() as { invites: { id: string; shop: string }[] };
check("the invited person sees the invite on their dashboard", meB0.invites?.some((i) => i.id === inv1.id));
check("someone else can't accept B's invite", (await site(`/api/app/invites/${inv1.id}/accept`, cookieA, { method: "POST", body: "{}" })).status === 400);
const acc = await (await site(`/api/app/invites/${inv1.id}/accept`, cookieB, { method: "POST", body: "{}" })).json() as { slug: string };
check("B accepts and gets A's counter", acc.slug === onboardA.slug, JSON.stringify(acc));
check("accepting twice is harmless", (await site(`/api/app/invites/${inv1.id}/accept`, cookieB, { method: "POST", body: "{}" })).ok);
const meB = await (await site("/api/app/me", cookieB)).json() as { workspaces: { id: string; role: string }[] };
check("B is owner of one shop and staff at another", meB.workspaces.length === 2 && meB.workspaces.some((w) => w.id === WS && w.role === "member") && meB.workspaces.some((w) => w.role === "owner"));
check("staff opens A's counter page", (await site(Q + "/staff", cookieB)).status === 200);
check("staff can notify on A's counter", (await site(Q + "/api/buzz/abc123abc123", cookieB, { method: "POST" })).status !== 403);
check("staff still can't change settings (403)", (await site(Q + "/api/settings", cookieB, { method: "POST", body: "{}" })).status === 403);
check("staff can't see the team (403)", (await site("/api/app/team?workspaceId=" + WS, cookieB)).status === 403);
check("used invite page says so", (await (await site("/invite/" + inv1.id)).text()).includes('"state":"used"'));
const inv2 = await (await invite(cookieA, `smoke-x-${run}@example.com`)).json() as { id: string };
check("Free: owner + 1 staff + 1 invite fills the team -> 402", (await invite(cookieA, `smoke-y-${run}@example.com`)).status === 402);
const team = await (await site("/api/app/team?workspaceId=" + WS, cookieA)).json() as { members: { userId: string; role: string; email: string }[]; invites: { id: string }[]; seatsLeft: number };
check("team lists owner, staff and the open invite", team.members.length === 2 && team.invites.length === 1 && team.seatsLeft === 0, JSON.stringify(team));
check("owner cancels an invite", (await site(`/api/app/invites/${inv2.id}/cancel`, cookieA, { method: "POST", body: "{}" })).ok);
check("cancelled invite page says so", (await (await site("/invite/" + inv2.id)).text()).includes('"state":"canceled"'));
check("a seat is free again", ((await (await site("/api/app/team?workspaceId=" + WS, cookieA)).json()) as { seatsLeft: number }).seatsLeft === 1);
const bId = team.members.find((m) => m.email === emailB)!.userId;
check("owner can't remove themselves", (await site("/api/app/members/remove", cookieA, { method: "POST", body: JSON.stringify({ workspaceId: WS, userId: team.members.find((m) => m.role === "owner")!.userId }) })).status === 400);
check("owner removes B from the team", (await site("/api/app/members/remove", cookieA, { method: "POST", body: JSON.stringify({ workspaceId: WS, userId: bId }) })).ok);
check("removed staff can't open the counter page (403)", (await site(Q + "/staff", cookieB)).status === 403);

// ---------- display screen (public, numbers only) ----------
check("display page opens logged out", (await site(Q + "/display")).status === 200);
check("display page scripts parse", parses(scripts(await (await site(Q + "/display")).text())));
check("display API is GET only", (await site(Q + "/api/display", "", { method: "POST" })).status === 404);
const tv = new Socket("/ws/display", "");
await tv.opened;
const tvFirst = await tv.next<Msg>((m) => (m as unknown as { type: string }).type === "display") as unknown as { calling: number[]; preparing: number[] };
check("display socket sends the current view", Array.isArray(tvFirst.calling) && Array.isArray(tvFirst.preparing));
const zed = await (await fetch(B + Q + "/api/join", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Zed Secret", key: "z".repeat(32) }) })).json() as TicketJson;
const afterJoin = await tv.next<Msg>((m) => (m as unknown as { type: string; preparing?: number[] }).type === "display" && !!(m as unknown as { preparing: number[] }).preparing?.includes(zed.num)) as unknown as { preparing: number[] };
check("a new ticket shows under Preparing", afterJoin.preparing.includes(zed.num));
const dj = await (await site(Q + "/api/display")).text();
check("display never shows names", !dj.includes("Zed Secret") && dj.includes('"type":"display"'));
await post("/api/buzz/" + zed.id);
const afterBuzz = await tv.next<Msg>((m) => !!(m as unknown as { calling?: number[] }).calling?.includes(zed.num)) as unknown as { calling: number[] };
check("Notify moves the number to Now calling (live)", afterBuzz.calling[0] === zed.num);
await post("/api/done/" + zed.id);
tv.close();

check("manual reset", (await post("/api/reset")).ok);

const joins = await Promise.all(Array.from({ length: 20 }, (_, i) => postJson<TicketJson>("/api/join", { name: "C" + i })));
const nums = joins.map((t) => t.num).sort((a, b) => a - b);
check("20 parallel joins get numbers 1..20, no duplicates", nums.join(",") === Array.from({ length: 20 }, (_, i) => i + 1).join(","), nums.join(","));

const key = "c".repeat(32);
const [d1, d2] = await Promise.all([postJson<TicketJson>("/api/join", { key }), postJson<TicketJson>("/api/join", { key })]);
check("same join key twice in parallel -> one ticket", d1!.id === d2!.id && d1!.num === 21, JSON.stringify([d1, d2]));
check("bad JSON body -> 400", (await fetch(B + Q + "/api/join", { method: "POST", body: "{nope" })).status === 400);

const byNum = (n: number): TicketJson => joins.find((t) => t.num === n)!;
const t1 = byNum(1), t2 = byNum(2), t3 = byNum(3);

const staff = new Socket("/ws/staff");
await staff.opened;
const first = await staff.next<StateJson>(isState);
check("staff socket gets the list on connect", first.tickets.length === 21);
const cust = new Socket("/ws/t/" + t1.id);
await cust.opened;
const firstStatus = await cust.next<StatusMsg>(isStatus());
check("customer socket gets status and place on connect", firstStatus.status === "waiting" && firstStatus.place === 1, JSON.stringify(firstStatus));
const cust4 = new Socket("/ws/t/" + byNum(4).id);
await cust4.opened;
check("4th ticket is 4th in line", (await cust4.next<StatusMsg>(isStatus())).place === 4);
await staff.next((m) => isState(m) && !!m.tickets.find((t) => t.id === t1.id)?.online);
check("staff sees the customer's page as open", true);

await post("/api/buzz/" + t1.id);
const buzzed = await cust.next<StatusMsg>(isStatus("buzzing"));
check("notify reaches the customer live with a 5-minute claim timer",
  buzzed.claimLeftMs != null && buzzed.claimLeftMs > 4.9 * 60_000 && buzzed.claimLeftMs <= 5 * 60_000, JSON.stringify(buzzed));
check("everyone behind moves up live", (await cust4.next<StatusMsg>((m) => isStatus("waiting")(m) && (m as StatusMsg).place === 3)).place === 3);
cust4.close();
await post("/api/done/" + t1.id);
check("done reaches the customer live", (await cust.next<StatusMsg>(isStatus("done"))).status === "done");
const lateAck = await postJson<{ ok: boolean; status: string }>("/api/ack/" + t1.id);
check("late 'OK, coming' after done is refused", lateAck.ok === false && lateAck.status === "done", JSON.stringify(lateAck));
check("status stays done", (await getJson<StatusJson>("/api/status/" + t1.id)).status === "done");
cust.close();

const page1 = await pageText("/t/" + t1.id);
check("ticket page has the ticket", page1.includes(`"id":"${t1.id}"`) && page1.includes(`${Q}/manifest/${t1.id}.json`));
check("ticket page remembers the ticket per queue", page1.includes(`const BASE = "${Q}"`) && page1.includes("'buzzerTicket:' + BASE.split('/').pop()"));
const mf = (await getJson<{ start_url: string; scope: string }>(`/manifest/${t1.id}.json`));
check("home-screen app opens this queue's ticket", mf.start_url === `${Q}/t/${t1.id}` && mf.scope === `${Q}/`, JSON.stringify(mf));

await post("/api/remove/" + t2.id);
check("removed ticket reports gone", (await getJson<StatusJson>("/api/status/" + t2.id)).status === "gone");
check("removed ticket page shows a notice", (await pageText("/t/" + t2.id)).includes("no longer in the queue"));
check("unknown ticket action is a no-op", (await postJson<{ ok: boolean }>("/api/buzz/" + "0".repeat(12))).ok === false);

const evil = await postJson<TicketJson>("/api/join", { name: "</script><b>x" });
const evilPage = await pageText("/t/" + evil.id);
check("name can't break out of the page script", !evilPage.includes("</script><b>x") && evilPage.includes("\\u003c/script>"));
const dollar = await postJson<TicketJson>("/api/join", { name: "a$'b$&c" });
const dollarPage = await pageText("/t/" + dollar.id);
check("a name with $' or $& doesn't break the ticket page", parses(scripts(dollarPage)) && dollarPage.includes("a$'b$&c"));
for (const p of ["/staff", "/qr", "", "/t/" + dollar.id]) check(`page scripts parse: ${p || "join"}`, parses(scripts(await pageText(p))));
for (const p of ["/", "/login", "/app"]) check(`page scripts parse: ${p}`, parses(scripts(await (await site(p, cookieA)).text())));
const sneaky = await postJson<TicketJson>("/api/join", { name: "__VIEW____VAPID__" });
const sneakyPage = await pageText("/t/" + sneaky.id);
check("a name that looks like a placeholder stays a name", parses(scripts(sneakyPage)) && sneakyPage.includes('"name":"__VIEW____VAPID__"') && !sneakyPage.includes("'__VAPID__'"));

const evilQueue = "</script><b>x $' $& __NOTICE__ __JOIN__ · Counter";
check("queue name saves", (await postJson<{ ok: boolean }>("/api/settings", { queueName: evilQueue })).ok === true);
for (const p of ["", "/t/" + dollar.id]) {
  const page = await pageText(p);
  check(`queue name can't break out of the page script: ${p}`, !page.includes("</script><b>x") && parses(scripts(page)) && page.includes("$' $& __NOTICE__"));
}
const poster = await pageText("/qr");
check("poster shows the queue name as text", poster.includes("&lt;/script&gt;&lt;b&gt;x $&#39; $&amp; __NOTICE__ __JOIN__") && parses(scripts(poster)));
check("bad claim time refused", (await post("/api/settings", { claimMinutes: 0 })).status === 400);
check("queue name cleared", (await postJson<{ ok: boolean }>("/api/settings", { queueName: "" })).ok === true);
check("service worker parses", parses(await (await site("/sw.js")).text()));

const c3 = new Socket("/ws/t/" + t3.id);
await c3.opened;
await c3.next(isStatus());
await post("/api/reset");
check("reset tells waiting phones", (await c3.next<StatusMsg>(isStatus("reset"))).status === "reset");
check("reset closes their connection", (await c3.closed) === 1000);
check("old ticket reports reset", (await getJson<StatusJson>("/api/status/" + t3.id)).status === "reset");
check("old ticket page explains the reset", (await pageText("/t/" + t3.id)).includes("reset for a new day"));
check("numbering restarts at 1", (await postJson<TicketJson>("/api/join", {})).num === 1);
const st = await staff.next<StateJson>((m) => isState(m) && m.tickets.length === 1);
check("staff list shows only the new day's ticket", st.tickets[0]?.num === 1);

check("bad reset time refused", (await post("/api/settings", { resetTime: "25:00" })).status === 400);
check("bad time zone refused", (await post("/api/settings", { timeZone: "Mars/Base" })).status === 400);
const s = await postJson<{ ok: boolean; nextResetAt: number }>("/api/settings", { autoReset: true, resetTime: "00:00", timeZone: "Asia/Manila" });
const next = new Date(s.nextResetAt);
check("default next reset is midnight Manila (16:00 UTC)", s.ok && next.getUTCHours() === 16 && next.getUTCMinutes() === 0 && s.nextResetAt > Date.now(), JSON.stringify(s));
staff.close();

// ---------- deleting ----------
const meA = await (await site("/api/app/me", cookieA)).json() as { workspaces: { queues: { id: string }[] }[] };
const queueId = meA.workspaces[0]!.queues[0]!.id;
const last = await postJson<TicketJson>("/api/join", {});
const phone = new Socket("/ws/t/" + last.id, "");
await phone.opened;
await phone.next(isStatus());
check("another shop's owner can't delete the queue", (await site("/api/app/queues/" + queueId, cookieB, { method: "DELETE" })).status === 403);
check("owner deletes the queue", (await site("/api/app/queues/" + queueId, cookieA, { method: "DELETE" })).ok);
check("connected phones are told the queue was closed", (await phone.next<StatusMsg>(isStatus("closed"))).status === "closed");
// (The page closes its own connection on "gone"; a server-side close takes ~10 s to finish under wrangler dev.)
phone.close();
check("deleted queue's address -> 404", (await site(Q)).status === 404);
check("deleted queue's API -> 404 (phones stop retrying)", (await site(Q + "/api/status/" + last.id)).status === 404);
// Printed QR codes point at the address forever, so a deleted queue's address is never given to someone else.
const cookieC = await devLogin(`smoke-c-${run}@example.com`, B);
const onboardC = await (await site("/api/app/onboard", cookieC, { method: "POST", body: JSON.stringify({ businessName: `Smoke Shop ${run}` }) })).json() as { slug: string };
check("a deleted queue's address is never reused", !!onboardC.slug && `/q/${onboardC.slug}` !== Q, JSON.stringify(onboardC));
await site("/api/app/account", cookieC, { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) });
check("account delete needs DELETE typed", (await site("/api/app/account", cookieA, { method: "DELETE", body: JSON.stringify({ confirm: "yes" }) })).status === 400);
for (const [who, c] of [["A", cookieA], ["B", cookieB]] as const) {
  check(`account ${who} deleted`, (await site("/api/app/account", c, { method: "DELETE", body: JSON.stringify({ confirm: "DELETE" }) })).ok);
  check(`account ${who}'s session no longer works`, (await site("/api/app/me", c)).status === 401);
}

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\n${passes} checks, ALL PASSED`);
process.exit(fails ? 1 : 0);
