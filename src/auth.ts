// Accounts: Better Auth inside the Worker, storing everything in D1.
// Log-in is passwordless: Google, or a 6-digit code by email. Workspaces are Better Auth "organizations".

import { betterAuth } from "better-auth";
import type { BetterAuthOptions, BetterAuthPlugin } from "better-auth";
import { emailOTP, organization } from "better-auth/plugins";
import { captcha } from "better-auth/plugins/captcha";
import { dash, sentinel } from "@better-auth/infra";

export const OTP_LENGTH = 6;
export const OTP_SECONDS = 10 * 60;
const SEND_CODE_PATH = "/email-otp/send-verification-otp";

/** What sign-in methods this deployment offers (the log-in page shows only these). */
export function signInMethods(env: Env): { google: boolean; email: boolean } {
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    email: env.EMAIL_MODE === "console",
  };
}

/** Better Auth settings for this deployment. Kept separate so the schema script can build the same tables. */
export function authOptions(env: Env, baseURL: string): BetterAuthOptions {
  const methods = signInMethods(env);
  const plugins: BetterAuthPlugin[] = [
    emailOTP({
      otpLength: OTP_LENGTH,
      expiresIn: OTP_SECONDS,
      allowedAttempts: 5,
      async sendVerificationOTP({ email, otp }) {
        // Local development only. The live site has no email sending until aqona.app is set up,
        // so its log-in page offers Google only and this refuses.
        if (env.EMAIL_MODE === "console") { console.log(`[dev] login code for ${email}: ${otp}`); return; }
        throw new Error("Email codes are not available yet");
      },
    }),
    organization({
      schema: { organization: { additionalFields: { plan: { type: "string", defaultValue: "free", input: false, required: false } } } },
    }),
    captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY ?? "", endpoints: [SEND_CODE_PATH] }),
  ];
  // Better Auth Infrastructure (owner-requested): dashboard and abuse protection. It sends sign-in
  // events to Better Auth's servers, so it is only on when its key is set (and the privacy notice says so).
  if (env.BETTER_AUTH_API_KEY) {
    plugins.push(dash({ apiKey: env.BETTER_AUTH_API_KEY }) as BetterAuthPlugin, sentinel({ apiKey: env.BETTER_AUTH_API_KEY }) as BetterAuthPlugin);
  }
  return {
    appName: "Aqona",
    baseURL,
    secret: env.BETTER_AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [baseURL],
    // A failed Google log-in comes back to our log-in page with ?error=<code> instead of Better Auth's
    // own error page. This covers failures before the flow's errorCallbackURL is known (expired or
    // mismatched state); the log-in and start pages also pass errorCallbackURL (e.g. for "Cancel").
    onAPIError: { errorURL: `${baseURL}/login` },
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: { [SEND_CODE_PATH]: { window: 60, max: 3 }, "/sign-in/email-otp": { window: 60, max: 10 } },
    },
    // Workspaces and accounts are created and deleted only through /api/app/*, which also creates or wipes
    // the queues' live data. Better Auth's own endpoints for these are switched off.
    disabledPaths: ["/organization/create", "/organization/delete", "/delete-user"],
    socialProviders: methods.google ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } } : {},
    plugins,
  };
}

export type Auth = ReturnType<typeof betterAuth>;

// One instance per address per isolate (the Worker serves 127.0.0.1 in dev and one host live).
const cache = new Map<string, Auth>();
export function createAuth(env: Env, request: Request): Auth {
  const baseURL = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/$/, "");
  let auth = cache.get(baseURL);
  if (!auth) { auth = betterAuth(authOptions(env, baseURL)); cache.set(baseURL, auth); }
  return auth;
}

export interface SessionInfo {
  user: { id: string; email: string; name: string };
  session: { id: string; activeOrganizationId?: string | null };
}

/** The signed-in person for this request, or null. */
export async function getSession(auth: Auth, request: Request): Promise<SessionInfo | null> {
  const s = await auth.api.getSession({ headers: request.headers });
  return (s as SessionInfo | null) ?? null;
}
