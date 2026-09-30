/**
 * Review: one inbox (redesign phase 5, docs/design/README.md). Pull requests, builder hand-offs and on-call
 * incidents in one list sorted by what waits on the person, with a pre-read and a risk level for every change.
 * Role: reviewer and on-call; lens: expert. The full pull request and incident lists (bulk reviews, filters,
 * earlier reviews, resolved incidents) stay one click away.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, ExternalLink, Send, FolderInput, Check, ListChecks, Siren, Sparkles, ChevronRight, ArrowLeft } from 'lucide-react'
import type { Incident } from '@shared/types'
import type { PreRead, RiskLevel } from '@shared/inbox'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useReviews, keyOf } from '@/stores/reviews'
import { useInbox, useInboxItems, matchesFilter, isPreRead, type ChangeItem, type InboxFilter, type InboxItem } from '@/stores/inbox'
import { yieldsToEditor } from '@/lib/keys'
import { useGuided } from '@/lib/guided'
import { friendlyError } from '@/lib/errors'
import { timeAgo } from '@/lib/format'
import { AccountPicker } from './AccountPicker'
import { PrDetail, ReviewCockpit } from './ReviewCockpit'
import { IncidentDetail, OnCallView } from './OnCallView'
import { ErrorNote } from './ErrorNote'
import { ConnectGitHubCard } from './ConnectGitHub'
import { Badge, Button, IconButton, Segmented, Spinner, hasOpenDialog, inputCls } from './ui'

const RISK: Record<RiskLevel, { label: string; tone: 'ok' | 'warn' | 'danger' }> = {
  low: { label: 'Low', tone: 'ok' },
  medium: { label: 'Medium', tone: 'warn' },
  high: { label: 'High', tone: 'danger' }
}
const SEV_TONE: Record<string, 'muted' | 'accent' | 'warn' | 'danger'> = { low: 'muted', medium: 'accent', high: 'warn', critical: 'danger' }

/** A request from the keyboard to the detail pane: focus the composer, take over, or ask to approve. */
type Command = { kind: 'note' | 'take' | 'approve' | 'focus'; n: number }

export function ReviewInbox(): React.JSX.Element {
  // Guided people have no Review in the rail; a link that still lands here gets a plain page, not the inbox.
  if (useGuided()) return <GuidedNotice />
  return <Inbox />
}

function GuidedNotice(): React.JSX.Element {
  const select = useApp((s) => s.select)
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-3 text-center">
      <p className="max-w-md text-[15px] text-muted">Reviews and incidents are handled by your team. Your own work is in your tasks.</p>
      <Button variant="primary" onClick={() => select(null)}>
        Go to your tasks
      </Button>
    </div>
  )
}

