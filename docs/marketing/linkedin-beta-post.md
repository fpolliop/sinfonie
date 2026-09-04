# LinkedIn beta invitation (draft, 2026-09-04)

Over the last year I've tried most of the AI-driven development apps: Cursor, Claude Code in the terminal, Conductor, Warp, and a few more.

Each one had something I loved and something I kept missing for the way I actually work. So I started building my own, borrowing the parts that worked for me and adding the ones nobody had.

From Conductor: workspaces as git worktrees, so every task has its own branch and folder.
From Claude Code: the permission modes, resume and fork, and running the agent's own CLI rather than reimplementing it.
From Warp: a real terminal next to the chat, not a toy one.
From Cursor: reviewing the diff before it ever becomes a PR.

And the parts that were mine:
• One workspace spans several repos. Same branch, as a worktree, in the frontend and backend monorepos at once. This is the one that made me build it.
• Any agent, your own subscription. Claude Code, Codex, Gemini CLI or Grok, plus API keys and local models.
• Spaces that keep clients apart: their own repos, Jira, MCP servers and accounts.
• A crew: an orchestrator model with subagents, and a review cockpit where a second model checks the work.

It's called Sinfonie. macOS only, rough in places, and built for my own cycle first. Now I'd like to know if it helps anyone else. If you work across more than one repo a day, download it at sinfonie.dev and tell me what breaks. There's a feedback button in the app and I read every one.

[GIF: new workspace, two repos get the same branch]

---

Notes
- Only credit a tool for a feature genuinely taken from it; drop a line rather than stretch it.
- Put the Gatekeeper "right-click → Open" instruction on the download page, not in the post.
- Reply to every comment in the first two hours.
