# Keep it mergeable: an agent that looks after open pull requests

Feedback #50 ("monitor PR and address / resolve comments, issues etc. (keep it mergeable)"),
2026-09-08. Status: plan, 2026-10-01.

## Problem

Opening the pull request is where most of the waiting starts. CI fails, a reviewer leaves comments, `main`
moves and the branch conflicts. Each of those needs someone to notice, then go back to the workspace and
ask the agent to deal with it. Sinfonie already has the pieces, just not tied together:

- `github.repoPrStatus`: the PR, its checks, review decision, mergeable state and review threads.
- The workspace agent, which can fix code, commit and push (`sendToWorkspace`).
- Review fix rounds (`reviews.fixFindings`, `iterate`), which apply findings and push.
- Stage automation (PR opens: In review; merged: Done), notifications, the Maestro brief and trail.
- Team guardrails (`rules`) and cost modes (Budget/Lean caps).

## Goal

Per workspace (or per PR), a **Keep it mergeable** switch. While it's on, Sinfonie watches the PR and,
when something needs doing, has the workspace's agent do it within limits you set, then tells you what
it did.

## What it watches and what it does

| Signal | Detected from | Action |
|---|---|---|
| A check fails | `statusCheckRollup` → failure | Agent reads the failing job's log (`gh run view --log-failed`), fixes the cause, commits, pushes |
| New review comment / changes requested | Unresolved review threads newer than the last round | Agent addresses each thread, replies on it saying what changed, and resolves it **only** when the reviewer's request is fully met |
| Conflicts with the base branch | `mergeable = CONFLICTING` | Agent merges or rebases (per team rule) and resolves conflicts; ambiguous conflicts stop and ask |
| Behind base, required to be up to date | `mergeStateStatus = BEHIND` | Update the branch (`gh pr update-branch`) |
| Flaky check | The same check passes on re-run | Re-run once; a second failure is treated as real |
| Approved, green, mergeable | All of the above clear | Notify "Ready to merge" (merging stays a person's call unless the team turns on auto-merge) |

## Guardrails (the important part)

Everything here leaves the Mac (pushes, comments, resolved threads), so the design guide's rule applies:
**confirm what leaves the Mac**, unless the person explicitly turned that confirmation off.

- **Autonomy, per workspace**: *Propose* (default) means the agent prepares the fix and a one-click card
  asks to push and reply. *Act* means it pushes and replies on its own, within the limits below. Guided
  users only get Propose.
- **Limits**: at most N rounds per day (default 3) and a spend cap per round (reuses the Budget
  per-turn cap). It also stops after the same failure survives two rounds, and never force-pushes.
- **Scope**: only PRs from Sinfonie workspaces, and only branches the user opened. Never someone else's PR.
- **Never**: dismiss a review, resolve a thread the reviewer did not get an answer to, change CI
  config to make checks pass, or touch protected branches.
- Team rules can require Propose for a space (for example production repos).

## Design

- `src/main/services/babysitter.ts`: one poller (every 3–5 min with backoff, on wake, and on focus)
  over workspaces with the switch on. It diffs the PR state against the last seen state, so it acts on
  what *changed*, not on everything every time.
- A round is a normal agent turn in the workspace, so it shows in the chat, in Running (#65) and in the
  usage ledger. The prompt carries the exact failing log excerpt or the thread text and the rules above.
- After a round: a trail entry in the Maestro brief ("Fixed the failing lint check on #412 and
  replied to 2 of Marta's comments"), and a desktop notification when something needs the person.
- UI: the switch and autonomy level in the workspace's PR area and in the status pill menu; a small
  "Watching" badge on the workspace; history of rounds in the PR area.
- Maestro: `babysit_pr(workspaceId, on, autonomy)` and the brief entries. A Home views action
  (`keepMergeable`) builds on the existing `fixWithAgent`.

## Phases

1. **Watch and propose**: poller, state diff, failing checks and new review threads, *Propose* cards
   only. Gets real-world signal before any autonomous push.
2. **Conflicts and up-to-date**: merge/rebase handling with stop-on-ambiguity; `update-branch`.
3. **Act mode**: autonomy setting, limits, team-rule override, brief trail, notifications.
4. **Auto-merge** (opt-in per space): merge when approved and green, respecting branch protection.

## Open questions

- Merge or rebase to resolve conflicts: follow the repo's history style, or a space setting?
  Proposal: a space setting, defaulting to merge (no force-push).
- Should replies on review threads be signed ("— via Sinfonie")? Proposal: yes, so reviewers know an
  agent wrote them.
- Does it also watch PRs opened outside Sinfonie from a workspace's branch? Proposal: yes, if the branch
  belongs to a Sinfonie workspace.
