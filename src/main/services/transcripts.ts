import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { AgentEvent, ChatItem } from '@shared/types'
import { applyEvent } from '@shared/transcript'

/**
 * Conversation history per workspace, held in main and written to
 * userData/chats/<workspaceId>.json shortly after every event. Main outlives
 * the renderer, so a renderer crash or an app quit never loses a transcript.
 */
const cache = new Map<string, ChatItem[]>()
const timers = new Map<string, NodeJS.Timeout>()
const dirty = new Set<string>()

function dir(): string {
  const d = join(app.getPath('userData'), 'chats')
  if (!existsSync(d)) mkdirSync(d, { recursive: true })
  return d
}

function file(workspaceId: string): string {
  return join(dir(), `${workspaceId}.json`)
}

export function getTranscript(workspaceId: string): ChatItem[] {
  const cached = cache.get(workspaceId)
  if (cached) return cached
  let items: ChatItem[] = []
  const f = file(workspaceId)
  if (existsSync(f)) {
    try {
      items = JSON.parse(readFileSync(f, 'utf8')) as ChatItem[]
    } catch (err) {
      console.error(`Corrupt transcript for ${workspaceId}, starting empty`, err)
    }
  }
  cache.set(workspaceId, items)
  return items
}

export function recordEvent(e: AgentEvent): void {
  const id = 'workspaceId' in e ? e.workspaceId : e.result.workspaceId
  const before = getTranscript(id)
  const after = applyEvent(before, e)
  if (after === before && e.type !== 'result') return
  cache.set(id, after)
  dirty.add(id)
  // A turn's end is worth an immediate write; deltas are batched.
  if (e.type === 'result' || e.type === 'user_message') flush(id)
  else scheduleFlush(id)
}

function scheduleFlush(id: string): void {
  if (timers.has(id)) return
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      flush(id)
    }, 400)
  )
}

function flush(id: string): void {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
  if (!dirty.has(id)) return
  dirty.delete(id)
  try {
    writeFileSync(file(id), JSON.stringify(cache.get(id) ?? []))
  } catch (err) {
    console.error(`Failed to write transcript ${id}`, err)
  }
}

export function flushAllTranscripts(): void {
  for (const id of Array.from(dirty)) flush(id)
}

export function clearTranscript(workspaceId: string): void {
  cache.set(workspaceId, [])
  dirty.delete(workspaceId)
  const t = timers.get(workspaceId)
  if (t) clearTimeout(t)
  timers.delete(workspaceId)
  try {
    if (existsSync(file(workspaceId))) unlinkSync(file(workspaceId))
  } catch (err) {
    console.error(`Failed to delete transcript ${workspaceId}`, err)
  }
}
