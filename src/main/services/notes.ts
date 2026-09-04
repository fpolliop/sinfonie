import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { nanoid } from 'nanoid'
import { z } from 'zod'
import { tool as aiTool, type ToolSet } from 'ai'
import { createSdkMcpServer, tool as sdkTool, type Options } from '@anthropic-ai/claude-agent-sdk'
import type { Note } from '@shared/types'

/**
 * Session notes: reminders, todos and scratch notes on a workspace, kept in one JSON file per
 * workspace. The user edits them in the Notes panel; the orchestrator gets the same list as tools.
 */

const cache = new Map<string, Note[]>()
let emitter: (workspaceId: string, notes: Note[]) => void = () => undefined

export function setNotesEmitter(fn: typeof emitter): void {
  emitter = fn
}

function dir(): string {
  const d = join(app.getPath('userData'), 'notes')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}
const file = (id: string): string => join(dir(), `${id}.json`)

export function list(workspaceId: string): Note[] {
  const hit = cache.get(workspaceId)
  if (hit) return hit
  let notes: Note[] = []
  try {
    if (existsSync(file(workspaceId))) notes = JSON.parse(readFileSync(file(workspaceId), 'utf8')) as Note[]
  } catch {
    notes = []
  }
  cache.set(workspaceId, notes)
  return notes
}

function save(workspaceId: string, notes: Note[]): Note[] {
  cache.set(workspaceId, notes)
  writeFileSync(file(workspaceId), JSON.stringify(notes, null, 2))
  emitter(workspaceId, notes)
  return notes
}

export function add(workspaceId: string, text: string, kind: Note['kind'], source: Note['source'] = 'user'): Note[] {
  const now = new Date().toISOString()
  const t = text.trim()
  if (!t) return list(workspaceId)
  const note: Note = { id: nanoid(6), text: t, kind, done: false, source, createdAt: now, updatedAt: now }
  return save(workspaceId, [...list(workspaceId), note])
}

export function update(workspaceId: string, id: string, patch: Partial<Pick<Note, 'text' | 'done' | 'kind'>>): Note[] {
  const notes = list(workspaceId)
  if (!notes.some((n) => n.id === id)) throw new Error(`No note ${id}`)
  return save(
    workspaceId,
    notes.map((n) => (n.id === id ? { ...n, ...(patch.text !== undefined ? { text: patch.text.trim() } : {}), ...(patch.done !== undefined ? { done: patch.done } : {}), ...(patch.kind ? { kind: patch.kind } : {}), updatedAt: new Date().toISOString() } : n))
  )
}

export function remove(workspaceId: string, id: string): Note[] {
  return save(
    workspaceId,
    list(workspaceId).filter((n) => n.id !== id)
  )
}

export function copy(from: string, to: string): void {
  const notes = list(from)
  if (notes.length) save(to, notes.map((n) => ({ ...n })))
}

export function deleteAll(workspaceId: string): void {
  cache.delete(workspaceId)
  try {
    rmSync(file(workspaceId), { force: true })
  } catch {
    /* ignore */
  }
}

/** The list as text, for prompts and tool results. */
export function render(workspaceId: string): string {
  const notes = list(workspaceId)
  if (notes.length === 0) return '(no notes yet)'
  return notes.map((n) => `- [${n.id}] ${n.kind === 'todo' ? (n.done ? '[x]' : '[ ]') + ' ' : ''}${n.text}${n.source === 'agent' ? ' (added by agent)' : ''}`).join('\n')
}

/** What every engine's system prompt says about notes. */
export function promptFor(workspaceId: string, toolsAvailable: boolean): string {
  const open = list(workspaceId).filter((n) => n.kind === 'todo' && !n.done).length
  const lines = [
    '',
    `Session notes: the user keeps notes, reminders and todos for this workspace in a Notes panel${open ? ` (${open} open todo${open === 1 ? '' : 's'})` : ''}.`
  ]
  if (toolsAvailable) {
    lines.push(
      'Read them with list_notes when the user refers to notes, todos or "what is left", and at the start of a substantial task. When the user asks you to remember something, or you find follow-up work that should not be lost (a skipped test, a TODO you left, a question for later), add it with add_note. Mark todos done with update_note when you complete them. Do not remove notes unless asked.'
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

/** Notes as an in-process MCP server for the Claude Code engine. */
export function sdkServer(workspaceId: string): NonNullable<Options['mcpServers']>[string] {
  const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] })
  return createSdkMcpServer({
    name: 'notes',
    tools: [
      sdkTool('list_notes', "The user's session notes and todos for this workspace, with ids.", {}, async () => text(render(workspaceId))),
      sdkTool('add_note', 'Add a note or todo for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping.', { text: z.string(), kind: kindSchema.default('todo') }, async ({ text: t, kind }) => {
        add(workspaceId, t, kind, 'agent')
        return text(`Added. Notes now:\n${render(workspaceId)}`)
      }),
      sdkTool('update_note', 'Edit a note or mark a todo done or not done.', { id: z.string(), text: z.string().optional(), done: z.boolean().optional(), kind: kindSchema.optional() }, async ({ id, text: t, done, kind }) => {
        update(workspaceId, id, { text: t, done, kind })
        return text(`Updated. Notes now:\n${render(workspaceId)}`)
      }),
      sdkTool('remove_note', 'Delete a note. Only when the user asked for it.', { id: z.string() }, async ({ id }) => {
        remove(workspaceId, id)
        return text(`Removed. Notes now:\n${render(workspaceId)}`)
      })
    ]
  })
}

/** Notes as AI SDK tools for the native engine. */
export function aiTools(workspaceId: string): ToolSet {
  return {
    list_notes: aiTool({ description: "The user's session notes and todos for this workspace, with ids.", inputSchema: z.object({}), execute: async () => render(workspaceId) }),
    add_note: aiTool({
      description: 'Add a note or todo for the user. Use kind "todo" for actionable follow-ups, "note" for context worth keeping.',
      inputSchema: z.object({ text: z.string(), kind: kindSchema.default('todo') }),
      execute: async ({ text, kind }) => {
        add(workspaceId, text, kind, 'agent')
        return `Added. Notes now:\n${render(workspaceId)}`
      }
    }),
    update_note: aiTool({
      description: 'Edit a note or mark a todo done or not done.',
      inputSchema: z.object({ id: z.string(), text: z.string().optional(), done: z.boolean().optional(), kind: kindSchema.optional() }),
      execute: async ({ id, text, done, kind }) => {
        update(workspaceId, id, { text, done, kind })
        return `Updated. Notes now:\n${render(workspaceId)}`
      }
    }),
    remove_note: aiTool({
      description: 'Delete a note. Only when the user asked for it.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        remove(workspaceId, id)
        return `Removed. Notes now:\n${render(workspaceId)}`
      }
    })
  }
}
