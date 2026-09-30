import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { tool as aiTool, type ToolSet } from 'ai'
import { createSdkMcpServer, query, tool as sdkTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Note, NotePatch, NoteScope, NotesContext, NotesFilter } from '@shared/types'
import { isAgentOwner, isStandingNote } from '@shared/types'
import { getStore } from '../store'
import * as agentLib from './agents'
import { claudeExecutableOption } from './claude-cli'
import { accountEnv, defaultAccountId } from './accounts'
import * as usage from './usage'

/**
 * Notes, reminders, todos, decisions and rules, one JSON file per owner. An owner is a workspace id,
 * a space ("space:<id>") or the app itself ("app", for things tied to no project). The user edits them
 * in the workspace Notes panel and the Notes view; agents get the same lists as tools. Decisions and
 * rules bind agents and Maestro: agents see them first and labelled, may file decisions, never rules.
 */

export const APP_OWNER = 'app'
export const spaceOwner = (spaceId: string): string => `space:${spaceId}`

const cache = new Map<string, Note[]>()
let emitter: (owner: string, notes: Note[]) => void = () => undefined

export function setNotesEmitter(fn: typeof emitter): void {
  emitter = fn
}

function dir(): string {
  const d = join(app.getPath('userData'), 'notes')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
// "space:<id>" is not a safe file name everywhere; keep the colon out of the file system.
const file = (owner: string): string => join(dir(), `${owner.replace(':', '__')}.json`)
const ownerOfFile = (name: string): string => name.replace(/\.json$/, '').replace('__', ':')

export function list(owner: string): Note[] {
  const hit = cache.get(owner)
  if (hit) return hit
  let notes: Note[] = []
  try {
    if (existsSync(file(owner))) notes = JSON.parse(readFileSync(file(owner), 'utf8')) as Note[]
  } catch {
    notes = []
  }
  cache.set(owner, notes)
  return notes
}

/** Every owner that has notes on disk, with its notes. */
export function listAll(): { owner: string; notes: Note[] }[] {
  const out: { owner: string; notes: Note[] }[] = []
  for (const f of readdirSync(dir())) {
    if (!f.endsWith('.json')) continue
    const owner = ownerOfFile(f)
    const notes = list(owner)
    if (notes.length) out.push({ owner, notes })
  }
  return out
}

function save(owner: string, notes: Note[]): Note[] {
  cache.set(owner, notes)
  if (notes.length === 0) {
    try {
      rmSync(file(owner), { force: true })
    } catch {
      /* ignore */
    }
  } else writeFileSync(file(owner), JSON.stringify(notes, null, 2))
  emitter(owner, notes)
  return notes
}

export function add(owner: string, text: string, kind: Note['kind'], source: Note['source'] = 'user'): Note[] {
  const now = new Date().toISOString()
  const t = text.trim()
  if (!t) return list(owner)
  const note: Note = { id: nanoid(6), text: t, kind, done: false, source, createdAt: now, updatedAt: now }
  return save(owner, [...list(owner), note])
}

export function update(owner: string, id: string, patch: NotePatch): Note[] {
  const notes = list(owner)
  if (!notes.some((n) => n.id === id)) throw new Error(`No note ${id}`)
  return save(
    owner,
    notes.map((n) => {
      if (n.id !== id) return n
      const next: Note = { ...n, updatedAt: new Date().toISOString() }
      if (patch.text !== undefined) next.text = patch.text.trim()
      if (patch.kind) {
        next.kind = patch.kind
        // Decisions and rules have no status; a todo turned into one stops counting as open or done.
        if (isStandingNote(next)) {
          next.done = false
          delete next.status
        }
      }
      // status and done are one fact; whichever the caller sends wins and the other follows.
      if (patch.status) {
        next.status = patch.status
        next.done = patch.status === 'done'
      } else if (patch.done !== undefined) {
        next.done = patch.done
        next.status = patch.done ? 'done' : n.status === 'doing' ? 'doing' : 'todo'
      }
      if (patch.priority !== undefined) {
        if (patch.priority) next.priority = patch.priority
        else delete next.priority
      }
      if (patch.due !== undefined) {
        if (patch.due) next.due = patch.due
        else delete next.due
      }
      if (patch.tags !== undefined) {
        if (patch.tags.length) next.tags = patch.tags.map((t) => t.trim()).filter(Boolean)
        else delete next.tags
      }
      if (patch.archived !== undefined) {
        if (patch.archived) next.archived = true
        else delete next.archived
        // Putting a note away is not a change to it; keep its age so "older than 30 days" stays true.
        next.updatedAt = n.updatedAt
      }
      return next
    })
  )
}

/** Move a note to another owner; the id stays. */
export function move(fromOwner: string, id: string, toOwner: string): Note[] {
  if (fromOwner === toOwner) return list(toOwner)
  const note = list(fromOwner).find((n) => n.id === id)
  if (!note) throw new Error(`No note ${id}`)
  save(fromOwner, list(fromOwner).filter((n) => n.id !== id))
  return save(toOwner, [...list(toOwner), { ...note, updatedAt: new Date().toISOString() }])
}

export function remove(owner: string, id: string): Note[] {
  return save(
    owner,
    list(owner).filter((n) => n.id !== id)
  )
}

export function copy(from: string, to: string): void {
  const notes = list(from)
  if (notes.length) save(to, notes.map((n) => ({ ...n })))
}

export function deleteAll(owner: string): void {
  cache.delete(owner)
  try {
    rmSync(file(owner), { force: true })
  } catch {
    /* ignore */
  }
}

// ---------- scopes, as agents see them ----------

/**
 * What a tool call runs inside: a workspace id (its space follows), an agent's own transcript id
 * ("agent-<id>", whose space is the agent's scope), or a context object.
 */
function ctxOf(c: string | NotesContext): NotesContext & { name?: string } {
  if (typeof c !== 'string') return c
  const { workspaces } = getStore().get()
  const ws = workspaces.find((w) => w.id === c)
  if (ws) return { workspaceId: ws.id, spaceId: ws.spaceId, name: ws.name }
  if (isAgentOwner(c)) {
    const agent = agentLib.get(c.slice(6))
    return { spaceId: agent?.scope }
  }
  return {}
}

/** The owner a scope names from a context: the workspace when there is one, its space, or the app. */
export function ownerFor(scope: NoteScope | undefined, c: string | NotesContext): string {
  const ctx = ctxOf(c)
  if (scope === 'app') return APP_OWNER
  if (scope === 'space') return ctx.spaceId ? spaceOwner(ctx.spaceId) : APP_OWNER
  return ctx.workspaceId ?? (ctx.spaceId ? spaceOwner(ctx.spaceId) : APP_OWNER)
}

/** The owners visible from a context, nearest first. */
function ownersAround(c: string | NotesContext): { scope: NoteScope; owner: string; label: string }[] {
  const ctx = ctxOf(c)
  const { spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ctx.spaceId)
  return [
    ...(ctx.workspaceId ? [{ scope: 'workspace' as const, owner: ctx.workspaceId, label: `this workspace (${ctx.name ?? ctx.workspaceId})` }] : []),
    ...(space ? [{ scope: 'space' as const, owner: spaceOwner(space.id), label: `the space (${space.name})` }] : []),
    { scope: 'app', owner: APP_OWNER, label: 'the app (not tied to a project)' }
  ]
}

function findOwner(c: string | NotesContext, id: string, scope?: NoteScope): string {
  if (scope) return ownerFor(scope, c)
  for (const o of ownersAround(c)) if (list(o.owner).some((n) => n.id === id)) return o.owner
  throw new Error(`No note ${id} in this workspace, its space or the app`)
}

/** Rules first, then decisions, then everything else; order kept within each group. */
const KIND_RANK: Record<Note['kind'], number> = { rule: 0, decision: 1, todo: 2, note: 2 }
export const byStanding = (a: Pick<Note, 'kind'>, b: Pick<Note, 'kind'>): number => KIND_RANK[a.kind] - KIND_RANK[b.kind]

/** How a note's kind reads in text for agents: "Rule: ", "Decision: ", a todo checkbox, or nothing. */
export function kindPrefix(n: Note): string {
  if (n.kind === 'rule') return 'Rule: '
  if (n.kind === 'decision') return 'Decision: '
  if (n.kind === 'todo') return `${n.done ? '[x]' : n.status === 'doing' ? '[~]' : '[ ]'} `
  return ''
}

/** One owner's list as text, for prompts and tool results. Rules and decisions come first, labelled. */
export function render(owner: string): string {
  return renderNotes(list(owner))
}
function renderNotes(list: Note[]): string {
  const notes = list.filter((n) => !n.archived).sort(byStanding)
  if (notes.length === 0) return '(no notes yet)'
  return notes.map((n) => `- [${n.id}] ${kindPrefix(n)}${n.text}${n.priority ? ` (${n.priority} priority)` : ''}${n.due ? ` (due ${n.due})` : ''}${n.source === 'agent' ? ' (added by agent)' : ''}`).join('\n')
}

/** The decisions and rules visible from a context (workspace, its space, the app), rules first, for system prompts. */
function standingAround(c: string | NotesContext, cap = 20): string {
  const items = ownersAround(c).flatMap((o) => list(o.owner).filter((n) => isStandingNote(n) && !n.archived).map((n) => ({ n, where: o.scope })))
  if (items.length === 0) return ''
  items.sort((a, b) => byStanding(a.n, b.n) || b.n.createdAt.localeCompare(a.n.createdAt))
  const shown = items.slice(0, cap).map(({ n, where }) => `- ${kindPrefix(n)}${n.text.length > 200 ? `${n.text.slice(0, 199)}…` : n.text} (${where})`)
  return `${shown.join('\n')}${items.length > cap ? `\n(${items.length - cap} more: list_notes)` : ''}`
}

/**
 * The decisions and rules around a context as a compact, self-explaining block, for engines that get no notes
 * prompt (lean mode, ACP), so rules bind on every engine. Empty when there are none.
 */
export function standingPrompt(c: string | NotesContext): string {
  const standing = standingAround(c)
  return standing ? `\nDecisions and rules that apply here. A Rule is a standing instruction from a person: follow it, and if the task conflicts with it, stop and ask the user. A Decision is settled: build on it and do not reopen it.\n${standing}\n` : ''
}

function renderScopes(c: string | NotesContext, scope: NoteScope | 'all' | undefined): string {
  const around = ownersAround(c)
  if (scope === undefined) return render(ownerFor(undefined, c))
  const picked = scope === 'all' ? around : around.filter((o) => o.scope === scope)
  if (picked.length === 0) return render(ownerFor(scope === 'all' ? undefined : scope, c))
  return picked.map((o) => `## ${o.label}\n${render(o.owner)}`).join('\n\n')
}

/** What every engine's system prompt says about notes. */
export function promptFor(c: string | NotesContext, toolsAvailable: boolean): string {
  const ctx = ctxOf(c)
  const home = ownerFor(undefined, c)
  const open = list(home).filter((n) => n.kind === 'todo' && !n.done).length
  const lines = [
    '',
    ctx.workspaceId
      ? `Session notes: the user keeps notes, reminders and todos in a Notes panel, at three levels: this workspace${open ? ` (${open} open todo${open === 1 ? '' : 's'})` : ''}, its space, and the app for things tied to no project.`
      : `Notes: the user keeps notes, reminders and todos in a Notes view, per workspace, per space, and at the app level for things tied to no project. You are not inside a workspace, so the default scope here is ${ctx.spaceId ? 'the space' : 'the app'}${open ? ` (${open} open todo${open === 1 ? '' : 's'})` : ''}.`,
    'Two kinds of note bind you. A "Rule" is a standing instruction from a person: follow it, and if the task conflicts with a rule, stop and ask the user instead of working around it. A "Decision" records something already decided: build on it and do not reopen it unless the user does. When your work relies on one, say so ("Following your rule …", "As decided: …").'
  ]
  const standing = standingAround(c)
  if (standing) lines.push(`Decisions and rules that apply here:\n${standing}`)
  if (toolsAvailable) {
    lines.push(
      'Read them with list_notes (scope "workspace" by default, "space", "app" or "all") when the user refers to notes, todos or "what is left", and at the start of a substantial task. When the user asks you to remember something, or you find follow-up work that should not be lost (a skipped test, a TODO you left, a question for later), add it with add_note; use scope "app" or "space" for things that are not about this workspace, such as requests gathered from Slack or email. When the user decides something in the conversation (a choice between options, a scope cut, a convention), file it with add_note kind "decision" in one sentence. You cannot create or edit rules; rules come from people, so if something sounds like a standing rule, suggest the user adds it. Mark todos done with update_note when you complete them. Do not remove notes unless asked.'
    )
  } else {
    lines.push('The current notes are included at the top of each message; you cannot edit them, so when something should be recorded, say so plainly and the user will add it.')
  }
  return lines.join('\n')
}

/** Prefix for engines that get no tools: the notes as read-only context. */
export function prefixFor(workspaceId: string): string {
  // Standing notes from the workspace, its space and the app lead; the workspace's other notes follow.
  const rest = list(workspaceId).filter((n) => !isStandingNote(n))
  const standing = standingPrompt(workspaceId).trim()
  if (rest.length === 0 && !standing) return ''
  return `<session_notes>\n${[standing, rest.length ? renderNotes(rest) : ''].filter(Boolean).join('\n\n')}\n</session_notes>\n\n`
}

/** Kinds an agent may file. Rules come from people, so agents never create or edit one. */
const kindSchema = z.enum(['note', 'todo', 'decision']).describe('"todo" for actionable follow-ups, "note" for context worth keeping, "decision" when the user decides something in the conversation (one sentence: what was decided). Rules are set by people only.')
const ADD_HINT = 'Add a note, todo or decision for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping, "decision" to record something the user decided in this conversation. You cannot add rules: rules come from people. Optional priority (low|medium|high) and due date (YYYY-MM-DD).'
const UPDATE_HINT = 'Edit a note; set status (todo|doing|done), priority, due date, kind, or mark done. Rules are the user\'s and cannot be edited by agents.'
/** Agents may not turn a note into a rule or change one; a clear refusal they can relay. */
function guardRule(owner: string, id: string, kind: string | undefined): void {
  if ((kind as Note['kind'] | undefined) === 'rule') throw new Error('Agents cannot create rules; rules come from people. Suggest the rule to the user and let them add it in Notes.')
  if (list(owner).find((n) => n.id === id)?.kind === 'rule') throw new Error('This note is a rule set by a person; agents cannot change it. Tell the user what you would change and why.')
}
const statusSchema = z.string().describe('todo, doing, done, or one of the user\'s own statuses')
const prioritySchema = z.enum(['low', 'medium', 'high'])
const scopeSchema = z.enum(['workspace', 'space', 'app'])
const SCOPE_HINT = 'Where the note lives: "workspace" (default, this project), "space" (the whole space) or "app" (not tied to any project, e.g. requests from Slack or email).'

/** Notes as an in-process MCP server for the Claude Code engine and Claude workers. */
export function sdkServer(workspaceId: string | NotesContext): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  return createSdkMcpServer({
    name: 'notes',
    tools: [
      sdkTool('list_notes', "The user's notes, todos, decisions and rules, with ids (rules and decisions first). Scope: workspace (default), space, app or all.", { scope: z.enum(['workspace', 'space', 'app', 'all']).optional() }, async ({ scope }) => text(renderScopes(workspaceId, scope))),
      sdkTool('add_note', ADD_HINT, { text: z.string(), kind: kindSchema.default('todo'), scope: scopeSchema.optional().describe(SCOPE_HINT), priority: prioritySchema.optional(), due: z.string().optional() }, async ({ text: t, kind, scope, priority, due }) => {
        const owner = ownerFor(scope, workspaceId)
        guardRule(owner, '', kind)
        const added = add(owner, t, kind, 'agent')
        const last = added[added.length - 1]
        if (last && (priority || due)) update(owner, last.id, { priority, due })
        return text(`Added at the ${scope ?? 'workspace'} level. Notes there now:\n${render(owner)}`)
      }),
      sdkTool('update_note', UPDATE_HINT, { id: z.string(), text: z.string().optional(), done: z.boolean().optional(), status: statusSchema.optional(), priority: prioritySchema.optional(), due: z.string().optional(), kind: kindSchema.optional(), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ id, text: t, done, status, priority, due, kind, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        guardRule(owner, id, kind)
        update(owner, id, { text: t, done, status, priority, due, kind })
        return text(`Updated. Notes there now:\n${render(owner)}`)
      }),
      sdkTool('remove_note', 'Delete a note. Only when the user asked for it.', { id: z.string(), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ id, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        guardRule(owner, id, undefined)
        remove(owner, id)
        return text(`Removed. Notes there now:\n${render(owner)}`)
      })
    ]
  })
}

