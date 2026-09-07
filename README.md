# Sinfonie

[Download for Mac](https://sinfonie.dev) · proprietary · [Releases](https://github.com/fpolliop/sinfonie-releases/releases)

A desktop app for running coding agents in isolated workspaces where **a workspace
spans several repositories**.

When you create a workspace, Sinfonie creates a git worktree on the same branch in
every repository you select, puts them side by side in one folder, runs each repo's
setup script, and opens a Claude Code session that can see all of them. Archiving a
workspace tears everything down together.

```
~/sinfonie/workspaces/checkout-redesign/
  frontend-monorepo/   worktree of frontend-monorepo, branch checkout-redesign
  backend-services/    worktree of backend-services, branch checkout-redesign
```

## Features

- Workspace = N worktrees on one branch name, created and archived as a unit
- Claude Code chat per workspace, resumed across app restarts, with permission prompts
- Changes tab: status and diff per repo, commit, push, and `gh pr create` with links to the sibling branches
- Terminal tab: a shell per worktree with `CONDUCTOR_*` and `SINFONIE_*` env vars set
- Run tab: runs each repo's `setup` / `run` script from `sinfonie.json`, concurrently or sequentially
- A block of 10 ports per workspace, exposed as `SINFONIE_PORT`

## sinfonie.json

One per repository, at its root (`conductor.json` is read as a fallback):

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev --port $SINFONIE_PORT",
    "archive": "./scripts/cleanup.sh"
  },
  "runScriptMode": "concurrent"
}
```

Variables available to scripts and terminals, in both `CONDUCTOR_*` and `SINFONIE_*` spellings:

| Variable | Meaning |
| --- | --- |
| `PORT` | First port of the workspace's block; each repo gets its own slot inside the block |
| `ROOT_PATH` | Path of the original repository |
| `WORKSPACE_NAME` | Slug of the workspace, also the branch name |
| `WORKSPACE_PATH` | This repo's worktree |
| `WORKSPACE_ROOT` | Folder containing all worktrees of the workspace |

## Development

```
pnpm install
pnpm dev        # run with hot reload
pnpm typecheck
pnpm package    # build a .dmg into dist/
```

Requirements: Node 22, pnpm, git, and a logged-in Claude Code (`claude` on the PATH or an
`ANTHROPIC_API_KEY`). `gh` is needed for the PR button.

## Layout

- `src/main/services/workspaces.ts` creates and archives multi-repo workspaces
- `src/main/services/agent.ts` bridges the Claude Agent SDK to the UI
- `src/main/services/git.ts`, `scripts.ts`, `terminal.ts` wrap git, script runs and node-pty
- `src/renderer` is the React UI; `src/shared` holds the types and the IPC contract

## Releasing

Bump `version` in `package.json`, commit, tag and push:

```
git tag v0.2.0 && git push origin main --tags
```

The Release workflow builds the app on macOS and publishes the DMG and zip to a GitHub Release in the public `fpolliop/sinfonie-releases` repo (this source repo is private). It needs a `RELEASES_TOKEN` secret: a fine-grained personal access token with Contents read/write on `sinfonie-releases`. Running copies of the app check that release feed on launch and show a download banner when a newer version exists. Builds are unsigned until the signing secrets exist on the repo; then the same workflow signs with the Developer ID certificate and notarizes with Apple:

```
gh secret set MAC_CERT_P12 -R fpolliop/sinfonie < <(base64 -i DeveloperIDApplication.p12)
gh secret set MAC_CERT_PASSWORD -R fpolliop/sinfonie
gh secret set APPLE_ID -R fpolliop/sinfonie                    # your Apple ID email
gh secret set APPLE_APP_SPECIFIC_PASSWORD -R fpolliop/sinfonie # from appleid.apple.com → App-Specific Passwords
gh secret set APPLE_TEAM_ID -R fpolliop/sinfonie               # 10 characters, from developer.apple.com → Membership
```

## Website

`site/` is a static page hosted on Cloudflare Pages (project `sinfonie`, https://sinfonie.pages.dev). Deploy with `pnpm site:deploy` after `npx wrangler login`. The download button reads the latest GitHub Release, so it needs no change per version.

## Feedback and error reports

`site/functions/api/feedback.js` is a Cloudflare Pages Function backed by the D1 database `sinfonie-feedback`. The site form and the app's Settings → Feedback post to it; the app also posts crash reports (message, stack, version, OS; never chat content) unless the user turns that off.

- Read the queue: `pnpm feedback` (uses your Cloudflare login), or `GET https://sinfonie.dev/api/feedback?token=ADMIN_TOKEN` (secret set on the Pages project).
- Local error log on each machine: `~/Library/Application Support/Sinfonie/logs/errors.log`, also reachable from Settings → Open logs folder.
- Schema: `site/schema.sql`; apply with `wrangler d1 execute sinfonie-feedback --remote --file site/schema.sql --config site/wrangler.toml`.

