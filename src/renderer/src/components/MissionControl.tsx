/**
 * Mission control: Build's overview of the active space, sorted by who is waiting on whom (docs/design/README.md,
 * principle 2). Needs you first (prompts, questions, failures), then what is running, what is in review, and the
 * idle rest folded away. Rows answer in place where that is safe (Deny / Allow once); everything else opens the
 * workspace. Keyboard: J/K or ↓/↑ move, ↵ opens, A allows a focused permission once, R opens to answer.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Plus } from 'lucide-react'
import type { ChatToolBlock, PermissionRequest, QuestionRequest, Repo, Workspace } from '@shared/types'
import { useApp, spaceScope } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useGuided, useWords, cap, stageLabel } from '@/lib/guided'
import { repoLabel, workspaceLabel } from '@/lib/labels'
import { expertToolName, guidedStep, turnActivity, formatDuration, formatElapsed } from '@/lib/activity'
import { friendlyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { yieldsToEditor } from '@/lib/keys'
import { tokens } from '@/lib/theme'
import { Button, hasOpenDialog } from './ui'
import { STAGE_DOT } from './StagePicker'

type Tone = 'attn' | 'run' | 'ok' | 'idle'

type Row =
  | { key: string; kind: 'permission'; ws: Workspace; req: PermissionRequest; since?: number }
  | { key: string; kind: 'question'; ws: Workspace; req: QuestionRequest; since?: number }
  | { key: string; kind: 'error'; ws: Workspace; text: string }
  | { key: string; kind: 'running'; ws: Workspace; tool?: ChatToolBlock; startedAt: number | null }
  | { key: string; kind: 'review'; ws: Workspace }
  | { key: string; kind: 'idle'; ws: Workspace }

const kbdCls = 'rounded border border-border px-1 font-sans text-[11px] leading-4 text-muted'

/** Whether mission control (rather than the first-run empty page) is what Build shows with nothing open. */
export function useHasMissionControl(): boolean {
  return useApp((s) => spaceScope(s).inSpace.length > 0)
}

/** The workspaces whose prompts mission control lists: every live one, across spaces. */
function promptWorkspaces(s: Parameters<typeof spaceScope>[0]): Workspace[] {
  return spaceScope(s).live
}

/** Whether mission control lists the prompt the global PermissionPrompt would show, so the modal can step aside. */
export function useListsFirstPrompt(): boolean {
  const workspaceId = useChat((s) => s.permissions[0]?.workspaceId)
  return useApp((s) => Boolean(workspaceId && promptWorkspaces(s).some((w) => w.id === workspaceId)))
}

