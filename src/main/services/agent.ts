import { query, type Options, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk'
import { nanoid } from 'nanoid'
import type { AgentEvent, PermissionMode, PermissionRequest, PermissionResponse, Workspace } from '@shared/types'
import { getStore } from '../store'
import { getWorkspace, patchWorkspace } from './workspaces'
import { accountEnv } from './accounts'

type EmitEvent = (e: AgentEvent) => void
type EmitPermission = (r: PermissionRequest) => void

interface Session {
  workspaceId: string
  q: Query
  push: (m: SDKUserMessage) => void
  end: () => void
  abort: AbortController
  busy: boolean
}

const sessions = new Map<string, Session>()
const pendingPermissions = new Map<string, (r: PermissionResponse) => void>()

/** An async iterable we can push into from outside; the SDK consumes it as the prompt stream. */
function makeInputStream(): { iterable: AsyncIterable<SDKUserMessage>; push: (m: SDKUserMessage) => void; end: () => void } {
  const queue: SDKUserMessage[] = []
  let waiting: ((v: IteratorResult<SDKUserMessage>) => void) | null = null
  let ended = false
  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift()!, done: false })
          if (ended) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => (waiting = resolve))
        }
      }
    }
  }
  return {
    iterable,
    push: (m) => {
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: m, done: false })
      } else queue.push(m)
    },
    end: () => {
      ended = true
      if (waiting) {
        const w = waiting
        waiting = null
        w({ value: undefined, done: true })
      }
    }
  }
}

function systemPromptFor(ws: Workspace): string {
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const lines = [
    `You are working inside an Orchestra workspace named "${ws.name}" that spans ${ws.repos.length} git repositories.`,
    `Each repository has its own worktree on the branch "${primary.branch}". The worktrees are:`,
    ...ws.repos.map((r) => `- ${r.repoName}: ${r.worktreePath} (branch ${r.branch}, based on ${r.baseBranch})`),
    `Your working directory is the ${primary.repoName} worktree. The other worktrees are added as additional directories; you can read and edit files in all of them.`,
    `A feature may need changes in several of these repositories. Keep the changes for each repository inside its own worktree, and run git commands from inside the worktree they apply to.`,
    `Never modify the original repositories outside these worktree paths.`
  ]
  return lines.join('\n')
}

function getOrCreateSession(workspaceId: string, emit: EmitEvent, emitPermission: EmitPermission): Session {
  const existing = sessions.get(workspaceId)
  if (existing) return existing

  const ws = getWorkspace(workspaceId)
  const { settings } = getStore().get()
  const primary = ws.repos.find((r) => r.repoId === ws.primaryRepoId) ?? ws.repos[0]
  const others = ws.repos.filter((r) => r !== primary).map((r) => r.worktreePath)
  const abort = new AbortController()
  const input = makeInputStream()

  const canUseTool: NonNullable<Options['canUseTool']> = async (toolName, toolInput, opts) => {
    const requestId = nanoid(8)
    const decision = await new Promise<PermissionResponse>((resolve) => {
      pendingPermissions.set(requestId, resolve)
      emitPermission({
        requestId,
        workspaceId,
        toolName,
        input: toolInput,
        blockedPath: opts.blockedPath,
        canAlwaysAllow: Boolean(opts.suggestions && opts.suggestions.length > 0)
      })
      opts.signal.addEventListener('abort', () => {
        pendingPermissions.delete(requestId)
        resolve({ requestId, decision: 'deny', message: 'Cancelled' })
      })
    })
    pendingPermissions.delete(requestId)
    if (decision.decision === 'deny') {
      const r: PermissionResult = { behavior: 'deny', message: decision.message || 'User denied this tool call' }
      return r
    }
    const r: PermissionResult = {
      behavior: 'allow',
      updatedInput: toolInput,
      ...(decision.decision === 'always' && opts.suggestions ? { updatedPermissions: opts.suggestions } : {})
    }
    return r
  }

  const mode = ws.permissionMode ?? settings.permissionMode
  const options: Options = {
    cwd: primary.worktreePath,
    additionalDirectories: others,
    permissionMode: mode,
    ...(mode === 'bypassPermissions' ? { allowDangerouslySkipPermissions: true } : {}),
    model: settings.model,
    includePartialMessages: true,
    abortController: abort,
    canUseTool,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPromptFor(ws) },
    settingSources: ['user', 'project', 'local'],
    env: {
      ...process.env,
      ...accountEnv(ws.claudeAccountId),
      ORCHESTRA_WORKSPACE_NAME: ws.slug,
      ORCHESTRA_WORKSPACE_ROOT: ws.rootPath,
      ORCHESTRA_PORT: String(ws.port)
    },
    stderr: (d) => console.error(`[agent ${ws.slug}]`, d.trimEnd()),
    ...(ws.sessionId ? { resume: ws.sessionId } : {})
  }

  const q = query({ prompt: input.iterable, options })
  const session: Session = { workspaceId, q, push: input.push, end: input.end, abort, busy: false }
  sessions.set(workspaceId, session)
  void pump(session, emit)
  return session
}

