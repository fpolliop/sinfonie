import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { tool as aiTool, type ToolSet } from 'ai'
import { createSdkMcpServer, query, tool as sdkTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Note, NotePatch, NoteScope, NotesContext, NotesFilter } from '@shared/types'
import { isAgentOwner } from '@shared/types'
import { getStore } from '../store'
import * as agentLib from './agents'
import { claudeExecutableOption } from './claude-cli'
import { accountEnv, defaultAccountId } from './accounts'
import * as usage from './usage'

/**
 * Notes, reminders and todos, one JSON file per owner. An owner is a workspace id, a space
 * ("space:<id>") or the app itself ("app", for things tied to no project). The user edits them
 * in the workspace Notes panel and the Notes view; agents get the same lists as tools.
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
      if (patch.kind) next.kind = patch.kind
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

/** One owner's list as text, for prompts and tool results. */
export function render(owner: string): string {
  const notes = list(owner)
  if (notes.length === 0) return '(no notes yet)'
  return notes.map((n) => `- [${n.id}] ${n.kind === 'todo' ? (n.done ? '[x]' : n.status === 'doing' ? '[~]' : '[ ]') + ' ' : ''}${n.text}${n.priority ? ` (${n.priority} priority)` : ''}${n.due ? ` (due ${n.due})` : ''}${n.source === 'agent' ? ' (added by agent)' : ''}`).join('\n')
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
      : `Notes: the user keeps notes, reminders and todos in a Notes view, per workspace, per space, and at the app level for things tied to no project. You are not inside a workspace, so the default scope here is ${ctx.spaceId ? 'the space' : 'the app'}${open ? ` (${open} open todo${open === 1 ? '' : 's'})` : ''}.`
  ]
  if (toolsAvailable) {
    lines.push(
      'Read them with list_notes (scope "workspace" by default, "space", "app" or "all") when the user refers to notes, todos or "what is left", and at the start of a substantial task. When the user asks you to remember something, or you find follow-up work that should not be lost (a skipped test, a TODO you left, a question for later), add it with add_note; use scope "app" or "space" for things that are not about this workspace, such as requests gathered from Slack or email. Mark todos done with update_note when you complete them. Do not remove notes unless asked.'
    )
  } else {
    lines.push('The current notes are included at the top of each message; you cannot edit them, so when something should be recorded, say so plainly and the user will add it.')
  }
  return lines.join('\n')
}

/** Prefix for engines that get no tools: the notes as read-only context. */
export function prefixFor(workspaceId: string): string {
  const notes = list(workspaceId)
  if (notes.length === 0) return ''
  return `<session_notes>\n${render(workspaceId)}\n</session_notes>\n\n`
}

const kindSchema = z.enum(['note', 'todo'])
const statusSchema = z.enum(['todo', 'doing', 'done'])
const prioritySchema = z.enum(['low', 'medium', 'high'])
const scopeSchema = z.enum(['workspace', 'space', 'app'])
const SCOPE_HINT = 'Where the note lives: "workspace" (default, this project), "space" (the whole space) or "app" (not tied to any project, e.g. requests from Slack or email).'

/** Notes as an in-process MCP server for the Claude Code engine and Claude workers. */
export function sdkServer(workspaceId: string | NotesContext): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  return createSdkMcpServer({
    name: 'notes',
    tools: [
      sdkTool('list_notes', "The user's notes and todos, with ids. Scope: workspace (default), space, app or all.", { scope: z.enum(['workspace', 'space', 'app', 'all']).optional() }, async ({ scope }) => text(renderScopes(workspaceId, scope))),
      sdkTool('add_note', 'Add a note or todo for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping. Optional priority (low|medium|high) and due date (YYYY-MM-DD).', { text: z.string(), kind: kindSchema.default('todo'), scope: scopeSchema.optional().describe(SCOPE_HINT), priority: prioritySchema.optional(), due: z.string().optional() }, async ({ text: t, kind, scope, priority, due }) => {
        const owner = ownerFor(scope, workspaceId)
        const added = add(owner, t, kind, 'agent')
        const last = added[added.length - 1]
        if (last && (priority || due)) update(owner, last.id, { priority, due })
        return text(`Added at the ${scope ?? 'workspace'} level. Notes there now:\n${render(owner)}`)
      }),
      sdkTool('update_note', 'Edit a note; set status (todo|doing|done), priority, due date, or mark done.', { id: z.string(), text: z.string().optional(), done: z.boolean().optional(), status: statusSchema.optional(), priority: prioritySchema.optional(), due: z.string().optional(), kind: kindSchema.optional(), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ id, text: t, done, status, priority, due, kind, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        update(owner, id, { text: t, done, status, priority, due, kind })
        return text(`Updated. Notes there now:\n${render(owner)}`)
      }),
      sdkTool('remove_note', 'Delete a note. Only when the user asked for it.', { id: z.string(), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ id, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        remove(owner, id)
        return text(`Removed. Notes there now:\n${render(owner)}`)
      })
    ]
  })
}

