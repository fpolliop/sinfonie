import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { tool as aiTool, type ToolSet } from 'ai'
import { createSdkMcpServer, query, tool as sdkTool, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Note, NoteScope, NotesFilter, Workspace } from '@shared/types'
import { getStore } from '../store'
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

export function update(owner: string, id: string, patch: Partial<Pick<Note, 'text' | 'done' | 'kind'>>): Note[] {
  const notes = list(owner)
  if (!notes.some((n) => n.id === id)) throw new Error(`No note ${id}`)
  return save(
    owner,
    notes.map((n) => (n.id === id ? { ...n, ...(patch.text !== undefined ? { text: patch.text.trim() } : {}), ...(patch.done !== undefined ? { done: patch.done } : {}), ...(patch.kind ? { kind: patch.kind } : {}), updatedAt: new Date().toISOString() } : n))
  )
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

/** The owner a scope names from inside a workspace: the workspace itself, its space, or the app. */
export function ownerFor(scope: NoteScope | undefined, ws: Workspace): string {
  if (scope === 'app') return APP_OWNER
  if (scope === 'space') return ws.spaceId ? spaceOwner(ws.spaceId) : APP_OWNER
  return ws.id
}

/** The owners an agent inside a workspace can see, nearest first. */
function ownersAround(ws: Workspace): { scope: NoteScope; owner: string; label: string }[] {
  const { spaces } = getStore().get()
  const space = spaces.find((s) => s.id === ws.spaceId)
  return [
    { scope: 'workspace', owner: ws.id, label: `this workspace (${ws.name})` },
    ...(space ? [{ scope: 'space' as const, owner: spaceOwner(space.id), label: `the space (${space.name})` }] : []),
    { scope: 'app', owner: APP_OWNER, label: 'the app (not tied to a project)' }
  ]
}

function findOwner(ws: Workspace, id: string, scope?: NoteScope): string {
  if (scope) return ownerFor(scope, ws)
  for (const o of ownersAround(ws)) if (list(o.owner).some((n) => n.id === id)) return o.owner
  throw new Error(`No note ${id} in this workspace, its space or the app`)
}

/** One owner's list as text, for prompts and tool results. */
export function render(owner: string): string {
  const notes = list(owner)
  if (notes.length === 0) return '(no notes yet)'
  return notes.map((n) => `- [${n.id}] ${n.kind === 'todo' ? (n.done ? '[x]' : '[ ]') + ' ' : ''}${n.text}${n.source === 'agent' ? ' (added by agent)' : ''}`).join('\n')
}

function renderScopes(ws: Workspace, scope: NoteScope | 'all' | undefined): string {
  const around = ownersAround(ws)
  const picked = scope === 'all' || scope === undefined ? around : around.filter((o) => o.scope === scope)
  if (scope === undefined) return render(ws.id)
  return picked.map((o) => `## ${o.label}\n${render(o.owner)}`).join('\n\n')
}

/** What every engine's system prompt says about notes. */
export function promptFor(workspaceId: string, toolsAvailable: boolean): string {
  const open = list(workspaceId).filter((n) => n.kind === 'todo' && !n.done).length
  const lines = [
    '',
    `Session notes: the user keeps notes, reminders and todos in a Notes panel, at three levels: this workspace${open ? ` (${open} open todo${open === 1 ? '' : 's'})` : ''}, its space, and the app for things tied to no project.`
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
const scopeSchema = z.enum(['workspace', 'space', 'app'])
const SCOPE_HINT = 'Where the note lives: "workspace" (default, this project), "space" (the whole space) or "app" (not tied to any project, e.g. requests from Slack or email).'

function wsOf(workspaceId: string): Workspace {
  const ws = getStore().get().workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error(`No workspace ${workspaceId}`)
  return ws
}

/** Notes as an in-process MCP server for the Claude Code engine and Claude workers. */
export function sdkServer(workspaceId: string): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  return createSdkMcpServer({
    name: 'notes',
    tools: [
      sdkTool('list_notes', "The user's notes and todos, with ids. Scope: workspace (default), space, app or all.", { scope: z.enum(['workspace', 'space', 'app', 'all']).optional() }, async ({ scope }) => text(renderScopes(wsOf(workspaceId), scope))),
      sdkTool('add_note', 'Add a note or todo for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping.', { text: z.string(), kind: kindSchema.default('todo'), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ text: t, kind, scope }) => {
        const owner = ownerFor(scope, wsOf(workspaceId))
        add(owner, t, kind, 'agent')
        return text(`Added at the ${scope ?? 'workspace'} level. Notes there now:\n${render(owner)}`)
      }),
      sdkTool('update_note', 'Edit a note or mark a todo done or not done.', { id: z.string(), text: z.string().optional(), done: z.boolean().optional(), kind: kindSchema.optional(), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ id, text: t, done, kind, scope }) => {
        const owner = findOwner(wsOf(workspaceId), id, scope)
        update(owner, id, { text: t, done, kind })
        return text(`Updated. Notes there now:\n${render(owner)}`)
      }),
      sdkTool('remove_note', 'Delete a note. Only when the user asked for it.', { id: z.string(), scope: scopeSchema.optional().describe(SCOPE_HINT) }, async ({ id, scope }) => {
        const owner = findOwner(wsOf(workspaceId), id, scope)
        remove(owner, id)
        return text(`Removed. Notes there now:\n${render(owner)}`)
      })
    ]
  })
}

/** Notes as AI SDK tools for the native engine and native workers. */
export function aiTools(workspaceId: string): ToolSet {
  return {
    list_notes: aiTool({ description: "The user's notes and todos, with ids. Scope: workspace (default), space, app or all.", inputSchema: z.object({ scope: z.enum(['workspace', 'space', 'app', 'all']).optional() }), execute: async ({ scope }) => renderScopes(wsOf(workspaceId), scope) }),
    add_note: aiTool({
      description: 'Add a note or todo for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping.',
      inputSchema: z.object({ text: z.string(), kind: kindSchema.default('todo'), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ text, kind, scope }) => {
        const owner = ownerFor(scope, wsOf(workspaceId))
        add(owner, text, kind, 'agent')
        return `Added at the ${scope ?? 'workspace'} level. Notes there now:\n${render(owner)}`
      }
    }),
    update_note: aiTool({
      description: 'Edit a note or mark a todo done or not done.',
      inputSchema: z.object({ id: z.string(), text: z.string().optional(), done: z.boolean().optional(), kind: kindSchema.optional(), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ id, text, done, kind, scope }) => {
        const owner = findOwner(wsOf(workspaceId), id, scope)
        update(owner, id, { text, done, kind })
        return `Updated. Notes there now:\n${render(owner)}`
      }
    }),
    remove_note: aiTool({
      description: 'Delete a note. Only when the user asked for it.',
      inputSchema: z.object({ id: z.string(), scope: scopeSchema.optional().describe(SCOPE_HINT) }),
      execute: async ({ id, scope }) => {
        const owner = findOwner(wsOf(workspaceId), id, scope)
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
