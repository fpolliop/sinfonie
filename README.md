# Sinfonie

[Download for Mac](https://sinfonie.dev) · MIT · [Releases](https://github.com/fpolliop/sinfonie/releases)

A desktop app for running coding agents in isolated workspaces, in the spirit of
[Conductor](https://www.conductor.build/), with one difference: **a workspace spans
several repositories**.

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
- Run tab: runs each repo's `setup` / `run` script from `conductor.json`, concurrently or sequentially
- A block of 10 ports per workspace, exposed as `CONDUCTOR_PORT` (existing `conductor.json` files work unchanged)

## conductor.json

Sinfonie reads the same file Conductor does, at the root of each repository:

```json
{
  "scripts": {
    "setup": "pnpm install",
    "run": "pnpm dev --port $CONDUCTOR_PORT",
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

The Release workflow builds the app on macOS and publishes the DMG and zip to a GitHub Release. Running copies of the app check that release feed on launch and show a download banner when a newer version exists. Builds are unsigned until Apple signing secrets are added to the workflow.

## Website

`site/` is a static page hosted on Cloudflare Pages (project `sinfonie`, https://sinfonie.pages.dev). Deploy with `pnpm site:deploy` after `npx wrangler login`. The download button reads the latest GitHub Release, so it needs no change per version.
