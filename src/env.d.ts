// Settings that may be missing, so they are optional here (the generated worker-configuration.d.ts
// only knows the values written in wrangler.jsonc).
interface Env {
  /** Push private key. Local: .dev.vars. Deployed: a Secret. Without it, buzzing works but push is skipped. */
  VAPID_PRIVATE_KEY?: string;
  /** Local testing only: the phone-reachable address to put in the QR code. */
  PUBLIC_URL?: string;
  /** Signs sessions and cookies. Local: .dev.vars. Deployed: a Secret. Required. */
  BETTER_AUTH_SECRET?: string;
  /** Better Auth Infrastructure (dashboard + abuse protection). Optional: off when missing. */
  BETTER_AUTH_API_KEY?: string;
  /** Google sign-in. Both optional: the Google button is hidden when either is missing. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** Turnstile check on "Email me a code". */
  TURNSTILE_SECRET_KEY?: string;
}

// Durable Objects default to Cloudflare.Env; keep the two in step.
declare namespace Cloudflare {
  interface Env {
    VAPID_PRIVATE_KEY?: string;
    PUBLIC_URL?: string;
    /** Signs sessions and cookies. Local: .dev.vars. Deployed: a Secret. Required. */
    BETTER_AUTH_SECRET?: string;
    /** Better Auth Infrastructure (dashboard + abuse protection). Optional: off when missing. */
    BETTER_AUTH_API_KEY?: string;
    /** Google sign-in. Both optional: the Google button is hidden when either is missing. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Turnstile check on "Email me a code". */
    TURNSTILE_SECRET_KEY?: string;
  }
}