function Inbox(): React.JSX.Element {
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const space = useApp((s) => s.spaces.find((x) => x.id === s.activeSpaceId))
  const defaultAccount = useApp((s) => s.settings.defaultClaudeAccountId)
  const { filter: savedFilter, override, setFilter, selectedKey, select, boot, error: inboxError } = useInbox()
  const filter = override ?? savedFilter
  const loadingPrs = useReviews((s) => s.loadingPrs)
  const reviewsError = useReviews((s) => s.error)
  const batchError = useReviews((s) => s.batchError)
  const partial = useInbox((s) => s.partial)
  const items = useInboxItems()
  const [full, setFull] = useState<null | 'prs' | 'incidents'>(null)
  const [accountId, setAccountId] = useState(defaultAccount)
  const [command, setCommand] = useState<Command | null>(null)
  useEffect(() => setAccountId(space?.claudeAccountId ?? defaultAccount), [space?.claudeAccountId, defaultAccount])

  useEffect(() => {
    void boot()
  }, [boot, activeSpaceId])

  const counts = useMemo(() => {
    const c: Record<InboxFilter, number> = { all: items.length, reviews: 0, incidents: 0, mine: 0 }
    for (const i of items) {
      if (i.kind === 'change') c.reviews++
      else c.incidents++
      if (i.waiting) c.mine++
    }
    return c
  }, [items])
  const visible = useMemo(() => items.filter((i) => matchesFilter(i, filter)), [items, filter])
  const selected = visible.find((i) => i.key === selectedKey) ?? items.find((i) => i.key === selectedKey) ?? null
  // GitHub search returns at most 100 pull requests per query: say so instead of implying that is all of them.
  const capped = useReviews((s) => s.prs.length >= 100)
  const plus = capped ? '+' : ''

  // Open on the first thing that waits on the person (else the first item); focus stays where it is.
  useEffect(() => {
    if (full || selected || !visible.length) return
    select((visible.find((i) => i.waiting) ?? visible[0]).key)
  }, [full, selected, visible, select])

  // Pre-reads for what is on screen; cached in the main process, three at a time.
  const { preread, prereadWorkspace } = useInbox()
  // Once a minute, so pending checks and newer AI reviews are read again while the inbox stays open.
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000)
    return () => clearInterval(t)
  }, [])
  useEffect(() => {
    for (const i of visible) {
      if (i.kind !== 'change') continue
      if (i.pr) preread(i.pr)
      else if (i.ws) prereadWorkspace(i.ws.id)
    }
  }, [visible, preread, prereadWorkspace, tick])

  // Keyboard: J/K move, Enter opens the detail, A approve, N note back, T take over.
  const listRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({ visible, selected, full })
  stateRef.current = { visible, selected, full }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey || hasOpenDialog() || yieldsToEditor(e) || document.querySelector('[aria-modal="true"]')) return
      const target = e.target instanceof HTMLElement ? e.target : null
      if (target && (target.isContentEditable || target.closest('input, textarea, select, [role="menu"], [role="dialog"], [role="alertdialog"]'))) return
      const { visible: list, selected: cur, full: inList } = stateRef.current
      if (inList) return
      if (e.repeat && e.key.length === 1) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      const i = cur ? list.findIndex((x) => x.key === cur.key) : -1
      const move = (dir: 1 | -1): void => {
        e.preventDefault()
        if (!list.length) return
        const n = i < 0 ? (dir === 1 ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, i + dir))
        select(list[n].key)
        requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-inbox-row="${CSS.escape(list[n].key)}"]`)?.focus())
      }
      if (key === 'j' || key === 'ArrowDown') return move(1)
      if (key === 'k' || key === 'ArrowUp') return move(-1)
      if (!cur) return
      const send = (kind: Command['kind']): void => {
        e.preventDefault()
        setCommand((c) => ({ kind, n: (c?.n ?? 0) + 1 }))
      }
      if (key === 'Enter' && target?.closest('[data-inbox-row]')) send('focus')
      else if (cur.kind === 'change' && key === 'n') send('note')
      else if (cur.kind === 'change' && key === 't') send('take')
      else if (cur.kind === 'change' && key === 'a' && cur.pr) send('approve')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [select])

  if (full) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-panel px-3 text-[12px]">
          <Button size="sm" variant="ghost" onClick={() => setFull(null)}>
            <ArrowLeft size={12} /> Back to the inbox
          </Button>
          <span className="text-muted">{full === 'prs' ? 'Every pull request: bulk AI reviews, repository and status filters, earlier reviews.' : 'Every incident: resolved ones, channel filters and bulk actions.'}</span>
        </div>
        <div className="min-h-0 flex-1">{full === 'prs' ? <ReviewCockpit /> : <OnCallView />}</div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="text-[15px] font-semibold">Review</h1>
        {space && (
          <span className="flex items-center gap-1 text-[12px] text-muted">
            <span className="h-2 w-2 rounded-full" style={{ background: space.color }} /> {space.name}
          </span>
        )}
        <Segmented
          size="sm"
          className="no-drag"
          value={filter}
          onChange={setFilter}
          options={[
            { id: 'all', label: `All ${counts.all}${plus}` },
            { id: 'reviews', label: `Reviews ${counts.reviews}${plus}` },
            { id: 'incidents', label: <span data-tour="oncall">Incidents {counts.incidents}</span> },
            { id: 'mine', label: <span title="What waits on you: incidents that need you, reviews requested of you, hand-offs">Mine {counts.mine}</span> }
          ]}
        />
        <IconButton label="Refresh pull requests and hand-offs" onClick={() => void boot(true, true)} disabled={loadingPrs}>
          <RefreshCw size={13} className={clsx(loadingPrs && 'animate-spin')} />
        </IconButton>
        <span className="ml-auto" />
        <Button size="sm" variant="ghost" onClick={() => setFull('prs')} title="Every open pull request, with bulk AI reviews and filters">
          <ListChecks size={12} /> All pull requests
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setFull('incidents')} title="Every incident, including resolved ones, with bulk actions">
          <Siren size={12} /> All incidents
        </Button>
        <AccountPicker value={accountId} onChange={setAccountId} className="no-drag" always engine="claude-code" />
      </header>
      {inboxError && (
        <div className="border-b border-warn/30 bg-warn/10 px-4 py-2 text-[12px]" role="status">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-warn">{inboxError.text}</span>
            <Button size="sm" variant="ghost" disabled={loadingPrs} onClick={() => void boot(true, true)}>
              {loadingPrs ? <Spinner /> : <RefreshCw size={12} />} Try again
            </Button>
            {inboxError.detail && (
              <details className="w-full text-[11px] text-muted" data-expert-ok="">
                <summary className="w-fit cursor-pointer select-none hover:text-text">Show details</summary>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono">{inboxError.detail}</pre>
              </details>
            )}
          </div>
          {(inboxError.kind === 'gh-missing' || inboxError.kind === 'auth') && <ConnectGitHubCard className="mt-2 max-w-[560px]" reason="so the review inbox can list your team’s pull requests." onConnected={() => void boot(true, true)} />}
        </div>
      )}
      {reviewsError && !inboxError && (
        <div className="border-b border-danger/30 bg-danger/10 px-4 py-2">
          <ErrorNote summary="Pull requests could not be loaded. Refresh to try again." detail={reviewsError} />
        </div>
      )}
      {batchError && (
        <div className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2">
          <ErrorNote className="flex-1" summary="A bulk AI review could not start." detail={batchError} />
          <Button size="sm" variant="ghost" onClick={() => useReviews.setState({ batchError: undefined })}>
            Dismiss
          </Button>
        </div>
      )}
      {partial.length > 0 && !inboxError && (
        <div className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[11px] text-muted" role="status">
          Partly loaded: {partial.join(', ')} could not be read.
          <button className="text-accent hover:underline" onClick={() => void boot(true)}>
            Retry
          </button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[400px] shrink-0 flex-col border-r border-border bg-panel">
          <div ref={listRef} className="min-h-0 flex-1 space-y-1 overflow-auto p-2" role="listbox" aria-label="Review inbox">
            {visible.length === 0 && (
              <div className="p-3 text-[12px] text-muted">
                {loadingPrs && items.length === 0 ? 'Loading pull requests…' : filter === 'mine' ? 'Nothing is waiting on you.' : filter === 'incidents' ? 'No open incidents in this space.' : 'Nothing to review in this space.'}
              </div>
            )}
            {visible.map((i) => (
              <Row key={i.key} item={i} active={selected?.key === i.key} onSelect={() => select(i.key)} />
            ))}
          </div>
          {capped && (
            <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted">
              GitHub search returns at most 100 pull requests per query, so older ones may be missing here and in All pull requests. Narrow the space to fewer repositories or owners to see them.
            </div>
          )}
          <div className="shrink-0 border-t border-border px-3 py-1.5 text-[11px] text-muted" aria-label="Keyboard shortcuts">
            <Kbd>J</Kbd> <Kbd>K</Kbd> move · <Kbd>↵</Kbd> open · <Kbd>A</Kbd> approve · <Kbd>N</Kbd> note back · <Kbd>T</Kbd> take over
          </div>
        </aside>
        <div className="min-w-0 flex-1 overflow-hidden">
          {!selected ? (
            <div className="flex h-full items-center justify-center text-[13px] text-muted">{visible.length ? '' : 'Nothing here right now.'}</div>
          ) : selected.kind === 'incident' ? (
            <IncidentPane key={selected.key} inc={selected.inc} />
          ) : (
            <ChangeDetail key={selected.key} item={selected} accountId={accountId} command={command} />
          )}
        </div>
      </div>
    </div>
  )
}

function Kbd({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <kbd className="rounded border border-border px-1 font-sans text-[11px]">{children}</kbd>
}

function Row({ item, active, onSelect }: { item: InboxItem; active: boolean; onSelect: () => void }): React.JSX.Element {
  const pre = useInbox((s) => (item.kind === 'change' ? s.prereads[item.key] : undefined))
  const base = clsx('flex w-full flex-col gap-1 rounded-lg px-3 py-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent', active ? 'bg-panel-2 shadow-[inset_3px_0_0_var(--color-accent)]' : 'hover:bg-panel-2/60')
  if (item.kind === 'incident') {
    const inc = item.inc
    return (
      <button type="button" data-inbox-row={item.key} role="option" aria-selected={active} onClick={onSelect} className={clsx(base, !active && 'bg-danger/10')}>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          <Badge tone="danger">Incident</Badge>
          {inc.severity ? <Badge tone={SEV_TONE[inc.severity]}>{inc.severity}</Badge> : <Badge>{inc.status === 'triaging' ? 'triaging' : 'untriaged'}</Badge>}
          <span className="min-w-0 flex-1 truncate">#{inc.channelName}</span>
          <span className="shrink-0">{timeAgo(inc.updatedAt)}</span>
        </div>
        <div className="truncate text-[13px] font-semibold">{inc.title}</div>
        <div className="truncate text-[12px] text-muted">{inc.report?.summary ?? (inc.status === 'triaging' ? 'The on-call agent is triaging it.' : 'Not triaged yet.')}</div>
        {item.waiting && <span className="text-[11px] text-warn">Needs you</span>}
      </button>
    )
  }
  const p = isPreRead(pre) ? pre : null
  return (
    <button type="button" data-inbox-row={item.key} role="option" aria-selected={active} onClick={onSelect} className={base}>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="min-w-0 flex-1 truncate">{sourceLine(item)}</span>
        {p ? <Badge tone={RISK[p.risk].tone}>{RISK[p.risk].label} risk</Badge> : pre === 'loading' ? <Spinner /> : null}
      </div>
      <div className="truncate text-[13px] font-semibold">
        {item.title}
        {item.mark && item.updatedAfterNote && <span className="font-normal text-muted"> · updated after your {item.mark.state === 'approved' ? 'approval' : 'note'}</span>}
      </div>
      <div className="flex items-center gap-2 text-[12px] text-muted">
        <span className="min-w-0 flex-1 truncate">{p ? `${p.reasons[0]} · ${p.files} file${p.files === 1 ? '' : 's'}` : ''}</span>
        <span className="shrink-0 text-[11px]">{timeAgo(item.at)}</span>
      </div>
      <StatusWords item={item} />
    </button>
  )
}

function sourceLine(item: ChangeItem): string {
  const repo = item.pr ? `${item.pr.nameWithOwner.split('/')[1]}#${item.pr.number}` : item.ws ? item.ws.repos.map((r) => r.repoName).join(', ') : ''
  if (item.teammate) return `${item.teammate.user.name ?? item.teammate.user.login} · hand-off · ${repo}`
  if (item.handoff && item.ws) return `Sent for review on this Mac (${item.ws.name}) · ${repo}`
  if (item.pr) return `${item.pr.author} · ${repo}`
  return repo
}

