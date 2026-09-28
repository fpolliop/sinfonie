# Sinfonie design guide

Read this before designing or building any UI in Sinfonie, whether you are a person or an agent. It describes the
redesign ("Sinfonie Next") decided in September 2026 and the rules the current app already enforces.

- Designs: the "Sinfonie UX/UI Audit and Redesign" canvas, **Redesign** page (ask the owner for access).
- Tokens and parts for mockups: [`sinfonie-next.css`](sinfonie-next.css).
- Guardrails in code: `pnpm lint:ui` (runs inside `pnpm typecheck`) and the dev-only guided checker
  (`src/renderer/src/lib/guidedLint.ts`).

---

## 1. The model: role, mode, and Maestro

Sinfonie is one engine (workspaces across repos, a crew of agents, reviews, on-call) used by four kinds of people.
Two separate ideas decide what someone sees:

| Idea | Values | Decides |
| --- | --- | --- |
| **Role**: what you are responsible for | Builder, Engineer, Reviewer, Admin (a person can hold several) | Which sections of the app you see |
| **Mode**: how you build | Guided (describe it) or Expert (the whole toolbox) | How the Build surfaces look and speak |

**Maestro is the core.** It is one companion that every role talks to, under the same name. It knows every space,
workspace, agent, integration and note. It briefs, answers, and proposes actions. Notes are its memory.

### Decisions (28 Sep 2026)

1. Maestro has **the same name for everyone**, builders included. Never "the assistant".
2. **Suggest, then one click.** Maestro proposes an action, cites its source (a note, a rule), and a person
   confirms, even when a rule covers the case. Maestro never acts silently.
3. **Everyone lands on Maestro home.** The brief is shaped by role and lens (engineer lens, guided lens).

### Information architecture

One rail on the left, for everyone:

| Rail item | Who sees it | What it is |
| --- | --- | --- |
| **Maestro** | Everyone (home) | Brief, "I can do next" suggestions, pinned pages, conversation across all spaces |
| **Build** (guided: **Tasks**) | Builders, engineers | Expert: mission control sorted by attention. Guided: task cards with previews |
| **Review** | Reviewers, on-call | One pre-read inbox for changes from builders, engineers and agents, plus incidents |
| **Notes** | Everyone | To-dos, findings, decisions, rules. Every note has a source and links to its work |
| **Team** | Admins | Apps, people and roles, guardrails, connections, on-call, usage and billing |

Everywhere else:

- **Maestro dock (⌘J)** on every screen. It knows what the screen shows: on Build it clears blockers, on Review
  it pre-reads, on Team it sets things up.
- **⌘K** is one box for commands and questions. It runs the command if one matches, otherwise it asks Maestro.
- **Personal settings** live under your avatar: preferences, your AI accounts and model providers, your
  agent and model overrides, devices. Team-wide settings live in Team.
- **Agents** (library, crew, agent chats, runs, schedules) sit in Build. Scheduled runs report in Maestro's brief.
- **Home pages** (generated views) are pinned on Maestro home; Maestro builds and edits them.

---

## 2. Personas

| | Engineer | Builder | Reviewer / tech lead | Team admin |
| --- | --- | --- | --- | --- |
| Real job | Keep several agents moving and verify their work | See the change, trust it, get it live | Clear many small changes; focus on the risky ones | Connect apps and people; set limits once |
| Bottleneck | Attention | Feedback and trust | Reading volume and risk | Setup spread everywhere |
| Ideal feel | Mission control | "My product is the canvas" | A pre-read inbox | A checklist that ends with a working team |
| Maestro is | Chief of staff | The one they talk to | First reader | Setup partner |
| Default lens | Dark, compact | Light, comfortable | Dark, compact | Light, compact |
| Measure | Minutes an agent waits on a person | Time from asking to first preview | Time to first review | Sign-up to a teammate's first shipped change |

---

## 3. Principles

