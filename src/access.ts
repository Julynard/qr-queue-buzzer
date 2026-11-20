// Who may open what under /q/<slug>. Checked in the Worker before anything reaches the queue's Durable Object.
// "public" = customers (no log-in); "member" = a signed-in member of the queue's workspace.

export interface QueueRoute { kind: "public" | "member"; forward: string }

const ID = "[a-f0-9]{12}";
const RULES: { re: RegExp; method: "GET" | "POST"; kind: QueueRoute["kind"] }[] = [
  { re: new RegExp(`^/t/${ID}$`), method: "GET", kind: "public" },
  { re: new RegExp(`^/manifest/${ID}\\.json$`), method: "GET", kind: "public" },
  { re: /^\/api\/join$/, method: "POST", kind: "public" },
  { re: new RegExp(`^/api/status/${ID}$`), method: "GET", kind: "public" },
  { re: new RegExp(`^/api/(subscribe|ack)/${ID}$`), method: "POST", kind: "public" },
  { re: new RegExp(`^/ws/t/${ID}$`), method: "GET", kind: "public" },
  { re: /^\/(staff|qr)$/, method: "GET", kind: "member" },
  { re: /^\/api\/state$/, method: "GET", kind: "member" },
  { re: new RegExp(`^/api/(buzz|done|remove)/${ID}$`), method: "POST", kind: "member" },
  { re: /^\/api\/(reset|settings)$/, method: "POST", kind: "member" },
  { re: /^\/ws\/staff$/, method: "GET", kind: "member" },
];

/** `rest` is the path after /q/<slug>. Returns null for anything not allowed (including /internal/*). */
export function classifyQueuePath(rest: string, method: string): QueueRoute | null {
  if (rest === "" || rest === "/") return method === "GET" ? { kind: "public", forward: "/join" } : null;
  for (const r of RULES) if (r.re.test(rest)) return method === r.method ? { kind: r.kind, forward: rest } : null;
  return null;
}
