// The owner's dashboard API (/api/app/*): first-time set-up, queues, and deleting a queue or the whole account.
// Every call needs a signed-in person.

import type { Auth, SessionInfo } from "./auth.ts";
import { uniqueSlug, randomSuffix } from "./slug.ts";
import { isPlan, limitsFor } from "./plans.ts";
import { createQueue, deleteQueueRow, queuesOf, roleIn, slugTaken } from "./queues.ts";
import { allows, isSuperadmin } from "./access.ts";
import type { QueueRow } from "./queues.ts";

const NAME_MAX = 60;
const json = (obj: unknown, status = 200): Response => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
const cleanName = (v: unknown): string => (typeof v === "string" ? v.trim().slice(0, NAME_MAX) : "");

// The organization plugin's server call (its types don't survive the shared options type in auth.ts).
type CreateOrganization = (args: { body: { name: string; slug: string }; headers: Headers }) => Promise<{ id: string } | null>;

interface WorkspaceRow { id: string; name: string; plan: string | null; role: string }

async function workspacesOf(db: D1Database, userId: string): Promise<WorkspaceRow[]> {
  const r = await db.prepare(
    'select o.id, o.name, o.plan, m.role from "member" m join "organization" o on o.id = m."organizationId" where m."userId" = ? order by m."createdAt"',
  ).bind(userId).all<WorkspaceRow>();
  return r.results;
}

const stubFor = (env: Env, q: QueueRow) => env.QUEUE.get(env.QUEUE.idFromName(q.id));
const queueCall = (env: Env, q: QueueRow, path: string, body: unknown) =>
  stubFor(env, q).fetch(new Request("https://queue" + path, { method: "POST", body: JSON.stringify(body ?? {}) }));

async function newQueue(env: Env, workspaceId: string, name: string): Promise<QueueRow> {
  const slug = await uniqueSlug(name, (s) => slugTaken(env.DB, s), randomSuffix);
  const row = await createQueue(env.DB, workspaceId, name, slug);
  await queueCall(env, row, "/internal/init", { base: `/q/${slug}`, queueName: name });
  return row;
}

/** Wipe a queue's live data (tickets, connections, alarm), then its row. */
export async function deleteQueue(env: Env, q: QueueRow): Promise<void> {
  await queueCall(env, q, "/internal/wipe", {});
  await deleteQueueRow(env.DB, q);
}

export async function handleAppApi(request: Request, env: Env, auth: Auth, session: SessionInfo | null): Promise<Response> {
  if (!session) return json({ error: "log in first" }, 401);
  const p = new URL(request.url).pathname;
  const userId = session.user.id;
  // Body is optional (GET, DELETE of a queue); when present it must be a JSON object.
  const text = request.method === "GET" ? "" : (await request.text()).slice(0, 10_000);
  let body: Record<string, unknown> | null = {};
  if (text) { try { const v: unknown = JSON.parse(text); body = v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null; } catch { body = null; } }
  if (!body) return json({ error: "bad request" }, 400);
  let m: RegExpMatchArray | null;

  if (p === "/api/app/me" && request.method === "GET") {
    const workspaces = await Promise.all((await workspacesOf(env.DB, userId)).map(async (w) => ({
      id: w.id, name: w.name, role: w.role, plan: w.plan ?? "free", limits: limitsFor(w.plan),
      queues: (await queuesOf(env.DB, w.id)).map((q) => ({ id: q.id, slug: q.slug, name: q.name })),
    })));
    return json({ user: { name: session.user.name, email: session.user.email }, superadmin: isSuperadmin(session.user.email, env.SUPERADMIN_EMAILS), workspaces });
  }

  if (p === "/api/app/onboard" && request.method === "POST") {
    const businessName = cleanName(body.businessName);
    const yourName = cleanName(body.yourName);
    if (!businessName) return json({ error: "Please enter your business or queue name." }, 400);
    if ((await workspacesOf(env.DB, userId)).some((w) => w.role === "owner")) return json({ error: "You already have a workspace." }, 409);
    if (yourName && yourName !== session.user.name) await auth.api.updateUser({ body: { name: yourName }, headers: request.headers });
    const createOrganization = (auth.api as unknown as { createOrganization: CreateOrganization }).createOrganization;
    const org = await createOrganization({ body: { name: businessName, slug: `ws-${crypto.randomUUID()}` }, headers: request.headers });
    if (!org) return json({ error: "Could not create the workspace." }, 500);
    const q = await newQueue(env, org.id, businessName);
    return json({ workspaceId: org.id, slug: q.slug });
  }

  if (p === "/api/app/queues" && request.method === "POST") {
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    const name = cleanName(body.name);
    if (!name) return json({ error: "Please enter a queue name." }, 400);
    const w = (await workspacesOf(env.DB, userId)).find((x) => x.id === workspaceId);
    if (!w || w.role !== "owner") return json({ error: "Only the owner can add queues." }, 403);
    if ((await queuesOf(env.DB, w.id)).length >= limitsFor(w.plan).queues) {
      const n = limitsFor(w.plan).queues;
      return json({ error: "upgrade", limit: "queues", message: `Your plan has ${n} counter${n === 1 ? "" : "s"}. More counters come with ${w.plan === "pro" ? "Max" : "Pro"}.` }, 402);
    }
    const q = await newQueue(env, w.id, name);
    return json({ id: q.id, slug: q.slug });
  }

  // Aqona's own people (SUPERADMIN_EMAILS) can put a shop on any plan by hand, e.g. to try Pro before payments exist.
  if (p === "/api/app/plan" && request.method === "POST") {
    if (!isSuperadmin(session.user.email, env.SUPERADMIN_EMAILS)) return json({ error: "Only Aqona admins can change a plan." }, 403);
    const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId : "";
    if (!isPlan(body.plan)) return json({ error: "Plan must be free, pro or max." }, 400);
    const r = await env.DB.prepare('update "organization" set plan = ? where id = ?').bind(body.plan, workspaceId).run();
    if (!r.meta.changes) return json({ error: "No such shop." }, 404);
    return json({ ok: true, plan: body.plan, limits: limitsFor(body.plan) });
  }

  if ((m = p.match(/^\/api\/app\/queues\/([0-9a-f-]{36})$/)) && request.method === "DELETE") {
    const row = await env.DB.prepare("select id, workspace_id, slug, name, created_at from queue where id = ?").bind(m[1]).first<QueueRow>();
    if (!row || !allows("owner", await roleIn(env, session.user, row.workspace_id))) return json({ error: "Only the owner can delete this queue." }, 403);
    await deleteQueue(env, row);
    return json({ ok: true });
  }

  if (p === "/api/app/account" && request.method === "DELETE") {
    if (body.confirm !== "DELETE") return json({ error: 'Type DELETE to confirm.' }, 400);
    // Workspaces this person owns go with them (one owner per workspace), including every queue's live data.
    for (const w of (await workspacesOf(env.DB, userId)).filter((x) => x.role === "owner")) {
      for (const q of await queuesOf(env.DB, w.id)) await deleteQueue(env, q);
      await env.DB.prepare('delete from "organization" where id = ?').bind(w.id).run();
    }
    // Sessions, sign-in methods and memberships go with the user (foreign keys cascade).
    await env.DB.prepare('delete from "user" where id = ?').bind(userId).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}