/** Translate the SDK's message stream into the small event set the UI renders. */
async function pump(session: Session, emit: EmitEvent): Promise<void> {
  const { workspaceId } = session
  let itemId = ''
  // Map content-block index -> tool_use id for the in-flight assistant message.
  const toolIds = new Map<number, string>()
  const toolJson = new Map<number, string>()
  try {
    for await (const msg of session.q as AsyncIterable<SDKMessage>) {
      switch (msg.type) {
        case 'system':
          if (msg.subtype === 'init') {
            getStore().update((d) => {
              const w = d.workspaces.find((x) => x.id === workspaceId)
              if (w) w.sessionId = msg.session_id
            })
            emit({ type: 'init', workspaceId, sessionId: msg.session_id, model: msg.model, cwd: msg.cwd })
          }
          break
        case 'stream_event': {
          if (msg.parent_tool_use_id) break // subagent chatter stays hidden
          const ev = msg.event
          if (ev.type === 'message_start') {
            itemId = nanoid(8)
            toolIds.clear()
            toolJson.clear()
            session.busy = true
            emit({ type: 'assistant_start', workspaceId, itemId })
          } else if (ev.type === 'content_block_start') {
            const block = ev.content_block
            if (block.type === 'tool_use') {
              toolIds.set(ev.index, block.id)
              toolJson.set(ev.index, '')
              emit({ type: 'tool_start', workspaceId, itemId, toolUseId: block.id, name: block.name })
            }
          } else if (ev.type === 'content_block_delta') {
            const delta = ev.delta
            if (delta.type === 'text_delta') emit({ type: 'text_delta', workspaceId, itemId, text: delta.text })
            else if (delta.type === 'thinking_delta') emit({ type: 'thinking_delta', workspaceId, itemId, text: delta.thinking })
            else if (delta.type === 'input_json_delta') toolJson.set(ev.index, (toolJson.get(ev.index) ?? '') + delta.partial_json)
          } else if (ev.type === 'content_block_stop') {
            const toolUseId = toolIds.get(ev.index)
            if (toolUseId) {
              let input: unknown = {}
              try {
                input = JSON.parse(toolJson.get(ev.index) || '{}')
              } catch {
                input = { raw: toolJson.get(ev.index) }
              }
              emit({ type: 'tool_input', workspaceId, itemId, toolUseId, input })
            }
          } else if (ev.type === 'message_stop') {
            emit({ type: 'assistant_end', workspaceId, itemId })
          }
          break
        }
        case 'user': {
          if (msg.parent_tool_use_id) break
          const content = msg.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_result') {
                const text =
                  typeof block.content === 'string'
                    ? block.content
                    : (block.content ?? [])
                        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
                        .join('\n')
                emit({ type: 'tool_result', workspaceId, toolUseId: block.tool_use_id, result: text, isError: Boolean(block.is_error) })
              }
            }
          }
          break
        }
        case 'result': {
          session.busy = false
          const isError = msg.subtype !== 'success'
          const errs = 'errors' in msg && Array.isArray(msg.errors) ? (msg.errors as string[]).join('\n') : ''
          const errorText = isError ? errs || (msg as { subtype: string }).subtype : undefined
          emit({
            type: 'result',
            result: {
              workspaceId,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              numTurns: msg.num_turns,
              isError,
              errorText
            }
          })
          emit({ type: 'status', workspaceId, busy: false })
          getStore().update((d) => {
            const w = d.workspaces.find((x) => x.id === workspaceId)
            if (w) w.lastMessageAt = new Date().toISOString()
          })
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!session.abort.signal.aborted) emit({ type: 'error', workspaceId, message })
  } finally {
    sessions.delete(workspaceId)
    emit({ type: 'status', workspaceId, busy: false })
  }
}

export function sendMessage(workspaceId: string, text: string, emit: EmitEvent, emitPermission: EmitPermission): void {
  const session = getOrCreateSession(workspaceId, emit, emitPermission)
  session.busy = true
  emit({ type: 'user_message', workspaceId, itemId: nanoid(8), text, createdAt: new Date().toISOString() })
  emit({ type: 'status', workspaceId, busy: true })
  session.push({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null
  })
}

/** Switch the mode for future sessions and, when one is live, for the running session too. */
export async function setMode(workspaceId: string, mode: PermissionMode): Promise<Workspace> {
  const ws = patchWorkspace(workspaceId, { permissionMode: mode })
  const s = sessions.get(workspaceId)
  if (s) {
    if (mode === 'bypassPermissions') {
      // The SDK only honours bypass when the session was started with the dangerous flag,
      // so restart the session; the stored session id makes the next message resume it.
      closeSession(workspaceId)
    } else {
      await s.q.setPermissionMode(mode)
    }
  }
  return ws
}

export function isBusy(workspaceId: string): boolean {
  return sessions.get(workspaceId)?.busy ?? false
}

export async function interrupt(workspaceId: string): Promise<void> {
  const s = sessions.get(workspaceId)
  if (!s) return
  try {
    await s.q.interrupt()
  } catch (err) {
    console.warn('interrupt failed', err)
  }
}

export function answerPermission(response: PermissionResponse): void {
  pendingPermissions.get(response.requestId)?.(response)
}

/** Drop the live session and forget the stored session id, so the next message starts fresh. */
export function resetSession(workspaceId: string): void {
  closeSession(workspaceId)
  getStore().update((d) => {
    const w = d.workspaces.find((x) => x.id === workspaceId)
    if (w) delete w.sessionId
  })
}

export function closeSession(workspaceId: string): void {
  const s = sessions.get(workspaceId)
  if (!s) return
  s.end()
  s.abort.abort()
  sessions.delete(workspaceId)
}

export function closeAllSessions(): void {
  for (const id of Array.from(sessions.keys())) closeSession(id)
}
