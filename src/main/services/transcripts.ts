import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { rename, unlink, writeFile } from 'fs/promises'
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
/** Workspaces with an async write on the way; one at a time per file, so writes never interleave. */
const inFlight = new Set<string>()
/** Bumped by clearTranscript, so a write that finishes after a clear does not bring the file back. */
const generation = new Map<string, number>()
/** How long the last serialisation took, per workspace: big transcripts flush less often. */
const stringifyMs = new Map<string, number>()

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
  // Serialising a multi-MB transcript blocks the main process, so wait about 20x as long as it took last time.
  const delay = Math.min(5000, Math.max(400, (stringifyMs.get(id) ?? 0) * 20))
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id)
      flush(id)
    }, delay)
  )
}

function clearTimer(id: string): void {
  const t = timers.get(id)
  if (t) {
    clearTimeout(t)
    timers.delete(id)
  }
}

/** Write without blocking on the disk: temp file, then rename over, so a crash never leaves half a transcript. */
function flush(id: string): void {
  clearTimer(id)
  if (!dirty.has(id)) return
  // A write is already running; try again when it ends (the transcript is still marked dirty).
  if (inFlight.has(id)) return
  dirty.delete(id)
  const started = performance.now()
  let json: string
  try {
    json = JSON.stringify(cache.get(id) ?? [])
  } catch (err) {
    console.error(`Failed to serialise transcript ${id}`, err)
    return
  }
  stringifyMs.set(id, performance.now() - started)
  const gen = generation.get(id) ?? 0
  const target = file(id)
  const tmp = `${target}.${process.pid}.tmp`
  inFlight.add(id)
  void writeFile(tmp, json)
    .then(async () => {
      if ((generation.get(id) ?? 0) !== gen) return unlink(tmp).catch(() => undefined)
      await rename(tmp, target)
    })
    .catch((err) => console.error(`Failed to write transcript ${id}`, err))
    .finally(() => {
      inFlight.delete(id)
      if (dirty.has(id)) scheduleFlush(id)
    })
}

/** Blocking write, for the moment the app quits and nothing may be left behind. */
function flushSync(id: string): void {
  clearTimer(id)
  dirty.delete(id)
  try {
    const tmp = `${file(id)}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(cache.get(id) ?? []))
    renameSync(tmp, file(id))
  } catch (err) {
    console.error(`Failed to write transcript ${id}`, err)
  }
}

export function flushAllTranscripts(): void {
  // Also redo the ones mid-write: the process may exit before their rename lands.
  for (const id of new Set([...dirty, ...inFlight])) flushSync(id)
}

/** Replace a workspace's transcript wholesale (used when resuming a session recorded elsewhere). */
export function replaceTranscript(workspaceId: string, items: ChatItem[]): void {
  cache.set(workspaceId, items)
  dirty.add(workspaceId)
  flush(workspaceId)
}

/** After a restart, tool calls that never got a result would spin forever; close them out. */
export function markInterrupted(workspaceId: string): boolean {
  const items = getTranscript(workspaceId)
  let changed = false
  const next = items.map((it) => {
    if (it.role !== 'assistant') return it
    const blocks = it.blocks.map((b) => {
      if (b.type === 'tool' && !b.done) {
        changed = true
        return { ...b, done: true, isError: true, result: 'Interrupted: the app restarted before this finished.' }
      }
      return b
    })
    return changed ? { ...it, blocks } : it
  })
  if (changed) replaceTranscript(workspaceId, next)
  return changed
}

export function clearTranscript(workspaceId: string): void {
  cache.set(workspaceId, [])
  dirty.delete(workspaceId)
  generation.set(workspaceId, (generation.get(workspaceId) ?? 0) + 1)
  clearTimer(workspaceId)
  try {
    if (existsSync(file(workspaceId))) unlinkSync(file(workspaceId))
  } catch (err) {
    console.error(`Failed to delete transcript ${workspaceId}`, err)
  }
}