function StatusWords({ item }: { item: ChangeItem }): React.JSX.Element | null {
  const words: { text: string; tone: string }[] = []
  if (item.mark && !item.updatedAfterNote) words.push(item.mark.state === 'approved' ? { text: 'Approved', tone: 'text-ok' } : { text: 'Changes requested', tone: 'text-muted' })
  if (item.pr?.isDraft) words.push({ text: 'Draft', tone: 'text-muted' })
  if (item.unseen) words.push({ text: 'AI review finished', tone: 'text-accent' })
  if (item.waiting) words.push({ text: item.requested ? 'Your review is requested' : 'Waiting on you', tone: 'text-warn' })
  if (!words.length) return null
  return (
    <div className="flex gap-2 text-[11px]">
      {words.map((w) => (
        <span key={w.text} className={w.tone}>
          {w.text}
        </span>
      ))}
    </div>
  )
}

function IncidentPane({ inc }: { inc: Incident }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const notify = useApp((s) => s.notify)
  const select = useInbox((s) => s.select)
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  const remove = (): void => {
    select(null)
    void go(() => api.invoke('oncall:remove', inc.id))
    notify({ kind: 'info', text: `Removed “${inc.title}”.`, undo: () => void go(async () => (await api.invoke('oncall:restore', inc), select(`inc:${inc.id}`))) })
  }
  return <IncidentDetail inc={inc} go={go} onRemove={remove} />
}

