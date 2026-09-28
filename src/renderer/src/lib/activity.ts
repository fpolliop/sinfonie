/**
 * What the assistant is doing, in words. The chat's working line reads the current turn's tool calls through
 * here: expert mode gets the tool name, guided mode gets a plain verb that never shows a path or a command.
 */
import type { ChatItem, ChatToolBlock } from '@shared/types'

const basename = (p: string): string => p.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? ''

/** A file name a person can read: the last path segment, only when it looks like a file name. */
function fileName(input: Record<string, unknown>): string | null {
  const raw = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.path === 'string' ? input.path : null
  if (!raw) return null
  const name = basename(raw)
  return /^[\w.@+-]{1,60}\.[\w]{1,8}$/.test(name) ? name : null
}

const isBrowser = (name: string): boolean => /browser|playwright|puppeteer|chrome/i.test(name)

/** One tool call as a guided step: "Looked at Button.tsx", "Changed checkout.ts", "Ran a check". */
export function guidedStep(block: Pick<ChatToolBlock, 'name' | 'input'>): string {
  const name = block.name
  const input = (block.input ?? {}) as Record<string, unknown>
  if (name === 'Read') {
    const f = fileName(input)
    return f ? `Looked at ${f}` : 'Looked at the code'
  }
  if (name === 'Grep' || name === 'Glob' || name === 'LS' || name === 'List') return 'Looked at the code'
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') {
    const f = fileName(input)
    return f ? `Changed ${f}` : 'Made changes'
  }
  if (name === 'Bash' || name === 'BashOutput') return 'Ran a check'
  if (isBrowser(name)) return 'Checked the preview'
  if (name === 'WebFetch' || name === 'WebSearch') return 'Looked something up'
  if (name === 'Task' || name === 'Agent') return 'Asked a helper'
  if (name === 'TodoWrite') return 'Planned the next steps'
  if (name === 'AskUserQuestion') return 'Asked you a question'
  return 'Working'
}

/** The tool name as an expert reads it: MCP prefixes dropped. */
export function expertToolName(block: Pick<ChatToolBlock, 'name' | 'input'>): string {
  const n = block.name.replace(/^mcp__/, '').replace(/__/g, ' · ')
  if (block.name === 'Task' || block.name === 'Agent') {
    const i = (block.input ?? {}) as Record<string, unknown>
    return typeof i.subagent_type === 'string' ? `${n} · ${i.subagent_type}` : n
  }
  return n
}

export interface TurnActivity {
  /** When the person sent the message this turn answers; null before any message. */
  startedAt: number | null
  /** Tool calls of the current turn, oldest first. */
  tools: ChatToolBlock[]
}

/** The current (or last) turn: everything after the latest user message. */
export function turnActivity(items: ChatItem[]): TurnActivity {
  let i = items.length - 1
  while (i >= 0 && items[i].role !== 'user') i--
  const startedAt = i >= 0 ? Date.parse(items[i].createdAt) : null
  const tools: ChatToolBlock[] = []
  for (const it of items.slice(i + 1)) if (it.role === 'assistant') for (const b of it.blocks) if (b.type === 'tool') tools.push(b)
  return { startedAt: startedAt !== null && Number.isFinite(startedAt) ? startedAt : null, tools }
}

/** The last `n` guided steps, with repeats in a row folded into one. */
export function recentGuidedSteps(tools: ChatToolBlock[], n = 3): { key: string; text: string; done: boolean }[] {
  const out: { key: string; text: string; done: boolean }[] = []
  for (const t of tools) {
    const text = guidedStep(t)
    const last = out[out.length - 1]
    if (last && last.text === text) {
      last.done = t.done
      last.key = t.toolUseId
    } else out.push({ key: t.toolUseId, text, done: t.done })
  }
  return out.slice(-n)
}

/** "12 s", "1 min 40 s", "1 h 3 min". */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m} min ${s % 60} s` : `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** "2 min", "40 s": the rounded form for a finished turn. */
export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  return m < 60 ? `${m} min` : formatElapsed(ms)
}

/**
 * A system notice in guided words, or null to leave it out. Notices are written for developers; the ones a guided
 * person can act on are rewritten, purely technical ones (compaction, cost modes, resumed sessions) are hidden,
 * and errors go through friendlyError by the caller.
 */
export function guidedNotice(text: string, level: 'info' | 'warn' | 'error'): string | null {
  if (level === 'error') return null
  if (/^You stopped the response/.test(text)) return 'You stopped the assistant.'
  if (/tool calls this turn/.test(text)) return 'The assistant paused here to keep things quick. Say “continue” to go on.'
  if (/declined this request/.test(text)) return 'The assistant declined this request.'
  if (/still starting/.test(text)) return 'The assistant is still starting. Send your message again in a moment.'
  return null
}