/** Notes as AI SDK tools for the native engine and native workers. */
export function aiTools(workspaceId: string | NotesContext): ToolSet {
  return {
    list_notes: aiTool({ description: "The user's notes, todos, decisions and rules, with ids (rules and decisions first). Scope: workspace (default), space, app or all.", inputSchema: z.object({ scope: z.enum(['workspace', 'space', 'app', 'all']).optional() }), execute: async ({ scope }) => renderScopes(workspaceId, scope) }),
    add_note: aiTool({
      description: ADD_HINT,
      inputSchema: z.object({ text: z.string(), kind: kindSchema.default('todo'), scope: scopeSchema.optional().describe(SCOPE_HINT), priority: prioritySchema.optional(), due: z.string().optional() }),
      execute: async ({ text, kind, scope, priority, due }) => {
        const owner = ownerFor(scope, workspaceId)
        guardRule(owner, '', kind)
        const added = add(owner, text, kind, 'agent')
        const last = added[added.length - 1]
        if (last && (priority || due)) update(owner, last.id, { priority, due })
        return `Added at the ${scope ?? 'workspace'} level. Notes there now:\n${render(owner)}`
      }
    }),
    update_note: aiTool({
      description: UPDATE_HINT,
      inputSchema: z.object({ id: z.string(), text: z.string().optional(), done: z.boolean().optional(), status: statusSchema.optional(), priority: prioritySchema.optional(), due: z.string().optional(), kind: kindSchema.optional(), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ id, text, done, status, priority, due, kind, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        guardRule(owner, id, kind)
        update(owner, id, { text, done, status, priority, due, kind })
        return `Updated. Notes there now:\n${render(owner)}`
      }
    }),
    remove_note: aiTool({
      description: 'Delete a note. Only when the user asked for it.',
      inputSchema: z.object({ id: z.string(), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ id, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        guardRule(owner, id, undefined)
        remove(owner, id)
        return `Removed. Notes there now:\n${render(owner)}`
      }
    })
  }
}

// ---------- the Notes view: filtering and summaries ----------

export function ownerLabel(owner: string): string {
  const { spaces, workspaces } = getStore().get()
  if (owner === APP_OWNER) return 'App'
  if (owner.startsWith('space:')) return `Space · ${spaces.find((s) => s.id === owner.slice(6))?.name ?? 'deleted space'}`
  const ws = workspaces.find((w) => w.id === owner)
  return ws ? `${ws.name}${ws.spaceId ? ` · ${spaces.find((s) => s.id === ws.spaceId)?.name ?? ''}` : ''}` : 'deleted workspace'
}

export function filtered(filter: NotesFilter): { owner: string; label: string; notes: Note[] }[] {
  const since = filter.since ? new Date(filter.since).getTime() : 0
  const q = filter.query?.trim().toLowerCase()
  const ids = filter.ids ? new Set(filter.ids) : null
  const out: { owner: string; label: string; notes: Note[] }[] = []
  for (const { owner, notes } of listAll()) {
    if (filter.owners?.length && !filter.owners.includes(owner)) continue
    const keep = notes.filter((n) => (ids ? ids.has(n.id) : !n.archived) && (!filter.source || n.source === filter.source) && (!filter.kind || (filter.kind === 'standing' ? isStandingNote(n) : n.kind === filter.kind)) && (!filter.openOnly || (n.kind === 'todo' && !n.done)) && (!since || new Date(n.createdAt).getTime() >= since) && (!q || n.text.toLowerCase().includes(q)))
    if (keep.length) out.push({ owner, label: ownerLabel(owner), notes: keep })
  }
  return out
}

/** Ask Claude for a summary of the filtered notes, or an answer to a question about them. */
/** The account Maestro runs on: the default Anthropic account, or a signed-in one when the default is signed out. */
function maestroAccountId(): string {
  const { settings } = getStore().get()
  const list = settings.claudeAccounts.filter((a) => (a.vendor ?? 'anthropic') === 'anthropic')
  const def = settings.defaultClaudeAccountId ?? defaultAccountId('anthropic') ?? 'default'
  if (list.find((a) => a.id === def)?.loggedIn === false) return list.find((a) => a.loggedIn === true)?.id ?? def
  return def
}
type SummaryResult = { text: string } | { error: { code: 'auth' | 'limit' | 'billing' | 'busy' | 'other'; message: string; detail?: string } }
function summaryError(code: string | undefined, raw: string): SummaryResult {
  const kind =
    code === 'authentication_failed' || /not logged in|invalid api key|please run \/login|authentication|unauthori[sz]ed|401/i.test(raw)
      ? 'auth'
      : code === 'rate_limit' || /usage limit|rate[ _]limit|limit reached|429/i.test(raw)
        ? 'limit'
        : code === 'billing_error' || /credit balance|billing/i.test(raw)
          ? 'billing'
          : code === 'overloaded' || /overloaded|529/i.test(raw)
            ? 'busy'
            : 'other'
  const message = { auth: 'Maestro is not signed in to Claude, so it could not read your notes.', limit: 'Maestro has hit its usage limit for now.', billing: 'The Claude account Maestro uses has a billing problem.', busy: 'Claude is busy right now. Try again in a moment.', other: 'The summary could not be written. Try again in a moment.' }[kind]
  return { error: { code: kind, message, ...(raw ? { detail: raw.slice(0, 800) } : {}) } }
}

export async function summarize(filter: NotesFilter, question?: string): Promise<SummaryResult> {
  const groups = filtered(filter)
  if (groups.length === 0) return { text: 'Nothing matches these filters.' }
  const { settings } = getStore().get()
  const accountId = maestroAccountId()
  const body = groups.map((g) => `## ${g.label}\n${[...g.notes].sort(byStanding).map((n) => `- ${kindPrefix(n)}${n.text} (${n.source}, ${n.createdAt.slice(0, 10)})`).join('\n')}`).join('\n\n')
  const prompt = [
    question?.trim()
      ? `Answer the question below about the user's notes and todos. Be concrete, cite the workspace or space a todo belongs to, and keep it short.\n\nQuestion: ${question.trim()}`
      : 'Summarise the user\'s notes and todos below for a quick morning read: what is open, grouped by theme rather than by workspace, the few things that look urgent or blocking first, then the rest in one line each, then anything already done that is worth noticing. Cite the workspace or space in parentheses. Keep it under 250 words, Markdown, no preamble.',
    '',
    body
  ].join('\n')
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), 90_000)
  const options: Options = {
    ...claudeExecutableOption(),
    cwd: process.env.HOME ?? '/',
    model: settings.model,
    maxTurns: 2,
    allowedTools: [],
    canUseTool: async (tool) => ({ behavior: 'deny', message: `${tool} is not needed; answer from the notes.` }),
    abortController: abort,
    settingSources: [],
    env: { ...process.env, ...accountEnv(accountId) },
    stderr: (d) => console.error('[notes summary]', d.trimEnd())
  }
  let out = ''
  let apiError: string | undefined
  try {
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'assistant' && msg.error) apiError = msg.error
      else if (msg.type === 'result') {
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: '', accountId, kind: 'suggest' }))
        } catch {
          /* ledger must never break the summary */
        }
        // is_error with subtype success: the result text is the API error ("Invalid API key · Please run /login"), not a summary.
        if (msg.subtype !== 'success') return summaryError(apiError, `${msg.subtype.replace(/_/g, ' ')}${'errors' in msg && Array.isArray(msg.errors) ? ` (${(msg.errors as string[]).join('; ')})` : ''}`)
        if (msg.is_error || apiError) return summaryError(apiError, msg.result ?? '')
        out = msg.result
      }
    }
  } catch (err) {
    return summaryError(apiError, abort.signal.aborted ? 'The summary took too long and was stopped.' : err instanceof Error ? err.message : String(err))
  } finally {
    clearTimeout(timer)
  }
  return { text: out || '(no summary)' }
}
