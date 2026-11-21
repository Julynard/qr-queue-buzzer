// Who may open what under /q/<slug>: the one table of queue permissions. Checked in the Worker before
// anything reaches the queue's Durable Object.
//   public = customers, no log-in
//   staff  = a signed-in member of the queue's workspace (any role)
//   owner  = the workspace's owner
// A superadmin (someone running Aqona, listed in the SUPERADMIN_EMAILS secret) passes every check.

export type Need = "public" | "staff" | "owner";
/** Better Auth's workspace roles ("owner", "admin", "member"), plus "superadmin" for Aqona's own people. */
export type Role = "superadmin" | "owner" | "admin" | "member";
export interface QueueRoute { need: Need; forward: string }

const ID = "[a-f0-9]{12}";
const RULES: { re: RegExp; method: "GET" | "POST"; need: Need }[] = [
  // Customers
  { re: new RegExp(`^/t/${ID}$`), method: "GET", need: "public" },
  { re: new RegExp(`^/manifest/${ID}\\.json$`), method: "GET", need: "public" },
  { re: /^\/api\/join$/, method: "POST", need: "public" },
  { re: new RegExp(`^/api/status/${ID}$`), method: "GET", need: "public" },
  { re: new RegExp(`^/api/(subscribe|ack)/${ID}$`), method: "POST", need: "public" },
  { re: new RegExp(`^/ws/t/${ID}$`), method: "GET", need: "public" },
  // Running the queue
  { re: /^\/(staff|qr)$/, method: "GET", need: "staff" },
  { re: /^\/api\/state$/, method: "GET", need: "staff" },
  { re: new RegExp(`^/api/(buzz|done|remove)/${ID}$`), method: "POST", need: "staff" },
  { re: /^\/ws\/staff$/, method: "GET", need: "staff" },
  // Settings and "Start new day"
  { re: /^\/api\/(reset|settings)$/, method: "POST", need: "owner" },
];

/** `rest` is the path after /q/<slug>. Returns null for anything not allowed (including /internal/*). */
export function classifyQueuePath(rest: string, method: string): QueueRoute | null {
  if (rest === "" || rest === "/") return method === "GET" ? { need: "public", forward: "/join" } : null;
  for (const r of RULES) if (r.re.test(rest)) return method === r.method ? { need: r.need, forward: rest } : null;
  return null;
}

/** Whether someone with `role` (null = not in the workspace) may do something that needs `need`. */
export function allows(need: Need, role: Role | null): boolean {
  if (need === "public") return true;
  if (role === "superadmin" || role === "owner") return true;
  return need === "staff" && (role === "admin" || role === "member");
}

/** Owners and superadmins may change settings; the staff page uses this to hide what staff can't use. */
export const canManage = (role: Role | null): boolean => allows("owner", role);

/** `list` is the SUPERADMIN_EMAILS secret: emails separated by commas. Case and spaces don't matter. */
export function isSuperadmin(email: string | null | undefined, list: string | null | undefined): boolean {
  const e = (email ?? "").trim().toLowerCase();
  if (!e || !list) return false;
  return list.split(",").some((x) => x.trim().toLowerCase() === e);
}