export function MissionControl(): React.JSX.Element {
  const guided = useGuided()
  const t = useWords()
  const spaces = useApp((s) => s.spaces)
  const workspaces = useApp((s) => s.workspaces)
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const pendingRemoval = useApp((s) => s.pendingRemoval)
  const select = useApp((s) => s.select)
  const setShowNewWorkspace = useApp((s) => s.setShowNewWorkspace)
  const chats = useChat((s) => s.chats)
  const permissions = useChat((s) => s.permissions)
  const questions = useChat((s) => s.questions)
  const promptSeenAt = useChat((s) => s.promptSeenAt)
  const answerPermission = useChat((s) => s.answerPermission)
  const [showIdle, setShowIdle] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const { currentId, inSpace } = useMemo(() => spaceScope({ spaces, workspaces, activeSpaceId, pendingRemoval }), [spaces, workspaces, activeSpaceId, pendingRemoval])
  const live = useMemo(() => promptWorkspaces({ spaces, workspaces, activeSpaceId, pendingRemoval }), [spaces, workspaces, activeSpaceId, pendingRemoval])
  const space = spaces.find((s) => s.id === currentId)
  const spaceName = space?.name ?? (spaces.length ? `No ${t.space}` : cap(t.workspaces))

  // Needs you spans every space (attention does not wait for a space switch); the rest is this space only.
  const liveById = useMemo(() => new Map(live.map((w) => [w.id, w])), [live])
  const needs: Row[] = []
  for (const req of permissions) {
    const ws = liveById.get(req.workspaceId)
    if (ws) needs.push({ key: `p:${req.requestId}`, kind: 'permission', ws, req, since: promptSeenAt[req.requestId] })
  }
  for (const req of questions) {
    const ws = liveById.get(req.workspaceId)
    if (ws) needs.push({ key: `q:${req.requestId}`, kind: 'question', ws, req, since: promptSeenAt[req.requestId] })
  }
  needs.sort((a, b) => ('since' in a && a.since ? a.since : 0) - ('since' in b && b.since ? b.since : 0))
  const prompted = new Set(needs.map((r) => r.ws.id))
  for (const ws of inSpace) {
    if (prompted.has(ws.id)) continue
    const c = chats[ws.id]
    const text = ws.status === 'error' ? (ws.error ?? '') : c?.error ? c.error : c && !c.busy && c.lastResult?.isError ? (c.lastResult.errorText ?? '') : undefined
    if (text !== undefined) needs.push({ key: `e:${ws.id}`, kind: 'error', ws, text })
  }
  const placed = new Set(needs.map((r) => r.ws.id))
  const byActivity = (a: Workspace, b: Workspace): number => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt)
  const running: Row[] = inSpace
    .filter((w) => !placed.has(w.id) && chats[w.id]?.busy)
    .map((ws) => {
      const act = turnActivity(chats[ws.id]?.items ?? [])
      return { key: `r:${ws.id}`, kind: 'running' as const, ws, tool: act.tools[act.tools.length - 1], startedAt: act.startedAt }
    })
  for (const r of running) placed.add(r.ws.id)
  const review: Row[] = inSpace.filter((w) => !placed.has(w.id) && w.stage === 'in-review').sort(byActivity).map((ws) => ({ key: `v:${ws.id}`, kind: 'review' as const, ws }))
  for (const r of review) placed.add(r.ws.id)
  const idle: Row[] = inSpace.filter((w) => !placed.has(w.id)).sort(byActivity).map((ws) => ({ key: `i:${ws.id}`, kind: 'idle' as const, ws }))

  const rows = [...needs, ...running, ...review, ...(showIdle ? idle : [])]
  const rowsRef = useRef(rows)
  rowsRef.current = rows

  // A clock for "waiting 3 min" and elapsed times, only while something is live.
  const [now, setNow] = useState(() => Date.now())
  const ticking = needs.some((r) => r.kind !== 'error') || running.length > 0
  useEffect(() => {
    if (!ticking) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [ticking])

  const open = (ws: Workspace): void => select(ws.id)
  const rowEl = (key: string): HTMLElement | null => rootRef.current?.querySelector<HTMLElement>(`[data-mc-row="${CSS.escape(key)}"] [data-mc-main]`) ?? null
  /** After a row answers and leaves, keep the keyboard where it was: the row that takes its place. */
  const answer = (row: Row, decision: 'allow' | 'deny'): void => {
    if (row.kind !== 'permission') return
    const list = rowsRef.current
    const i = list.findIndex((r) => r.key === row.key)
    const hadFocus = Boolean(rootRef.current?.querySelector(`[data-mc-row="${CSS.escape(row.key)}"]`)?.contains(document.activeElement))
    void answerPermission(row.req.requestId, decision).catch((err) => useApp.getState().setError(friendlyError(err)))
    if (!hadFocus) return
    requestAnimationFrame(() => {
      const after = rowsRef.current
      const next = after[Math.min(i, after.length - 1)]
      if (next) rowEl(next.key)?.focus()
    })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenDialog() || yieldsToEditor(e) || document.querySelector('[aria-modal="true"]')) return
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target && (target.isContentEditable || target.closest('input, textarea, select, [role="menu"], [role="dialog"], [role="alertdialog"]'))) return
      const root = rootRef.current
      if (!root) return
      // Keys act only from the list itself or from nowhere in particular (the page body), never from other lists.
      if (!(target && root.contains(target)) && target !== document.body) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      // A held letter must not repeat: allowing one prompt should never go on to allow the next.
      if (e.repeat && e.key.length === 1) return
      const list = rowsRef.current
      if (!list.length) return
      const current = (document.activeElement?.closest('[data-mc-row]') as HTMLElement | null)?.dataset.mcRow
      const i = current ? list.findIndex((r) => r.key === current) : -1
      const move = (dir: 1 | -1): void => {
        e.preventDefault()
        const n = i < 0 ? (dir === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir))
        rowEl(list[n].key)?.focus()
      }
      if (key === 'j' || key === 'ArrowDown') return move(1)
      if (key === 'k' || key === 'ArrowUp') return move(-1)
      if (i < 0) return
      const row = list[i]
      if (key === 'a' && row.kind === 'permission') {
        e.preventDefault()
        answer(row, 'allow')
      } else if (key === 'r' && (row.kind === 'question' || row.kind === 'permission' || row.kind === 'error')) {
        e.preventDefault()
        open(row.ws)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const waitingCount = new Set(needs.map((r) => r.ws.id)).size
  const summary = [
    `${inSpace.length} ${inSpace.length === 1 ? t.workspace : t.workspaces}`,
    running.length ? `${running.length} ${guided ? 'working' : 'running'}` : '',
    waitingCount ? `${waitingCount} waiting ${guided ? 'for' : 'on'} you` : ''
  ]
    .filter(Boolean)
    .join(' · ')

  const props = { guided, now, open, answer }
  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-6">
        <h1 className="text-[15px] font-semibold">{guided ? cap(t.workspaces) : 'Build'}</h1>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-muted">
          <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: space?.color ?? tokens.muted }} />
          <span className="truncate">{spaceName}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{summary}</span>
        </span>
        <Button variant="primary" size="sm" className="ml-auto" onClick={() => setShowNewWorkspace(true, currentId)}>
          <Plus size={13} />
          {t.newWorkspace}
          <kbd className="ml-1 rounded bg-black/30 px-1 font-sans text-[11px]">⇧⌘N</kbd>
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-5">
          {needs.length > 0 ? (
            <Section id="mc-needs" tone="attn" title={guided ? 'Waiting for you' : 'Needs you'} count={needs.length} hint={guided ? 'Oldest first. Nothing happens until you answer.' : 'Oldest first'}>
              {needs.map((r) => (
                <RowView key={r.key} row={r} {...props} showSpace={(r.ws.spaceId ?? '') !== currentId && spaces.length > 0} />
              ))}
            </Section>
          ) : (
            <p className={clsx('text-muted', guided ? 'text-[15px]' : 'text-[13px]')}>{guided ? 'Nothing is waiting for you right now.' : 'Nothing needs you right now.'}</p>
          )}
          {running.length > 0 && (
            <Section id="mc-running" tone="run" title={guided ? 'Working' : 'Running'} count={running.length} hint={guided ? 'Maestro is on it. Nothing to do.' : 'Live · nothing to do'}>
              {running.map((r) => (
                <RowView key={r.key} row={r} {...props} />
              ))}
            </Section>
          )}
          {review.length > 0 && (
            <Section id="mc-review" tone="ok" title={guided ? 'With a reviewer' : 'In review'} count={review.length} hint={guided ? stageLabel('in-review', true) : 'Waiting for review or ready to ship'}>
              {review.map((r) => (
                <RowView key={r.key} row={r} {...props} />
              ))}
            </Section>
          )}
          {idle.length > 0 && (
            <section aria-labelledby="mc-idle" className="flex flex-col gap-2">
              <button id="mc-idle" type="button" aria-expanded={showIdle} onClick={() => setShowIdle(!showIdle)} className="flex w-fit items-center gap-1.5 rounded-md text-[12px] text-muted hover:text-text">
                <ChevronRight size={12} className={clsx('transition-transform', showIdle && 'rotate-90')} />
                {idle.length} {guided ? `other ${idle.length === 1 ? t.workspace : t.workspaces}` : 'idle'} · <span className="text-accent">{showIdle ? 'Hide' : 'Show'}</span>
              </button>
              {showIdle && (
                <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">
                  {idle.map((r) => (
                    <RowView key={r.key} row={r} {...props} />
                  ))}
                </div>
              )}
            </section>
          )}
          {!guided && (
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted">
              <span>
                <kbd className={kbdCls}>J</kbd> <kbd className={kbdCls}>K</kbd> move
              </span>
              <span>
                <kbd className={kbdCls}>↵</kbd> open
              </span>
              <span>
                <kbd className={kbdCls}>A</kbd> allow once
              </span>
              <span>
                <kbd className={kbdCls}>R</kbd> answer
              </span>
              <span>
                <kbd className={kbdCls}>⌥⌘↑</kbd> <kbd className={kbdCls}>⌥⌘↓</kbd> step through {t.workspaces}
              </span>
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function Section({ id, tone, title, count, hint, children }: { id: string; tone: Tone; title: string; count: number; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h2 id={id}>
          <Pill tone={tone}>
            {title} <span className="tabular-nums opacity-80">{count}</span>
          </Pill>
        </h2>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-panel">{children}</div>
    </section>
  )
}

function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }): React.JSX.Element {
  return <span className={clsx('inline-flex h-5 items-center gap-1 rounded-full px-2 text-[11px] font-semibold', tone === 'attn' && 'bg-warn/15 text-warn', tone === 'run' && 'bg-accent/15 text-accent', tone === 'ok' && 'bg-ok/15 text-ok', tone === 'idle' && 'bg-panel-2 text-muted')}>{children}</span>
}