1. **The work is the interface.** Builders see their product, engineers see diffs and runs, reviewers see the
   change. Chat sits next to the work, never in front of it.
2. **Attention is the scarcest thing.** Sort every list by who is waiting on whom; "Needs you" comes first.
3. **Same engine, different lenses.** A task and a workspace are one object shown two ways, so handoffs are free.
4. **Explain in the reader's language.** "The button is bigger on phones" for a builder, "+12 −3 in index.html"
   for an engineer: the same event.
5. **Reversible by default.** Offer Undo instead of "Are you sure?". Confirm only what leaves the Mac (push,
   PRs, production, payments, money).
6. **Keyboard for experts, pointing for builders.** J/K and ⌘K on one side; click on the thing on the other.
7. **Maestro is one voice, everywhere.** Same name, knows the screen, cites the note it used, shows every change
   before making it.

---

## 4. Maestro patterns

- **Suggestion card** (`.m-card`, violet): one sentence saying what it will do and why, the source ("your note",
  "your rule allows staging migrations"), a primary button for the action, and a quiet alternative
  ("I'll answer", "Show me").
- **Brief** on Maestro home: grouped by status pill (Ready, Needs you, Incident, Slack). One line each, with one
  action.
- **Citations**: every answer that relies on a note links to it. A wrong answer is fixed by editing one note.
- **Rules bind Maestro.** Team guardrails apply to it like everyone else. Production, payments and money always
  ask a person.
- **Trail**: anything Maestro did on someone's behalf shows in the next brief, with undo where possible.
- **Violet is only for Maestro.** Never use `--maestro` for app buttons or statuses.

## 5. Notes

Note kinds: **To-do**, **Finding** (what an agent learned), **Decision**, **Rule**. Decisions and rules are what
Maestro answers and acts with. Every note shows its source (you, a teammate, an agent in a named workspace, or
Slack via Maestro) and links to its workspace, file, ticket or PR. To-dos offer "Start a workspace" and
"Ask Maestro".

---

## 6. Voice and copy

- Plain sentences, sentence case, no exclamation marks. Say what happened and what to do next.
- **Guided lens never shows** branch, worktree, repo, commit, push, PR, CLI, MCP, API key, localhost, Claude
  Code, file paths, tool names or raw errors. Use the vocabulary map in `src/renderer/src/lib/guided.ts`
  (`useWords()`): workspace → task, repository → app, space → team, archive → Finish.
- File changes in guided language: "Changed the page", "Changed the styling" (`src/renderer/src/lib/activity.ts`).
- Errors go through `friendlyError()` (`src/renderer/src/lib/errors.ts`). Keep the raw text behind "Show
  details" and mark that element `data-expert-ok` so the guided checker allows it.
- Status always has a word, never colour alone: "Needs you", "Running", "Ready to ship", "3 tests failing".
- Buttons are verbs that say the result: "Send to Marta", "Allow once", "Open 2 PRs". Never "OK" or "Submit".

---

## 7. Visual system

Two lenses share one set of parts. Tokens are in `sinfonie-next.css`: the `.t-dark` and `.t-light` classes plus
`.compact` (13px) and `.comfy` (15px) density.

### Colour (every pairing checked for 4.5:1 or better)

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| bg / surface / surface-2 | #0e0f13 / #15171c / #1c1f26 | #f6f5f2 / #ffffff / #f1f0ec | Grounds |
| text / text-2 / text-3 | #eceef2 / #a8aebb / #8a91a0 | #1b1c20 / #55585f / #6b6e75 | Body, secondary, tertiary |
| primary | #3b57d4 (white text 6.0:1) | #3b57d4 | Primary buttons only |
| accent | #8aa4ff | #3b57d4 | Links, focus, running |
| attn (needs you) | #f5a524 | #9a5200 on #fff1dc | Waiting on a person |
| ok / danger | #3ecf8e / #ff7a7a | #137a4b / #b42318 | Done, failed |
| maestro | #c9b6ff | #5b3fc4 on #f1ecff | Maestro only |