/** Notes as AI SDK tools for the native engine and native workers. */
export function aiTools(workspaceId: string | NotesContext): ToolSet {
  return {
    list_notes: aiTool({ description: "The user's notes and todos, with ids. Scope: workspace (default), space, app or all.", inputSchema: z.object({ scope: z.enum(['workspace', 'space', 'app', 'all']).optional() }), execute: async ({ scope }) => renderScopes(workspaceId, scope) }),
    add_note: aiTool({
      description: 'Add a note or todo for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping. Optional priority (low|medium|high) and due date (YYYY-MM-DD).',
      inputSchema: z.object({ text: z.string(), kind: kindSchema.default('todo'), scope: scopeSchema.optional().describe(SCOPE_HINT), priority: prioritySchema.optional(), due: z.string().optional() }),
      execute: async ({ text, kind, scope, priority, due }) => {
        const owner = ownerFor(scope, workspaceId)
        const added = add(owner, text, kind, 'agent')
        const last = added[added.length - 1]
        if (last && (priority || due)) update(owner, last.id, { priority, due })
        return `Added at the ${scope ?? 'workspace'} level. Notes there now:\n${render(owner)}`
      }
    }),
    update_note: aiTool({
      description: 'Edit a note; set status (todo|doing|done), priority, due date, or mark done.',
      inputSchema: z.object({ id: z.string(), text: z.string().optional(), done: z.boolean().optional(), status: statusSchema.optional(), priority: prioritySchema.optional(), due: z.string().optional(), kind: kindSchema.optional(), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ id, text, done, status, priority, due, kind, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
        update(owner, id, { text, done, status, priority, due, kind })
        return `Updated. Notes there now:\n${render(owner)}`
      }
    }),
    remove_note: aiTool({
      description: 'Delete a note. Only when the user asked for it.',
      inputSchema: z.object({ id: z.string(), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ id, scope }) => {
        const owner = findOwner(workspaceId, id, scope)
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
  const out: { owner: string; label: string; notes: Note[] }[] = []
  for (const { owner, notes } of listAll()) {
    if (filter.owners?.length && !filter.owners.includes(owner)) continue
    const keep = notes.filter((n) => (!filter.source || n.source === filter.source) && (!filter.kind || n.kind === filter.kind) && (!filter.openOnly || (n.kind === 'todo' && !n.done)) && (!since || new Date(n.createdAt).getTime() >= since) && (!q || n.text.toLowerCase().includes(q)))
    if (keep.length) out.push({ owner, label: ownerLabel(owner), notes: keep })
  }
  return out
}

/** Ask Claude for a summary of the filtered notes, or an answer to a question about them. */
export async function summarize(filter: NotesFilter, question?: string): Promise<string> {
  const groups = filtered(filter)
  if (groups.length === 0) return 'Nothing matches these filters.'
  const { settings } = getStore().get()
  const body = groups.map((g) => `## ${g.label}\n${g.notes.map((n) => `- ${n.kind === 'todo' ? (n.done ? '[x]' : '[ ]') + ' ' : ''}${n.text} (${n.source}, ${n.createdAt.slice(0, 10)})`).join('\n')}`).join('\n\n')
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
    env: { ...process.env, ...accountEnv(undefined) },
    stderr: (d) => console.error('[notes summary]', d.trimEnd())
  }
  let out = ''
  try {
    for await (const msg of query({ prompt, options }) as AsyncIterable<SDKMessage>) {
      if (msg.type === 'result') {
        try {
          usage.recordTurn(usage.fromResult(msg, { workspaceId: '', spaceId: '', accountId: defaultAccountId('anthropic') ?? 'default', kind: 'suggest' }))
        } catch {
          /* ledger must never break the summary */
        }
        if (msg.subtype === 'success') out = msg.result
        else throw new Error(`Summary ended with ${msg.subtype}`)
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return out || '(no summary)'
}