const chip = 'inline-flex h-[18px] shrink-0 items-center rounded bg-panel-2 px-1.5 text-[11px] text-muted'
const code = 'min-w-0 truncate rounded bg-bg px-1.5 font-mono text-[12px] text-text'

interface RowProps {
  row: Row
  guided: boolean
  now: number
  open: (ws: Workspace) => void
  answer: (row: Row, decision: 'allow' | 'deny') => void
  showSpace?: boolean
}

function RowView({ row, guided, now, open, answer, showSpace }: RowProps): React.JSX.Element {
  const ws = row.ws
  const repos = useApp((s) => s.repos)
  const name = workspaceLabel(ws, guided)
  const attn = row.kind === 'permission' || row.kind === 'question' || row.kind === 'error'
  const since = 'since' in row ? row.since : undefined
  const meta =
    row.kind === 'permission' || row.kind === 'question'
      ? since
        ? `waiting ${formatDuration(now - since)}`
        : ''
      : row.kind === 'error'
        ? `stopped ${timeAgo(ws.lastMessageAt ?? ws.createdAt)}`
        : row.kind === 'running'
          ? ''
          : `updated ${timeAgo(ws.lastMessageAt ?? ws.createdAt)}`

  const main = (
    <button
      type="button"
      data-mc-main
      onClick={() => open(ws)}
      aria-label={`${name}. ${rowSummaryText(row, guided, repos)}${meta ? `, ${meta}` : ''}`}
      className="flex min-w-0 flex-1 flex-col gap-1 rounded-md text-left focus-visible:outline-offset-4"
    >
      <span className="flex min-w-0 items-center gap-2">
        {row.kind === 'running' && <span aria-hidden className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />}
        {row.kind === 'idle' && <span aria-hidden className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', STAGE_DOT[ws.stage])} />}
        <span className={clsx('truncate font-semibold', guided ? 'text-[15px]' : 'text-[13px]')}>{name}</span>
        {showSpace && <SpaceChip spaceId={ws.spaceId} />}
        {!guided && (ws.jira || ws.linear) && <span className={clsx(chip, 'text-accent')}>{ws.jira?.key ?? ws.linear?.identifier}</span>}
        {!guided &&
          ws.repos.slice(0, 4).map((r) => (
            <span key={r.repoId} className={chip}>
              {r.repoName}
            </span>
          ))}
        {!guided && ws.repos.length > 4 && <span className="text-[11px] text-muted">+{ws.repos.length - 4}</span>}
        {meta && <span className="shrink-0 text-[11px] text-muted">{meta}</span>}
      </span>
      <RowDetail row={row} guided={guided} repos={repos} />
    </button>
  )

  return (
    <div data-mc-row={row.key} className={clsx('flex items-center gap-3 px-4 py-3 transition-colors hover:bg-panel-2/60 focus-within:bg-panel-2', attn ? 'focus-within:shadow-[inset_3px_0_0_var(--color-warn)]' : 'focus-within:shadow-[inset_3px_0_0_var(--color-accent)]')}>
      {main}
      {row.kind === 'running' && row.startedAt !== null && <span className="w-[88px] shrink-0 text-right font-mono text-[11px] text-muted tabular-nums">{formatElapsed(now - row.startedAt)}</span>}
      {row.kind === 'permission' && (
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" onClick={() => answer(row, 'deny')}>
            {guided ? 'No' : 'Deny'}
          </Button>
          <Button size="sm" variant="primary" onClick={() => answer(row, 'allow')}>
            {guided ? 'Go ahead' : 'Allow once'}
            {!guided && <kbd className="ml-1 rounded bg-black/30 px-1 font-sans text-[11px]">A</kbd>}
          </Button>
        </div>
      )}
      {row.kind === 'question' && (
        <Button size="sm" className="shrink-0" onClick={() => open(ws)}>
          Answer
          {!guided && <kbd className={clsx(kbdCls, 'ml-1')}>R</kbd>}
        </Button>
      )}
      {(row.kind === 'error' || row.kind === 'review') && (
        <Button size="sm" className="shrink-0" onClick={() => open(ws)}>
          Open
        </Button>
      )}
    </div>
  )
}

function SpaceChip({ spaceId }: { spaceId?: string }): React.JSX.Element | null {
  const sp = useApp((s) => s.spaces.find((x) => x.id === spaceId))
  if (!sp) return null
  return (
    <span className={clsx(chip, 'gap-1')}>
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: sp.color }} />
      {sp.name}
    </span>
  )
}