function ChangeDetail({ item, accountId, command }: { item: ChangeItem; accountId: string; command: Command | null }): React.JSX.Element {
  const pre = useInbox((s) => s.prereads[item.key])
  const { preread, prereadWorkspace, setMark } = useInbox()
  const run = useReviews((s) => s.runs[item.key])
  const startReview = useReviews((s) => s.startReview)
  // reviews:orgs lists the signed-in GitHub login first. GitHub refuses approving your own pull request.
  const me = useReviews((s) => s.orgs[0]?.toLowerCase() ?? '')
  const ownPr = Boolean(item.pr && me && item.pr.author.toLowerCase() === me)
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const openSettings = useApp((s) => s.openSettings)
  const [takeError, setTakeError] = useState<string | null>(null)
  const setError = useApp((s) => s.setError)
  const notify = useApp((s) => s.notify)
  const openWorkspace = useApp((s) => s.select)
  // The draft lives in the store, per item: a refresh, a re-sort or switching items never loses it.
  const note = useInbox((s) => s.drafts[item.key] ?? '')
  const setDraft = useInbox((s) => s.setDraft)
  const setNote = (text: string): void => setDraft(item.key, text)
  const [confirmTake, setConfirmTake] = useState(false)
  const [sending, setSending] = useState(false)
  const [taking, setTaking] = useState(false)
  const [confirmApprove, setConfirmApprove] = useState(false)
  const [approving, setApproving] = useState(false)
  const [showFiles, setShowFiles] = useState(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const focusAction = (name: string): void => rootRef.current?.querySelector<HTMLElement>(`[data-action="${name}"]`)?.focus()
  const p = isPreRead(pre) ? pre : null
  // Notes go to the agent when the change lives in a workspace on this Mac; otherwise to GitHub.
  const toConversation = Boolean(item.ws)

  // A local change just opens; an external PR becomes a new workspace, so it asks first (inline, one click).
  const askTakeOver = (): void => {
    if (item.ws) return openWorkspace(item.ws.id)
    if (!item.pr) return
    setConfirmTake(true)
    requestAnimationFrame(() => focusAction('take'))
  }
  const takeOver = async (): Promise<void> => {
    if (item.ws) return openWorkspace(item.ws.id)
    if (!item.pr) return
    setConfirmTake(false)
    setTaking(true)
    setTakeError(null)
    try {
      const ws = await api.invoke('inbox:takeOverPr', item.pr)
      openWorkspace(ws.id)
    } catch (err) {
      const text = friendlyError(err, 'The change could not be opened as a workspace.')
      // The repository is not on this Mac: say so next to a button to its Repositories page instead of a dead end.
      if (/is not on this Mac yet/.test(text)) setTakeError(text)
      else setError(text)
    } finally {
      setTaking(false)
    }
  }

  const sendNote = async (): Promise<void> => {
    const text = note.trim()
    if (!text) return
    setSending(true)
    try {
      if (item.ws) {
        const instruction = `A reviewer sent a note back on "${item.title}". Please make the change they ask for, check it works, and say when it is ready to send for review again.\n\nThe reviewer's note:\n${text}`
        await api.invoke('agent:send', item.ws.id, instruction)
        await setMark(item.key, { state: 'changes-requested', note: text, at: new Date().toISOString(), via: 'conversation', ...(p?.headSha ? { headSha: p.headSha } : {}) })
        notify({ kind: 'success', text: `Note sent to ${item.ws.name}. Marked as changes requested.` })
      } else if (item.pr) {
        await api.invoke('inbox:noteBackPr', item.pr, text)
        useInbox.setState({ marks: await api.invoke('inbox:marks') })
        notify({ kind: 'success', text: 'Note posted on GitHub. Marked as changes requested.', link: { label: 'Open', url: item.pr.url } })
      }
      setNote('')
    } catch (err) {
      setError(friendlyError(err, 'The note could not be sent.'))
    } finally {
      setSending(false)
    }
  }

  const approve = async (): Promise<void> => {
    if (!item.pr || !p?.headSha) return
    setApproving(true)
    try {
      await api.invoke('inbox:approvePr', item.pr, p.headSha)
      useInbox.setState({ marks: await api.invoke('inbox:marks') })
      notify({ kind: 'success', text: `Approved ${item.pr.nameWithOwner}#${item.pr.number} on GitHub.`, link: { label: 'Open', url: item.pr.url } })
      setConfirmApprove(false)
    } catch (err) {
      setError(friendlyError(err, 'GitHub did not accept the approval.'))
      // The PR may have moved on: read it again so the pre-read shows the new head.
      preread(item.pr, true)
    } finally {
      setApproving(false)
    }
  }

  // Keyboard commands from the list.
  const lastCommand = useRef(command?.n ?? 0)
  useEffect(() => {
    if (!command || command.n === lastCommand.current) return
    lastCommand.current = command.n
    if (command.kind === 'note') noteRef.current?.focus()
    else if (command.kind === 'take') askTakeOver()
    else if (command.kind === 'focus') focusAction('note')
    else if (command.kind === 'approve' && item.pr && !ownPr) {
      setConfirmApprove(true)
      requestAnimationFrame(() => focusAction('approve'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command])

  const meta = [
    item.teammate ? `by ${item.teammate.user.name ?? item.teammate.user.login}` : item.pr ? `by ${item.pr.author}` : item.ws ? `workspace ${item.ws.name}` : '',
    item.pr ? `${item.pr.nameWithOwner} #${item.pr.number}` : '',
    item.handoff ? `sent for review ${timeAgo(item.at)}` : `updated ${timeAgo(item.at)}`,
    p ? `${p.files} file${p.files === 1 ? '' : 's'}` : ''
  ].filter(Boolean)

  return (
    <div ref={rootRef} className="flex h-full flex-col">
      <div className="drag flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-[15px] font-semibold">{item.title}</h2>
            {item.pr && (
              <IconButton label="Open on GitHub" className="no-drag" onClick={() => void api.invoke('shell:openExternal', item.pr!.url)}>
                <ExternalLink size={13} />
              </IconButton>
            )}
          </div>
          <div className="truncate text-[12px] text-muted">{meta.join(' · ')}</div>
        </div>
        <Button data-action="note" className="no-drag" onClick={() => noteRef.current?.focus()} title="Write a note back (N)">
          <Send size={13} /> Send a note back
        </Button>
        <Button className="no-drag" onClick={askTakeOver} disabled={taking} title={item.ws ? 'Open the workspace this change lives in (T)' : 'Open the pull request branch as a workspace on this Mac (T)'}>
          {taking ? <Spinner /> : <FolderInput size={13} />} Take it over
        </Button>
        {item.pr && !ownPr && (
          <Button variant="primary" className="no-drag" onClick={() => setConfirmApprove(true)} disabled={approving || !p?.headSha} title={p?.headSha ? 'Approve on GitHub (A)' : pre && pre !== 'loading' && 'error' in pre ? 'The pre-read failed. Read the change again, then approve the commit you read.' : 'Waiting for the pre-read, so the approval is for the commit you read'}>
            <Check size={13} /> Approve
          </Button>
        )}
        {item.pr && ownPr && <span className="shrink-0 text-[12px] text-muted">Your own pull request: GitHub doesn’t let you approve it.</span>}
      </div>
      {confirmApprove && item.pr && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-ok/10 px-5 py-2 text-[12px]">
          <span className="mr-auto">
            Approve {item.pr.nameWithOwner}#{item.pr.number} on GitHub as you?{p && p.risk !== 'low' ? ` The pre-read rates it ${RISK[p.risk].label.toLowerCase()} risk.` : ''}
          </span>
          <Button data-action="approve" size="sm" variant="primary" onClick={() => void approve()} disabled={approving || !p?.headSha}>
            {approving ? <Spinner /> : <Check size={12} />} Approve on GitHub
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmApprove(false)}>
            Cancel
          </Button>
        </div>
      )}
      {takeError && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warn/10 px-5 py-2 text-[12px]">
          <span className="mr-auto">{takeError}</span>
          <Button size="sm" variant="primary" onClick={() => openSettings(activeSpaceId ? { scope: 'space', spaceId: activeSpaceId, page: 'repos' } : { scope: 'app', page: 'repos' })}>
            Add the repository
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setTakeError(null)}>
            Dismiss
          </Button>
        </div>
      )}
      {confirmTake && item.pr && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-panel-2 px-5 py-2 text-[12px]">
          <span className="mr-auto">
            Open <span className="font-mono">{p?.headRefName ?? 'the pull request branch'}</span> as a new workspace on this Mac, with the pull request's commits?
          </span>
          <Button data-action="take" size="sm" variant="primary" onClick={() => void takeOver()} disabled={taking}>
            {taking ? <Spinner /> : <FolderInput size={12} />} Take it over
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmTake(false)}>
            Cancel
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 px-5 pt-5">
          {item.mark && (
            <div className={clsx('rounded-lg border px-3 py-2 text-[12px]', item.updatedAfterNote ? 'border-warn/40 bg-warn/10' : 'border-border bg-panel')}>
              <div className="flex items-center gap-2">
                <span className="font-medium">{item.mark.state === 'approved' ? `You approved it ${timeAgo(item.mark.at)}.` : `You asked for changes ${timeAgo(item.mark.at)}${item.mark.via === 'conversation' ? ', in the builder’s conversation' : ', on GitHub'}.`}</span>
                {item.updatedAfterNote && <span className="text-warn">Updated since.</span>}
                <button className="ml-auto text-[11px] text-accent hover:underline" onClick={() => void setMark(item.key, null)}>
                  Clear
                </button>
              </div>
              {item.mark.note && <div className="mt-1 whitespace-pre-wrap text-muted">“{item.mark.note}”</div>}
            </div>
          )}

          <PreReadCard pre={pre} onRefresh={() => (item.pr ? preread(item.pr, true) : item.ws && prereadWorkspace(item.ws.id, true))} showFiles={showFiles} setShowFiles={setShowFiles} />

          <section className="rounded-xl border border-border bg-panel p-3">
            <label htmlFor="inbox-note" className="mb-2 block text-[12px] text-muted">
              {toConversation ? `Send a note back. It goes to the agent in ${item.ws!.name} as an instruction, and the change is marked as changes requested.` : 'Send a note back. There is no workspace for this change on this Mac, so it is posted on GitHub as a review asking for changes.'}
            </label>
            <div className="flex items-end gap-2">
              <textarea
                id="inbox-note"
                ref={noteRef}
                rows={2}
                className={clsx(inputCls, 'min-h-[40px]')}
                value={note}
                disabled={sending}
                placeholder="e.g. Keep the button 16px from the edges on phones"
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault()
                    void sendNote()
                  }
                  if (e.key === 'Escape') (e.target as HTMLTextAreaElement).blur()
                }}
              />
              <Button onClick={() => void sendNote()} disabled={sending || !note.trim()} title="Send the note (⌘↵)">
                {sending ? <Spinner /> : <Send size={12} />} {toConversation ? 'Send note' : 'Post on GitHub'}
              </Button>
            </div>
          </section>
        </div>
        {item.pr ? (
          <PrDetail
            pr={item.pr}
            run={run}
            onStart={() =>
              void startReview(item.pr!, accountId)
                .then(() => useReviews.getState().select(keyOf(item.pr!)))
                .catch((err) => setError(friendlyError(err)))
            }
          />
        ) : (
          <div className="mx-auto max-w-4xl p-5 text-[12px] text-muted">
            <Sparkles size={12} className="mr-1 inline" />
            This hand-off has no pull request yet, so there is no AI review. Take it over to see the diff in its workspace.
          </div>
        )}
      </div>
    </div>
  )
}

