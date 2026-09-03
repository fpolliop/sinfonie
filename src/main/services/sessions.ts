import { forkSession, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { nanoid } from 'nanoid'
import type { ChatBlock, ChatItem, ChatToolBlock, SessionSummary } from '@shared/types'
import { getStore } from '../store'
import { getWorkspace, patchWorkspace } from './workspaces'
import { accountEnv } from './accounts'
import { closeSession } from './agent'
import { getTranscript, replaceTranscript } from './transcripts'
import { createWorkspace } from './workspaces'
import type { ScriptOutputEvent } from '@shared/types'

/** Run fn with CLAUDE_CONFIG_DIR pointed at the workspace's account, so the SDK reads that account's sessions. */
async function withAccountEnv<T>(accountId: string | undefined, fn: () => Promise<T>): Promise<T> {
  const env = accountEnv(accountId)
  const prev = process.env.CLAUDE_CONFIG_DIR
  if (env.CLAUDE_CONFIG_DIR) process.env.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR
  else delete process.env.CLAUDE_CONFIG_DIR
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = prev
  }
}

export async function listResumable(workspaceId: string, scope: 'workspace' | 'all', query: string): Promise<SessionSummary[]> {
  const ws = getWorkspace(workspaceId)
  const dirs = new Set(ws.repos.map((r) => r.worktreePath))
  return withAccountEnv(ws.claudeAccountId, async () => {
    let raw = scope === 'all' ? await listSessions({ limit: 300 }) : (await Promise.all(ws.repos.map((r) => listSessions({ dir: r.worktreePath, limit: 100 }).catch(() => [])))).flat()
    if (scope === 'all') raw = raw.filter((s) => s.cwd !== '/')
    const q = query.trim().toLowerCase()
    const seen = new Set<string>()
    const out: SessionSummary[] = []
    for (const s of raw) {
      if (seen.has(s.sessionId) || s.sessionId === ws.sessionId) continue
      seen.add(s.sessionId)
      const title = s.customTitle || s.summary || s.firstPrompt || '(untitled)'
      if (q && !`${title} ${s.firstPrompt ?? ''} ${s.cwd ?? ''} ${s.gitBranch ?? ''}`.toLowerCase().includes(q)) continue
      out.push({ sessionId: s.sessionId, title, firstPrompt: s.firstPrompt, cwd: s.cwd, gitBranch: s.gitBranch, lastModified: s.lastModified, fileSize: s.fileSize, inWorkspace: Boolean(s.cwd && dirs.has(s.cwd)) })
    }
    return out.sort((a, b) => b.lastModified - a.lastModified).slice(0, 200)
  })
}

interface ApiMessage {
  role?: string
  content?: string | { type: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: unknown; is_error?: boolean }[]
}

/** Rebuild a transcript from a session file so the chat shows the history before the first resumed turn. */
function toItems(messages: { type: string; uuid: string; message: unknown; parent_tool_use_id: string | null }[]): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ChatToolBlock>()
  for (const m of messages) {
    if (m.parent_tool_use_id) continue
    const msg = (m.message ?? {}) as ApiMessage
    if (m.type === 'user') {
      const content = msg.content
      if (typeof content === 'string') {
        if (content.trim()) items.push({ id: m.uuid, role: 'user', blocks: [{ type: 'text', text: content }], createdAt: '' })
        continue
      }
      const texts: string[] = []
      for (const b of content ?? []) {
        if (b.type === 'text' && b.text && !b.text.startsWith('<')) texts.push(b.text)
        if (b.type === 'tool_result' && b.tool_use_id) {
          const t = tools.get(b.tool_use_id)
          if (t) {
            t.done = true
            t.isError = Boolean(b.is_error)
            t.result = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? (b.content as { type: string; text?: string }[]).map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n') : ''
          }
        }
      }
      if (texts.length) items.push({ id: m.uuid, role: 'user', blocks: [{ type: 'text', text: texts.join('\n') }], createdAt: '' })
    } else if (m.type === 'assistant') {
      const blocks: ChatBlock[] = []
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b.type === 'text' && b.text) blocks.push({ type: 'text', text: b.text })
        else if (b.type === 'thinking' && b.thinking) blocks.push({ type: 'thinking', text: b.thinking })
        else if (b.type === 'tool_use' && b.id) {
          const t: ChatToolBlock = { type: 'tool', toolUseId: b.id, name: b.name ?? 'tool', input: b.input, done: false }
          tools.set(b.id, t)
          blocks.push(t)
        }
      }
      if (blocks.length === 0) continue
      const last = items[items.length - 1]
      // Consecutive assistant frames belong to one turn: merge them into one item.
      if (last && last.role === 'assistant') last.blocks.push(...blocks)
      else items.push({ id: m.uuid, role: 'assistant', blocks, createdAt: '' })
    }
  }
  return items
}