/** The second line of a row: what the workspace wants, or what it is doing. */
function RowDetail({ row, guided, repos }: { row: Row; guided: boolean; repos: Repo[] }): React.JSX.Element {
  const cls = clsx('flex min-w-0 items-center gap-1.5 text-muted', guided ? 'text-[15px]' : 'text-[12px]')
  if (row.kind === 'permission') {
    if (guided) return <span className={cls}>{guidedAsk(row.req, row.ws, repos)}</span>
    const { verb, target, where } = expertAsk(row.req, row.ws)
    return (
      <span className={cls}>
        <span className="shrink-0">{verb}</span>
        {target && <code className={code}>{target}</code>}
        {where && <span className="shrink-0">{where}</span>}
      </span>
    )
  }
  if (row.kind === 'question') {
    const q = row.req.questions[0]?.question ?? ''
    const more = row.req.questions.length - 1
    return (
      <span className={cls}>
        <span className="truncate">
          {guided ? 'Maestro asks: ' : 'Asks: '}“{q}”{more > 0 ? ` and ${more} more` : ''}
        </span>
      </span>
    )
  }
  if (row.kind === 'error') {
    return (
      <span className={cls}>
        <span className="inline-flex h-[18px] shrink-0 items-center rounded-full bg-danger/15 px-2 text-[11px] font-semibold text-danger">{guided ? 'Stopped' : 'Failed'}</span>
        {guided ? (
          <span className="truncate">{row.text ? friendlyError(row.text, 'Something went wrong. Open it to see what happened.', true) : 'Something went wrong. Open it to see what happened.'}</span>
        ) : (
          <span className="truncate" title={row.text}>
            {firstLine(row.text) || 'The last turn ended with an error.'}
          </span>
        )}
      </span>
    )
  }
  if (row.kind === 'running') {
    if (guided) return <span className={cls}>{row.tool ? `${guidedStep(row.tool)}…` : 'Working on it…'}</span>
    if (!row.tool) return <span className={cls}>Thinking…</span>
    const head = toolHeadline(row.tool, row.ws)
    return (
      <span className={cls}>
        <span className="shrink-0">{expertToolName(row.tool)}</span>
        {head && <code className={code}>{head}</code>}
      </span>
    )
  }
  if (row.kind === 'review') {
    const branch = row.ws.repos[0]?.branch
    return <span className={cls}>{guided ? 'A reviewer is looking at it.' : branch ? <code className={code}>{branch}</code> : 'In review'}</span>
  }
  return <span className={cls}>{stageLabel(row.ws.stage, guided)}</span>
}

