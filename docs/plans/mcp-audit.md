# MCP integrations audit (13 Oct 2026)

Trigger: a Lumepic developer reported that Slack and Jira MCP "don't work, and when they do they disconnect randomly".

## How each integration reaches an agent

| Engine | Jira / Linear (before) | Slack (before) |
| --- | --- | --- |
| Claude Code in-app chat (`agent.ts`) | Remote URL + static bearer; session rebuilt only if a message was sent while idle after expiry | **Missing**: Sinfonie's Slack tools were never added |
| Claude Code CLI (`cli-session.ts`) | Static bearer written to the CLI's `.mcp.json` for the CLI's whole life | In-process tools over the hook port |
| Crew workers, Maestro | Static bearer per run (fresh each run) | In-process tools |
| ACP (Codex, Gemini, Grok) | Static bearer for the session; an expired Jira login threw and dropped **every** MCP server; disabling Jira silently skipped Linear | None |
| Native | Static bearer for the client's life | None |

## Findings

1. **Refresh race logs people out (Jira, Linear).** The MCP SDK refreshes on a 401 inside each client. Atlassian rotates refresh
   tokens, so two refreshes at once spend the same one twice; the loser gets `invalid_grant`, the SDK wipes the stored tokens,
   and Sinfonie marks the connection disconnected. Reproduced against a fake rotating OAuth server: two concurrent `auth()`
   calls ended with stored tokens `undefined`. Two workspaces starting together, or Maestro plus a session, is enough.
2. **A network error during refresh counts as "sign in again".** The SDK swallows non-OAuth errors in refresh and falls through to
   a new authorization, which a background call cannot do, so a Wi-Fi blip at the wrong minute disconnected Jira.
3. **Static bearers die within the hour.** CLI sessions, ACP and native kept the first token forever. The in-app chat reloaded
   only when the user sent a message after expiry; a long turn, or a queued message, ran with a dead token.
4. **Slack refresh disconnected on any error** (network, the sinfonie.dev proxy, 5xx) and was not single-flight; one
   `invalid_auth` from any API call also disconnected it without retrying.
5. **Slack missing from the main chat.** The in-app Claude Code session never got Sinfonie's Slack tools; only CLI sessions,
   workers and Maestro had them.
6. **No mid-session health.** MCP status was read once, at init. A server that dropped later was neither reported nor reconnected.
   `pending` at init was treated as fine and never checked again.
7. **Inherited servers are hidden.** Failures of servers from the user's own Claude Code config are folded into one info notice per
   app run. With a separate Claude account (its own `CLAUDE_CONFIG_DIR`), the user's `~/.claude.json` servers are not loaded at all.
8. **Refresh tokens could be lost** when a server answers a refresh without a new refresh token (the SDK overwrote it).

## Fixes (branch `mcp-audit`)

- `oauth-refresh.ts`: one refresh in flight per connection; keep the stored refresh token when none is returned; only
  `invalid_grant` / `invalid_client` / `unauthorized_client` count as signed out; everything else is retryable and keeps the login.
- `jira.ts`, `linear.ts`: the internal MCP clients use a fetch that adds the token and refreshes once on a 401 (no SDK authProvider
  refresh). `tokenFor()` replaces `warmToken` / `tokenExpiresAt`.
- `mcp-relay.ts`: a local relay (`127.0.0.1`, per-run secret) in front of Atlassian and Linear. Every engine now gets the relay URL,
  and the relay adds a fresh token per request, retrying once on a 401. A dead login answers 403 with "Reconnect Jira in Sinfonie's
  Settings", not a 401 that would start an OAuth flow against the relay. The idle-reload-on-expiry workaround is removed.
- ACP: Jira and Linear are checked independently; an expired login no longer drops the other servers.
- Slack: single-flight refresh; only dead-login answers disconnect; `invalid_auth` renews and retries once first. The in-app chat
  gets Sinfonie's Slack tools (read tools pre-allowed, posting still asks), unless the user configured their own `slack` server.
- After each turn, Sinfonie's servers are checked with `mcpServerStatus()`; a failed one is reconnected with
  `reconnectMcpServer()`, and the user is told once if that does not help.

## Tested

- Fake rotating OAuth server: 5 concurrent refreshes share 1; rotated token stored; stale-forced reuse; network error and 503 are
  transient with the login kept; recovery after an outage; `invalid_grant` is the only sign-out. (13/13 with the relay tests.)
- Relay with the real MCP SDK client against a fake MCP server: SSE and JSON responses, 401 → refresh → retry, session id passed
  through, wrong secret refused, revoked login → readable 403.
- Typecheck and UI lint pass.

## Not tested yet

- `pnpm build` and the dev app (blocked in this session).
- The SDK `reconnectMcpServer()` path live (the bundled CLI would not start from the sandboxed shell).
- Real Atlassian, Linear and Slack logins: needs a connected account.

## Open questions for the reporter

- Which Slack and Jira does he use: Sinfonie's integrations (Settings, Integrations) or servers from his own Claude Code config
  (`claude mcp add`, claude.ai connectors)? Finding 7 covers the second case; the fixes above cover the first.
- Engine (Claude Code chat, CLI, Codex/Gemini) and whether he uses a separate Claude account in Sinfonie.