function PreReadCard({ pre, onRefresh, showFiles, setShowFiles }: { pre: PreRead | { error: string } | 'loading' | undefined; onRefresh: () => void; showFiles: boolean; setShowFiles: (v: boolean) => void }): React.JSX.Element {
  if (!pre || pre === 'loading') {
    return (
      <section className="flex items-center gap-2 rounded-xl border border-border bg-panel p-4 text-[12px] text-muted">
        <Spinner /> Reading the change…
      </section>
    )
  }
  if ('error' in pre) {
    return (
      <section className="rounded-xl border border-border bg-panel p-4">
        <ErrorNote summary="The pre-read could not be made." detail={pre.error} />
        <Button size="sm" className="mt-2" onClick={onRefresh}>
          Try again
        </Button>
      </section>
    )
  }
  const source = pre.summarySource === 'ai-review' ? 'from the AI review' : pre.summarySource === 'description' ? 'from the description' : 'worked out from the diff'
  const c = pre.checks
  const checks = c.passed + c.failed + c.pending === 0 ? 'No checks reported' : [c.failed ? `${c.failed} failing (${c.failedNames.slice(0, 3).join(', ')})` : '', c.pending ? `${c.pending} running` : '', c.passed ? `${c.passed} passing` : ''].filter(Boolean).join(' · ')
  return (
    <section className="rounded-xl border border-border bg-panel p-4" aria-label="Pre-read">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[13px] font-semibold">Pre-read</span>
        <span className="text-[11px] text-muted">rules on the diff, checks and AI findings · {timeAgo(pre.computedAt)}</span>
        <IconButton label="Read the change again" className="ml-auto" onClick={onRefresh}>
          <RefreshCw size={12} />
        </IconButton>
      </div>
      <dl className="grid grid-cols-[96px_1fr] gap-x-4 gap-y-2 text-[13px]">
        <dt className="text-muted">What</dt>
        <dd className="max-w-[72ch]">
          <span className="whitespace-pre-wrap">{pre.summary}</span> <span className="text-[11px] text-muted">({source})</span>
        </dd>
        <dt className="text-muted">Risk</dt>
        <dd>
          <Badge tone={RISK[pre.risk].tone}>{RISK[pre.risk].label}</Badge>
          <ul className="mt-1 list-disc pl-5 text-[12px] text-muted">
            {pre.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </dd>
        <dt className="text-muted">Checks</dt>
        <dd className={clsx('text-[12px]', c.failed ? 'text-danger' : 'text-muted')}>{checks}</dd>
        <dt className="text-muted">Size</dt>
        <dd className="text-[12px]">
          <button className="inline-flex items-center gap-1 text-left hover:underline" onClick={() => setShowFiles(!showFiles)} aria-expanded={showFiles}>
            <ChevronRight size={12} className={clsx('transition-transform', showFiles && 'rotate-90')} />
            {pre.files} file{pre.files === 1 ? '' : 's'}, <span className="text-ok">+{pre.additions}</span> <span className="text-danger">−{pre.deletions}</span>
            {pre.headRefName && (
              <span className="font-mono text-[11px] text-muted">
                {' '}
                · {pre.headRefName}
                {pre.baseRefName ? ` → ${pre.baseRefName}` : ''}
              </span>
            )}
          </button>
          {showFiles && (
            <ul className="mt-1 max-h-48 overflow-auto font-mono text-[11px] text-muted">
              {pre.paths.map((x) => (
                <li key={x} className="truncate">
                  {x}
                </li>
              ))}
            </ul>
          )}
        </dd>
      </dl>
    </section>
  )
}