/** Plain text of a row's second line, for its accessible name. */
function rowSummaryText(row: Row, guided: boolean, repos: Repo[]): string {
  if (row.kind === 'permission') {
    if (guided) return guidedAsk(row.req, row.ws, repos)
    const { verb, target, where } = expertAsk(row.req, row.ws)
    return [verb, target, where].filter(Boolean).join(' ')
  }
  if (row.kind === 'question') return `${guided ? 'Maestro asks' : 'Asks'}: ${row.req.questions[0]?.question ?? ''}`
  if (row.kind === 'error') return guided ? 'Stopped: something went wrong' : 'Failed'
  if (row.kind === 'running') return guided ? (row.tool ? guidedStep(row.tool) : 'Working on it') : row.tool ? `Running ${expertToolName(row.tool)}` : 'Thinking'
  return stageLabel(row.ws.stage, guided)
}

const firstLine = (s: string): string => s.split('\n').find((l) => l.trim())?.trim() ?? ''
const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** A path as an expert reads it in a row: relative to the worktree it sits in, plus which repository that is. */
function relPath(p: string, ws: Workspace): { path: string; repo?: string } {
  const r = ws.repos.find((x) => x.worktreePath && (p === x.worktreePath || p.startsWith(x.worktreePath + '/')))
  if (r) return { path: p.slice(r.worktreePath.length + 1) || '.', repo: r.repoName }
  if (ws.rootPath && p.startsWith(ws.rootPath + '/')) return { path: p.slice(ws.rootPath.length + 1) }
  return { path: p }
}

