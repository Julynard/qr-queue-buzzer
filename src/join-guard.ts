// Protection for "Take a number", the one queue call anyone can make without logging in.
//   1. A rate limit per queue and IP, so one phone or script can't fill a shop's queue.
//   2. A Cloudflare Turnstile check, so a script can't take numbers at all.
// Turnstile is on only when TURNSTILE_SECRET_KEY is set; the rate limit is always on.

/** The Turnstile "action" the join page asks for; a token made for any other page is refused. */
export const JOIN_ACTION = "join";
/** Longest token Turnstile issues; anything longer is not a real token. */
const TOKEN_MAX = 2048;
const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export interface Limiter { limit(opts: { key: string }): Promise<{ success: boolean }> }
export type JoinGuard = { ok: true } | { ok: false; status: 429; error: "busy" } | { ok: false; status: 403; error: "check" };

interface SiteverifyResult { success?: unknown; action?: unknown; hostname?: unknown; metadata?: { result_with_testing_key?: unknown } }

/**
 * Asks Cloudflare whether `token` is a real Turnstile pass for the join page on `hostname`.
 * Anything unexpected (no answer, an error, an odd reply) counts as a fail.
 */
export async function verifyTurnstile(o: { token: string | null; secret: string; ip: string | null; hostname: string; fetchFn?: typeof fetch }): Promise<boolean> {
  if (!o.token || o.token.length > TOKEN_MAX) return false;
  const body = new URLSearchParams({ secret: o.secret, response: o.token });
  if (o.ip) body.set("remoteip", o.ip);
  let d: SiteverifyResult;
  try {
    const r = await (o.fetchFn ?? fetch)(SITEVERIFY, { method: "POST", body, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return false;
    d = (await r.json()) as SiteverifyResult;
  } catch {
    return false;
  }
  if (!d || typeof d !== "object" || d.success !== true) return false;
  // Cloudflare's test keys (local development) always answer for "example.com" with no action.
  if (d.metadata?.result_with_testing_key === true) return true;
  return d.action === JOIN_ACTION && d.hostname === o.hostname;
}

/** Whether this "Take a number" call may go ahead. `ip` is the caller's address (CF-Connecting-IP). */
export async function guardJoin(o: {
  limiter: Limiter; secret: string | undefined; token: string | null; ip: string | null; hostname: string; queueId: string; fetchFn?: typeof fetch;
}): Promise<JoinGuard> {
  // Cheap check first: a flood is stopped before any call to Cloudflare's Turnstile service.
  const { success } = await o.limiter.limit({ key: `${o.queueId}:${o.ip ?? "unknown"}` });
  if (!success) return { ok: false, status: 429, error: "busy" };
  if (o.secret && !(await verifyTurnstile({ token: o.token, secret: o.secret, ip: o.ip, hostname: o.hostname, fetchFn: o.fetchFn }))) {
    return { ok: false, status: 403, error: "check" };
  }
  return { ok: true };
}
