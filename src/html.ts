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
