// Staff invites and team members. Uses Better Auth's own "invitation" and "member" tables (same status words
// and role names as its organization plugin), but only through /api/app/*, which checks the plan's seat limit.
// No email is sent: the owner copies the invite link and sends it (Messenger, WhatsApp...).

export const INVITE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normEmail = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 254) : "");
export const isEmail = (v: string): boolean => EMAIL_RE.test(v);
export const isInviteId = (v: string): boolean => /^[a-f0-9]{24}$/.test(v);
export const newInviteId = (): string => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface InviteRow { id: string; organizationId: string; email: string; role: string | null; status: string; expiresAt: string; createdAt: string; inviterId: string }
export interface MemberRow { userId: string; name: string; email: string; role: string; createdAt: string }

export const isLive = (inv: Pick<InviteRow, "status" | "expiresAt">, now: number): boolean =>
  inv.status === "pending" && Date.parse(inv.expiresAt) > now;

/**
 * Seats: the owner and every staff member, plus pending invites that haven't expired, count against the plan's
 * "people" limit (null = no limit). Free's 3 = owner + 2 staff.
 */
export function seatsLeft(people: number | null, members: number, liveInvites: number): number | null {
  return people === null ? null : Math.max(0, people - members - liveInvites);
}

/** Why an invite can't be sent, in words for the owner; null when it's fine. */
export function inviteProblem(email: string, opts: { ownEmail: string; memberEmails: string[]; liveInviteEmails: string[]; seatsLeft: number | null }): string | null {
  if (!email) return "Enter their email.";
  if (!isEmail(email)) return "That doesn't look like an email. Try name@example.com.";
  if (email === normEmail(opts.ownEmail)) return "That's you. You're already on the team.";
  if (opts.memberEmails.map(normEmail).includes(email)) return `${email} is already on your team.`;
  if (opts.liveInviteEmails.map(normEmail).includes(email)) return `${email} is already invited. Copy the link again from the list.`;
  if (opts.seatsLeft !== null && opts.seatsLeft <= 0) return "Your team is full on this plan. Remove someone or move to a bigger plan.";
  return null;
}

/** Why an invite can't be accepted by this person; null when they can join. */
export function acceptProblem(inv: InviteRow | null, sessionEmail: string, now: number, alreadyMember: boolean, seats: number | null): string | null {
  if (!inv) return "This invite doesn't exist. Ask the owner for a new link.";
  if (inv.status === "canceled") return "This invite was cancelled. Ask the owner for a new link.";
  if (inv.status === "accepted") return alreadyMember ? null : "This invite was already used. Ask the owner for a new link.";
  if (!isLive(inv, now)) return "This invite has expired. Ask the owner for a new link.";
  if (normEmail(sessionEmail) !== normEmail(inv.email)) return `This invite is for ${inv.email}. Sign in with that email to join.`;
  if (alreadyMember) return null;
  if (seats !== null && seats <= 0) return "This team is full. Ask the owner to free a seat.";
  return null;
}

// ---------- database ----------

export async function membersOf(db: D1Database, workspaceId: string): Promise<MemberRow[]> {
  const r = await db.prepare(
    'select m."userId" as userId, u.name as name, u.email as email, m.role as role, m."createdAt" as createdAt from "member" m join "user" u on u.id = m."userId" where m."organizationId" = ? order by (m.role = ?) desc, m."createdAt"',
  ).bind(workspaceId, "owner").all<MemberRow>();
  return r.results;
}

export async function invitesOf(db: D1Database, workspaceId: string, now: number): Promise<InviteRow[]> {
  const r = await db.prepare('select * from "invitation" where "organizationId" = ? and status = ? order by "createdAt"').bind(workspaceId, "pending").all<InviteRow>();
  return r.results.filter((i) => isLive(i, now));
}

export async function inviteById(db: D1Database, id: string): Promise<InviteRow | null> {
  return isInviteId(id) ? await db.prepare('select * from "invitation" where id = ?').bind(id).first<InviteRow>() : null;
}

/** Pending, unexpired invites for this email (shown on the dashboard so invited staff don't make their own shop). */
export async function invitesForEmail(db: D1Database, email: string, now: number): Promise<(InviteRow & { shop: string })[]> {
  const r = await db.prepare('select i.*, o.name as shop from "invitation" i join "organization" o on o.id = i."organizationId" where lower(i.email) = ? and i.status = ?')
    .bind(normEmail(email), "pending").all<InviteRow & { shop: string }>();
  return r.results.filter((i) => isLive(i, now));
}

export async function createInvite(db: D1Database, workspaceId: string, email: string, inviterId: string, now: number): Promise<InviteRow> {
  const row: InviteRow = {
    id: newInviteId(), organizationId: workspaceId, email, role: "member", status: "pending",
    expiresAt: new Date(now + INVITE_DAYS * DAY_MS).toISOString(), createdAt: new Date(now).toISOString(), inviterId,
  };
  await db.prepare('insert into "invitation" (id, "organizationId", email, role, status, "expiresAt", "createdAt", "inviterId") values (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(row.id, row.organizationId, row.email, row.role, row.status, row.expiresAt, row.createdAt, row.inviterId).run();
  return row;
}

export async function setInviteStatus(db: D1Database, id: string, status: "accepted" | "canceled"): Promise<void> {
  await db.prepare('update "invitation" set status = ? where id = ?').bind(status, id).run();
}

export async function addMember(db: D1Database, workspaceId: string, userId: string, now: number): Promise<void> {
  await db.prepare('insert into "member" (id, "organizationId", "userId", role, "createdAt") values (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), workspaceId, userId, "member", new Date(now).toISOString()).run();
}

export async function removeMember(db: D1Database, workspaceId: string, userId: string): Promise<boolean> {
  const r = await db.prepare('delete from "member" where "organizationId" = ? and "userId" = ? and role != ?').bind(workspaceId, userId, "owner").run();
  return r.meta.changes > 0;
}
