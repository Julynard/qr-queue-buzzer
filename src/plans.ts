// Plan limits, in one place. This version only checks "queues per workspace" when a queue is created;
// the rest are switched on in a later slice.

export interface Limits { queues: number; people: number; softTicketsPerDay: number }

export const FREE_LIMITS: Readonly<Limits> = Object.freeze({ queues: 1, people: 3, softTicketsPerDay: 300 });

/** Limits for a workspace's plan. Paid plans don't exist yet, so every plan gets the Free limits. */
export function limitsFor(_plan: string | null | undefined): Readonly<Limits> {
  return FREE_LIMITS;
}
