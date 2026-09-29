import React, { useEffect, useId, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, ChevronDown, ChevronsUpDown, Square, RotateCcw, Send, ShieldCheck, XCircle, AlertTriangle, Info, History, Users, GitFork, ListTree, ArrowLeft, StickyNote, Paperclip, X, Plus, Coffee, Check } from 'lucide-react'
import { imageFiles } from '@/lib/images'
import type { AgentMode, ContextUsage, ChatTurnResult, AgentEvent, ChatImageRef, LimitAlternative, CostMode, CostModeScope } from '@shared/types'
import { CliView, closeCliView } from './TerminalPane'
import { NotesPanel } from './NotesPanel'
import { ContextMenu } from './ContextMenu'
import { useNotes } from '@/stores/notes'
import { api } from '@/lib/api'
import { PERMISSION_MODES, type PermissionMode } from '@shared/types'
import { QuestionCard } from './QuestionCard'
import { ResumeDialog } from './ResumeDialog'
import { Dialog, Field, IconButton, hasOpenDialog, inputCls } from './ui'
import { useChat } from '@/stores/chat'
import { useApp } from '@/stores/app'
import { useResources, subscribeResources } from '@/stores/resources'
import { Markdown } from '@/lib/markdown'
import { Button, Spinner } from './ui'
import { useGuided, words } from '@/lib/guided'
import { friendlyError, rawMessage } from '@/lib/errors'
import { yieldsToEditor } from '@/lib/keys'
import { expertToolName, formatDuration, formatElapsed, guidedNotice, recentGuidedSteps, turnActivity } from '@/lib/activity'
import { AskTeammate, AskTeammateButton } from './AskTeammate'
import { CaffeineButton } from './CaffeineButton'
import type { ChatBlock, ChatItem, ChatToolBlock } from '@shared/types'

/** Right panel state: closed, the activity overview, or one delegation's detail. */
type PanelView = { kind: 'closed' } | { kind: 'activity' } | { kind: 'delegation'; id: string } | { kind: 'notes' }
const usePanel = (() => {
  let listeners: (() => void)[] = []
  let current: PanelView = { kind: 'closed' }
  const set = (v: PanelView): void => {
    current = v
    listeners.forEach((l) => l())
  }
  return (): [PanelView, (v: PanelView) => void] => {
    const [, force] = useState(0)
    useEffect(() => {
      const l = (): void => force((n) => n + 1)
      listeners.push(l)
      return () => {
        listeners = listeners.filter((x) => x !== l)
      }
    }, [])
    return [current, set]
  }
})()

/**
 * The conversation (left of the workspace split): the chat through the SDK, or the vendor's CLI in a terminal on the same
 * session. The switch at the top moves between the two without losing the conversation.
 */
