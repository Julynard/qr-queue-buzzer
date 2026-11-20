// Queue addresses: /q/<slug>. Slugs are permanent once created (printed QR codes point at them).

export const SLUG_MAX = 40;
/** Words that are, or may become, our own addresses. */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set(["app", "api", "login", "start", "admin", "privacy", "terms", "q", "ws", "static", "staff", "join"]);

/** "Ana's Milk Tea · Counter 1" -> "anas-milk-tea-counter-1". May return "" (e.g. only emoji). */
export function slugify(name: string): string {
  let s = name.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length > SLUG_MAX) {
    s = s.slice(0, SLUG_MAX);
    const cut = s.lastIndexOf("-");
    if (cut > SLUG_MAX / 2) s = s.slice(0, cut);
    s = s.replace(/-+$/g, "");
  }
  return s;
}

/**
 * A free, non-reserved slug for a new queue. `taken` checks the database; `rand` gives a short suffix.
 * Falls back to "queue-<suffix>" when the name has no letters or numbers.
 */
export async function uniqueSlug(name: string, taken: (s: string) => Promise<boolean>, rand: () => string): Promise<string> {
  const base = slugify(name).slice(0, SLUG_MAX - 5).replace(/-+$/g, "") || "queue";
  if (base !== "queue" && !RESERVED_SLUGS.has(base) && !(await taken(base))) return base;
  for (let i = 0; i < 20; i++) {
    const s = `${base}-${rand()}`;
    if (!(await taken(s))) return s;
  }
  throw new Error("could not find a free address");
}

/** 4 random lowercase letters/digits. */
export function randomSuffix(): string {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => a[b % a.length]).join("");
}
