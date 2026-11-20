# TypeScript Conversion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the server code and tests from JavaScript to TypeScript with no change in behaviour, so the accounts work starts on a typed base.

**Architecture:** Same files, renamed `.js` → `.ts`, with types added. Wrangler compiles TypeScript itself (no build step). Tests keep running on plain `node --test`, using Node's built-in type stripping, so imports name `.ts` files explicitly and the code avoids TypeScript-only runtime syntax (no `enum`, no `namespace`, no constructor parameter properties). `tsc --noEmit` is the type checker. Customer-facing page scripts (`src/pages/*`) stay plain JavaScript.

**Tech Stack:** TypeScript 7.0.2 (`tsc --noEmit` only), Wrangler 4.165.0 (`wrangler types` for the Workers runtime and `Env` types), Node 24 (`node --test` with type stripping).

**Spec:** `docs/design/2026-11-20-aqona-accounts-design.md` (owner decision 6: "Server code moves to TypeScript first, as its own pull request before slice 1. Customer-page scripts stay plain JavaScript.")

## Global Constraints

- No behaviour change: every route, message, status and timing stays as it is today.
- `npm test` must keep working with no extra test runner (plain `node --test`).
- Imports between `.ts` files use the `.ts` extension (`import { QueueCore } from "./queue-core.ts"`): Node's type stripping requires it.
- Only erasable TypeScript syntax (`erasableSyntaxOnly: true`): no `enum`, `namespace`, parameter properties, or `import x = require()`.
- `strict: true`. No `any` except at JSON-parsing boundaries, where the value is narrowed straight away.
- `src/pages/*` (HTML, `sw.txt`, `icon.svg`) are not converted.
- No secrets in the repo. `.dev.vars` stays gitignored.
- Branch off `main`. Commit hooks strip AI attribution; never use `--no-verify`.

## Review Focus

1. **Cloudflare build:** the GitHub build runs `npm clean-install` then `npx wrangler deploy` on a fresh machine with no `.dev.vars`. It must still deploy. Pinned by the `wrangler deploy --dry-run` step in Task 2.
2. **Test discovery:** `node --test` must find `.test.ts` files, or `npm test` "passes" while running 0 tests. Pinned by the expected count of 32 in Task 1.
3. **Page text imports:** `.html`, `.txt` and `.svg` imports must still bundle as strings, and the pages must render. Pinned by the smoke run in Task 2.
4. **Optional settings typed as always present:** `VAPID_PRIVATE_KEY` (secret) and `PUBLIC_URL` (dev only) may be missing. Their types must be `string | undefined`, so the existing "push skipped" and `url.origin` fallbacks stay type-checked. Pinned by Task 2's `env.d.ts`.
5. **Stale generated types:** `worker-configuration.d.ts` drifting from `wrangler.jsonc`. Pinned by `npm run check`, which runs `wrangler types --check` before `tsc`.

---

### Task 1: TypeScript tooling and the pure modules

Converts the three modules that run in plain Node and their tests, and adds the tooling around them.

**Files:**
- Create: `tsconfig.json`, `src/types.d.ts`, `test/types.d.ts`
- Modify: `package.json` (devDependencies, scripts)
- Rename and type: `src/reset-time.js` → `src/reset-time.ts`, `src/queue-core.js` → `src/queue-core.ts`, `src/push.js` → `src/push.ts`, `scripts/gen-vapid.js` → `scripts/gen-vapid.ts`
- Rename and type: `test/reset-time.test.js`, `test/queue-core.test.js`, `test/push.test.js` → `.test.ts`

