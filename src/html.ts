// Helpers for filling page templates.

// Values are put into the page as JSON / plain text; escape "<" so a name can't close the <script> tag.
// Placeholders are filled with a replace function, because a plain replacement string treats "$'" / "$&" in a
// customer's name as special patterns and would paste other parts of the page into the script.
export const safeJson = (v: unknown): string => JSON.stringify(v).replace(/</g, "\\u003c");
// Fill every __NAME__ placeholder in one pass, so text pasted in (a customer's name, the queue name)
// is never scanned again: a name like "__VAPID__" stays a name.
export const fill = (page: string, vals: Record<string, string>): string =>
  page.replace(/__([A-Z_]+?)__/g, (all, k: string) => (Object.hasOwn(vals, k) ? vals[k]! : all));
export const escHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * Where to go after log-in: a path on this site only. Anything that could leave the site
 * ("//x", backslashes, tabs or other control characters, encoded or not, another origin) gives "/app".
 */
export function safeNext(next: string | null | undefined, origin: string): string {
  if (!next || !next.startsWith("/")) return "/app";
  let decoded: string;
  try { decoded = decodeURIComponent(next); } catch { return "/app"; }
  if (/[\\\u0000-\u001f\u007f]/.test(next + decoded) || decoded.startsWith("//")) return "/app";
  const u = new URL(next, origin);
  return u.origin === origin ? u.pathname + u.search + u.hash : "/app";
}