/** Expert: "Wants to run `pnpm db:migrate`", "Wants to use Edit on `src/x.ts` in api". */
function expertAsk(req: PermissionRequest, ws: Workspace): { verb: string; target?: string; where?: string } {
  const input = (req.input ?? {}) as Record<string, unknown>
  const outside = req.blockedPath ? 'outside the workspace' : undefined
  if (typeof input.command === 'string') return { verb: 'Wants to run', target: clip(firstLine(input.command)), where: outside }
  const file = typeof input.file_path === 'string' ? input.file_path : typeof input.notebook_path === 'string' ? input.notebook_path : typeof input.path === 'string' ? input.path : null
  const tool = expertToolName({ name: req.toolName, input })
  if (file) {
    const { path, repo } = relPath(file, ws)
    return { verb: `Wants to use ${tool} on`, target: clip(path), where: outside ?? (repo ? `in ${repo}` : undefined) }
  }
  const other = typeof input.url === 'string' ? input.url : typeof input.pattern === 'string' ? input.pattern : typeof input.query === 'string' ? input.query : null
  return { verb: 'Wants to use', target: other ? `${tool} ${clip(other, 70)}` : tool, where: outside }
}

/** Guided: the same request in plain words, never a path or a command (the phrasing of PermissionPrompt). */
function guidedAsk(req: PermissionRequest, ws: Workspace, repos: Repo[]): string {
  const input = (req.input ?? {}) as Record<string, unknown>
  if (req.blockedPath) return 'Maestro wants to change something outside this task.'
  const filePath = typeof input.file_path === 'string' ? input.file_path : null
  if (!filePath) return 'Maestro wants to run something that needs your OK.'
  const r = ws.repos.find((x) => x.worktreePath && filePath.startsWith(x.worktreePath + '/'))
  const app = r ? repoLabel(repos.find((x) => x.id === r.repoId)) || r.repoName : undefined
  return `Maestro wants to change ${filePath.slice(filePath.lastIndexOf('/') + 1)}${app ? ` in ${app}` : ''}.`
}

/** A short headline for the tool call a running workspace is on: the command, the file, the search. */
function toolHeadline(block: ChatToolBlock, ws: Workspace): string {
  const input = (block.input ?? {}) as Record<string, unknown>
  const str = (k: string): string | null => (typeof input[k] === 'string' && (input[k] as string).trim() ? (input[k] as string) : null)
  const file = str('file_path') ?? str('notebook_path')
  if (str('command')) return clip(firstLine(str('command')!))
  if (file) return clip(relPath(file, ws).path)
  const v = str('description') ?? str('pattern') ?? str('url') ?? str('query') ?? str('path') ?? str('prompt')
  return v ? clip(firstLine(v), 70) : ''
}