**Interfaces:**
- Produces (used by Task 2 and the accounts work):
  - `src/queue-core.ts` exports `type TicketStatus = "waiting" | "buzzing" | "coming" | "done"`.
  - It exports `type Action = "buzz" | "ack" | "done" | "remove"`.
  - It exports `interface PushSubscriptionJSON { endpoint: string; keys: { p256dh: string; auth: string } }`.
  - It exports `interface Ticket { id: string; num: number; name: string; status: TicketStatus; key: string | null; createdAt: number; subs: PushSubscriptionJSON[] }`.
  - It exports `interface Settings { autoReset: boolean; resetTime: string; timeZone: string }`.
  - It exports `interface Meta { nextNum: number; settings: Settings; nextResetAt: number | null; dayStartedAt: number | null; lastResetIds: string[] }`.
  - It exports `interface Changes { clearAll: boolean; put: Ticket[]; del: string[]; meta: Meta | null }`.
  - The `QueueCore` methods keep today's names and arguments, with these types:
    - `join(body: { name?: unknown; key?: unknown }, opts: { now: number; newId: () => string }): { ticket: Ticket; created: boolean } | { error: "full" }`
    - `act(action: string, id: string): { ok: boolean; changed: boolean; ticket?: Ticket; removed?: boolean }`
    - `status(id: string): TicketStatus | "reset" | "gone"`
    - `takeChanges(): Changes`
    - The rest keep their current shapes, typed the same way.
  - `src/push.ts` exports `interface VapidKeys { publicKey: string; privateKey: string; subject: string }`.
  - It also exports `sendPush(sub: PushSubscriptionJSON, payload: string, vapid: VapidKeys, options?: { ttl?: number; urgency?: string }): Promise<{ ok: boolean; status: number; gone: boolean }>`.

- [ ] **Step 1: Install the tools**

Run: `npm install -D typescript@7.0.2`
Expected: `package.json` lists `typescript` 7.0.2. Then run `npx tsc --version`. Expected: `Version 7.0.2`.

- [ ] **Step 2: Add `tsconfig.json`**

Required options:
- `target` and `lib`: `ES2023`.
- `module`: `ESNext`, with `moduleResolution`: `Bundler`.
- `strict: true`, `noEmit: true`.
- `allowImportingTsExtensions: true`, `verbatimModuleSyntax: true`, `erasableSyntaxOnly: true`.
- `types`: `["node"]` only for tests (see Step 4).
- `include`: `["src", "test", "scripts", "worker-configuration.d.ts"]`.

If `tsc` 7 rejects an option, fix it with the closest supported equivalent and note it in the commit message.

- [ ] **Step 3: Declare text imports in `src/types.d.ts`**

Declare three ambient modules: `*.html`, `*.txt` and `*.svg`. Each has `const content: string; export default content;`.

- [ ] **Step 4: Declare test-only modules in `test/types.d.ts`**

`http_ece` has no types. Declare `module "http_ece"` with `decrypt(buffer: Buffer, params: { version: string; privateKey: import("node:crypto").ECDH; authSecret: Buffer }): Buffer`. Install `@types/node` as a dev dependency for `node:test`, `node:assert` and `node:crypto`.

- [ ] **Step 5: Rename the files with `git mv`, add types, and switch imports to `.ts` extensions**

Keep the logic line-for-line. Add only types, plus narrowing where a value comes from `JSON.parse` or user input. `QueueCore`'s private `#` methods stay as they are, since they are erasable.

- [ ] **Step 6: Update `package.json` scripts**

The scripts become:
- `"test": "node --test \"test/**/*.test.ts\""`
- `"check": "wrangler types --check && tsc --noEmit"`
- `"types": "wrangler types"`
- `"vapid": "node scripts/gen-vapid.ts"`

- [ ] **Step 7: Run the tests**

Run: `npm test`
Expected: `ℹ tests 32`, `ℹ pass 32`, `ℹ fail 0`. A count other than 32 means test discovery broke (Review Focus 2).

- [ ] **Step 8: Run `npx tsc --noEmit`**

Expected: errors only in files Task 2 converts (`src/index.js` and `src/queue-do.js` are still JS and not in scope). If `tsc` complains about the JS files, set `allowJs: false`, the default, so it ignores them for now. No errors in the converted files.

- [ ] **Step 9: Check the key script still works**

