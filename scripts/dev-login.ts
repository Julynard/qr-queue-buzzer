// Local testing only: signs in through the real email-code flow against `npm run dev` and returns the
// session cookie. The code is read from the local D1 database (codes are only printed, never emailed, in dev).
//   node scripts/dev-login.ts <email> [base]     prints "better-auth.session_token=..."
import { execFileSync } from "node:child_process";

// Cloudflare's always-pass Turnstile test token (works with the test secret in .dev.vars.example).
const TEST_CAPTCHA = "XXXX.DUMMY.TOKEN.XXXX";

function readCode(email: string): string {
  const out = execFileSync("npx", ["wrangler", "d1", "execute", "aqona", "--local", "--json", "--command",
    `select value from verification where identifier = 'sign-in-otp-${email.replace(/'/g, "''")}' order by createdAt desc limit 1`],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const value = (JSON.parse(out) as { results: { value: string }[] }[])[0]?.results[0]?.value;
  if (!value) throw new Error("no login code found for " + email);
  return value.split(":")[0]!;
}

export async function devLogin(email: string, base = "http://127.0.0.1:8787"): Promise<string> {
  const headers = { "Content-Type": "application/json", Origin: base };
  const sent = await fetch(base + "/api/auth/email-otp/send-verification-otp", {
    method: "POST", headers: { ...headers, "x-captcha-response": TEST_CAPTCHA }, body: JSON.stringify({ email, type: "sign-in" }),
  });
  if (!sent.ok) throw new Error(`send code failed: ${sent.status} ${await sent.text()}`);
  const r = await fetch(base + "/api/auth/sign-in/email-otp", { method: "POST", headers, body: JSON.stringify({ email, otp: readCode(email) }) });
  if (!r.ok) throw new Error(`sign in failed: ${r.status} ${await r.text()}`);
  const cookie = r.headers.getSetCookie().map((c) => c.split(";")[0]!).find((c) => c.startsWith("better-auth.session_token="));
  if (!cookie) throw new Error("no session cookie");
  return cookie;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(await devLogin(process.argv[2] ?? "dev@example.com", process.argv[3]));
}
