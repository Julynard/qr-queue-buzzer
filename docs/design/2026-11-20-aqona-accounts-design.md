# Aqona accounts: design

Status: approved by the owner (2026-11-20), including account settings and super admin.

## Intent

Aqona (today's QR queue buzzer) runs one shared queue that anyone can control. To put it in front of real
shops, anyone should be able to sign up from the website, create their own queue, and get their own QR code
and staff page, without a registered business and without us setting them up by hand.

Who signs up: a person (shop owner, freelance barber, clinic secretary, event organiser, school registrar).
Customers waiting in a queue never sign up and never give personal data. That privacy rule is unchanged.

## Goals

1. Self-serve sign-up and log-in from the website, with no passwords: Google sign-in, or a 6-digit code sent by email.
2. Someone who signs up with "Start free" gets a **workspace** (the account's "business", named by the user; no papers needed).
   Someone who arrives through a staff invite does not get asked to create one.
3. A workspace has **queues**. Each queue has its own permanent address, QR code, staff page, daily reset and settings,
   and works exactly like today's single queue.
4. Owners can invite **staff** by email. Staff log in the same way and can run the queue.
5. Every workspace is on the **Free** plan. Plan limits exist in code but are generous or off, so they can be switched on
   later when paid plans exist.
6. The current public, unprotected `/staff`, `/join` and `/t/<id>` pages are retired.
7. Owners can delete a queue or their whole account, and that removes all of its data (including the live queue).
8. Shop owners manage their own Aqona account and their staff from one settings page.
9. The Aqona owner has a **super admin** panel to look after all accounts: find users and shops, block abuse,
   delete accounts, and set a shop's plan by hand.

## Non-goals (this version)

- Payments, paid plans, and paid-plan features (branding, reports, multiple branches, food-park QR, waiting-screen promos).
- Staff PIN (replaced by staff log-in).
- Customer accounts, SMS, phone numbers, native apps.
- Custom domains per shop.

## Anti-goals (would make this a failure even if it works)

- Collecting personal data from customers in the queue.
- A Free shop hitting a hard limit in the middle of a rush with no way out.
- Passwords to store or reset.
- Requiring business registration documents.
- Breaking the customer flow: scan → join → get buzzed must stay as fast and simple as today.
- Anything that lets a test or preview build touch live queues.

## Constraints

- Cloudflare Workers: the owner agreed to move to **Workers Paid** (about US$5/month) when needed. That removes the free
  plan's shared 100,000 requests/day ceiling and its Worker size limit, and allows Cloudflare Email Service.
- The GitHub repository is public: no secrets or business strategy in the repo. Prices are public on the pricing page
  (owner, 2026-11-21: Free ₱0, Pro ₱299/month for up to 5 counters, Max ₱999/month for up to 10 counters and branches;
  yearly = 2 months free). Set after comparing Pumila.ph (Free/₱199/₱399/₱999/₱2,499) and a ₱5,699 10-disc pager set.
- Email sending needs an owned domain (`aqona.app`; the owner will buy it before real shops print QR codes).
  Login codes and invites are sent with **Cloudflare Email Service** (needs Workers Paid and the domain onboarded).
- Production Google sign-in should run on the owned domain. The `workers.dev` address is the live site (preview builds are off),
  so testing happens locally with `wrangler dev`, not on `workers.dev`.
- Printed QR codes contain the full web address. Real shops should only print QR codes once the final address (`aqona.app`)
  is live; afterwards `workers.dev` should redirect to `aqona.app` so any early test prints keep working.
- Philippine Data Privacy Act: we store owners' and staff members' emails and names. We need a privacy notice and real deletion.
- Existing behaviour that must keep working per queue: WebSocket live updates with 10s polling fallback, lock-screen push,
  daily reset (default 00:00 Asia/Manila, configurable), join idempotency key, the status transition rules, the
  999-tickets/day safety cap.

## Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A (chosen)** | **Better Auth** (open-source auth library) inside the Worker, with **Cloudflare D1** for accounts, workspaces, members and queues | Free, data stays in our Cloudflare account, the library already handles Google sign-in, email codes, sessions and invitations. One dependency to keep updated. |
| B | Hosted auth (Clerk, Auth0, Firebase) | Fastest log-in screens, but user data lives with another company, monthly cost as it grows, and Workers integration friction. |
| C | Hand-written auth | No dependency, but the most code in the most security-sensitive area. |

Cloudflare Access was ruled out: it is for company staff, not public sign-up.
The user chose A.

## Design

### Pieces

- **D1 database** (new): Better Auth's tables (users, sessions, sign-in accounts, verification codes, and its organisation /
  member / invitation tables) plus our own `queue` table. Better Auth's "organisation" maps to our **workspace**.
- **Queue Durable Object** (existing `QueueDO`): one per queue, addressed by the queue's internal id (not the slug).
  Holds tickets, live connections, push and the daily-reset alarm, as today.
- **Worker** (existing `src/index.js`): serves pages, runs Better Auth under `/api/auth/*`, checks log-in and membership,
  looks up queues in D1, and forwards queue calls to the right Durable Object.

### Data

- `queue`: `id`, `workspace_id`, `slug` (unique, permanent), `name`, `created_at`.
- Workspace plan: stored on the workspace (`plan = 'free'` for everyone in this version).
- Plan limits live in one place in code. **Free plan** (owner's decision):

  | Limit | Free | Enforcement |
  |---|---|---|
  | Queues per workspace | 1 | Hard: creating a second queue is refused with an "upgrade to Pro" message |
  | People per workspace | Owner + 2 staff | Hard: a fourth invite is refused (pending invites count) |
  | Tickets per queue per day | 300 | **Soft**: customers are never blocked; past 300, the staff page shows "over the Free limit today" |

  The existing 999-tickets/day cap stays as a hard safety limit for everyone.

### Addresses

| Address | Who | What |
|---|---|---|
| `/` | public | Home page: what Aqona is, "Start free" button, link to log in. |
| `/login` | public | Google sign-in or email code. |
| `/app` | logged in | Dashboard: workspace name, list of queues, create queue, staff/invites, delete queue, delete account. |
| `/q/<slug>` | public | Customer join page (what the QR opens). |
| `/q/<slug>/t/<ticketId>` | public | Customer ticket page. |
| `/q/<slug>/qr` | logged-in member | Printable QR poster. |
| `/q/<slug>/staff` | logged-in member | Staff page (today's staff page, per queue). |
| `/privacy`, `/terms` | public | Privacy notice and terms. |
| `/api/auth/*` | public | Better Auth endpoints. |

Queue API and live connections move under the queue's address (`/q/<slug>/api/...`, `/q/<slug>/ws/...`).

**Which queue calls need log-in** (checked in the Worker before the call reaches the Durable Object):

- Public (customers): join, ticket page, `status`, `subscribe`, `ack`, the ticket WebSocket.
- Logged-in members of the queue's workspace only: `state` (the list of names), `buzz`, `done`, `remove`, `reset`,
  `settings`, the staff WebSocket, the QR poster.

The staff WebSocket is authenticated by the session cookie on the upgrade request (same origin), checked in the Worker
before forwarding.

### Slugs

- Made from the queue name when it is created (lowercase, letters/numbers/dashes), with a short suffix if taken.
- **Permanent** once created, because printed QR codes point at them. Renaming a queue changes its display name only.
- A request for an unknown slug returns 404 **without creating a Durable Object** (look up D1 first; the lookup may be
  cached briefly).

### Sign-up and log-in

```
aqona.app → [Start free] → /login
  → Sign in with Google        or   email → 6-digit code (10 minutes) → enter code
  → first time: "Name your business or queue" (e.g. "Ana's Milk Tea")
     → creates workspace + first queue → /app shows the QR and "Open staff page"
```

- Email codes: rate-limited per email and per IP, with limits stored in the database (in-memory limits do nothing on Workers),
  and Cloudflare Turnstile on "Send code".
- In local development only (`wrangler dev`), the code is printed to the console instead of being emailed. The live site
  never does this: until `aqona.app` is bought and verified with the email provider, the live site offers Google sign-in only.
- Use only the official `better-auth` package (no third-party Cloudflare wrappers). Exact adapter and plugin import paths
  are to be confirmed against better-auth.com during planning; they were not verified for this design.
- Better Auth needs the `nodejs_compat` compatibility flag. Check the Worker bundle size with `wrangler deploy --dry-run`
  (on Workers Paid the size limit is no longer a concern).

### Workspaces and people (builder's call, owner may correct)

- One person can belong to several workspaces: own one, and be staff in others (a barber working at two shops).
- A workspace has exactly one owner in this version.
- `/app` shows a workspace switcher only when the person belongs to more than one workspace.
- First log-in: through an invite link → join that workspace, no "Name your business" step. Through "Start free" → create a workspace.

### Account settings for shop owners (`/app/settings`)

- **Profile**: name, email (read-only; it is the login), sign-in methods (Google linked or not), "Sign out of all devices".
- **Workspace**: rename. Shows the plan (Free) and the limits in use (queues 1/1, people 2/3, tickets today).
- **Staff**: list of members with role and date joined; pending invites with "Resend" and "Cancel";
  "Invite staff" (respects the people limit); "Remove" a staff member, which ends their sessions in this workspace at once.
- **Staff themselves**: can see the workspace and "Leave this workspace". They cannot invite, remove, or change settings.
- **Danger zone** (owner only): delete a queue; delete the account (and with it the workspace, see "Deletion and privacy").
- No ownership transfer in this version (one owner per workspace). If an owner needs to hand over, the super admin does it.

### Super admin (`/admin`)

Who: people whose email is listed in the `SUPER_ADMIN_EMAILS` setting (a Secret, comma-separated). At launch: the Aqona
owner only. The list is checked on every admin request, so removing an email removes access at once.

How they log in: **Google sign-in only** for admin access (Google's own 2-step verification protects it); an email-code
session cannot open `/admin`. Better Auth's admin plugin may provide user listing, banning and session revocation;
confirm during planning against better-auth.com, and use it only where it fits these rules.

What they can do:
- **Overview**: sign-ups today / this week, active workspaces, queues, tickets today across all shops, Cloudflare usage hint.
- **Users**: search by email or name; see their workspaces and roles, sign-in methods, created date, last active;
  **block / unblock** (blocked users cannot log in and their sessions end immediately); **delete** (same full deletion as
  self-delete, including the queues' live data).
- **Workspaces**: search by name or queue address; see owner, members, queues, plan, tickets today;
  **change plan by hand** (Free / Pro / Max), so early paying shops can be served before online payments exist;
  **transfer ownership** to another member; **delete**.
- **Queues**: **pause** a queue (its QR shows "This queue is not available right now"; staff page shows why) and resume it.
- **Audit log**: every admin action is recorded (who, what, which account, when) and shown in `/admin/log`.
  Admin actions cannot be deleted from the log.

What they cannot do (privacy by design):
- See customers' names or ticket details inside a queue. Admin views show counts only.
- Log in as another user ("impersonation"). Support happens by looking at the account's settings, not by acting as them.

Data: `admin_audit` table (`id`, `admin_user_id`, `action`, `target_type`, `target_id`, `details` JSON, `created_at`);
a `status` column on queue (`active` / `paused`); `plan` on workspace (already planned).

### Roles

- **Owner**: everything: queues, staff, settings, delete.
- **Staff**: run the queue (buzz, done, remove, start new day by hand). Only the owner changes the daily-reset settings
  (owner's decision).
- Invites: the owner enters an email; the invitee gets an email link, logs in with that email, and joins the workspace.
  Invites expire (7 days).

### Customer pages

- Unchanged behaviour, under `/q/<slug>`.
- The remembered ticket in the phone's storage is kept **per queue** (keyed by slug). Today it is one global key, so a
  customer who joined queue A and then scans queue B's QR would land on A's ticket.
- Push notification links and the per-ticket home-screen manifest use the new `/q/<slug>/t/<id>` address.
- Free plan: "Powered by Aqona" link on customer pages.
- Show the customer why lock-screen alerts are off when registering for them fails (today it fails silently).
- Detect in-app viewers (Google app / Google Lens, Facebook, Messenger, Instagram, TikTok) and show a clear banner:
  "Open in Chrome / Safari to get alerts when your phone is locked". These viewers don't support lock-screen alerts.
  Seen in testing on 2026-11-20: a QR scanned with the Google app opened in its viewer, and alerts could not be enabled.

### Retiring the old pages

`/staff`, `/join`, `/t/<id>` and the old `"default"` queue stop working: `/join` and `/t/<id>` redirect to the home page,
`/staff` redirects to `/login`. The old queue only holds test data.

### Deletion and privacy

- Deleting a queue: remove the D1 row **and** wipe the queue's Durable Object (`deleteAll` storage, delete its alarm,
  close its connections).
- Deleting an account: if it owns the workspace, delete every queue as above, the workspace, members and invites;
  then the user and sessions.
- Privacy notice: what we store (owner/staff name and email, queue names; customers' optional first name and push address,
  cleared by the daily reset), why, and how to delete.

### Deploy

- New D1 database; migrations run in the Cloudflare build **before** `wrangler deploy` (deploy command becomes
  migrations-then-deploy). Verify the automatic build token has D1 permission.
- New secrets, each added as type **Secret** (never a plain Variable, never in `wrangler.jsonc`):
  `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TURNSTILE_SECRET_KEY`, `SUPER_ADMIN_EMAILS`.
  Email goes through a `send_email` binding (Cloudflare Email Service), not an API key.
- Preview builds stay off (they would share live data).

## Delivery slices

1. **Accounts core**: D1 + Better Auth, log-in (Google; email code where the domain allows, console code in dev),
   workspace on "Start free", create a queue, per-queue addresses, staff page and staff API behind log-in, old pages
   retired, slug lookup, **privacy notice and delete queue / delete account** (needed before collecting any emails).
2. **Staff invites**, roles, workspace switcher, **account settings page**, and a **first super admin** (users and
   workspaces lists, block / unblock, delete, audit log). Public sign-up should not stay open long without a way to stop abuse.
3. **Home page, terms page**, "Powered by Aqona".
4. **Free limits enforced** (1 queue, owner + 2 staff, 300 tickets/day soft warning).
5. **Super admin, rest**: overview numbers, change plan by hand, transfer ownership, pause / resume queue.

The in-app-viewer banner and the push-failure message don't depend on accounts. They can ship first, as a small
separate pull request against today's site.

Each slice is its own pull request and leaves the site working.

## What only the owner can do

- Buy `aqona.app` (needed for emailed codes and production Google sign-in).
- Create a Google Cloud OAuth client (consent screen + client ID/secret) and add the secrets in Cloudflare.
- Move the account to Workers Paid, and onboard `aqona.app` in Cloudflare Email Sending.
- Run `npx wrangler login` once, if the builder needs to create the D1 database from the terminal.

## Left to the builder

- ORM / query layer for D1 (within what Better Auth officially supports).
- Page styling and copy for `/`, `/login`, `/app`, email templates.
- Slug algorithm details, caching of slug lookups.
- Test layout (keep `npm test` pure-Node where possible; end-to-end checks against `wrangler dev`).

## Owner decisions (2026-11-20)

1. `aqona.app` will be bought before real shops print QR codes. Until then the live site offers Google sign-in only.
2. Moving to Workers Paid (about US$5/month) is OK when needed.
3. Free plan limits as in the table under "Data": 1 queue, owner + 2 staff (hard), 300 tickets/day (soft).
4. Only the owner can change daily-reset settings; staff can still start a new day by hand.
5. The builder's calls on workspaces and people, privacy in slice 1, and local-only testing are agreed.
6. Server code moves to **TypeScript first**, as its own pull request before slice 1. Customer-page scripts stay plain JavaScript.
7. Shop owners manage their account and staff from one settings page; the Aqona owner gets a super admin panel
   (requested and approved 2026-11-20).
