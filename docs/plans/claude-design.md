# Claude Design in Sinfonie: design, then build, without leaving the app

Status: plan, 2026-10-06. Spike done 2026-10-10 (see Spike results).

## Who designs

- **Engineers** hand a design to their agents: "implement this canvas", then check the result against it.
- **Vibecoders**: designers, the CEO and leadership, working in the guided lens. They shape an idea
  visually, tweak it on a canvas, and press **Build this**. They never see branches, diffs or terminals.

Both end in the same place: a workspace whose agent builds what the design shows, and a review that
compares the two.

## What exists, and what Sinfonie's agents can reach (checked 2026-10-06)

| Piece | What it is | Reachable from Sinfonie |
|---|---|---|
| **Design canvas** | A claude.ai Artifact running the Claude Design canvas editor (artboards, properties panel, Save publishes a version). The redesign was done on one. | Claude Code's `Artifact` tool creates and reads them. A probe of an **Agent SDK** session on the owner's login (with and without user settings) listed 30 tools: `DesignSync` but **no `Artifact`**. The full Claude Code CLI has it; Sinfonie already runs workspaces in CLI mode. |
| **Design system** | A claude.ai/design design-system project: the team's components as preview cards that canvases build from. | `DesignSync` is in SDK sessions: list/read projects, and write only through a finalized plan the user approves. Meant to run inside the user-started `/design-sync` flow. |
| **The canvas page** | A private claude.ai page. | The in-app browser can open it once signed in to claude.ai in that space's browser session, and agents already have browser tools (DOM and screenshots). |

There is no public Claude Design API, so every path goes through Claude Code's tools or the in-app
browser. Only the Claude engine has these tools; Codex, Gemini and Grok workspaces get the
browser-based path or nothing. Using them needs a claude.ai plan with Claude Design.

## The four flows

### 1. Design → build (engineers, and anyone who has a canvas)

- **Link a design** to a workspace: paste a canvas link in the chat (detected), drop it on the
  workspace, attach it from a ticket, or ask Maestro. Stored as `Workspace.designs: { url, title,
  linkedAt, version? }`.
- **Design pane**: a workspace tab next to Preview showing the canvas, signed in through the space's
  browser session. A side-by-side toggle puts the Design next to the running app.
- **The agent reads it**, picking the best path the workspace's engine allows:
  - *CLI mode (Claude engine):* `Artifact` read returns the artboards' HTML. Exact.
  - *Chat mode:* a design brief built with the browser tools: every artboard's text, layout tree and a
    screenshot, attached to the turn as images plus structure.
- The first turn's prompt says which repo and route each artboard maps to (asked once, remembered on
  the link).

### 2. Design first, then Build this (vibecoders, guided lens)

- Maestro home and the Tasks screen get **Sketch an idea**: describe it ("a friendlier checkout"),
  and Maestro creates a canvas from the team's design system, opens it in the Design pane, and offers
  **Build this** once the person is happy.
- Iterating stays visual: edits happen on the canvas (by the person or by asking Maestro); nothing
  touches code until Build this.
- **Build this** creates the task with the design linked (flow 1) and the guided vocabulary throughout.
- The CEO case: share the canvas link with the team for comments before anyone builds; a reviewer can
  press Build this for them.
- Needs `Artifact`, so canvases are made by a **design runner**: a non-interactive Claude Code CLI
  invocation driven by Sinfonie (as in CLI mode), not an SDK session. Phase 0 confirms it works.

### 3. The team's design system, per space (engineers set it up once)

- Team → a space → **Design system**: pick or create the claude.ai/design project for this space,
  choose the repo and folder of the component library, and sync. Sinfonie runs the `/design-sync`
  flow in a workspace session; the user approves the plan of files before anything is written
  (`finalize_plan`).
- Incremental after that: when a workspace changes a component, Sinfonie offers to sync that one
  component. It never replaces the whole project.
- Payoff: every canvas in flow 2 uses the real components, so designs are buildable as drawn.

### 4. Design QA in review