/** Claude Code keeps sessions under <config>/projects/<cwd with every non [A-Za-z0-9-] char turned into '-'>/<id>.jsonl. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9-]/g, '-')
}

/**
 * The CLI only resumes sessions that live in the current project's folder, so a
 * session recorded elsewhere is copied into the primary worktree's folder first.
 */
function makeResumableFrom(ws: ReturnType<typeof getWorkspace>, sessionId: string, cwd: string | undefined): void {
  const configDir = accountEnv(ws.claudeAccountId).CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const projects = join(configDir, 'projects')
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const destDir = join(projects, encodeProjectDir(primary.worktreePath))
  const dest = join(destDir, `${sessionId}.jsonl`)
  if (existsSync(dest)) return
  let src = cwd ? join(projects, encodeProjectDir(cwd), `${sessionId}.jsonl`) : ''
  if (!src || !existsSync(src)) {
    src = ''
    if (existsSync(projects)) {
      for (const d of readdirSync(projects)) {
        const candidate = join(projects, d, `${sessionId}.jsonl`)
        if (existsSync(candidate)) {
          src = candidate
          break
        }
      }
    }
  }
  if (!src) throw new Error(`Session file for ${sessionId.slice(0, 8)} not found under ${projects}`)
  mkdirSync(destDir, { recursive: true })
  copyFileSync(src, dest)
}

export async function resumeInto(workspaceId: string, sessionId: string): Promise<{ messages: number }> {
  const ws = getWorkspace(workspaceId)
  const messages = await withAccountEnv(ws.claudeAccountId, () => getSessionMessages(sessionId))
  const cwd = (messages.find((m) => typeof (m as { cwd?: unknown }).cwd === 'string') as { cwd?: string } | undefined)?.cwd
  makeResumableFrom(ws, sessionId, cwd)
  const items = toItems(messages as Parameters<typeof toItems>[0]).map((it) => ({ ...it, id: it.id || nanoid(8) }))
  closeSession(workspaceId)
  patchWorkspace(workspaceId, { sessionId, lastMessageAt: new Date().toISOString() })
  replaceTranscript(workspaceId, [
    ...items,
    { id: nanoid(8), role: 'system', level: 'info', blocks: [{ type: 'text', text: `Resumed session ${sessionId.slice(0, 8)} (${items.length} messages). Your next message continues it here.` }], createdAt: new Date().toISOString() }
  ])
  void getStore
  return { messages: items.length }
}

/**
 * Fork like the CLI's /fork, but across a whole workspace: a new workspace whose
 * branches start where this one's are now, plus a forked copy of the Claude
 * session so the new chat continues with the same context.
 */
export async function forkWorkspace(workspaceId: string, name: string, emit: (e: ScriptOutputEvent) => void): Promise<ReturnType<typeof getWorkspace>> {
  const src = getWorkspace(workspaceId)
  if (src.status !== 'ready') throw new Error('Only a ready workspace can be forked')
  const created = await createWorkspace(
    {
      name,
      // Cut each new branch from the source workspace's current branch, so the code state carries over.
      repos: src.repos.map((r) => ({ repoId: r.repoId, baseBranch: r.branch })),
      primaryRepoId: src.primaryRepoId,
      spaceId: src.spaceId,
      claudeAccountId: src.claudeAccountId,
      jira: src.jira
    },
    emit
  )
  if (created.status !== 'ready') return created
  patchWorkspace(created.id, { stage: src.stage, labelIds: src.labelIds, permissionMode: src.permissionMode })

  const items = getTranscript(workspaceId).map((it) => ({ ...it, id: nanoid(8) }))
  let note = `Forked from "${src.name}". Branches start from ${src.repos.map((r) => `${r.repoName}@${r.branch}`).join(', ')}.`
  if (src.sessionId) {
    try {
      const { sessionId } = await withAccountEnv(src.claudeAccountId, () => forkSession(src.sessionId!, { title: name }))
      const messages = await withAccountEnv(src.claudeAccountId, () => getSessionMessages(sessionId))
      const cwd = (messages.find((m) => typeof (m as { cwd?: unknown }).cwd === 'string') as { cwd?: string } | undefined)?.cwd
      makeResumableFrom(created, sessionId, cwd)
      patchWorkspace(created.id, { sessionId })
      note += ' The conversation continues here with its full context.'
    } catch (err) {
      note += ` The Claude session could not be forked (${err instanceof Error ? err.message : String(err)}); the transcript is copied for reference and the next message starts fresh.`
    }
  }
  replaceTranscript(created.id, [...items, { id: nanoid(8), role: 'system', level: 'info', blocks: [{ type: 'text', text: note }], createdAt: new Date().toISOString() }])
  return getWorkspace(created.id)
}