## Accounts and plans

Settings → Plan signs the user in with GitHub or Google through sinfonie.dev (`site/functions/oauth/{github,google}/*` and `/oauth/poll`, same parked-code relay as Slack; a second provider with the same verified email joins the existing account) and keeps a session token in the encrypted secrets. `GET /api/me` returns the account and the effective plan (free, pro, team), computed in `site/functions/_session.js` from the user's Paddle subscription, team membership (`orgs`, `org_members`) and manual overrides (`users.plan_override`). The app caches the answer in `settings.cloud`, refreshes every six hours, and treats an answer older than two weeks as free.

- Limits per plan are in `PLAN_LIMITS` (`src/shared/types.ts`) and enforced by `cloud.assertWithin` in `src/main/services/cloud.ts` when creating spaces, adding repos to a space and adding accounts. They only bite when the server sends `enforce: true` (Pages variable `PLANS_ENFORCED=true`); existing data is never locked. `SINFONIE_PLAN=pro|team` overrides for development.
- Checkout is Paddle Billing, server-side: `POST /api/billing/checkout?plan=&period=` creates the transaction and returns the URL; `/api/billing/webhook` applies `subscription.*` events; `/api/billing/portal` opens Paddle's customer portal.
- Pages secrets and variables: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (OAuth app with callback `https://sinfonie.dev/oauth/github/callback`), `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` (web client with redirect `https://sinfonie.dev/oauth/google/callback`), `PADDLE_API_KEY`, `PADDLE_CLIENT_TOKEN`, `PADDLE_WEBHOOK_SECRET`, `PADDLE_ENV` (`sandbox` or `live`), `PADDLE_PRICE_PRO_MONTH`, `PADDLE_PRICE_PRO_YEAR`, `PADDLE_PRICE_TEAM_MONTH`, `PADDLE_PRICE_TEAM_YEAR`, `PLANS_ENFORCED`.
- Grant a plan by hand: `UPDATE users SET plan_override = 'pro' WHERE login = '<github login>'`.
- Coupon codes: `pnpm coupon new` mints a code that gives every feature for good to one person (`--uses 20`, `--days 90`, `--plan pro`, `--note "beta wave 1"` to vary it); `pnpm coupon` lists them. Each prints a link, `https://sinfonie.dev/redeem/<CODE>`, that opens the app and applies the code after sign-in; the code can also be typed under Settings → Plan → "Have a code?". A code counts once per user and never lowers a grant the user already has. The same is available over HTTP at `/api/admin/coupons` with the admin token.

## Phone companion

Settings → Phone pairs a phone: the QR carries a random key in the URL fragment; room id and auth token are SHA-256 derivations of it, and every message between Mac and phone is AES-GCM encrypted with it (`src/main/services/remote.ts`, `site/m/shared.js`). The relay is a Worker with one Durable Object per room (`relay/`, deployed to relay.sinfonie.dev with `wrangler deploy --config relay/wrangler.toml`); it forwards envelopes, queues phone → desktop messages while the Mac is offline, and sends Web Push (RFC 8291 + VAPID, implemented with WebCrypto in `relay/src/webpush.js`). The only plaintext it reads is the desktop's notification request: workspace name, prompt kind, tool name.

- Native app for iPhone and Android: `mobile/` (Expo). See `mobile/README.md`. Push goes through Expo's push service (the relay accepts an Expo push token as a push address).
- Web fallback: `site/m/` (plain JS PWA, `marked` from cdnjs for markdown). Service worker shows pushes and answers permission prompts from the notification's Allow/Deny actions by POSTing an encrypted envelope to the relay. When opened from the QR it offers to hand the pairing to the native app (`sinfonie://pair#…`).
- Pushes go out only when `powerMonitor` reports the Mac idle for `settings.remote.awayMinutes` (default 1). While a phone is connected and an agent runs, a power-save blocker keeps the Mac awake.
- Relay secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (base64url P-256), `VAPID_SUBJECT`. Overrides for development: `SINFONIE_RELAY_URL`, `SINFONIE_PHONE_URL`.
