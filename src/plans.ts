// Plan limits, in one place. This version only checks "counters per workspace" when one is created;
// the rest are switched on in a later slice. null = no limit.

export type Plan = "free" | "pro" | "max";
export const PLANS: readonly Plan[] = ["free", "pro", "max"];
export const isPlan = (v: unknown): v is Plan => typeof v === "string" && (PLANS as readonly string[]).includes(v);

export interface Limits { queues: number; people: number | null; softTicketsPerDay: number | null }

export const FREE_LIMITS: Readonly<Limits> = Object.freeze({ queues: 1, people: 3, softTicketsPerDay: 300 });
// Pro: up to 5 counters, owner + 5 staff, unlimited tickets. Max: up to 10 counters, unlimited staff.
export const PRO_LIMITS: Readonly<Limits> = Object.freeze({ queues: 5, people: 6, softTicketsPerDay: null });
export const MAX_LIMITS: Readonly<Limits> = Object.freeze({ queues: 10, people: null, softTicketsPerDay: null });

/** Limits for a workspace's plan. Unknown or missing plans get the Free limits. */
export function limitsFor(plan: string | null | undefined): Readonly<Limits> {
  return plan === "max" ? MAX_LIMITS : plan === "pro" ? PRO_LIMITS : FREE_LIMITS;
}
