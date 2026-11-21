# Sign-in, onboarding and one app for owner and staff (design)

Status: proposal, screens on the design canvas (rows "Proposal A"). Not built.
Owner decisions: 2026-11-21.

## Why

- Log in and Start free are two screens that do the same thing (both only "Continue with Google").
- After sign-up the owner gets one "Name your business" form, then a dashboard that says "Free plan"
  four times, shows "Add a queue" (people don't understand it) and shows delete buttons right away.
- Owner dashboard and staff page look different. Staff have to find their counter.
- "Queue" is unclear to shop owners; "Counter" is what they call it.

## Goals

1. One sign-in screen for new and returning people: Continue with Google, or email + 6-digit code.
   New account → onboarding. Existing account → their shop.
2. Onboarding for owners: (1) pick a plan, (2) name the shop, (3) invite staff (skippable) → Home.
3. Home's first card: **Print your QR poster**, with a 3-step getting-started list.
4. One app shell for everyone (owner and staff): same top bar and sidebar.
5. The plan is shown once (top bar chip "Free plan · See Pro").
6. The first counter is created automatically ("Counter 1"). No "Add a queue" on Free.
7. Staff sign in and land straight on their counter.
8. Wording: "queue" → **Counter / Counters** everywhere in the app.
9. **No delete buttons in daily work.** The counter list has Notify and Done only (the "×" remove goes).
   Team keeps "Remove from team" inside a "⋯" menu (an owner must be able to remove someone who left).
10. **History (archive).** Every past day stays after the nightly reset: per day customers, served, no-shows,
    average wait, and each ticket's number, times and result. Download as CSV.
11. **Display screen is on every plan, Free too** (public "Now calling" link for a TV).

## Non-goals

- Payments. Pro and Max stay visible but can't be chosen yet.
- More than one counter on Free.
- Separate permission levels beyond "only the owner manages staff".

## Decisions (owner)

- **Plan step:** Free first. Picking Pro or Max shows a validation message ("Pro opens soon. For now every
  shop starts on Free") and the only way forward is "Continue with Free".
- **Permissions:** owner and staff use the same screens. Only the owner sees Team (add/remove staff).
  Staff can use Settings. (This changes PR #16, where Settings is owner-only.)
- **Staff landing:** staff go straight to their counter after sign-in.
- **Sign-in:** owners may use Google or an email code. Email codes need email sending on the live site
  (today `EMAIL_MODE=off`).
- **Invites:** owner types the person's email; Team also gives a "Copy invite link" to send by Messenger or
  WhatsApp, because the live site can't send emails yet. The invited person signs in with that email and
  joins. Links work 7 days.
- **Staff at one shop, owner of another:** allowed. A shop switcher in the top bar lists every shop with the
  person's role; "Create another shop" at the bottom.
- **Structure (approach A):** one app per counter instead of a separate shop dashboard.

## Approaches considered

- **A. One app per counter (picked).** Sidebar: Home, Counter, QR & poster · Team (owner only), Settings ·
  Pro (locked) items. Owners land on Home, staff on Counter. On Pro a counter switcher sits in the top bar.
  One place to learn; matches "staff go straight to their counter".
- **B. Shop dashboard + separate counter page, same shell.** Closer to what's built, but two places to learn
  and staff would rarely use the dashboard.

## Screens (design canvas)

Sign in · Enter code · Onboarding 1 Plan (interactive) · Onboarding 2 Shop · Onboarding 3 Team ·
Staff opens invite link · Owner Home · Staff on Counter (no Team) · History · Display screen · Team (full) ·
Team (Play: checks) · Shop switcher open · Pro: Home, counter switcher, Team (5 seats, counter per person), Reports, Branding.

## Later decisions (owner, 2026-11-21) and their effects

- **History keeps no names:** customer first names are still removed when the day ends, because the home page
  and privacy notice promise "cleared every night". Numbers, times and results are kept. (Builder's call to
  confirm with the owner before changing the promise.)
- **Display screen moves to Free:** home page pricing (Free list gains "Display screen for a TV at the counter",
  Pro list and the FAQ drop it), staff page (no lock on Display screen), and the design doc's plan table.
- **Team at the limit:** the invite box hides when staff seats are used up (Free 2, Pro 5) and a banner offers
  "Remove someone or move to Pro". Invite checks: empty, not an email, your own email, already on the team,
  already invited.

## Left to the builder

- Storage for History (a per-day archive written at reset, without names).
- Data model for invites (pending invite rows with email, shop, expiry) and joining on sign-in.
- Email sending provider for codes and invite emails (until then: link only, codes only in local dev).
- Routing: `/login` and `/start` become one page; `/app` becomes the counter app; old `/q/<slug>/staff`
  keeps working.
- PR #18 (dashboard top bar) is superseded by this; reuse its top bar/menu code.