- When a workspace with a linked design is sent for review, the agent captures the implemented screens
  in the in-app browser and compares them with the artboards: text, layout, spacing, colours.
- The review inbox shows the deltas next to the diff ("Primary button is 12px tall, design says 16px",
  "Empty state missing"), in plain words for guided reviewers.
- Findings can go back to the workspace as a fix round, like AI review findings today.

## Safety and privacy

- Canvases and design systems live on claude.ai under the person's account and are private until they
  share them. Sinfonie never shares a canvas on its own.
- Writing to a design system always goes through the user-approved plan (`DesignSync` enforces it).
- Reading a canvas through the browser uses the person's own claude.ai session in that space's browser
  profile; nothing is copied off the Mac except what the agent sends to the model.
- Team rules apply: a space can turn Sketch an idea off, or limit who can sync the design system.

## Spike results (2026-10-10)

| Question | Answer |
|---|---|
| Can Sinfonie's agent sessions create or read canvases? | **No.** The `Artifact` tool is absent from Agent SDK sessions and from non-interactive Claude Code (`claude -p`), in the bundled 2.1.259 **and** the newest installed 2.1.285, both in the initial tool list and as a deferred tool (`ToolSearch "select:Artifact"` → "No matching deferred tools found"). It is only present in Claude Code sessions launched from the Claude app. |
| Does `DesignSync` work from an agent session? | **Yes, after a one-time authorization.** The first call returns: "DesignSync needs design-system authorization, and /design-login cannot run in this non-interactive session… run /design-login once from an interactive Claude Code session on this machine; headless and SDK runs then reuse that authorization." |
| Can the in-app browser read a private canvas? | **Not tested yet.** It needs the owner's claude.ai sign-in in a space's in-app browser (or an imported login from Arc) and a canvas link. |

### What changes

- **Flow 3 (design system per space) is buildable now.** Sinfonie detects the authorization error and
  offers "Authorize Claude Design": it opens Sinfonie's CLI terminal with `claude` and asks the person
  to run `/design-login` once.
- **Flow 1 (design → build) is buildable with a different reading path.** No `Artifact` read, so:
  - the **Design pane** accepts the canvas link (opened in the in-app browser, if question 3 passes) and
    **exported artboards** (the canvas editor exports PNG/PDF), which the agent reads as images, as chat
    images already work;
  - the design brief is built from the exported images plus whatever the browser path can read.
- **Flow 2 (Sketch an idea → canvas) is blocked** on Claude Design. Until canvases are reachable from
  headless or SDK sessions, two options:
  - *Sinfonie-native sketches:* Maestro drafts HTML mockups built from the team's design-system
    components (read with `DesignSync get_file`), shown in the Design pane, with "Open in Claude
    Design" as a manual hand-off;
  - *wait:* re-check each Claude Code release (one probe call) and switch to real canvases when
    `Artifact` appears in headless sessions.
- **Flow 4 (design QA)** works off exported artboards just as well.

## Phases

0. **Spike (1–2 days)**:
   - Does the CLI Sinfonie bundles expose `Artifact` in a non-interactive run, and can that run create
     and read a canvas?
   - How does `DesignSync`'s first-call scope prompt surface in an SDK session (no terminal)?
   - Can the in-app browser stay signed in to claude.ai and read a private canvas's artboards reliably?
1. **Design → build**: linked designs, the Design pane, the design brief (browser path) and the CLI
   path where available.
2. **Design system per space**: the Team page and the sync flow, then incremental component sync.
3. **Design first** (guided): Sketch an idea, the design runner, Build this.
4. **Design QA**: screen capture vs artboards, findings in the review inbox, fix rounds.

## Open questions

- Whose claude.ai account owns team canvases: each person's, or an organisation workspace on
  claude.ai? This matters for the CEO sharing flow.
- Should Sinfonie keep a local snapshot of the linked design version a workspace was built from, so a
  later canvas edit doesn't silently change what review compares against? Proposal: yes, pin the
  version on Build this.
- Flow 2 for non-Claude engines: design with Claude, build with another engine? Proposal: allowed; the
  design brief is engine-neutral.