Run: `npm run vapid | sed 's/PRIVATE_KEY=.*/PRIVATE_KEY=<hidden>/'`
Expected: a `VAPID_PUBLIC_KEY=` line of 87 characters after the `=`, and a hidden private line.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: TypeScript for queue core, reset time, push and tests"
```

### Task 2: Worker and Durable Object in TypeScript

**Files:**
- Rename and type: `src/queue-do.js` → `src/queue-do.ts`, `src/index.js` → `src/index.ts`
- Create: `worker-configuration.d.ts` (generated by `npm run types`, committed), `src/env.d.ts`
- Modify: `wrangler.jsonc` (`"main": "src/index.ts"`)

**Interfaces:**
- Consumes: Task 1's types (`Ticket`, `Meta`, `Changes`, `Settings`, `PushSubscriptionJSON`, `VapidKeys`, `sendPush`).
- Produces:
  - `export class QueueDO extends DurableObject<Env>`, with the same routes and behaviour.
  - `export default { fetch(request: Request, env: Env): Promise<Response> } satisfies ExportedHandler<Env>`.
  - The `Env` type includes `QUEUE: DurableObjectNamespace<QueueDO>`, `VAPID_PUBLIC_KEY: string` and `VAPID_SUBJECT: string`, from the generated file.
  - It also includes `VAPID_PRIVATE_KEY?: string` and `PUBLIC_URL?: string`, from `src/env.d.ts`.

- [ ] **Step 1: Generate the runtime types**

Run: `npm run types`
Expected: `worker-configuration.d.ts` is created, containing `interface Env` with `QUEUE`, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`. If it also picks up `VAPID_PRIVATE_KEY` from your local `.dev.vars`, regenerate with `--env-file /dev/null` (or the equivalent flag), so the committed file doesn't depend on one machine's `.dev.vars`. Optional settings belong in `src/env.d.ts`.

- [ ] **Step 2: Add `src/env.d.ts`**

Add the optional settings to the global `Env` interface (declaration merging): `VAPID_PRIVATE_KEY?: string` and `PUBLIC_URL?: string`.

- [ ] **Step 3: Rename and type the DO and the Worker**

Use `git mv`. Use `.ts` import extensions, and point `wrangler.jsonc` `main` at `src/index.ts`. SQL rows come back loosely typed. Parse `data` and `v` with `JSON.parse(...) as Ticket` / `as Meta` at the one load site in the constructor. No other changes.

- [ ] **Step 4: Type check everything**

Run: `npm run check`
Expected: `wrangler types --check` reports the types are up to date, and `tsc --noEmit` exits 0 with no output.

- [ ] **Step 5: Check the Cloudflare build path**

Run: `CI=1 npx wrangler deploy --dry-run`
Expected: it ends with `--dry-run: exiting now.` and lists the `QUEUE` binding, `VAPID_PUBLIC_KEY` and `VAPID_SUBJECT`, with no errors.

- [ ] **Step 6: Check behaviour hasn't changed**

Start `npm run dev`. When `Ready on http://127.0.0.1:8787` appears, run the end-to-end smoke script from the Cloudflare-move PR against it. That script isn't in the repo, so recreate it as `scripts/smoke.ts` (see Task 3) or run an equivalent check covering:
- the pages return 200;
- 20 parallel joins get #1 to #20;
- a repeated join key gives one ticket;
- buzz and done reach the customer live;
- a late ack is refused;
- reset says `reset` and closes the connection;
- names with `</script>` or `$'` don't break the page;
- bad settings return 400.

Expected: every check passes.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: TypeScript for Worker and Durable Object"
```

### Task 3: Keep the smoke test, update docs, open the PR

**Files:**
- Create: `scripts/smoke.ts`. It's the end-to-end check from Task 2 Step 6, run as `npm run smoke` against a running `npm run dev`, with the base URL as an optional argument (default `http://127.0.0.1:8787`).
- Modify: `package.json` (`"smoke": "node scripts/smoke.ts"`), `README.md` (the Test section lists `npm test`, `npm run check` and `npm run smoke`)

- [ ] **Step 1: Write `scripts/smoke.ts`**

It covers the checks listed in Task 2 Step 6. It exits 1 if anything fails, and prints `ALL PASSED` at the end on success.

- [ ] **Step 2: Run it against `npm run dev`**

Run: `npm run smoke`
Expected: the last line is `ALL PASSED`.

- [ ] **Step 3: Run the full set once more**

Run: `npm test && npm run check`
Expected: 32 tests pass, and the check exits 0.

- [ ] **Step 4: Commit, push and open the PR**

```bash
git add -A
git commit -m "test: keep end-to-end smoke check as npm run smoke"
git push -u origin <branch>
```

Open the PR with `gh pr create` and a body from `~/.claude/templates/pr-template.md`, following the rules in the global CLAUDE.md. The QA test cases are "everything behaves as before": join, buzz, done, start new day, and settings, on `npm run dev`.
