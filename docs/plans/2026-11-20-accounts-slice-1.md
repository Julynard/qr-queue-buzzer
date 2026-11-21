# Accounts Slice 1 (Login, Start free, Queues) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Anyone can sign up from the website (Google or a 6-digit email code), name their business, and get their own queue at `/q/<slug>` with its own QR, staff page (behind log-in) and settings; owners can delete a queue or their account.

**Architecture:** Better Auth runs inside the Worker under `/api/auth/*`, storing users, sessions, codes, rate limits and organisations (= workspaces) in a new D1 database, plus our own `queue` table. The Worker looks up `/q/<slug>` in D1, checks the session for staff-only calls, strips the `/q/<slug>` prefix and forwards to that queue's Durable Object (`idFromName(queue.id)`), so `QueueDO` keeps its current routes. New pages (`/login`, `/start`, `/app`, `/privacy`) are plain HTML templates like the existing ones, styled from the canvas artboards Login, Register and Landing.

**Tech Stack:** better-auth 1.7.26 (plugins `emailOTP`, `organization`, `captcha`), @better-auth/infra 0.4.31 (`dash`, `sentinel`; optional, see Task 1), Cloudflare D1, Wrangler 4.165, TypeScript (`tsc --noEmit`), `node --test`.

**Spec:** `docs/design/2026-11-20-aqona-accounts-design.md`, section "Delivery slices", slice 1. Design canvas: https://claude.ai/artifact/2URSZfKR8EaeST3cVSsRSB (artboards Login, Register, Landing, Staff).

## Global Constraints

- Customers never sign up and never give personal data. Customer flow (scan → join → notified) stays as fast as today.
- No passwords. Log-in = Google, or a 6-digit email code valid 10 minutes (`otpLength: 6`, `expiresIn: 600`).
- Local dev (`wrangler dev`) prints the code to the console instead of emailing it. The live site never does; until `aqona.app` and Cloudflare Email Service exist, the live site offers Google sign-in only (email-code UI hidden when no email binding).
- Rate limits stored in D1 (`rateLimit: { storage: "database" }`), with a stricter rule on sending codes; Cloudflare Turnstile on "Email me a code".
- Only the official `better-auth` package (and the owner-requested `@better-auth/infra`); no third-party Cloudflare wrappers. `compatibility_flags: ["nodejs_compat"]`.
- Secrets only as Wrangler secrets / `.dev.vars` (gitignored): `BETTER_AUTH_SECRET`, `BETTER_AUTH_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SECRET_KEY`. Never in `wrangler.jsonc`, the repo, commits or PR text. The repo is public.
- Free plan limits live in one place in code; this slice only enforces "1 queue per workspace" at creation (rest is slice 4).
- Slugs are permanent; unknown slug → 404 without creating a Durable Object.
- Old `/staff` → redirect `/login`; old `/join`, `/t/<id>` → redirect `/`. Old `"default"` queue is abandoned (test data).
- Deleting a queue wipes its Durable Object (`deleteAll`, `deleteAlarm`, close sockets) and its D1 row. Deleting an account deletes its owned workspace's queues, the workspace, then the user and sessions.
- Page scripts stay plain JS, dependency-free except the QR library from cdnjs and Google Fonts.
- Branch `feat/accounts-core` off `main`. Never `--no-verify`; commit hooks strip AI attribution.

## Review Focus

1. **A logged-out request to a staff call** (`/q/<slug>/api/buzz/<id>`, `/q/<slug>/ws/staff`, `/q/<slug>/api/state`, `/q/<slug>/qr`) must get 401/redirect, and a logged-in user from *another* workspace must get 403. Pinned by `test/access.test.ts` (Task 2) and smoke checks (Task 6).
2. **Two customers' remembered tickets on different queues** must not cross: localStorage key is per slug (`buzzerTicket:<slug>`). Pinned by a smoke check that the join page script contains the per-slug key (Task 5).
3. **Push link and per-ticket manifest** must point at `/q/<slug>/t/<id>`, or tapping a notification opens a 404. Pinned by a unit test on the push payload builder (Task 3) and a smoke check on the manifest `start_url` (Task 5).
4. **Slug collisions and odd names** ("Ana's Milk Tea", "☕", 60 chars, a name that slugifies to `app`, `api`, `login`) must give a valid, unique, non-reserved slug. Pinned by `test/slug.test.ts` (Task 2).
5. **Deleting a queue while phones are connected** must close their sockets and leave no alarm firing on a wiped object. Pinned by a smoke check (Task 6).