- The current app's tokens (`src/renderer/src/index.css`) are the dark lens today; move them toward these.
- Never put white text on `accent-2` (3.6:1); use `bg-primary`. `pnpm lint:ui` rejects it.

### Type

- System font (SF Pro on macOS); mono is SF Mono / Menlo.
- In the current app, sizes stay on the scale **11 · 12 · 13 · 15 · 18 · 24 px** (enforced by `pnpm lint:ui`).
  Body text is 13px in the expert lens and 15px in the guided lens.
- Prose is capped at 72ch. Code and tables may use the full width.

### Parts (classes in `sinfonie-next.css`)

`win`, `titlebar`, `rail`/`rail-item`, `dock`/`dock-head`/`m-input`, `card`, `panel`, `btn`
(`primary`, `ghost`, `sm`, `lg`), `pill` (`attn`, `run`, `ok`, `danger`, `idle`), `chip`, `seg`, `kbd`, `pulse`,
`m-mark`, `m-card`, `m-say`, `note`, `src`, `diff`, `site` (the user's own product in a preview), `pick` (a
pointed-at element).

Key components and their two voices:

| Component | Expert voice | Guided voice |
| --- | --- | --- |
| Permission | Tool, agent, exact command; Deny / Always / Allow once | Plain headline, "If you're not sure, say no and ask …"; No / Go ahead; details folded |
| Working line | Current tool, model, elapsed, Stop ⌘. | "Working on it", elapsed, last 3 plain steps, Stop |
| A change | Path with +/− counts, Diff | Sentence plus before/after, Undo |
| Send / ship | Open N PRs | Send for review sheet with Maestro's checks and the reviewer's view |

---

## 8. Interaction rules

- **Undo vs confirm**: undo toasts for removals and clearing; confirm for push, PRs, deletes of shared things,
  production.
- **Keyboard**: ⌘K palette, ⌘J Maestro, ⌘/ shortcut sheet, J/K to move in lists, ↵ to open, A to allow, R to
  reply, D to diff. Global shortcuts yield to the editor and terminal (`src/renderer/src/lib/keys.ts`).
- **Focus**: every control shows `:focus-visible`; dialogs trap focus (`useFocusTrap`) and label themselves.
- **Hover-only controls** also appear on keyboard focus (`.reveal-on-focus` with `group`).
- Icon-only buttons use `IconButton` with a label. Targets are at least 24px (44px on touch).
- Success goes through `notify()`, never the error channel.

---

## 9. For agents designing on the canvas

- One artboard per screen, a 1440×900 desktop window (390×844 for phone). Load the shared stylesheet asset after
  the `support.js` line and compose with its classes.
- Use real `<button>`, `<input>` and `<label>` elements, even in mockups. No emoji: inline stroke SVG icons only.
- Use realistic sample data consistent with the canvas: space **Acme**, apps **web**, **api**, **ml** and
  **Coffee Shop**, people **Francisco** (admin, engineer), **Marta** (reviewer), **Ana** (builder) and **Jonas**
  (engineer, on-call). Don't invent metrics about real usage.
- Show both lenses when a screen serves both personas, or state which lens it is in the board title.
- Every new screen must name its role, its lens, and where it sits in the rail.

## 10. For agents building in code

- Guided-visible strings go through `useWords()` or `friendlyError()`, and must pass the guided checker in
  `pnpm dev`.
- Run `pnpm typecheck` (tsc plus UI lint) and `pnpm build` before committing.
- Reuse the primitives in `src/renderer/src/components/ui.tsx`: `Button`, `IconButton`, `Dialog` (including
  `bare` for palettes), `Segmented`, `Toggle`, `SectionHeader`, `Field`, `inputCls`.
- Build order (from the build plan):
  1. Maestro home, dock and rail
  2. Mission control and Notes
  3. The workspace split view
  4. The builder preview-first task screen (test with users first)
  5. One review inbox
  6. Team console and guardrails