export function ChatPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const spaceMode = useApp((s) => s.spaces.find((sp) => sp.id === ws?.spaceId)?.agentMode)
  const setError = useApp((s) => s.setError)
  const draft = useChat((s) => s.chats[workspaceId]?.draft ?? '')
  const setDraft = useChat((s) => s.setDraft)
  const load = useChat((s) => s.load)
  const guided = useGuided()
  // Guided mode has no terminal UI: the chat is the only face of Maestro.
  const mode: AgentMode = guided ? 'chat' : ws?.agentMode ?? spaceMode ?? 'chat'
  const claude = (ws?.engine ?? useApp.getState().spaces.find((sp) => sp.id === ws?.spaceId)?.engine ?? useApp.getState().settings.engine ?? 'claude-code') === 'claude-code'
  const switchTo = (next: AgentMode): void => {
    if (next === mode) return
    // Mode first, so the CLI view unmounts before its shell is dropped (otherwise it would respawn one).
    api
      .invoke('workspaces:setAgentMode', workspaceId, next)
      .then(() => {
        if (next === 'chat') {
          closeCliView(workspaceId)
          void load(workspaceId)
        }
      })
      .catch((err) => setError(friendlyError(err)))
  }
  return (
    <div className="flex h-full flex-col">
      {claude && !guided && (
        <div className="flex h-[30px] shrink-0 items-center gap-2 border-b border-border px-3">
          <span className="text-[11px] text-muted">{mode === 'cli' ? 'The real Claude Code, on this conversation. Permissions, cost and your devices keep working.' : 'Agent'}</span>
          <div className="ml-auto flex rounded-md border border-border p-0.5 text-[11px]">
            {(['chat', 'cli'] as AgentMode[]).map((m) => (
              <button key={m} className={clsx('rounded px-2 py-0.5', mode === m ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')} onClick={() => switchTo(m)} title={m === 'chat' ? 'Sinfonie chat through the Agent SDK' : "Claude Code's own terminal UI, same session"}>
              {m === 'chat' ? 'Chat' : 'CLI'}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1">
        {mode === 'cli' && claude ? <CliView workspaceId={workspaceId} prompt={draft} onPromptConsumed={() => setDraft(workspaceId, '')} onBackToChat={() => switchTo('chat')} /> : <ChatPaneInner workspaceId={workspaceId} />}
      </div>
    </div>
  )
}

function ChatPaneInner({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const guided = useGuided()
  const chat = useChat((s) => s.chats[workspaceId])
  const allQuestions = useChat((s) => s.questions)
  const allPermissions = useChat((s) => s.permissions)
  // Filter outside the selector: a selector that returns a fresh array re-renders forever.
  const questions = useMemo(() => allQuestions.filter((q) => q.workspaceId === workspaceId), [allQuestions, workspaceId])
  const waitingForOk = useMemo(() => allPermissions.some((p) => p.workspaceId === workspaceId), [allPermissions, workspaceId])
  const { send, interrupt, reset, setDraft, load, unqueue, addImages, removeImage, restorableSession, restore } = useChat()
  const notify = useApp((s) => s.notify)

  useEffect(() => {
    void load(workspaceId)
  }, [workspaceId, load])
  // Guided mode: a small "what changed" nudge after a turn touches files, with a look at the preview.
  const setTab = useApp((s) => s.setTab)
  const [changed, setChanged] = useState<string[] | null>(null)
  useEffect(() => {
    if (!guided) return
    return api.on('guided:changed', (e) => {
      if (e.workspaceId === workspaceId) setChanged(e.apps)
    })
  }, [guided, workspaceId])
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const scrollRef = useRef<HTMLDivElement>(null)
  const items = chat?.items ?? []
  const busy = chat?.busy ?? false
  const draft = chat?.draft ?? ''
  const pendingImages = chat?.images ?? NO_IMAGES
  const fileInput = useRef<HTMLInputElement>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const [taHeight, setTaHeight] = useState<number>(() => Number(localStorage.getItem('sinfonie.composerHeight')) || 0)
  const saveHeight = (h: number): void => {
    setTaHeight(h)
    if (h) localStorage.setItem('sinfonie.composerHeight', String(h))
    else localStorage.removeItem('sinfonie.composerHeight')
    if (taRef.current) taRef.current.style.height = h ? `${h}px` : ''
  }
  const maxComposer = (): number => Math.floor(window.innerHeight * 0.6)
  // Custom resize handle in the top-right corner: the composer's bottom edge is pinned, so dragging up makes it taller.
  const startResize = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startY = e.clientY
    const startH = taRef.current?.offsetHeight ?? taHeight ?? 64
    const maxH = maxComposer()
    let h = startH
    const onMove = (ev: MouseEvent): void => {
      h = Math.min(maxH, Math.max(64, startH - (ev.clientY - startY)))
      if (taRef.current) taRef.current.style.height = `${h}px`
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      saveHeight(h)
    }
    document.body.style.cursor = 'ns-resize'
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }
  // The same handle from the keyboard: ↑ taller, ↓ shorter (Shift for bigger steps), Home resets.
  const resizeKey = (e: React.KeyboardEvent): void => {
    const cur = taRef.current?.offsetHeight ?? (taHeight || 64)
    const step = e.shiftKey ? 64 : 16
    if (e.key === 'ArrowUp') saveHeight(Math.min(maxComposer(), cur + step))
    else if (e.key === 'ArrowDown') saveHeight(Math.max(64, cur - step))
    else if (e.key === 'Home' || e.key === 'Enter') saveHeight(0)
    else return
    e.preventDefault()
  }
  const queue = chat?.queue ?? []
  const disabled = ws?.status !== 'ready'
  const notReady = notReadyText(ws, guided)
  const canSend = !disabled && (Boolean(draft.trim()) || pendingImages.length > 0)
  const settingsModel = useApp((s) => s.settings.model)
  const settingsMode = useApp((s) => s.settings.permissionMode)
  // Effective cost profile: workspace, then space, then app; lean beats budget.
  const costMode = useApp((s): CostMode => {
    const w = s.workspaces.find((x) => x.id === workspaceId)
    if (w?.costMode) return w.costMode
    const sp = s.spaces.find((x) => x.id === w?.spaceId)
    if (sp?.leanMode ?? s.settings.leanMode) return 'lean'
    return (sp?.budgetMode ?? s.settings.budgetMode) ? 'budget' : 'standard'
  })
  const costModeSource = useApp((s): 'workspace' | 'space' | 'app' => {
    const w = s.workspaces.find((x) => x.id === workspaceId)
    if (w?.costMode) return 'workspace'
    const sp = s.spaces.find((x) => x.id === w?.spaceId)
    return sp?.leanMode !== undefined || sp?.budgetMode !== undefined ? 'space' : 'app'
  })
  const engineLabel = useApp((s) => {
    const sp = s.spaces.find((x) => x.id === ws?.spaceId)
    const e = sp?.engine ?? s.settings.engine ?? 'claude-code'
    return e === 'native' ? 'native' : e === 'claude-code' ? 'claude code' : e
  })
  // Select stable references, derive outside the selector (a fresh array per read loops React).
  const space = useApp((s) => s.spaces.find((x) => x.id === ws?.spaceId))
  const library = useApp((s) => s.agents)
  const leanMode = costMode === 'lean'
  const crew = useMemo(() => {
    if (space?.useCrew === false || leanMode) return []
    const off = new Set(space?.crewDisabled ?? [])
    const models = space?.crewModels ?? {}
    return library.filter((a) => a.enabled && a.crew && (!a.scope || a.scope === space?.id) && !off.has(a.id)).map((a) => (models[a.id] ? { ...a, model: models[a.id] } : a))
  }, [space, library, leanMode])
  const crewNames = useMemo(() => crew.map((a) => `${a.name} (${a.model})`), [crew])
  /** Agents an @mention can reach: everything visible to the space, on or off the crew. */
  const mentionable = useMemo(() => library.filter((a) => a.enabled && (!a.scope || a.scope === space?.id)), [library, space])
  // "@" at the start of the message opens a picker; "@name …" sends the message straight to that agent.
  const mentionQuery = useMemo(() => {
    const m = /^@([A-Za-z0-9_-]*)$/.exec(draft)
    return m ? m[1].toLowerCase() : null
  }, [draft])
  const mentionOptions = useMemo(() => (mentionQuery === null ? [] : mentionable.filter((a) => a.name.toLowerCase().startsWith(mentionQuery)).slice(0, 8)), [mentionQuery, mentionable])
  const [mentionIdx, setMentionIdx] = useState(0)
  useEffect(() => setMentionIdx(0), [mentionQuery])
  const mentionTarget = useMemo(() => {
    const m = /^@([A-Za-z0-9_-]+)(?:\s|$)/.exec(draft)
    return m ? mentionable.find((a) => a.name.toLowerCase() === m[1].toLowerCase()) ?? null : null
  }, [draft, mentionable])
  const pickMention = (name: string): void => {
    setDraft(workspaceId, `@${name} `)
    taRef.current?.focus()
  }
  const setError = useApp((s) => s.setError)
  const mode: PermissionMode = ws?.permissionMode ?? settingsMode
  const [resumeDlg, setResumeDlg] = useState(false)
  const [forkDlg, setForkDlg] = useState(false)
  const [confirmFresh, setConfirmFresh] = useState(false)
  // Follow new output only while the view is already at the bottom; scrolling up detaches.
  const [atBottom, setAtBottom] = useState(true)
  const [unseen, setUnseen] = useState(false)
  const onScroll = (): void => {
    const el = scrollRef.current
    if (!el) return
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    setAtBottom(near)
    if (near) setUnseen(false)
  }
  const jumpToLatest = (): void => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    setAtBottom(true)
    setUnseen(false)
  }

  const changeMode = (next: PermissionMode): void => {
    api.invoke('agent:setMode', workspaceId, next).catch((err) => setError(friendlyError(err)))
  }
  const cycleMode = (): void => {
    const i = PERMISSION_MODES.findIndex((m) => m.id === mode)
    changeMode(PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length].id)
  }

  /**
   * Start over (guided) and New session (expert): clear the conversation, and offer Undo, which resumes the
   * cleared session. When the engine keeps no session to come back to, ask first instead.
   */
  const startFresh = async (confirmed = false): Promise<void> => {
    const sessionId = items.length > 0 ? restorableSession(workspaceId) : null
    if (items.length > 0 && !sessionId && !confirmed) {
      setConfirmFresh(true)
      return
    }
    try {
      await reset(workspaceId)
    } catch (err) {
      setError(friendlyError(err))
      return
    }
    setChanged(null)
    if (sessionId)
      notify({
        id: `chat-restore:${workspaceId}`,
        kind: 'info',
        text: guided ? 'Started a fresh conversation. Your changes are still there.' : 'Started a new session',
        undo: () => void restore(workspaceId, sessionId).catch((err) => setError(friendlyError(err, 'The earlier conversation could not be brought back.')))
      })
  }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (atBottom) el.scrollTop = el.scrollHeight
    else setUnseen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, questions.length])

  // ⌘. stops the running turn, from anywhere in the workspace except an editor or terminal that wants the key.
  useEffect(() => {
    if (!busy) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey || e.shiftKey || e.altKey || e.ctrlKey || e.key !== '.' || hasOpenDialog() || yieldsToEditor(e)) return
      e.preventDefault()
      void interrupt(workspaceId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, interrupt, workspaceId])
  // The plan card shows the latest plan in full; earlier versions fold into one line.
  const latestPlan = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const b = [...items[i].blocks].reverse().find((x): x is ChatToolBlock => x.type === 'tool' && x.name === 'TodoWrite')
      if (b) return b.toolUseId
    }
    return null
  }, [items])

  // While a turn runs, Enter queues the message; main delivers it when the turn ends.
  const onSubmit = (): void => {
    if (!canSend) return
    void send(workspaceId, draft)
  }
  const contextShare = chat?.contextTokens && chat?.contextWindow ? chat.contextTokens / chat.contextWindow : 0

  return (
    <div className="flex h-full">
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {resumeDlg && <ResumeDialog workspaceId={workspaceId} onClose={() => setResumeDlg(false)} />}
      {forkDlg && ws && <ForkDialog wsId={ws.id} wsName={ws.name} branch={ws.repos[0]?.branch ?? ''} onClose={() => setForkDlg(false)} />}
      {confirmFresh && (
        <Dialog title={guided ? 'Start over?' : 'Start a new session?'} onClose={() => setConfirmFresh(false)} width={420}>
          <p className="mb-4 text-[13px] text-muted">
            {guided ? 'Maestro forgets this conversation and it cannot be brought back. Your changes to the app stay.' : 'This engine keeps no session to resume, so the current conversation cannot be restored afterwards. Changes in the worktrees stay.'}
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setConfirmFresh(false)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                setConfirmFresh(false)
                void startFresh(true)
              }}
            >
              {guided ? 'Start over' : 'New session'}
            </Button>
          </div>
        </Dialog>
      )}
      <div ref={scrollRef} onScroll={onScroll} className="relative flex-1 overflow-auto px-6 py-4">
        {items.length === 0 && (
          <div className="mx-auto mt-16 max-w-md text-center text-muted">
            <p className="mb-2">{guided ? 'Describe what should change. You’ll see it in Preview.' : 'Claude Code runs here with every worktree of this workspace in scope.'}</p>
            <p className="text-[12px]">
              {ws?.repos.map((r) => r.repoName).join(' · ')}
              {ws?.sessionId && <span className="mt-1 block">{guided ? 'You can pick up where you left off.' : 'Previous session will be resumed.'}</span>}
            </p>
          </div>
        )}
        <div className="mx-auto flex max-w-4xl flex-col gap-4">
          <LatestPlan.Provider value={{ id: latestPlan, busy }}>
            {items.map((it) => (
              <Message key={it.id} item={it} />
            ))}
          </LatestPlan.Provider>
          {questions.map((q) => (
            <QuestionCard key={q.requestId} req={q} />
          ))}
          {chat?.error && (
            guided ? (
              <div role="alert" className="flex items-center gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[12px]">
                <span className="min-w-0 flex-1">{friendlyError(chat.error, 'Something went wrong. Try asking again in different words, or ask a teammate.')}</span>
                <AskTeammate workspaceId={workspaceId} prefill={`I hit a problem on this task: ${rawMessage(chat.error).slice(0, 300)}`} trigger={(open) => <Button size="sm" onClick={open}>Ask a teammate</Button>} />
              </div>
            ) : (
              <div role="alert" className="whitespace-pre-wrap rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{rawMessage(chat.error)}</div>
            )
          )}
        </div>
      </div>
      <div className="relative border-t border-border px-4 py-3">
        {!atBottom && (
          <button onClick={jumpToLatest} className={clsx('absolute -top-9 left-1/2 z-10 -translate-x-1/2 rounded-full border px-3 py-1 text-[12px] shadow-lg', unseen ? 'border-accent/50 bg-primary text-white' : 'border-border bg-panel text-muted hover:text-text')}>
            ↓ {unseen ? 'New output below' : 'Jump to latest'}
          </button>
        )}
        <div className="mx-auto max-w-4xl">
          <WorkingLine items={items} busy={busy} result={chat?.lastResult} waiting={questions.length > 0 ? 'question' : waitingForOk ? 'permission' : null} onStop={() => void interrupt(workspaceId)} />
          {queue.length > 0 && (
            <div className="mb-2 flex flex-col gap-1">
              {queue.map((m) => (
                <div key={m.id} className="flex items-center gap-2 rounded-md border border-dashed border-border py-0.5 pl-2.5 pr-1 text-[12px] text-muted">
                  <span className="shrink-0 text-[11px] uppercase tracking-wide">{guided ? 'Up next' : 'Queued'}</span>
                  <span className="min-w-0 flex-1 truncate">{m.text}</span>
                  <IconButton label={guided ? 'Don’t send this' : 'Remove from queue'} className="shrink-0 hover:text-danger" onClick={() => void unqueue(workspaceId, m.id)}>
                    <X size={12} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
          {chat?.limit && <LimitCard workspaceId={workspaceId} ev={chat.limit} />}
          {guided && changed && (
            <div className="mb-2 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2 text-[12px]">
              <span className="min-w-0 flex-1">Updated {changed.join(' and ')}. The preview shows it.</span>
              <Button size="sm" variant="primary" onClick={() => { setTab('browser'); setChanged(null) }}>
                Look
              </Button>
              <IconButton label="Dismiss" onClick={() => setChanged(null)}>
                <X size={12} />
              </IconButton>
            </div>
          )}
          {!guided && <CrewBar items={items} busy={busy} model={chat?.model ?? settingsModel} crewNames={crewNames} />}
          {disabled && notReady && (
            <div role="status" className="mb-2 flex items-center gap-2 px-1 text-[12px] text-muted">
              {ws?.status === 'creating' || ws?.status === 'archiving' ? <Spinner /> : <Info size={13} className="shrink-0" />}
              <span>{notReady}</span>
            </div>
          )}
          <div
            className="rounded-xl border border-border bg-panel focus-within:border-accent"
            onDragOver={(e) => {
              if (imageFiles(e.dataTransfer).length) e.preventDefault()
            }}
            onDrop={(e) => {
              const files = imageFiles(e.dataTransfer)
              if (files.length) {
                e.preventDefault()
                void addImages(workspaceId, files)
              }
            }}
          >
            {pendingImages.length > 0 && (
              <div className="flex flex-wrap gap-2 px-3 pt-3">
                {pendingImages.map((img) => (
                  <div key={img.id} className="group relative">
                    <img src={img.preview} alt={img.name} className="h-16 w-16 rounded-md border border-border object-cover" />
                    <IconButton label={`Remove ${img.name}`} className="reveal-on-focus absolute -right-2 -top-2 rounded-full border border-border bg-panel opacity-0 hover:text-danger group-hover:opacity-100" onClick={() => removeImage(workspaceId, img.id)}>
                      <X size={10} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}
            <input ref={fileInput} type="file" accept="image/*" multiple className="hidden" onChange={(e) => (e.target.files?.length && void addImages(workspaceId, Array.from(e.target.files)), (e.target.value = ''))} />
            <div className="relative">
              {mentionOptions.length > 0 && (
                <div className="absolute bottom-full left-2 z-20 mb-1 w-[360px] overflow-hidden rounded-lg border border-border bg-panel shadow-xl">
                  <div className="px-3 py-1.5 text-[11px] uppercase tracking-wide text-muted">Send straight to an agent</div>
                  {mentionOptions.map((a, i) => (
                    <button key={a.id} onMouseDown={(e) => e.preventDefault()} onClick={() => pickMention(a.name)} className={clsx('flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px]', i === mentionIdx ? 'bg-panel-2' : 'hover:bg-panel-2/60')}>
                      <span className="w-5 text-center">{a.icon || '🤖'}</span>
                      <span className="font-medium">@{a.name}</span>
                      <span className="truncate text-muted">{a.description}</span>
                      <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{a.model}</span>
                    </button>
                  ))}
                </div>
              )}
              {mentionTarget && mentionOptions.length === 0 && (
                <div className="absolute bottom-full left-2 z-20 mb-1 flex items-center gap-1.5 rounded-md border border-border bg-panel px-2 py-1 text-[11px] text-muted shadow">
                  <span>{mentionTarget.icon || '🤖'}</span> Goes straight to <span className="font-medium text-text">{mentionTarget.name}</span> on {mentionTarget.model}, outside the orchestrator.
                </div>
              )}
              <div
                role="separator"
                aria-orientation="horizontal"
                aria-label="Resize the message box"
                aria-valuemin={64}
                aria-valuemax={maxComposer()}
                aria-valuenow={taHeight || 64}
                tabIndex={0}
                className="absolute right-1.5 top-1.5 z-10 cursor-ns-resize rounded p-1 text-muted hover:bg-panel-2 hover:text-text"
                title="Drag to resize (or focus and use ↑ ↓). Double-click resets."
                onMouseDown={startResize}
                onKeyDown={resizeKey}
                onDoubleClick={() => saveHeight(0)}
              >
                <ChevronsUpDown size={12} />
              </div>
            <textarea
              value={draft}
              disabled={disabled}
              aria-label={guided ? 'Message to Maestro' : 'Message'}
              onChange={(e) => setDraft(workspaceId, e.target.value)}
              onPaste={(e) => {
                const files = imageFiles(e.clipboardData)
                if (files.length) {
                  e.preventDefault()
                  void addImages(workspaceId, files)
                }
              }}
              onKeyDown={(e) => {
                if (mentionOptions.length > 0) {
                  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault()
                    setMentionIdx((i) => (i + (e.key === 'ArrowDown' ? 1 : mentionOptions.length - 1)) % mentionOptions.length)
                    return
                  }
                  if (e.key === 'Enter' || e.key === 'Tab') {
                    e.preventDefault()
                    pickMention(mentionOptions[mentionIdx].name)
                    return
                  }
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    setDraft(workspaceId, '')
                    return
                  }
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  onSubmit()
                } else if (e.key === 'Tab' && e.shiftKey && !guided) {
                  e.preventDefault()
                  cycleMode()
                }
              }}
              rows={3}
              ref={taRef}
              style={taHeight ? { height: taHeight } : undefined}
              placeholder={disabled ? notReady ?? '' : busy ? (guided ? 'Type the next thing; it goes when Maestro is done (Enter)' : 'Type to queue a message for when this turn ends… (Enter to queue)') : words(guided).composerPlaceholder}
              className="block min-h-[64px] max-h-[60vh] w-full resize-none bg-transparent pt-3 pl-3 pr-8 text-[13px] outline-none placeholder:text-muted"
            />
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 px-2 pb-2">
              {guided ? (
                <StartOver busy={busy} disabled={disabled} long={contextShare > 0.6} onNew={() => void startFresh()} />
              ) : (
                <>
                  <ModePicker mode={mode} onChange={changeMode} />
                  <span className="max-w-[140px] truncate font-mono text-[11px] text-muted" title={`Model: ${chat?.model ?? settingsModel}. Change the default in Settings.`}>
                    {shortModel(chat?.model ?? settingsModel)}
                  </span>
                  <SessionPill workspaceId={workspaceId} spaceId={ws?.spaceId} engineLabel={engineLabel} costMode={costMode} costModeSource={costModeSource} model={chat?.model ?? settingsModel} contextTokens={chat?.contextTokens} contextWindow={chat?.contextWindow} cacheRead={chat?.contextCacheRead} history={chat?.contextHistory} result={chat?.lastResult} busy={busy} onNewSession={() => void startFresh()} />
                </>
              )}
              <span className="ml-auto" />
              {guided ? (
                <>
                  <IconButton label="Attach images (or paste or drop them into the message)" className="px-1.5" onClick={() => fileInput.current?.click()} disabled={disabled}>
                    <Paperclip size={13} />
                  </IconButton>
                  <AskTeammateButton workspaceId={workspaceId} />
                  <CaffeineButton compact />
                </>
              ) : (
                <ComposerMenu workspaceId={workspaceId} busy={busy} disabled={disabled} onAttach={() => fileInput.current?.click()} onFork={() => setForkDlg(true)} onResume={() => setResumeDlg(true)} onNew={() => void startFresh()} />
              )}
              {busy ? (
                <Button size="sm" onClick={onSubmit} disabled={!canSend} title="Queue: delivered when the current turn ends (Enter)">
                  <Send size={12} /> Queue <kbd className="ml-0.5 font-sans text-[11px] opacity-60">↵</kbd>
                </Button>
              ) : (
                <Button size="sm" variant="primary" onClick={onSubmit} disabled={!canSend} title="Send (Enter). Shift+Enter adds a new line.">
                  <Send size={12} /> Send <kbd className="ml-0.5 font-sans text-[11px] opacity-70">↵</kbd>
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    {!guided && <SubagentPanel items={items} model={chat?.model ?? settingsModel} workspaceId={workspaceId} />}
    </div>
  )
}

/** Why the composer is off, in the mode's words; null when the workspace is ready. */
function notReadyText(ws: { status: string; error?: string } | undefined, guided: boolean): string | null {
  if (!ws) return guided ? 'This task is no longer available.' : 'This workspace no longer exists.'
  switch (ws.status) {
    case 'ready':
      return null
    case 'creating':
      return guided ? 'The task is getting ready…' : 'Setting up the workspace: creating worktrees and running setup…'
    case 'error':
      return guided ? 'This task could not be set up. Ask a teammate for help.' : `Workspace setup failed${ws.error ? `: ${rawMessage(ws.error)}` : '.'}`
    case 'archiving':
      return guided ? 'Finishing this task…' : 'Archiving this workspace…'
    case 'archived':
      return guided ? 'This task is finished.' : 'This workspace is archived.'
    default:
      return guided ? 'The task is not ready yet.' : 'Workspace is not ready.'
  }
}

/**
 * The turn in progress, pinned above the composer so a long turn never looks frozen. Both modes show the elapsed
 * time and Stop; guided adds the last few steps in plain words, expert the tool running now. When a guided turn
 * ends it folds into one "Done in … · N steps" line; expert drops it, since the tool rows tell the story.
 */
function WorkingLine({ items, busy, result, waiting, onStop }: { items: ChatItem[]; busy: boolean; result?: ChatTurnResult; waiting: 'question' | 'permission' | null; onStop: () => void }): React.JSX.Element | null {
  const guided = useGuided()
  const { startedAt, tools } = useMemo(() => turnActivity(items), [items])
  const [now, setNow] = useState(() => Date.now())
  // When the turn began before this view mounted and the transcript has no timestamp, count from the mount.
  const since = useRef<number | null>(null)
  if (busy && since.current === null) since.current = Date.now()
  if (!busy) since.current = null
  useEffect(() => {
    if (!busy) return
    setNow(Date.now())
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [busy])
  const steps = useMemo(() => (guided ? recentGuidedSteps(tools, 3) : []), [guided, tools])
  const rel = useRelative()

  if (!busy) {
    // A finished guided turn: one quiet line, until the next message.
    if (!guided || !result || items[items.length - 1]?.role === 'user' || startedAt === null) return null
    const n = tools.length
    return (
      <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] text-muted">
        {result.isError ? <Square size={10} className="shrink-0" aria-hidden /> : <Check size={12} className="shrink-0 text-ok" aria-hidden />}
        <span>
          {result.isError ? 'Stopped after' : 'Done in'} {formatDuration(result.durationMs)}
          {n > 0 && ` · ${n} step${n === 1 ? '' : 's'}`}
        </span>
      </div>
    )
  }

  const start = startedAt !== null && startedAt <= now ? startedAt : since.current ?? now
  const elapsed = formatElapsed(now - start)
  const label = waiting === 'question' ? 'Waiting for your answer' : waiting === 'permission' ? 'Waiting for your OK' : guided ? 'Working on it' : 'Working'
  const dot = (
    <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
      {!waiting && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent/40 [animation-duration:2s]" />}
      <span className={clsx('relative inline-flex h-2 w-2 rounded-full', waiting ? 'bg-warn' : 'bg-accent')} />
    </span>
  )

  if (!guided) {
    const current = [...tools].reverse().find((t) => !t.done)
    const detail = current ? rel(toolHeadline(current)) : ''
    return (
      <div className="mb-2 flex h-9 items-center gap-2 rounded-lg border border-border bg-panel px-3 text-[12px]">
        {dot}
        <span className="min-w-0 max-w-[45%] shrink truncate text-text">{current && !waiting ? expertToolName(current) : label}</span>
        {current && !waiting && detail && <span className="min-w-0 truncate font-mono text-[11px] text-muted">{detail}</span>}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{elapsed}</span>
        <Button size="sm" className="ml-auto shrink-0" onClick={onStop} title="Stop this turn (⌘.)" aria-keyshortcuts="Meta+.">
          <Square size={10} /> Stop <kbd className="ml-0.5 font-sans text-[11px] opacity-60">⌘.</kbd>
        </Button>
      </div>
    )
  }

  return (
    <div className="mb-2 rounded-lg border border-border bg-panel/60 px-3 py-2 text-[12px]">
      <div className="flex items-center gap-2">
        {dot}
        <span className="text-text">{label}</span>
        <span className="tabular-nums text-muted">· {elapsed}</span>
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onStop} title="Stop Maestro. What it already changed stays. (⌘.)">
          <Square size={10} /> Stop
        </Button>
      </div>
      {steps.length > 0 && (
        <ul aria-live="polite" className="mt-1 flex flex-col gap-0.5 pl-4 text-muted">
          {steps.map((st) => (
            <li key={st.key} className="flex items-center gap-1.5">
              {st.done ? <Check size={11} className="shrink-0 text-ok/80" aria-hidden /> : <span className="mx-[3px] h-1 w-1 shrink-0 rounded-full bg-muted" aria-hidden />}
              <span className="truncate">{st.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Guided mode's only session control: a fresh conversation. Always there; highlighted once the chat has grown long. */
function StartOver({ busy, disabled, long, onNew }: { busy: boolean; disabled: boolean; long: boolean; onNew: () => void }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant={long ? 'subtle' : 'ghost'}
        disabled={busy || disabled}
        onClick={onNew}
        title={long ? 'This conversation has grown long, which makes Maestro slower. Starting over keeps your changes; you can undo it right after.' : 'Start a fresh conversation. Your changes stay; you can undo it right after.'}
      >
        <RotateCcw size={12} /> Start over
      </Button>
      {long && !busy && <span className="text-[11px] text-warn">The chat is getting long</span>}
    </span>
  )
}

function ModePicker({ mode, onChange }: { mode: PermissionMode; onChange: (m: PermissionMode) => void }): React.JSX.Element {
  const current = PERMISSION_MODES.find((m) => m.id === mode) ?? PERMISSION_MODES[0]
  const tone = mode === 'bypassPermissions' ? 'text-danger bg-danger/15' : mode === 'plan' ? 'text-warn bg-warn/15' : mode === 'default' ? 'text-muted bg-panel-2' : 'text-ok bg-ok/15'
  const id = useId()
  return (
    <span data-tour="mode" className={clsx('relative inline-flex h-6 items-center gap-1 rounded-md pl-1.5 text-[11px] font-medium', tone)} title={`${current.label}: ${current.hint}. Shift+Tab in the message box cycles modes.`}>
      <ShieldCheck size={12} aria-hidden />
      <label htmlFor={id} className="cursor-pointer opacity-80">
        Permissions:
      </label>
      <select id={id} className="h-full cursor-pointer appearance-none rounded-md bg-transparent pl-0.5 pr-5 font-medium text-current" value={mode} onChange={(e) => onChange(e.target.value as PermissionMode)}>
        {PERMISSION_MODES.map((m) => (
          <option key={m.id} value={m.id} title={m.hint} className="bg-panel text-text">
            {m.label}
          </option>
        ))}
      </select>
      <ChevronDown size={11} className="pointer-events-none absolute right-1.5 opacity-70" aria-hidden />
    </span>
  )
}

/** Composer extras behind one "+": attach, keep awake, notes, and the session actions. */
function ComposerMenu({ workspaceId, busy, disabled, onAttach, onFork, onResume, onNew }: { workspaceId: string; busy: boolean; disabled: boolean; onAttach: () => void; onFork: () => void; onResume: () => void; onNew: () => void }): React.JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [awake, setAwake] = useState(false)
  useEffect(() => {
    void api.invoke('power:get').then(setAwake)
    return api.on('power:changed', setAwake)
  }, [])
  const [view, setView] = usePanel()
  const openTodos = useOpenTodos(workspaceId)
  const notesOn = view.kind === 'notes'
  const entries = [
    { label: 'Attach images…', icon: <Paperclip size={13} />, onClick: onAttach, disabled },
    { label: awake ? 'Let the Mac sleep' : 'Keep the Mac awake', icon: <Coffee size={13} className={awake ? 'text-accent' : undefined} />, onClick: () => void api.invoke('power:set').then(setAwake) },
    { label: notesOn ? 'Hide notes' : `Notes${openTodos ? ` · ${openTodos} open` : ''}`, icon: <StickyNote size={13} />, onClick: () => setView(notesOn ? { kind: 'closed' } : { kind: 'notes' }) },
    { separator: true },
    { label: 'Fork into a new workspace…', icon: <GitFork size={13} />, onClick: onFork, disabled: busy || disabled },
    { label: 'Resume a past session…', icon: <History size={13} />, onClick: onResume, disabled: busy },
    { label: 'New session', icon: <RotateCcw size={13} />, onClick: onNew, disabled: busy }
  ]
  const open = (e: React.MouseEvent<HTMLButtonElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const height = entries.reduce((h, m) => h + (m.separator ? 9 : 30), 8)
    setMenu({ x: r.right - 224, y: r.top - 6 - height })
  }
  return (
    <>
      <IconButton data-tour="notes" label={`More: attach, keep awake, notes, session${openTodos ? ` (${openTodos} open todos)` : ''}`} aria-haspopup="menu" aria-expanded={Boolean(menu)} className={clsx('relative px-1.5', (menu || notesOn) && 'bg-panel-2 text-text')} onClick={open}>
        <Plus size={14} />
        {(openTodos > 0 || awake) && <span className={clsx('absolute right-0.5 top-0.5 h-1.5 w-1.5 rounded-full', awake ? 'bg-accent' : 'bg-warn')} aria-hidden />}
      </IconButton>
      {menu && <ContextMenu x={menu.x} y={menu.y} label="Composer actions" onClose={() => setMenu(null)} entries={entries} />}
    </>
  )
}

/** Open todos in a workspace's notes, loading them once. */
function useOpenTodos(workspaceId: string): number {
  const notes = useNotes((s) => s.byWorkspace[workspaceId]) ?? NO_NOTES
  const { load, subscribe } = useNotes()
  useEffect(() => {
    subscribe()
    void load(workspaceId)
  }, [workspaceId, load, subscribe])
  return notes.filter((n) => n.kind === 'todo' && !n.done).length
}

/** A system notice: the first paragraph always shows; anything after a blank line folds behind "Details". */
function NoticeText({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const cut = text.indexOf('\n\n')
  if (cut < 0) return <span className="whitespace-pre-wrap">{text}</span>
  return (
    <span className="min-w-0 flex-1">
      <span className="whitespace-pre-wrap">{text.slice(0, cut)}</span>{' '}
      <button type="button" className="text-accent hover:underline" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Hide details' : 'Details'}
      </button>
      {open && (
        <span data-expert-ok className="mt-1.5 block whitespace-pre-wrap font-mono text-[11px]">
          {text.slice(cut + 2)}
        </span>
      )}
    </span>
  )
}

export function Message({ item }: { item: ChatItem }): React.JSX.Element | null {
  const guided = useGuided()
  if (item.role === 'system') {
    const raw = item.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    const level = item.level ?? 'info'
    // Guided: errors in plain words, notices it can act on rewritten, purely technical ones left out.
    const text = !guided ? raw : level === 'error' ? friendlyError(raw) : guidedNotice(raw, level)
    if (text === null) return null
    return (
      <div role={level === 'error' ? 'alert' : undefined} className={clsx('flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]', level === 'error' ? 'border-danger/40 bg-danger/10 text-danger' : level === 'warn' ? 'border-warn/40 bg-warn/10 text-warn' : 'border-border bg-panel text-muted')}>
        {level === 'error' ? <XCircle size={14} className="mt-0.5 shrink-0" aria-hidden /> : level === 'warn' ? <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden /> : <Info size={14} className="mt-0.5 shrink-0" aria-hidden />}
        <NoticeText text={text} />
      </div>
    )
  }
  if (item.role === 'user') {
    const full = item.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')
    // Guided: technical output attached to a message (for example "Ask Maestro to fix it") folds away.
    const fence = guided ? full.indexOf('\n\n```') : -1
    const text = fence > 0 ? full.slice(0, fence) : full
    const attached = fence > 0 ? full.slice(fence).trim().replace(/^```\w*\n?|```$/g, '').trim() : ''
    const images = item.blocks.filter((b): b is Extract<typeof b, { type: 'image' }> => b.type === 'image').map((b) => b.image)
    return (
      <div className="flex flex-col items-end gap-1.5">
        {images.length > 0 && (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {images.map((img) => (
              <ChatImage key={img.id} image={img} />
            ))}
          </div>
        )}
        {text.trim() && (
          <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent-2/25 px-3.5 py-2 text-[13px]">
            {text}
            {attached && <AttachedDetails text={attached} />}
          </div>
        )}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {groupBlocks(item.blocks).map((g, i) => (g.kind === 'tools' ? <ToolChips key={i} blocks={g.blocks} /> : g.kind === 'plan' ? <PlanBlock key={i} block={g.block} /> : <Block key={i} block={g.block} />))}
    </div>
  )
}

type BlockGroup = { kind: 'one'; block: ChatBlock } | { kind: 'tools'; blocks: ChatToolBlock[] } | { kind: 'plan'; block: ChatToolBlock }
const isDelegation = (b: ChatToolBlock): boolean => b.name === 'Agent' || b.name === 'Task'

/** Consecutive plain tool calls become one row of chips; delegations keep their full row, a plan its card. */
function groupBlocks(blocks: ChatBlock[]): BlockGroup[] {
  const out: BlockGroup[] = []
  for (const b of blocks) {
    if (b.type !== 'tool' || isDelegation(b)) out.push({ kind: 'one', block: b })
    else if (b.name === 'TodoWrite') out.push({ kind: 'plan', block: b })
    else {
      const last = out[out.length - 1]
      if (last?.kind === 'tools') last.blocks.push(b)
      else out.push({ kind: 'tools', blocks: [b] })
    }
  }
  return out
}

/** The newest plan in the conversation and whether a turn is running; outside a workspace chat every plan shows in full. */
const LatestPlan = React.createContext<{ id: string | null; busy: boolean }>({ id: null, busy: false })

interface PlanItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}
function planItems(block: ChatToolBlock): PlanItem[] {
  const todos = ((block.input ?? {}) as { todos?: unknown }).todos
  return Array.isArray(todos) ? todos.filter((t): t is PlanItem => Boolean(t) && typeof (t as PlanItem).content === 'string') : []
}

/** The orchestrator's plan (its todo list) as a checklist. Older versions of the plan fold into one line. */
function PlanBlock({ block }: { block: ChatToolBlock }): React.JSX.Element | null {
  const guided = useGuided()
  const { id: latest, busy } = React.useContext(LatestPlan)
  const [open, setOpen] = useState(false)
  const list = planItems(block)
  if (guided || list.length === 0) return null
  const done = list.filter((t) => t.status === 'completed').length
  const summary = `${done} of ${list.length} done`
  if (latest && latest !== block.toolUseId && !open) {
    return (
      <button className="inline-flex items-center gap-1 self-start text-[11px] text-muted hover:text-text" aria-expanded={false} onClick={() => setOpen(true)}>
        <ChevronRight size={11} aria-hidden /> Plan updated · {summary}
      </button>
    )
  }
  return (
    <section aria-label="Plan" className="max-w-[72ch] rounded-lg border border-border bg-panel px-3.5 py-2.5 text-[13px]">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="font-semibold">Plan</span>
        <span className="ml-auto text-[11px] text-muted">{summary}</span>
        {open && (
          <IconButton label="Fold this earlier plan" onClick={() => setOpen(false)}>
            <X size={12} />
          </IconButton>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {list.map((t, i) => (
          <li key={i} className={clsx('flex items-start gap-2.5', t.status === 'pending' && 'text-muted')}>
            <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
              {t.status === 'completed' ? (
                <Check size={13} className="text-ok" />
              ) : t.status === 'in_progress' ? (
                <span className={clsx('h-2 w-2 rounded-full bg-accent', busy && latest === block.toolUseId && 'animate-pulse')} />
              ) : (
                <span className="h-2.5 w-2.5 rounded-full border border-muted" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="sr-only">{t.status === 'completed' ? 'Done: ' : t.status === 'in_progress' ? 'In progress: ' : 'To do: '}</span>
              {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Lines a text spans, for the +/− of an edit as the tool call describes it. */
const lineCount = (v: unknown): number => (typeof v === 'string' && v.length ? v.split('\n').length : 0)

/** An edit's +/− from the tool call itself: lines written against lines replaced. Null for anything that is not an edit. */
function editCounts(block: ChatToolBlock): { adds: number; dels: number } | null {
  const i = (block.input ?? {}) as Record<string, unknown>
  if (block.name === 'Write') return { adds: lineCount(i.content), dels: 0 }
  if (block.name === 'Edit') return { adds: lineCount(i.new_string), dels: lineCount(i.old_string) }
  if (block.name === 'MultiEdit' && Array.isArray(i.edits)) {
    return (i.edits as Record<string, unknown>[]).reduce<{ adds: number; dels: number }>((n, e) => ({ adds: n.adds + lineCount(e.new_string), dels: n.dels + lineCount(e.old_string) }), { adds: 0, dels: 0 })
  }
  return null
}

/** Paths read relative to the open workspace: "api/src/discounts.ts", not the full folder on disk. */
function useRelative(): (p: string) => string {
  const root = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId)?.rootPath)
  return (p) => (root ? p.split(`${root}/`).join('').split(root).join('.') : p)
}

function toolHeadline(block: ChatToolBlock): string {
  const input = (block.input ?? {}) as Record<string, unknown>
  return typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.pattern === 'string' ? input.pattern : typeof input.url === 'string' ? input.url : typeof input.description === 'string' ? input.description : ''
}

const CHIPS_SHOWN = 3

/**
 * A turn's tool calls as compact chips ("Edit api/src/discounts.ts +42 −9"), the first few shown and the rest
 * behind "+ N more". A chip opens its call's input and result underneath.
 */
function ToolChips({ blocks }: { blocks: ChatToolBlock[] }): React.JSX.Element | null {
  const guided = useGuided()
  const rel = useRelative()
  const [all, setAll] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  if (guided) return null
  const shown = all || blocks.length <= CHIPS_SHOWN + 1 ? blocks : blocks.slice(0, CHIPS_SHOWN)
  const hidden = blocks.length - shown.length
  const hiddenFailed = blocks.slice(shown.length).filter((b) => b.isError).length
  const opened = blocks.find((b) => b.toolUseId === openId)
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-1.5">
        {shown.map((b) => {
          const counts = editCounts(b)
          const verb = b.name === 'MultiEdit' ? 'Edit' : expertToolName(b)
          const head = rel(toolHeadline(b))
          return (
            <button
              key={b.toolUseId}
              aria-expanded={openId === b.toolUseId}
              onClick={() => setOpenId(openId === b.toolUseId ? null : b.toolUseId)}
              title={`${verb} ${head}`.trim()}
              className={clsx(
                'inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 text-[12px] transition-colors @min-[520px]:max-w-[380px]',
                b.isError ? 'border-danger/40 text-danger' : openId === b.toolUseId ? 'border-accent/50 bg-panel-2 text-text' : 'border-border bg-panel text-text hover:bg-panel-2'
              )}
            >
              {!b.done && <Spinner />}
              <span className="shrink-0 font-medium">{verb}</span>
              {head && <span className="min-w-0 truncate font-mono text-[11px] text-muted">{head}</span>}
              {counts && (counts.adds > 0 || counts.dels > 0) && (
                <span className="shrink-0 font-mono text-[11px] tabular-nums">
                  {counts.adds > 0 && <span className="text-ok">+{counts.adds}</span>}
                  {counts.dels > 0 && <span className="ml-1 text-danger">−{counts.dels}</span>}
                </span>
              )}
              {b.isError && <span className="sr-only">(failed)</span>}
            </button>
          )
        })}
        {hidden > 0 && (
          <button onClick={() => setAll(true)} className={clsx('inline-flex h-6 items-center rounded-md border border-dashed px-2 text-[12px] hover:bg-panel-2', hiddenFailed ? 'border-danger/40 text-danger' : 'border-border text-muted hover:text-text')}>
            + {hidden} more{hiddenFailed ? ` · ${hiddenFailed} failed` : ''}
          </button>
        )}
        {all && blocks.length > CHIPS_SHOWN + 1 && (
          <button onClick={() => setAll(false)} className="inline-flex h-6 items-center rounded-md px-2 text-[12px] text-muted hover:text-text">
            Show fewer
          </button>
        )}
      </div>
      {opened && <ToolCall key={opened.toolUseId} block={opened} defaultOpen />}
    </div>
  )
}

/** Technical text sent along with a guided message, closed by default; opening it is a deliberate choice. */
function AttachedDetails({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <span className="mt-1.5 block">
      <button className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-text" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={11} className={clsx('transition-transform', open && 'rotate-90')} aria-hidden /> Details sent along
      </button>
      {open && (
        <pre data-expert-ok className="mt-1 max-h-48 overflow-auto rounded-md bg-sunken p-2 font-mono text-[11px] text-muted">
          {text}
        </pre>
      )}
    </span>
  )
}

function Block({ block }: { block: ChatBlock }): React.JSX.Element | null {
  const guided = useGuided()
  if (block.type === 'text') return block.text.trim() ? <Markdown text={block.text} /> : null
  if (block.type === 'image') return <ChatImage image={block.image} />
  // A guided user reads what Maestro says, not how it thinks or which commands it ran.
  if (guided) return null
  if (block.type === 'thinking') return block.text.trim() ? <Collapsible label="Thinking" muted body={block.text} /> : null
  return <ToolCall block={block} />
}

const NO_IMAGES: never[] = []

/** The session's vitals in one small pill; the details, the context window and Compact open on click. */
const COST_MODES: { id: CostMode; label: string; hint: string }[] = [
  { id: 'standard', label: 'Standard', hint: 'Your model and crew as configured.' },
  { id: 'budget', label: 'Budget', hint: 'Sonnet orchestrator, low effort, two subagents, 60 tool calls per message.' },
  { id: 'lean', label: 'Lean', hint: 'One Sonnet agent, no crew, no browser or web tools, trimmed output, 25 tool calls per message. Fewest tokens.' }
]

/** Cost profile picker with a scope: this workspace, its space, or the whole app. Applies at once; the session restarts and resumes. */
function CostModeControl({ workspaceId, spaceId, mode, source, busy }: { workspaceId: string; spaceId?: string; mode: CostMode; source: 'workspace' | 'space' | 'app'; busy: boolean }): React.JSX.Element {
  const [scope, setScope] = useState<'workspace' | 'space' | 'app'>(source)
  const [saving, setSaving] = useState(false)
  // A switch restarts the session, so it waits for a confirmation right here.
  const [pending, setPending] = useState<CostMode | null>(null)
  const setError = useApp((s) => s.setError)
  useEffect(() => setScope(source), [source])
  const apply = (next: CostMode): void => {
    if (saving || next === mode) return
    const target: CostModeScope = scope === 'workspace' ? { kind: 'workspace', id: workspaceId } : scope === 'space' && spaceId ? { kind: 'space', id: spaceId } : { kind: 'app' }
    setSaving(true)
    setPending(null)
    api
      .invoke('costMode:set', target, next)
      .catch((err) => setError(friendlyError(err)))
      .finally(() => setSaving(false))
  }
  const current = COST_MODES.find((m) => m.id === mode) ?? COST_MODES[0]
  return (
    <div className="mt-1.5">
      <div className="flex items-center gap-2">
        <span className="w-[76px] shrink-0 text-muted">Cost mode</span>
        <div className="flex flex-1 rounded-md bg-bg p-0.5">
          {COST_MODES.map((m) => (
            <button key={m.id} title={m.hint} disabled={saving} aria-pressed={mode === m.id} onClick={() => m.id !== mode && setPending(m.id)} className={clsx('flex-1 rounded px-2 py-0.5 text-[11px]', mode === m.id ? (m.id === 'standard' ? 'bg-panel-2 text-text' : 'bg-ok/20 text-ok') : pending === m.id ? 'bg-panel-2 text-text ring-1 ring-accent/60' : 'text-muted hover:text-text')}>
              {m.label}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
        <span className="w-[76px] shrink-0">Apply to</span>
        <select className="flex-1 rounded border border-border bg-bg px-1 py-px text-[11px] text-text" value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="workspace">This workspace</option>
          {spaceId && <option value="space">This space</option>}
          <option value="app">Everywhere</option>
        </select>
      </div>
      {pending ? (
        <div role="alert" className="mt-1.5 rounded-md border border-warn/40 bg-warn/10 p-2 text-[11px]">
          <div className="mb-1.5">
            Switch to {COST_MODES.find((m) => m.id === pending)?.label} {scope === 'workspace' ? 'for this workspace' : scope === 'space' ? 'for this space' : 'everywhere'}? Changing cost mode restarts the session{busy ? ' after the current turn' : ''}; the conversation continues.
          </div>
          <div className="flex justify-end gap-1.5">
            <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="primary" disabled={saving} onClick={() => apply(pending)}>
              Restart with {COST_MODES.find((m) => m.id === pending)?.label}
            </Button>
          </div>
        </div>
      ) : (
        <div className="mt-1 text-[11px] text-muted">
          {current.hint} Set {source === 'workspace' ? 'on this workspace' : source === 'space' ? 'on this space' : 'app-wide'}.
        </div>
      )}
    </div>
  )
}

/**
 * Read-only session status next to the composer ("42% context · $1.20 · lean"); a click opens the diagnostics:
 * the context breakdown, Compact, cost by model and the cost mode.
 */
function SessionPill({ workspaceId, spaceId, engineLabel, costMode, costModeSource, model, contextTokens, contextWindow, cacheRead, history, result, busy, onNewSession }: { workspaceId: string; spaceId?: string; engineLabel: string; costMode: CostMode; costModeSource: 'workspace' | 'space' | 'app'; model: string; contextTokens?: number; contextWindow?: number; cacheRead?: number; history?: number[]; result?: ChatTurnResult; busy: boolean; onNewSession: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [usage, setUsage] = useState<ContextUsage | null>(null)
  const [detail, setDetail] = useState(false)
  const [compacting, setCompacting] = useState(false)
  const setError = useApp((s) => s.setError)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !hasOpenDialog()) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  useEffect(() => {
    if (!open) return
    api.invoke('agent:contextUsage', workspaceId).then(setUsage).catch(() => setUsage(null))
  }, [open, workspaceId, contextTokens])
  useEffect(() => {
    if (compacting && contextTokens !== undefined) setCompacting(false)
  }, [contextTokens, compacting])
  const window = usage?.maxTokens || contextWindow || 200_000
  const used = usage?.totalTokens ?? contextTokens ?? 0
  const pct = Math.min(100, (used / window) * 100)
  const tone = pct >= 85 ? 'danger' : pct >= 60 ? 'warn' : 'ok'
  const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n))
  const cacheShare = contextTokens && cacheRead ? Math.round((cacheRead / contextTokens) * 100) : null
  const compact = (): void => {
    setCompacting(true)
    api.invoke('agent:compact', workspaceId).catch((err) => {
      setCompacting(false)
      setError(friendlyError(err))
    })
  }
  const statusParts = [contextTokens ? `${Math.round(pct)}% context` : '0% context', result ? `$${result.costUsd.toFixed(2)}` : null, costMode !== 'standard' ? costMode : null].filter(Boolean)
  const usedCats = (usage?.categories ?? []).filter((c) => c.kind === 'used' && c.tokens > 0).sort((a, b) => b.tokens - a.tokens)
  const buffer = (usage?.categories ?? []).find((c) => c.kind === 'buffer')
  const byServer = Object.entries((usage?.mcpTools ?? []).reduce<Record<string, number>>((m, t) => ((m[t.serverName] = (m[t.serverName] ?? 0) + t.tokens), m), {})).sort((a, b) => b[1] - a[1])
  return (
    <div ref={ref} className="relative">
      <button
        data-tour="session"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className={clsx('inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] tabular-nums hover:bg-panel-2 hover:text-text', tone === 'danger' && contextTokens ? 'text-danger' : tone === 'warn' && contextTokens ? 'text-warn' : 'text-muted')}
        title={`Session details${contextTokens ? `: ${contextTokens.toLocaleString()} of ${window.toLocaleString()} context tokens used` : ''}. Click for the breakdown, Compact and cost mode.`}
      >
        {statusParts.join(' · ')}
        <ChevronRight size={11} className={clsx('transition-transform', open ? '-rotate-90' : 'rotate-90')} aria-hidden />
      </button>
      {open && (
        <div role="dialog" aria-label="Session details" className="absolute bottom-full left-0 z-20 mb-1 w-[360px] rounded-lg border border-border bg-panel p-3 text-[12px] shadow-2xl">
          {/* context window */}
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-wide text-muted">Context window</span>
            <span className="font-mono text-[11px]">
              {k(used)} / {k(window)} · {Math.round(pct)}%
            </span>
          </div>
          <div className="mb-1.5 flex h-2 w-full overflow-hidden rounded-full bg-panel-2" title={usedCats.map((c) => `${c.name}: ${k(c.tokens)}`).join('\n')}>
            {usedCats.length > 0
              ? usedCats.map((c, i) => <span key={c.name} className={clsx('h-full', ['bg-accent', 'bg-accent/75', 'bg-accent/55', 'bg-accent/40', 'bg-accent/30', 'bg-accent/25'][i % 6])} style={{ width: `${(c.tokens / window) * 100}%` }} title={`${c.name}: ${k(c.tokens)}`} />)
              : <span className={clsx('h-full', tone === 'danger' ? 'bg-danger' : tone === 'warn' ? 'bg-warn' : 'bg-accent/70')} style={{ width: `${pct}%` }} />}
            {buffer && <span className="ml-auto h-full bg-border/60" style={{ width: `${(buffer.tokens / window) * 100}%` }} title={`${buffer.name}: ${k(buffer.tokens)} reserved for compaction`} />}
          </div>
          {usedCats.length > 0 && (
            <div className="mb-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
              {usedCats.slice(0, 6).map((c) => (
                <div key={c.name} className="flex justify-between gap-2">
                  <span className="truncate text-muted">{c.name}</span>
                  <span className="font-mono">{k(c.tokens)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted">
            {history && history.length > 1 && (
              <span className="inline-flex items-end gap-px" title="Context size over the last turns">
                {history.slice(-24).map((h, i) => (
                  <span key={i} className="w-[3px] rounded-sm bg-accent/60" style={{ height: `${Math.max(2, (h / Math.max(...history)) * 14)}px` }} />
                ))}
              </span>
            )}
            {cacheShare != null && <span title="Share of the context served from the prompt cache on the last call (cheaper than fresh input)">cache {cacheShare}%</span>}
            {history && history.length > 1 && <span>+{k(Math.max(0, history[history.length - 1] - history[history.length - 2]))} last turn</span>}
            {usage?.overLimit && <span className="text-danger">{k(usage.overLimit.tokensOver)} over the {usage.overLimit.kind === 'hard_limit' ? 'hard limit' : 'compaction window'}</span>}
          </div>
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant={pct >= 60 ? 'primary' : 'subtle'} disabled={busy || compacting || !contextTokens} onClick={compact} title="Ask Claude Code to summarise the conversation so far in place. Detail becomes a summary; the work continues with a much smaller context.">
              {compacting ? <Spinner /> : <History size={12} />} {compacting ? 'Compacting…' : 'Compact conversation'}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => (setOpen(false), onNewSession())} title="Start from an empty context. You can undo it right after.">
              <RotateCcw size={12} /> New session
            </Button>
            {(byServer.length > 0 || (usage?.agents.length ?? 0) > 0 || (usage?.memoryFiles.length ?? 0) > 0) && (
              <button className="ml-auto text-[11px] text-accent hover:underline" onClick={() => setDetail(!detail)}>
                {detail ? 'Hide' : 'What fills it'}
              </button>
            )}
          </div>
          {detail && usage && (
            <div className="mb-2 max-h-[220px] overflow-auto rounded-md border border-border bg-bg p-2 text-[11px]">
              {byServer.length > 0 && (
                <>
                  <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">MCP tool definitions</div>
                  {byServer.map(([srv, t]) => (
                    <div key={srv} className="flex justify-between">
                      <span>{srv}</span>
                      <span className="font-mono">{k(t)}</span>
                    </div>
                  ))}
                </>
              )}
              {usage.agents.length > 0 && (
                <>
                  <div className="mb-0.5 mt-1.5 text-[11px] uppercase tracking-wide text-muted">Crew and agents</div>
                  {usage.agents.map((a) => (
                    <div key={a.agentType} className="flex justify-between">
                      <span>{a.agentType}</span>
                      <span className="font-mono">{k(a.tokens)}</span>
                    </div>
                  ))}
                </>
              )}
              {usage.memoryFiles.length > 0 && (
                <>
                  <div className="mb-0.5 mt-1.5 text-[11px] uppercase tracking-wide text-muted">Memory and instructions</div>
                  {usage.memoryFiles.map((m) => (
                    <div key={m.path} className="flex justify-between gap-2">
                      <span className="truncate" title={m.path}>{m.path.split('/').slice(-2).join('/')}</span>
                      <span className="font-mono">{k(m.tokens)}</span>
                    </div>
                  ))}
                </>
              )}
              {usage.skills.length > 0 && (
                <>
                  <div className="mb-0.5 mt-1.5 text-[11px] uppercase tracking-wide text-muted">Skills</div>
                  {usage.skills.map((sk) => (
                    <div key={sk.name} className="flex justify-between">
                      <span>{sk.name}</span>
                      <span className="font-mono">{k(sk.tokens)}</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
          {/* session */}
          <div className="border-t border-border pt-2">
            <Row k="Engine" v={engineLabel} />
            <Row k="Model" v={model} />
            <CostModeControl workspaceId={workspaceId} spaceId={spaceId} mode={costMode} source={costModeSource} busy={busy} />
            {result && (
              <>
                <Row k="Session cost" v={`$${result.costUsd.toFixed(2)}`} />
                <Row k="Last turn" v={`${(result.durationMs / 1000).toFixed(1)}s · ${result.numTurns} step${result.numTurns === 1 ? '' : 's'}`} />
                {result.byModel && result.byModel.length > 0 && (
                  <div className="mt-1.5">
                    <div className="mb-0.5 text-[11px] uppercase tracking-wide text-muted">By model</div>
                    {result.byModel.map((m) => (
                      <div key={m.model} className="flex justify-between font-mono text-[11px]">
                        <span>{shortModel(m.model)}</span>
                        <span>
                          ${m.costUsd.toFixed(2)} · {k(m.outputTokens)} out
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="mt-2 border-t border-border pt-2 text-[11px] text-muted">Every message re-reads the whole context. Compact when a task is done, or start a new session for the next one. Costs are estimates at list price.</div>
        </div>
      )}
    </div>
  )
}
function Row({ k, v, warn }: { k: string; v: string; warn?: boolean }): React.JSX.Element {
  return (
    <div className="flex gap-2 py-0.5">
      <span className="w-[88px] shrink-0 text-muted">{k}</span>
      <span className={clsx('min-w-0 flex-1', warn && 'text-warn')}>{v}</span>
    </div>
  )
}

/** Near or past a subscription limit: what happened and the ways forward, each one click. */
function LimitCard({ workspaceId, ev }: { workspaceId: string; ev: Extract<AgentEvent, { type: 'limit' }> }): React.JSX.Element {
  const [busyChoice, setBusyChoice] = useState<string | null>(null)
  const setError = useApp((s) => s.setError)
  const pick = (a: LimitAlternative): void => {
    setBusyChoice(a.kind + (a.id ?? ''))
    void api.invoke('usage:resolveLimit', workspaceId, ev.itemId, a).catch((err) => {
      setBusyChoice(null)
      setError(friendlyError(err))
    })
  }
  return (
    <div role="alert" className={clsx('mb-2 rounded-xl border p-3 text-[12px]', ev.mode === 'hit' ? 'border-danger/40 bg-danger/10' : 'border-warn/40 bg-warn/10')}>
      <div className="mb-1 flex items-center gap-2 font-medium">
        <AlertTriangle size={14} className={ev.mode === 'hit' ? 'text-danger' : 'text-warn'} />
        {ev.mode === 'hit' ? 'Usage limit reached' : 'Low on usage'}
        {ev.utilization != null && ev.mode === 'preflight' && <span className="font-mono text-[11px] text-muted">{Math.round(ev.utilization * 100)}% used</span>}
      </div>
      <p className="mb-2 text-muted">{ev.text}</p>
      <div className="flex flex-wrap gap-1.5">
        {ev.alternatives.map((a) => (
          <button
            key={a.kind + (a.id ?? '')}
            disabled={busyChoice !== null}
            title={a.hint}
            onClick={() => pick(a)}
            className={clsx('rounded-md px-2 py-1 text-[11px]', a.kind === 'proceed' || (ev.mode === 'hit' && a.kind === 'account') ? 'bg-primary text-white hover:bg-primary-hover' : a.kind === 'cancel' ? 'text-muted hover:text-text' : 'border border-border hover:bg-panel-2', busyChoice === a.kind + (a.id ?? '') && 'opacity-60')}
          >
            {a.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/** A stored image in the transcript; click to open it full size in the default viewer. */
function ChatImage({ image }: { image: ChatImageRef }): React.JSX.Element {
  return (
    <button className="overflow-hidden rounded-lg border border-border bg-bg" title={`${image.name} · click to open`} onClick={() => void api.invoke('shell:openExternal', `file://${image.path}`)}>
      <img src={image.url} alt={image.name} className="max-h-[240px] max-w-[320px] object-contain" />
    </button>
  )
}

/** Who is doing what: the orchestrator, delegations in flight, and how many are done. */
function agentTypeOf(d: ChatToolBlock): string {
  const i = (d.input ?? {}) as Record<string, unknown>
  return typeof i.subagent_type === 'string' ? i.subagent_type : typeof i.description === 'string' ? i.description.slice(0, 30) : 'agent'
}

function CrewBar({ items, busy, model, crewNames }: { items: ChatItem[]; busy: boolean; model: string; crewNames: string[] }): React.JSX.Element | null {
  const [, setPanel] = usePanel()
  const openPanel = (id: string): void => setPanel({ kind: 'delegation', id })
  const delegations = items.flatMap((it) => (it.role === 'assistant' ? it.blocks.filter((b): b is ChatToolBlock => b.type === 'tool' && (b.name === 'Agent' || b.name === 'Task')) : []))
  const running = delegations.filter((d) => !d.done)
  const done = delegations.filter((d) => d.done).length
  if (!busy && delegations.length === 0 && crewNames.length === 0) return null
  const typeOf = agentTypeOf
  return (
    <div className="relative flex flex-wrap items-center gap-1.5 px-1 pb-2 text-[11px]">
      <span className={clsx('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5', busy ? 'border-accent/50 text-accent' : 'border-border text-muted')} title="The model you are talking to. It plans, delegates and integrates.">
        {busy && running.length === 0 ? <Spinner /> : <Users size={11} />}
        orchestrator <span className="font-mono opacity-70">{shortModel(model)}</span>
      </span>
      {running.map((d) => (
        <button key={d.toolUseId} onClick={() => openPanel(d.toolUseId)} className="inline-flex items-center gap-1.5 rounded-full border border-warn/50 bg-warn/10 px-2 py-0.5 text-warn hover:bg-warn/20" title="Click to watch this subagent">
          <Spinner /> {typeOf(d)}
          {d.sub?.model && <span className="font-mono opacity-70">{shortModel(d.sub.model)}</span>}
          {d.sub && <span className="opacity-70">{d.sub.toolCalls} calls{d.sub.lastTool ? ` · ${d.sub.lastTool}` : ''}</span>}
        </button>
      ))}
      <button data-tour="activity" onClick={() => setPanel({ kind: 'activity' })} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted hover:text-text" title="Activity: who did what in this session">
        <ListTree size={11} /> Activity{done > 0 ? ` · ${done} done` : ''}
      </button>
      {crewNames.length > 0 && running.length === 0 && (
        <span className="ml-auto text-muted" title="Crew available to the orchestrator this session">
          crew: {crewNames.join(', ')}
        </span>
      )}
    </div>
  )
}

function ForkDialog({ wsId, wsName, branch, onClose }: { wsId: string; wsName: string; branch: string; onClose: () => void }): React.JSX.Element {
  const [name, setName] = useState(`${wsName} fork`)
  const [busy, setBusy] = useState(false)
  const select = useApp((s) => s.select)
  const setError = useApp((s) => s.setError)
  const submit = async (): Promise<void> => {
    if (!name.trim()) return
    setBusy(true)
    try {
      const ws = await api.invoke('workspaces:fork', wsId, name.trim())
      select(ws.id)
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title="Fork this conversation" onClose={onClose} width={460}>
      <p className="mb-3 text-[12px] text-muted">
        Creates a new workspace with a worktree per repo, each on a new branch cut from <code className="rounded bg-panel-2 px-1">{branch}</code> as it is now, and a forked copy of the Claude session so the new chat keeps this context. Uncommitted changes stay here.
      </p>
      <Field label="New workspace name" hint="Also the new branch name.">
        <input autoFocus className={inputCls} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void submit()} />
      </Field>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim()}>
          <GitFork size={13} /> {busy ? 'Forking…' : 'Fork'}
        </Button>
      </div>
    </Dialog>
  )
}

function shortModel(m: string): string {
  return m.replace(/^claude-/, '').replace(/\[.*\]$/, '')
}

function SubagentSteps({ block, compact }: { block: ChatToolBlock; compact?: boolean }): React.JSX.Element {
  const steps = block.sub?.steps ?? []
  const input = (block.input ?? {}) as Record<string, unknown>
  const endRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!compact) endRef.current?.scrollIntoView({ block: 'end' })
  }, [steps.length, compact])
  return (
    <div className="flex flex-col gap-2 empty:hidden">
      {typeof input.prompt === 'string' && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Brief from the orchestrator</div>
          <div className={clsx('whitespace-pre-wrap rounded-md border border-border bg-bg p-2 text-[12px]', compact && 'max-h-32 overflow-auto')}>{input.prompt}</div>
        </div>
      )}
      <div>
        <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">
          Activity · {steps.filter((s) => s.kind === 'tool').length} tool call{steps.filter((s) => s.kind === 'tool').length === 1 ? '' : 's'}
          {!block.done && <span className="ml-2 inline-flex items-center gap-1 text-warn"><Spinner /> running</span>}
        </div>
        <div className={clsx('flex flex-col gap-0.5 rounded-md border border-border bg-bg p-2', compact && 'max-h-64 overflow-auto')}>
          {steps.length === 0 && <div className="text-[12px] text-muted">Waiting for the first step…</div>}
          {steps.map((s, i) =>
            s.kind === 'tool' ? (
              <div key={i} className="flex items-baseline gap-2 font-mono text-[11px]">
                <span className="shrink-0 text-accent">{s.name}</span>
                <span className="truncate text-muted" title={s.detail}>{s.detail}</span>
              </div>
            ) : (
              <div key={i} className="whitespace-pre-wrap py-0.5 text-[12px]">{s.detail}</div>
            )
          )}
          <div ref={endRef} />
        </div>
      </div>
      {block.done && block.result !== undefined && (
        <div>
          <div className="mb-1 text-[11px] uppercase tracking-wide text-muted">Result returned to the orchestrator</div>
          <div className={clsx('rounded-md border border-border bg-bg p-2', compact && 'max-h-48 overflow-auto')}>
            <Markdown text={block.result.slice(0, 20_000)} />
          </div>
        </div>
      )}
    </div>
  )
}

/** Per-actor summary and delegation history, or one delegation's live detail. */
function SubagentPanel({ items, model, workspaceId }: { items: ChatItem[]; model: string; workspaceId: string }): React.JSX.Element | null {
  const [view, setView] = usePanel()
  if (view.kind === 'closed') return null
  if (view.kind === 'notes') return <NotesPanel workspaceId={workspaceId} onClose={() => setView({ kind: 'closed' })} />
  const assistant = items.filter((it) => it.role === 'assistant')
  const allTools = assistant.flatMap((it) => it.blocks.filter((b): b is ChatToolBlock => b.type === 'tool'))
  const delegations = allTools.filter((b) => b.name === 'Agent' || b.name === 'Task')

  if (view.kind === 'delegation') {
    const block = delegations.find((b) => b.toolUseId === view.id)
    if (!block) return null
    return (
      <aside className="flex w-[440px] max-w-[55%] shrink-0 flex-col border-l border-border bg-panel">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <IconButton label="Back to activity" onClick={() => setView({ kind: 'activity' })}>
            <ArrowLeft size={14} />
          </IconButton>
          <Users size={14} className="text-accent" />
          <span className="text-[13px] font-semibold">{agentTypeOf(block)}</span>
          {block.sub?.model && <span className="rounded bg-panel-2 px-1 py-px font-mono text-[11px] text-muted">{shortModel(block.sub.model)}</span>}
          <span className="ml-auto text-[11px]">{block.done ? (block.isError ? <span className="text-danger">error</span> : <span className="text-ok">done</span>) : <span className="inline-flex items-center gap-1 text-warn"><Spinner /> running</span>}</span>
          {!block.done && <StopTaskButton workspaceId={workspaceId} toolUseId={block.toolUseId} />}
          <IconButton label="Close panel" className="ml-1" onClick={() => setView({ kind: 'closed' })}>
            <X size={14} />
          </IconButton>
        </div>
        <div className="flex-1 overflow-auto p-3">
          <SubagentSteps block={block} />
        </div>
      </aside>
    )
  }

  // ---- activity tree ----
  return (
    <aside className="flex w-[440px] max-w-[55%] shrink-0 flex-col border-l border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <ListTree size={14} className="text-accent" />
        <span className="text-[13px] font-semibold">Activity</span>
        <IconButton label="Close activity" className="ml-auto" onClick={() => setView({ kind: 'closed' })}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="flex-1 overflow-auto p-2">
        <ActivityTree items={items} model={model} onOpen={(id) => setView({ kind: 'delegation', id })} />
      </div>
    </aside>
  )
}

/** Stop one running subagent through the governor; shown when the task is known to it. */
function StopTaskButton({ workspaceId, toolUseId }: { workspaceId: string; toolUseId: string }): React.JSX.Element | null {
  const snap = useResources((s) => s.snapshot)
  useEffect(() => subscribeResources(), [])
  const task = snap?.sessions.find((s) => s.workspaceId === workspaceId)?.tasks.find((t) => t.toolUseId === toolUseId)
  if (!task) return null
  return (
    <button className="ml-2 inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-muted hover:border-danger hover:text-danger" title="Stop this subagent; the orchestrator is told it was stopped" onClick={() => api.invoke('resources:stopTask', workspaceId, task.taskId).catch(() => undefined)}>
      <Square size={10} /> Stop
    </button>
  )
}

/**
 * Orchestrator → agents → tasks → steps, each level collapsible. Active tasks
 * start expanded so their live steps are visible; finished ones start closed.
 */
function ActivityTree({ items, model, onOpen }: { items: ChatItem[]; model: string; onOpen: (id: string) => void }): React.JSX.Element {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const isOpen = (key: string, fallback: boolean): boolean => open[key] ?? fallback
  const toggle = (key: string, fallback: boolean): void => setOpen((o) => ({ ...o, [key]: !isOpen(key, fallback) }))

  const assistant = items.filter((it) => it.role === 'assistant')
  const allTools = assistant.flatMap((it) => it.blocks.filter((b): b is ChatToolBlock => b.type === 'tool'))
  const delegations = allTools.filter((b) => b.name === 'Agent' || b.name === 'Task')
  const own = allTools.filter((b) => !(b.name === 'Agent' || b.name === 'Task'))
  const thinking = assistant.reduce((n, it) => n + it.blocks.filter((b) => b.type === 'thinking').length, 0)
  const countBy = (names: string[]): [string, number][] => {
    const m = new Map<string, number>()
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1)
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }
  const byAgent = new Map<string, ChatToolBlock[]>()
  for (const d of delegations) byAgent.set(agentTypeOf(d), [...(byAgent.get(agentTypeOf(d)) ?? []), d])
  const descOf = (d: ChatToolBlock): string => {
    const i = (d.input ?? {}) as Record<string, unknown>
    return typeof i.description === 'string' ? i.description : 'task'
  }
  const Chevron = ({ on }: { on: boolean }): React.JSX.Element => <ChevronRight size={11} className={clsx('shrink-0 transition-transform', on && 'rotate-90')} />
  const Tags = ({ pairs }: { pairs: [string, number][] }): React.JSX.Element => (
    <div className="flex flex-wrap gap-1">
      {pairs.map(([n, c]) => (
        <span key={n} className="rounded bg-panel-2 px-1.5 py-px text-[11px] text-muted">
          {n.replace(/^mcp__/, '')} ×{c}
        </span>
      ))}
    </div>
  )

  const rootOpen = isOpen('root', true)
  return (
    <div className="text-[12px]">
      {/* root: orchestrator */}
      <button onClick={() => toggle('root', true)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-panel-2">
        <Chevron on={rootOpen} />
        <Users size={12} className="shrink-0 text-accent" />
        <span className="font-medium">orchestrator</span>
        <span className="font-mono text-[11px] text-muted">{shortModel(model)}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted">
          {assistant.length} turn{assistant.length === 1 ? '' : 's'} · think ×{thinking} · delegate ×{delegations.length}
        </span>
      </button>
      {rootOpen && (
        <div className="ml-3 border-l border-border pl-2">
          {own.length > 0 && (
            <div className="px-1.5 py-1">
              <Tags pairs={countBy(own.map((b) => b.name))} />
            </div>
          )}
          {byAgent.size === 0 && <div className="px-1.5 py-1 text-muted">No delegations yet in this session.</div>}
          {Array.from(byAgent.entries()).map(([name, list]) => {
            const key = `agent:${name}`
            const on = isOpen(key, true)
            const calls = list.reduce((n, d) => n + (d.sub?.toolCalls ?? 0), 0)
            const agentModel = list.find((d) => d.sub?.model)?.sub?.model
            const running = list.filter((d) => !d.done).length
            return (
              <div key={name}>
                <button onClick={() => toggle(key, true)} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-panel-2">
                  <Chevron on={on} />
                  <span className="font-medium">{name}</span>
                  {agentModel && <span className="font-mono text-[11px] text-muted">{shortModel(agentModel)}</span>}
                  <span className="ml-auto shrink-0 text-[11px] text-muted">
                    {list.length} task{list.length === 1 ? '' : 's'}
                    {running ? <span className="text-warn"> · {running} running</span> : ''} · {calls} calls
                  </span>
                </button>
                {on && (
                  <div className="ml-3 border-l border-border pl-2">
                    {list.map((d) => {
                      const tkey = `task:${d.toolUseId}`
                      const ton = isOpen(tkey, !d.done)
                      const steps = d.sub?.steps ?? []
                      const shown = ton ? steps.slice(-40) : []
                      return (
                        <div key={d.toolUseId}>
                          <div className="flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-panel-2">
                            <button onClick={() => toggle(tkey, !d.done)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
                              <Chevron on={ton} />
                              {d.done ? (
                                <span role="img" aria-label={d.isError ? 'Failed' : 'Done'} title={d.isError ? 'Failed' : 'Done'} className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', d.isError ? 'bg-danger' : 'bg-ok')} />
                              ) : (
                                <span role="img" aria-label="Running" title="Running" className="inline-flex">
                                  <Spinner />
                                </span>
                              )}
                              <span className="min-w-0 flex-1 truncate" title={descOf(d)}>
                                {descOf(d)}
                              </span>
                            </button>
                            <span className="shrink-0 text-[11px] text-muted">{d.sub?.toolCalls ?? 0} calls</span>
                            <button className="shrink-0 text-[11px] text-accent hover:underline" onClick={() => onOpen(d.toolUseId)} title="Open full detail">
                              open
                            </button>
                          </div>
                          {ton && (
                            <div className="ml-3 mb-1 border-l border-border pl-2">
                              {steps.length > shown.length && (
                                <button className="px-1.5 py-0.5 text-[11px] text-muted hover:text-text" onClick={() => onOpen(d.toolUseId)}>
                                  … {steps.length - shown.length} earlier steps, open detail to see all
                                </button>
                              )}
                              {shown.length === 0 && <div className="px-1.5 py-0.5 text-[11px] text-muted">{d.done ? 'No recorded steps.' : 'Waiting for the first step…'}</div>}
                              {shown.map((st, i) =>
                                st.kind === 'tool' ? (
                                  <div key={i} className="flex items-baseline gap-1.5 px-1.5 py-px font-mono text-[11px]">
                                    <span className="shrink-0 text-accent">{st.name}</span>
                                    <span className="truncate text-muted" title={st.detail}>
                                      {st.detail}
                                    </span>
                                  </div>
                                ) : (
                                  <div key={i} className="truncate px-1.5 py-px text-[11px] text-muted" title={st.detail}>
                                    “{st.detail}”
                                  </div>
                                )
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ToolCall({ block, defaultOpen = false }: { block: ChatToolBlock; defaultOpen?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen)
  const [, setPanel] = usePanel()
  const openPanel = (id: string): void => setPanel({ kind: 'delegation', id })
  const input = (block.input ?? {}) as Record<string, unknown>
  const isAgent = block.name === 'Agent' || block.name === 'Task'
  // Paths read relative to the open workspace: "shop-website/index.html", not the full folder on disk.
  const root = useApp((s) => s.workspaces.find((w) => w.id === s.selectedId)?.rootPath)
  const rawHeadline =
    typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : typeof input.pattern === 'string' ? input.pattern : typeof input.description === 'string' ? input.description : ''
  const headline = root ? rawHeadline.split(`${root}/`).join('').split(root).join('.') : rawHeadline
  const agentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent'
  return (
    <div className={clsx('rounded-md border text-[12px]', block.isError ? 'border-danger/40' : isAgent ? 'border-accent/40' : 'border-border')}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left hover:bg-panel">
        <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
        {isAgent ? (
          <>
            <Users size={12} className="shrink-0 text-accent" />
            <span className="font-medium text-accent">{agentType}</span>
            {block.sub?.model && <span className="rounded bg-panel-2 px-1 py-px font-mono text-[11px] text-muted">{shortModel(block.sub.model)}</span>}
            <span className="truncate text-muted">{headline}</span>
            <span className="ml-auto shrink-0 text-muted">
              {block.sub ? `${block.sub.toolCalls} tool call${block.sub.toolCalls === 1 ? '' : 's'}${!block.done && block.sub.lastTool ? ` · ${block.sub.lastTool}` : ''}` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="font-medium">{block.name}</span>
            <span className="truncate font-mono text-muted">{headline}</span>
          </>
        )}
        <span className="ml-2 shrink-0">{block.done ? (block.isError ? <span className="text-danger">error</span> : <span className="text-ok">done</span>) : <Spinner />}</span>
      </button>
      {open && isAgent && (
        <div className="border-t border-border px-2.5 py-2 text-[12px]">
          <button className="mb-2 text-accent hover:underline" onClick={() => openPanel(block.toolUseId)}>
            Open activity panel →
          </button>
          <SubagentSteps block={block} compact />
        </div>
      )}
      {open && !isAgent && (
        <div className="border-t border-border bg-bg px-2.5 py-2 font-mono text-[11px]">
          <div className="mb-1 text-muted">input</div>
          <pre className="mb-2 max-h-60 overflow-auto whitespace-pre-wrap">{JSON.stringify(block.input, null, 2)}</pre>
          {block.result !== undefined && (
            <>
              <div className="mb-1 text-muted">result</div>
              <pre className="max-h-80 overflow-auto whitespace-pre-wrap">{block.result.slice(0, 20_000)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Collapsible({ label, body, muted }: { label: string; body: string; muted?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={clsx('text-[12px]', muted && 'text-muted')}>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 hover:text-text">
        <ChevronRight size={12} className={clsx('transition-transform', open && 'rotate-90')} /> {label}
      </button>
      {open && <pre className="mt-1 whitespace-pre-wrap rounded-md border border-border bg-bg p-2 font-sans text-[12px]">{body}</pre>}
    </div>
  )
}

const NO_NOTES: never[] = []