---

### Task 1: D1, Better Auth wiring, schema

**Files:**
- Modify: `wrangler.jsonc` (add `"compatibility_flags": ["nodejs_compat"]`, `d1_databases: [{ binding: "DB", database_name: "aqona", database_id: "<from wrangler d1 create>", migrations_dir: "migrations" }]`, var `EMAIL_MODE: "off"`), `package.json` scripts, `.dev.vars.example`, `src/env.d.ts`
- Create: `src/auth.ts`, `migrations/0001_auth.sql`, `migrations/0002_queue.sql`

**Interfaces:**
- Produces: `createAuth(env: Env): Auth` in `src/auth.ts` (one instance per request; cache per isolate keyed by env object is fine); `type Session = { user: { id; email; name }, session: { id; activeOrganizationId?: string | null } } | null`; `getSession(auth, request): Promise<Session>`.
- Produces D1 table `queue(id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES organization(id), slug TEXT UNIQUE NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL)`; column `organization.plan TEXT NOT NULL DEFAULT 'free'` (via the organization plugin's `schema.organization.additionalFields`).

- [ ] **Step 1: Create the database.** `npx wrangler d1 create aqona` (needs `wrangler login`; if the owner hasn't logged in, use a placeholder id and `--local` only, and note it in the PR). Put the id in `wrangler.jsonc`.
- [ ] **Step 2: Write `src/auth.ts`.** `betterAuth({ database: env.DB, secret: env.BETTER_AUTH_SECRET, baseURL: env.PUBLIC_URL ?? origin, advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } }, rateLimit: { enabled: true, storage: "database", customRules: { "/email-otp/send-verification-otp": { window: 60, max: 3 } } }, socialProviders: google only when both Google secrets are set, plugins: [emailOTP({ otpLength: 6, expiresIn: 600, allowedAttempts: 5, sendVerificationOTP }), organization({ schema: { organization: { additionalFields: { plan: { type: "string", defaultValue: "free", input: false } } } } }), captcha({ provider: "cloudflare-turnstile", secretKey: env.TURNSTILE_SECRET_KEY, endpoints: ["/email-otp/send-verification-otp"] }), ...infra] })`. `sendVerificationOTP`: if `env.EMAIL_MODE === "console"` → `console.log("[dev] login code for", email, otp)`; else throw (email sending arrives with the domain). `infra` = `[dash({ apiKey }), sentinel({ apiKey })]` only when `env.BETTER_AUTH_API_KEY` is set, else `[]`. Confirm each import path against `node_modules/better-auth/package.json` exports (`better-auth/plugins`, `better-auth/plugins/captcha`) before writing.
- [ ] **Step 3: Generate the auth schema.** `npx auth@latest generate --config src/auth.ts --output migrations/0001_auth.sql -y`. If the CLI can't load a Worker config, write a throwaway `scripts/auth-schema.ts` that builds the same options with a fake env and calls `getMigrations(options)` from `better-auth/db/migration` against a local SQLite file, then copy the SQL. Check it has tables `user`, `session`, `account`, `verification`, `rateLimit`, `organization` (with `plan`), `member`, `invitation`, and `session.activeOrganizationId`.
- [ ] **Step 4: Write `migrations/0002_queue.sql`** with the `queue` table above and `CREATE INDEX queue_workspace ON queue(workspace_id)`.
- [ ] **Step 5: Scripts.** `"db:migrate:local": "wrangler d1 migrations apply aqona --local"`, `"db:migrate": "wrangler d1 migrations apply aqona --remote"`, `"deploy": "npm run db:migrate && wrangler deploy"`. `.dev.vars.example` lists every secret name with dummy values, `EMAIL_MODE=console`, and Turnstile test keys (site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA`).
- [ ] **Step 6: Mount the handler.** In `src/index.ts`: `if (p.startsWith("/api/auth/")) return createAuth(env).handler(request);` before other routes.
- [ ] **Step 7: Verify.** `npm run db:migrate:local`; `npm run dev`; `curl -s -XPOST 127.0.0.1:8787/api/auth/email-otp/send-verification-otp -H 'content-type: application/json' -H 'x-captcha-response: XXXX.DUMMY.TOKEN.XXXX' -d '{"email":"a@example.com","type":"sign-in"}'` → 200 and the code in the dev console. Then `npx wrangler deploy --dry-run --outdir /tmp/aqona-dry` succeeds; note the bundle size in the PR. `npm run check` passes.
- [ ] **Step 8: Commit** `feat: Better Auth with D1 (email code, Google, workspaces)`.

### Task 2: Pure helpers (slug, plan limits, access rules)

**Files:**
- Create: `src/slug.ts`, `src/plans.ts`, `src/access.ts`, `test/slug.test.ts`, `test/access.test.ts`

**Interfaces:**
- Produces: `slugify(name: string): string`; `RESERVED_SLUGS: ReadonlySet<string>` (`app`, `api`, `login`, `start`, `admin`, `privacy`, `terms`, `q`, `ws`, `static`); `uniqueSlug(name: string, taken: (s: string) => Promise<boolean>, rand: () => string): Promise<string>`.
- Produces: `FREE_LIMITS = { queues: 1, people: 3, softTicketsPerDay: 300 } as const`; `limitsFor(plan: string)`.
- Produces: `type QueueRoute = { kind: "public" | "member"; forward: string }`; `classifyQueuePath(rest: string, method: string): QueueRoute | null` where `rest` is the path after `/q/<slug>` (e.g. `/api/buzz/abc123abc123`).

- [ ] **Step 1: Write failing tests.**
  - `slugify("Ana's Milk Tea · Counter 1") === "anas-milk-tea-counter-1"`; `slugify("☕☕") === ""`; `slugify("x".repeat(80)).length <= 40`; no leading/trailing `-`.
  - `uniqueSlug("Ana's Milk Tea", taken=s=>s==="anas-milk-tea", rand=()=>"k3x9")` → `"anas-milk-tea-k3x9"`; `uniqueSlug("☕", …)` → `"queue-k3x9"`; `uniqueSlug("Login", …)` → `"login-k3x9"` (reserved).
  - `classifyQueuePath("", "GET")` → `{ kind: "public", forward: "/join" }`; `"/t/abc123abc123"` → public; `"/api/join" POST`, `"/api/status/<id>"`, `"/api/subscribe/<id>" POST`, `"/api/ack/<id>" POST`, `"/ws/t/<id>"` → public; `"/staff"`, `"/qr"`, `"/api/state"`, `"/api/buzz/<id>"`, `"/api/done/<id>"`, `"/api/remove/<id>"`, `"/api/reset"`, `"/api/settings"`, `"/ws/staff"` → member; `"/api/nope"` → null.
- [ ] **Step 2: Run** `node --test test/slug.test.ts test/access.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** the three modules (ASCII-fold with `normalize("NFKD")` and strip non `[a-z0-9]`, collapse to `-`, cut at 40 on a dash boundary).
- [ ] **Step 4: Run** `npm test` → all pass.
- [ ] **Step 5: Commit** `feat: slugs, plan limits and queue access rules`.

### Task 3: Per-queue routing in the Worker and Durable Object

**Files:**
- Modify: `src/index.ts`, `src/queue-do.ts`, `src/queue-core.ts` (push payload builder only), `test/queue-core.test.ts`
- Create: `src/queues.ts` (D1 queries)

**Interfaces:**
- Consumes: `classifyQueuePath`, `getSession`, `createAuth`.
- Produces in `src/queues.ts`: `findQueueBySlug(db, slug): Promise<QueueRow | null>` (cache 30 s per isolate in a `Map`); `isMember(db, userId, workspaceId): Promise<boolean>` (query `member`); `createQueue(db, workspaceId, name, slug)`; `deleteQueueRow(db, id)`; `type QueueRow = { id; workspace_id; slug; name; created_at }`.
- Produces in `QueueDO`: internal routes `POST /internal/init` (body `{ base, queueName }`: stores `meta.base`, sets `settings.queueName`) and `POST /internal/wipe` (closes every socket with 1000 "deleted", `deleteAlarm`, `deleteAll`). Internal routes are only reachable from the Worker: the Worker never forwards a path starting `/internal/`.
- Produces in core: `pushPayload(t: Ticket, base: string, queueName: string): { title; body; url; tag }` with `url = base + "/t/" + t.id`.

- [ ] **Step 1: Failing core test** `pushPayload` returns `url: "/q/anas-milk-tea/t/<id>"` and the existing title/body text.
- [ ] **Step 2: Implement** `pushPayload`, use it in `QueueDO.#pushTicket` with `this.core.meta.base ?? ""` (add optional `base?: string` to `Meta`).
- [ ] **Step 3: Worker routing.** `/q/<slug>(/rest)?`: `findQueueBySlug` → 404 page if null (no DO touched); `classifyQueuePath(rest)` → 404 if null; for `member`: no session → pages redirect to `/login?next=<path>`, API/WS → 401; not `isMember` → 403. Forward to `env.QUEUE.get(env.QUEUE.idFromName(queue.id))` with the path rewritten to `forward` (pages are rendered by the Worker as today, with `__BASE__` = `/q/<slug>` added to `fill()`).
- [ ] **Step 4: Old routes.** `/staff` → 302 `/login`; `/join`, `/t/<id>` → 302 `/`; drop the `"default"` shop constant.
- [ ] **Step 5: Run** `npm test`, `npm run check` → pass.
- [ ] **Step 6: Commit** `feat: queues at /q/<slug> with staff calls behind log-in`.

### Task 4: Sign-up, log-in and dashboard pages

**Files:**
- Create: `src/pages/login.html`, `src/pages/start.html`, `src/pages/app.html`, `src/pages/privacy.html`, `src/pages/home.html`, `src/app-api.ts`
- Modify: `src/index.ts`

**Interfaces:**
- Consumes: `createAuth`, `getSession`, `uniqueSlug`, `createQueue`, `limitsFor`, QueueDO `/internal/init`.
- Produces API (all need a session; JSON):
  - `GET /api/app/me` → `{ user: { name, email }, workspaces: [{ id, name, role, plan, queues: [{ id, slug, name }] }] }`.
  - `POST /api/app/onboard` body `{ businessName: string, yourName?: string }` → creates organisation via `auth.api.createOrganization({ body: { name, slug }, headers })`, its first queue (name = businessName, `uniqueSlug`), calls DO `/internal/init`, updates user name if given → `{ slug }`. Refused (409) when the user already owns a workspace.
  - `POST /api/app/queues` body `{ workspaceId, name }` → 403 unless owner; 402 `{ error: "upgrade", limit: "queues" }` when at `limitsFor(plan).queues`.
  - `DELETE /api/app/queues/<id>` → owner only; DO `/internal/wipe`, then `deleteQueueRow`.
  - `DELETE /api/app/account` body `{ confirm: "DELETE" }` → wipe every queue of workspaces the user owns, delete those organisations, then the user (`auth.api.deleteUser`, enable `user.deleteUser.enabled`).
- Pages:
  - `/` (`home.html`): the canvas **Landing** artboard (nav, hero, how it works, why not pagers, privacy, Free/Plus "Coming soon", honest answers, final CTA, footer).
  - `/login`: canvas **Login** artboard. Google button only when Google is configured (`__GOOGLE__` flag); email + "Email me a code" (Turnstile widget, site key `__TURNSTILE_SITE__`) only when `EMAIL_MODE !== "off"`; code step with "Use another email" and a 60 s resend countdown. After sign-in → `next` param or `/app`.
  - `/start`: canvas **Register** artboard. Business name (shows `aqona.app/q/<slugify(name)>` preview), your name; both kept in `sessionStorage` (`aqonaStart`) and sent to `/api/app/onboard` right after sign-in.
  - `/app`: dashboard in the Staff sidebar style: workspace name, its queue card (name, join link, QR, "Open staff page", "Print poster"), "Delete this queue" and "Delete my account" in a separate danger zone (type DELETE to confirm), sign out. First visit with no workspace → "Name your business or queue" form (prefilled from `aqonaStart`).
  - `/privacy`: what is stored (owner/staff name and email, queue names; customers' optional first name and push address, cleared nightly), why, processors (Cloudflare; Better Auth Infrastructure when `BETTER_AUTH_API_KEY` is set; Google if used), how to delete (account page or email).
- Staff page: add a "Sign out" and "All queues" link in the sidebar footer; the account chip shows the signed-in name.

- [ ] **Step 1:** Implement `src/app-api.ts` handlers; add routes in `src/index.ts`.
- [ ] **Step 2:** Build the five pages from the artboards (same tokens and fonts as `customer.html`); visual check at 390 and 1440 with headless Chrome.
- [ ] **Step 3:** `npm run check` → pass.
- [ ] **Step 4: Commit** `feat: home, log-in, start free, dashboard and privacy pages`.

### Task 5: Customer and staff pages under `/q/<slug>`

**Files:**
- Modify: `src/pages/customer.html`, `src/pages/staff.html`, `src/pages/poster.html`, `src/pages/sw.txt`, `src/index.ts` (manifest)

- [ ] **Step 1:** Every `fetch`/`WebSocket`/`location` path in the three pages is prefixed with `BASE` (`const BASE = '__BASE__'`). localStorage key `buzzerTicket:` + slug; resume only from `BASE` (the join page), never from `BASE/t/<id>`.
- [ ] **Step 2:** Per-ticket manifest at `/q/<slug>/manifest/<id>.json` with `start_url: /q/<slug>/t/<id>`, `scope: /q/<slug>/`.
- [ ] **Step 3:** Customer page shows a visible message when push registration fails (design: "Show the customer why lock-screen alerts are off").
- [ ] **Step 4:** Commit `feat: customer and staff pages per queue`.

### Task 6: End-to-end checks and docs

**Files:**
- Modify: `scripts/smoke.ts`, `README.md`, `.dev.vars.example`
- Create: `scripts/dev-login.ts` (signs in through the API: sends a code, reads it from local D1 with `wrangler d1 execute aqona --local --json --command "select value from verification where identifier like '%<email>%' order by createdAt desc limit 1"`, posts `/api/auth/sign-in/email-otp`, returns the cookie). If the stored value is hashed, switch the plugin to `storeOTP: "plain"` **only when** `EMAIL_MODE === "console"`.

- [ ] **Step 1: Smoke rewrite.** Two users A and B sign up via `dev-login`; A onboards "Ana's Milk Tea" → slug. Run the existing customer/staff checks against `/q/<slug>` with A's cookie. New checks: logged-out `api/buzz` → 401, `ws/staff` → 401, `/q/<slug>/staff` → 302 `/login`; B → 403; `/q/does-not-exist` → 404; `/staff` → 302 `/login`, `/join` → 302 `/`; manifest `start_url` per slug; join page contains `buzzerTicket:` + slug; second `POST /api/app/queues` → 402; delete queue with a connected customer socket → socket closes with 1000, `/q/<slug>` → 404; delete account → A's session gives 401.
- [ ] **Step 2:** Run `npm test`, `npm run check`, `npm run db:migrate:local`, `npm run dev`, `npm run smoke` → all pass.
- [ ] **Step 3: README**: new setup (`.dev.vars` from example, `npm run db:migrate:local`), deploy order (owner: `wrangler login`, `d1 create`, secrets, Google OAuth client with redirect `https://<host>/api/auth/callback/google`), live site = Google only until email is set up.
- [ ] **Step 4: Commit** `test: end-to-end checks for accounts and per-queue routes`; open the PR with the template.

## Owner-only steps (before deploy)

1. `npx wrangler login`, then `npx wrangler d1 create aqona` (or let the builder run it after login).
2. Google Cloud OAuth client (Web app): authorized redirect `https://aqona.<account>.workers.dev/api/auth/callback/google` and `http://127.0.0.1:8787/api/auth/callback/google`.
3. `npx wrangler secret put` for `BETTER_AUTH_SECRET` (`openssl rand -base64 32`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SECRET_KEY`, `BETTER_AUTH_API_KEY`.
4. Turnstile site in the Cloudflare dashboard (site key goes in `wrangler.jsonc` vars, it is public).
