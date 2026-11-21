import { isSuperadmin } from "./access.ts";
import type { Role } from "./access.ts";

// The list of queues (D1). A queue's live data is in its Durable Object, addressed by idFromName(queue.id).

export interface QueueRow { id: string; workspace_id: string; slug: string; name: string; created_at: number }

// Slug lookups are cached briefly per isolate: every customer request needs one.
// A deleted queue may still be found here for up to CACHE_MS in other isolates; its Durable Object then answers 410.
const CACHE_MS = 30_000;
const cache = new Map<string, { row: QueueRow | null; at: number }>();

export async function findQueueBySlug(db: D1Database, slug: string, now = Date.now()): Promise<QueueRow | null> {
  const hit = cache.get(slug);
  if (hit && now - hit.at < CACHE_MS) return hit.row;
  const row = await db.prepare("select id, workspace_id, slug, name, created_at from queue where slug = ?").bind(slug).first<QueueRow>();
  cache.set(slug, { row: row ?? null, at: now });
  return row ?? null;
}

export function forgetSlug(slug: string): void { cache.delete(slug); }

/** In use, or used before by a deleted queue (addresses are never reused). */
export async function slugTaken(db: D1Database, slug: string): Promise<boolean> {
  return !!(await db.prepare("select 1 as x from queue where slug = ?1 union all select 1 from deleted_slug where slug = ?1 limit 1").bind(slug).first());
}

export async function memberRole(db: D1Database, userId: string, workspaceId: string): Promise<string | null> {
  const r = await db.prepare('select role from "member" where "userId" = ? and "organizationId" = ?').bind(userId, workspaceId).first<{ role: string }>();
  return r?.role ?? null;
}

/** This person's role for a workspace: superadmin first, else their member role, else null (not on the team). */
export async function roleIn(env: Env, user: { id: string; email: string }, workspaceId: string): Promise<Role | null> {
  if (isSuperadmin(user.email, env.SUPERADMIN_EMAILS)) return "superadmin";
  const r = await memberRole(env.DB, user.id, workspaceId);
  return r === "owner" || r === "admin" || r === "member" ? r : null;
}

export async function queuesOf(db: D1Database, workspaceId: string): Promise<QueueRow[]> {
  const r = await db.prepare("select id, workspace_id, slug, name, created_at from queue where workspace_id = ? order by created_at").bind(workspaceId).all<QueueRow>();
  return r.results;
}

export async function createQueue(db: D1Database, workspaceId: string, name: string, slug: string, now = Date.now()): Promise<QueueRow> {
  const row: QueueRow = { id: crypto.randomUUID(), workspace_id: workspaceId, slug, name, created_at: now };
  await db.prepare("insert into queue (id, workspace_id, slug, name, created_at) values (?, ?, ?, ?, ?)").bind(row.id, row.workspace_id, row.slug, row.name, row.created_at).run();
  forgetSlug(slug);
  return row;
}

export async function renameQueue(db: D1Database, id: string, name: string): Promise<void> {
  await db.prepare("update queue set name = ? where id = ?").bind(name, id).run();
}

export async function deleteQueueRow(db: D1Database, row: QueueRow, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare("insert or ignore into deleted_slug (slug, deleted_at) values (?, ?)").bind(row.slug, now),
    db.prepare("delete from queue where id = ?").bind(row.id),
  ]);
  forgetSlug(row.slug);
}
