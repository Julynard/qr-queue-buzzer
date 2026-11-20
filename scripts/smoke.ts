// End-to-end check against a running server. Start `npm run dev` first, then:
//   npm run smoke                      (default http://127.0.0.1:8787)
//   npm run smoke -- http://host:port
// It starts a new day on that queue, so never point it at the live site.

interface TicketJson { id: string; num: number; name: string; status: string }
interface StateJson { type: "state"; tickets: { id: string; num: number; online: boolean }[] }
interface StatusJson { status: string }
interface StatusMsg { type: "status"; status: string; place: number | null; waitMin: number | null; claimLeftMs: number | null }
type Msg = StateJson | StatusMsg;
export {};

const B = process.argv[2] ?? "http://127.0.0.1:8787";
let fails = 0;
let passes = 0;
function check(name: string, cond: boolean, extra = ""): void {
  if (cond) passes++;
  else fails++;
  console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " " + extra));
}
const post = (p: string, body?: unknown): Promise<Response> =>
  fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const getJson = async <T>(p: string): Promise<T> => (await (await fetch(B + p)).json()) as T;
const postJson = async <T>(p: string, body?: unknown): Promise<T> => (await (await post(p, body)).json()) as T;
const pageText = async (p: string): Promise<string> => (await fetch(B + p)).text();
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
  constructor(path: string) {
    this.ws = new WebSocket(B.replace(/^http/, "ws") + path);
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

for (const p of ["/staff", "/", "/qr", "/join", "/sw.js", "/icon.svg", "/manifest.json"]) {
  const r = await fetch(B + p);
  check(`GET ${p} -> 200`, r.status === 200, String(r.status));
}
check("unknown path -> 404", (await fetch(B + "/nope")).status === 404);
check("manual reset", (await post("/api/reset")).ok);

const joins = await Promise.all(Array.from({ length: 20 }, (_, i) => postJson<TicketJson>("/api/join", { name: "C" + i })));
const nums = joins.map((t) => t.num).sort((a, b) => a - b);
check("20 parallel joins get numbers 1..20, no duplicates", nums.join(",") === Array.from({ length: 20 }, (_, i) => i + 1).join(","), nums.join(","));

const key = "c".repeat(32);
const [d1, d2] = await Promise.all([postJson<TicketJson>("/api/join", { key }), postJson<TicketJson>("/api/join", { key })]);
check("same join key twice in parallel -> one ticket", d1!.id === d2!.id && d1!.num === 21, JSON.stringify([d1, d2]));
check("bad JSON body -> 400", (await fetch(B + "/api/join", { method: "POST", body: "{nope" })).status === 400);

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
check("ticket page has the ticket", page1.includes(`"id":"${t1.id}"`) && page1.includes(`/manifest/${t1.id}.json`));

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
for (const p of ["/staff", "/qr", "/join", "/t/" + dollar.id]) check(`page scripts parse: ${p}`, parses(scripts(await pageText(p))));
const sneaky = await postJson<TicketJson>("/api/join", { name: "__VIEW____VAPID__" });
const sneakyPage = await pageText("/t/" + sneaky.id);
check("a name that looks like a placeholder stays a name", parses(scripts(sneakyPage)) && sneakyPage.includes('"name":"__VIEW____VAPID__"') && !sneakyPage.includes("'__VAPID__'"));

const evilQueue = "</script><b>x $' $& __NOTICE__ __JOIN__ · Counter";
check("queue name saves", (await postJson<{ ok: boolean }>("/api/settings", { queueName: evilQueue })).ok === true);
for (const p of ["/join", "/t/" + dollar.id]) {
  const page = await pageText(p);
  check(`queue name can't break out of the page script: ${p}`, !page.includes("</script><b>x") && parses(scripts(page)) && page.includes("$' $& __NOTICE__"));
}
const poster = await pageText("/qr");
check("poster shows the queue name as text", poster.includes("&lt;/script&gt;&lt;b&gt;x $&#39; $&amp; __NOTICE__ __JOIN__") && parses(scripts(poster)));
check("bad claim time refused", (await post("/api/settings", { claimMinutes: 0 })).status === 400);
check("queue name cleared", (await postJson<{ ok: boolean }>("/api/settings", { queueName: "" })).ok === true);
check("service worker parses", parses(await pageText("/sw.js")));

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

console.log(fails ? `\n${fails} FAILED, ${passes} passed` : `\n${passes} checks, ALL PASSED`);
process.exit(fails ? 1 : 0);
