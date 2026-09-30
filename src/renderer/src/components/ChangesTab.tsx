import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, MessageSquareText, Undo2, FolderTree, GitCompare, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { parseUnifiedDiff, type DiffFile } from '@/lib/diff'
import { friendlyError } from '@/lib/errors'
import { useApp, type Tab } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useGithub } from '@/stores/github'
import { useReviews } from '@/stores/reviews'
import { openMaestro } from '@/stores/maestro'
import { DiffView, type ViewMode } from './ChangesPane'
import { FilesPane } from './FilesPane'
import { Button, Dialog, IconButton, Segmented, Spinner } from './ui'
import { useChangesLive } from './WorkspaceTabs'
import { notReadyText } from './ChatPane'
import { useGuided } from '@/lib/guided'
import type { ChangeScope, ChangedFileStat, ReviewFinding } from '@shared/types'

/** One changed file: its repository and its numstat line (+/− counts, git status letter). */
interface Changed {
  repoId: string
  repoName: string
  worktreePath: string
  stat: ChangedFileStat
}
interface Loaded {
  scope: ChangeScope
  files: Changed[]
  at: number
}

/** The file picked in each workspace, so switching tabs or workspaces comes back to it. */
const picked = new Map<string, string>()
/** The scope picked in each workspace, for this session. */
const scopes = new Map<string, ChangeScope>()
/** Reviewer findings dismissed here (this session): they stay in the review, just not on this diff. */
const dismissed = new Set<string>()
const keyOf = (c: Pick<Changed, 'repoId' | 'stat'>): string => `${c.repoId}:${c.stat.path}`
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

const readView = (): ViewMode => {
  try {
    return (localStorage.getItem('sinfonie.changesView') as ViewMode) || 'unified'
  } catch {
    return 'unified'
  }
}

/** +12 −3, or "binary" / "new" when git has no line counts. */
function Counts({ stat }: { stat: ChangedFileStat }): React.JSX.Element {
  if (stat.binary) return <span className="text-muted">binary</span>
  return (
    <>
      {stat.adds === null ? <span className="text-ok">new</span> : stat.adds > 0 && <span className="text-ok">+{stat.adds}</span>}
      {(stat.dels ?? 0) > 0 && <span className="ml-1 text-danger">−{stat.dels}</span>}
    </>
  )
}
const countsText = (stat: ChangedFileStat): string => (stat.binary ? 'binary' : `${stat.adds === null ? 'new' : `+${stat.adds}`}${stat.dels ? ` −${stat.dels}` : ''}`)

/**
 * The Changes tab: every changed file grouped by repository with its +/− counts, either the uncommitted work or
 * the whole branch (against its merge-base with the base branch), and the selected file's diff with "Ask about
 * this" (Maestro, with the workspace as context) and "Revert file". Reviewer findings from an AI review of this
 * branch's pull request sit on the line they are about, in the whole-branch view. "All files" behind it is the full
 * tree and editor, with commit, push and pull request.
 */
export function ChangesTab({ workspaceId, tab, visible }: { workspaceId: string; tab: Tab; visible: boolean }): React.JSX.Element {
  const setTab = useApp((s) => s.setTab)
  const view = tab === 'code' ? 'files' : 'changes'
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-border px-2">
        <Segmented
          size="sm"
          value={view}
          onChange={(v) => setTab(v === 'files' ? 'code' : 'changes')}
          options={[
            { id: 'changes', label: <span className="inline-flex items-center gap-1"><GitCompare size={11} aria-hidden /> Changed</span> },
            { id: 'files', label: <span className="inline-flex items-center gap-1"><FolderTree size={11} aria-hidden /> All files</span> }
          ]}
        />
      </div>
      <div className="min-h-0 flex-1">{view === 'files' ? <FilesPane workspaceId={workspaceId} /> : <ChangedFiles workspaceId={workspaceId} visible={visible} />}</div>
    </div>
  )
}

function ChangedFiles({ workspaceId, visible }: { workspaceId: string; visible: boolean }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const setError = useApp((s) => s.setError)
  const notify = useApp((s) => s.notify)
  const agentBusy = useChat((s) => s.chats[workspaceId]?.busy ?? false)
  const guided = useGuided()
  const [data, setData] = useState<Loaded | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState<string | null>(null)
  const [scope, setScopeState] = useState<ChangeScope | null>(() => scopes.get(workspaceId) ?? null)
  const [sel, setSel] = useState<string | null>(() => picked.get(workspaceId) ?? null)
  const [mode, setMode] = useState<ViewMode>(readView)
  const [revert, setRevert] = useState<Changed | null>(null)
  const [diff, setDiff] = useState<{ key: string; scope: ChangeScope; file: DiffFile | null } | null>(null)
  const [, bump] = useState(0)
  const ready = ws?.status === 'ready'
  const repoKey = ws?.repos.map((r) => r.repoId).join(',') ?? ''
  const setScope = (v: ChangeScope): void => {
    scopes.set(workspaceId, v)
    setScopeState(v)
  }

  // One load at a time, and only the newest may land: a slow answer never overwrites a newer one.
  const seq = useRef(0)
  const inFlight = useRef(false)
  const load = useCallback(
    async (force = false): Promise<void> => {
      const w = useApp.getState().workspaces.find((x) => x.id === workspaceId)
      if (!w || w.status !== 'ready' || (inFlight.current && !force)) return
      const mine = ++seq.current
      inFlight.current = true
      setLoading(true)
      try {
        const listOf = async (sc: ChangeScope): Promise<Changed[]> => {
          const out: Changed[] = []
          for (const r of w.repos) {
            const res = await api.invoke('git:changes', workspaceId, r.repoId, sc)
            for (const stat of res.files) out.push({ repoId: r.repoId, repoName: r.repoName, worktreePath: r.worktreePath, stat })
          }
          return out
        }
        // First visit: uncommitted work when there is some, else the whole branch.
        let sc = scopes.get(workspaceId) ?? null
        let files: Changed[]
        if (sc) files = await listOf(sc)
        else {
          files = await listOf('uncommitted')
          sc = files.length ? 'uncommitted' : 'branch'
          if (sc === 'branch') files = await listOf('branch')
          scopes.set(workspaceId, sc)
          if (mine === seq.current) setScopeState(sc)
        }
        if (mine !== seq.current) return
        setData({ scope: sc, files, at: Date.now() })
        setFailed(null)
      } catch (err) {
        if (mine === seq.current) setFailed(friendlyError(err, 'The changes could not be read.'))
      } finally {
        if (mine === seq.current) {
          inFlight.current = false
          setLoading(false)
        }
      }
    },
    [workspaceId]
  )

  // Live while on screen and the window is visible: every few seconds while the agent works, else every half minute.
  useEffect(() => {
    if (!visible || !ready) return
    void load(true)
    const t = setInterval(() => !document.hidden && void load(), agentBusy ? 5_000 : 30_000)
    const onVisible = (): void => void (!document.hidden && load())
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [visible, ready, agentBusy, load, repoKey, scope])

  const files = useMemo(() => (data && data.scope === scope ? data.files : []), [data, scope])
  // The tab's count follows this list while it is on screen, instead of a second poller.
  useEffect(() => {
    if (data) useChangesLive.setState({ [workspaceId]: data.files.length })
  }, [data, workspaceId])
  useEffect(
    () => () =>
      useChangesLive.setState((s) => {
        const next = { ...s }
        delete next[workspaceId]
        return next
      }, true),
    [workspaceId]
  )

  const groups = useMemo(() => {
    const m = new Map<string, { repoName: string; files: Changed[] }>()
    for (const f of files) {
      const g = m.get(f.repoId) ?? { repoName: f.repoName, files: [] }
      g.files.push(f)
      m.set(f.repoId, g)
    }
    return [...m.entries()]
  }, [files])
  const current = files.find((f) => keyOf(f) === sel) ?? files[0] ?? null
  const currentKey = current ? keyOf(current) : null
  const pick = (c: Changed): void => {
    picked.set(workspaceId, keyOf(c))
    setSel(keyOf(c))
  }

  // Only the selected file's diff is fetched: one git process, however many files changed.
  const diffSeq = useRef(0)
  const [diffError, setDiffError] = useState<{ key: string; message: string } | null>(null)
  const [diffTry, setDiffTry] = useState(0)
  useEffect(() => {
    if (!current || !scope || !data) return
    const mine = ++diffSeq.current
    const key = keyOf(current)
    api
      .invoke('git:fileDiff', workspaceId, current.repoId, current.stat.path, scope)
      .then((raw) => {
        if (mine !== diffSeq.current) return
        setDiff({ key, scope, file: parseUnifiedDiff(raw)[0] ?? null })
        setDiffError(null)
      })
      // Shown in place of the diff, with Try again, instead of "Reading the diff…" forever.
      .catch((err) => mine === diffSeq.current && setDiffError({ key, message: friendlyError(err, 'The diff could not be read.') }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, currentKey, scope, data?.at, diffTry])
  const shownDiff = diff && diff.key === currentKey && diff.scope === scope ? diff.file : undefined

  const findings = useFindings(workspaceId, current, scope === 'branch')

  // ↑/↓ in the list move the selection, like the file tree.
  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    e.preventDefault()
    const i = current ? files.indexOf(current) : -1
    const next = files[Math.max(0, Math.min(files.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
    if (!next) return
    pick(next)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-change="${CSS.escape(keyOf(next))}"]`)?.focus())
  }

  const ask = (c: Changed): void => {
    const prompt = `About ${c.repoName}/${c.stat.path} in this workspace (${countsText(c.stat)}): `
    void openMaestro({ context: { workspaceId, ...(ws?.spaceId ? { spaceId: ws.spaceId } : {}), screen: 'build' }, prompt }).catch((err) => setError(friendlyError(err)))
  }

  const doRevert = async (c: Changed): Promise<void> => {
    try {
      const { saved, hash } = await api.invoke('git:restoreFile', workspaceId, c.repoId, c.stat.path)
      void load(true)
      notify({
        kind: 'info',
        text: `Reverted ${baseName(c.stat.path)} to its last commit.`,
        undo: () =>
          void api
            .invoke('git:undoRestore', workspaceId, c.repoId, c.stat.path, saved, hash)
            .then(() => load(true))
            .catch(() => setError(`Could not undo the revert of ${baseName(c.stat.path)}: the file changed after it was reverted, so it was left as it is.`))
      })
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  if (!ws) return <div />
  if (!ready)
    return (
      <div role="status" className="flex flex-col gap-1 p-4 text-[12px] text-muted">
        <span>{notReadyText(ws, guided)}</span>
        <span>{guided ? 'Changes show here once the task is ready.' : 'Changes show here once the workspace is ready.'}</span>
      </div>
    )

  const scopeSwitch = (
    <Segmented
      size="sm"
      value={scope ?? 'uncommitted'}
      onChange={(v) => {
        setScope(v)
        setDiff(null)
      }}
      options={[
        { id: 'uncommitted', label: 'Uncommitted' },
        { id: 'branch', label: 'Whole branch' }
      ]}
    />
  )
  const refresh = (
    <IconButton label="Refresh the changes" onClick={() => void load(true)}>
      <RefreshCw size={12} className={clsx(loading && 'animate-spin')} />
    </IconButton>
  )

  if (!data || data.scope !== scope) {
    return (
      <div className="flex flex-col">
        {(scope || failed) && (
          <div className="flex items-center gap-2 border-b border-border px-2 py-1">
            {scope && scopeSwitch}
            <span className="ml-auto" />
            {refresh}
          </div>
        )}
        <div className="flex items-center gap-2 p-4 text-[12px] text-muted">
          {failed ? (
            <>
              <span role="alert" className="min-w-0 flex-1 text-danger">
                {failed}
              </span>
              <Button size="sm" onClick={() => void load(true)} disabled={loading}>
                <RefreshCw size={12} className={clsx(loading && 'animate-spin')} aria-hidden /> Try again
              </Button>
            </>
          ) : (
            <>
              <Spinner /> Reading the changes…
            </>
          )}
        </div>
      </div>
    )
  }
  if (files.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-2 border-b border-border px-2 py-1">
          {scopeSwitch}
          <span className="ml-auto" />
          {refresh}
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <GitCompare size={22} className="text-muted" aria-hidden />
          <p className="max-w-[40ch] text-[13px] text-muted">
            {scope === 'uncommitted' ? 'Nothing uncommitted. Everything so far is committed; see it under Whole branch.' : 'No changes on this branch yet. The agent’s edits show here, file by file, as they happen.'}
          </p>
          <div className="flex gap-2">
            {scope === 'uncommitted' && <Button size="sm" onClick={() => setScope('branch')}>Show the whole branch</Button>}
            <Button size="sm" variant="ghost" onClick={() => useApp.getState().setTab('code')}>
              <FolderTree size={12} /> Browse all files
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // Revert puts a file back to HEAD, so it is offered for uncommitted changes to tracked files only.
  const revertable = (c: Changed): boolean => scope === 'uncommitted' && c.stat.status === 'M' && !c.stat.binary
  const visibleFindings = findings.filter((f) => !dismissed.has(f.id))
  const onLine = new Map<number, ReviewFinding[]>()
  const offLine: ReviewFinding[] = []
  const newLines = new Set(shownDiff?.lines.map((l) => l.newNo).filter((n): n is number => n !== undefined))
  for (const f of visibleFindings) {
    if (mode === 'unified' && f.line !== null && newLines.has(f.line)) onLine.set(f.line, [...(onLine.get(f.line) ?? []), f])
    else offLine.push(f)
  }
  const fix = (f: ReviewFinding): void => {
    const where = `${current ? `${current.repoName}/${current.stat.path}` : f.path}${f.line ? `:${f.line}` : ''}`
    void useChat.getState().send(workspaceId, `Fix this review finding in ${where}: ${f.title}\n\n${f.body}${f.suggestion ? `\n\nSuggested change:\n\n\`\`\`\n${f.suggestion}\n\`\`\`` : ''}`)
    dismissed.add(f.id)
    bump((n) => n + 1)
  }
  const dismiss = (f: ReviewFinding): void => {
    dismissed.add(f.id)
    bump((n) => n + 1)
    notify({
      kind: 'info',
      text: 'Finding hidden here. It stays in the review.',
      undo: () => {
        dismissed.delete(f.id)
        bump((n) => n + 1)
      }
    })
  }
  const card = (f: ReviewFinding): React.ReactNode => <FindingCard key={f.id} finding={f} onFix={() => fix(f)} onDismiss={() => dismiss(f)} />

  return (
    // A size container: under 620px the file list becomes a picker above a full-width diff, and the file actions icons.
    <div className="@container flex h-full min-w-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-2 py-1">
        {scopeSwitch}
        <Segmented
          size="sm"
          value={mode}
          onChange={(m) => {
            setMode(m)
            try {
              localStorage.setItem('sinfonie.changesView', m)
            } catch {
              /* remembered for this session only */
            }
          }}
          options={[
            { id: 'unified', label: 'Unified' },
            { id: 'split', label: 'Split' },
            { id: 'file', label: 'File' }
          ]}
        />
        {failed ? (
          <span role="alert" className="ml-auto min-w-0 truncate text-[11px] text-danger" title={failed}>
            {failed}
          </span>
        ) : (
          <span className="ml-auto text-[11px] text-muted">{loading ? 'Updating…' : 'Updates live'}</span>
        )}
        {refresh}
      </div>
      <div className="flex min-h-0 flex-1">
        <div role="listbox" aria-label="Changed files" className="flex w-[38%] min-w-[150px] max-w-[240px] shrink-0 flex-col gap-px overflow-auto border-r border-border p-1.5 text-[12px] @max-[620px]:hidden" onKeyDown={onListKey}>
          {groups.map(([repoId, g]) => (
            <div key={repoId} role="group" aria-label={g.repoName} className="mb-1.5">
              <div className="flex items-center gap-1 px-1.5 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted">
                <span className="truncate">{g.repoName}</span>
                <span aria-hidden>·</span>
                <span className="tabular-nums">{g.files.length}</span>
              </div>
              {g.files.map((c) => {
                const on = current === c
                return (
                  <button
                    key={keyOf(c)}
                    role="option"
                    aria-selected={on}
                    tabIndex={on ? 0 : -1}
                    data-change={keyOf(c)}
                    onClick={() => pick(c)}
                    title={`${c.stat.path}${c.stat.status === '?' ? ' (new file)' : ''}`}
                    className={clsx('flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left', on ? 'bg-panel-2 text-text' : 'text-muted hover:bg-panel-2/60 hover:text-text')}
                  >
                    <span className="min-w-0 flex-1 truncate">{baseName(c.stat.path)}</span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      <Counts stat={c.stat} />
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
        </div>
        {current && (
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
              {/* Narrow panel: a picker in place of the list, grouped by repository. */}
              <label className="hidden min-w-0 flex-1 @max-[620px]:flex">
                <span className="sr-only">Changed file</span>
                <select
                  className="w-full min-w-0 truncate rounded-md border border-border bg-bg px-2 py-1 font-mono text-[12px] outline-none focus:border-accent"
                  value={keyOf(current)}
                  onChange={(e) => {
                    const c = files.find((f) => keyOf(f) === e.target.value)
                    if (c) pick(c)
                  }}
                >
                  {groups.map(([repoId, g]) => (
                    <optgroup key={repoId} label={`${g.repoName} · ${g.files.length}`}>
                      {g.files.map((c) => (
                        <option key={keyOf(c)} value={keyOf(c)}>
                          {/* The closed picker shows only this text, so it names the repository too. */}
                          {groups.length > 1 ? `${g.repoName}/` : ''}{c.stat.path} ({countsText(c.stat)})
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] @max-[620px]:hidden" title={`${current.repoName}/${current.stat.path}`}>
                <span className="text-muted">{current.repoName}/{dirName(current.stat.path) && `${dirName(current.stat.path)}/`}</span>
                {baseName(current.stat.path)}
              </span>
              <Button size="sm" variant="ghost" className="shrink-0" onClick={() => ask(current)} aria-label="Ask about this" title="Ask Maestro about this file, with this workspace as context">
                <MessageSquareText size={12} aria-hidden /> <span className="@max-[620px]:hidden">Ask about this</span>
              </Button>
              {revertable(current) && (
                <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setRevert(current)} aria-label="Revert file" title="Revert file: put it back to its last commit; you can undo it right after">
                  <Undo2 size={12} aria-hidden /> <span className="@max-[620px]:hidden">Revert file</span>
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {offLine.length > 0 && <div className="flex flex-col gap-2 border-b border-border p-2">{offLine.map(card)}</div>}
              {shownDiff === undefined && diffError && diffError.key === currentKey ? (
                <div className="flex items-center gap-2 p-3 text-[12px]">
                  <span role="alert" className="min-w-0 flex-1 text-danger">
                    {diffError.message}
                  </span>
                  <Button size="sm" onClick={() => setDiffTry((n) => n + 1)}>
                    <RefreshCw size={12} aria-hidden /> Try again
                  </Button>
                </div>
              ) : shownDiff === undefined ? (
                <div className="flex items-center gap-2 p-3 text-[12px] text-muted">
                  <Spinner /> Reading the diff…
                </div>
              ) : shownDiff === null ? (
                <div className="p-3 text-[12px] text-muted">{current.stat.binary ? 'Binary file: no line diff to show.' : 'No line changes to show for this file.'}</div>
              ) : (
                <DiffView file={shownDiff} view={mode} workspaceId={workspaceId} worktreePath={current.worktreePath} annotate={onLine.size ? (n) => onLine.get(n)?.map(card) : undefined} />
              )}
            </div>
          </div>
        )}
      </div>
      {revert && (
        <Dialog title={`Revert ${baseName(revert.stat.path)}?`} onClose={() => setRevert(null)} width={440}>
          <p className="mb-4 text-[13px] text-muted">
            Puts <code className="rounded bg-panel-2 px-1 font-mono text-[12px]">{revert.repoName}/{revert.stat.path}</code> back to its last commit ({countsText(revert.stat)}), staged changes included. Other files stay as they are, and you can undo it right after.
          </p>
          <div className="flex justify-end gap-2">
            <Button onClick={() => setRevert(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                const c = revert
                setRevert(null)
                void doRevert(c)
              }}
            >
              <Undo2 size={12} /> Revert file
            </Button>
          </div>
        </Dialog>
      )}
    </div>
  )
}

/**
 * Findings from an AI review of this workspace's pull request for the selected file, when one ran. Findings that
 * a fix round already addressed are left out.
 */
function useFindings(workspaceId: string, current: Changed | null, enabled: boolean): ReviewFinding[] {
  const prs = useGithub((s) => s.byWorkspace[workspaceId]?.repos)
  const runs = useReviews((s) => s.runs)
  useEffect(() => {
    useReviews.getState().subscribe()
    if (Object.keys(useReviews.getState().runs).length) return
    void api
      .invoke('reviews:runs')
      .then((list) => useReviews.setState((s) => ({ runs: { ...Object.fromEntries(list.map((r) => [r.key, r])), ...s.runs } })))
      .catch(() => undefined)
  }, [])
  return useMemo(() => {
    // Findings point at lines of the pull request's head, so they only line up with the whole-branch diff.
    if (!current || !enabled) return []
    const repo = prs?.find((r) => r.repoId === current.repoId)
    if (!repo?.pr || !repo.nameWithOwner) return []
    const run = runs[`${repo.nameWithOwner}#${repo.pr.number}`]
    return (run?.findings ?? []).filter((f) => f.path === current.stat.path && !f.addressedRound)
  }, [prs, runs, current, enabled])
}

const SEVERITY_TONE: Record<ReviewFinding['severity'], string> = { critical: 'text-danger', major: 'text-warn', minor: 'text-muted', nit: 'text-muted' }

function FindingCard({ finding, onFix, onDismiss }: { finding: ReviewFinding; onFix: () => void; onDismiss: () => void }): React.JSX.Element {
  return (
    <div className="max-w-[72ch] rounded-lg border border-border bg-panel-2 px-3 py-2 font-sans text-[12px] leading-normal">
      <div className="flex items-center gap-2">
        <Sparkles size={12} className="shrink-0 text-accent" aria-hidden />
        <span className="font-semibold text-text">Reviewer</span>
        <span className={clsx('text-[11px]', SEVERITY_TONE[finding.severity])}>{finding.severity}</span>
        {finding.line !== null && <span className="text-[11px] text-muted">on line {finding.line}</span>}
      </div>
      <div className="mt-1 font-medium text-text">{finding.title}</div>
      {finding.body && <div className="mt-0.5 whitespace-pre-wrap text-muted">{finding.body}</div>}
      <div className="mt-2 flex gap-1.5">
        <Button size="sm" onClick={onFix} title="Ask the agent in this workspace to fix it">
          Fix it
        </Button>
        <Button size="sm" variant="ghost" onClick={onDismiss} title="Hide it here; it stays in the review">
          Dismiss
        </Button>
      </div>
    </div>
  )
}
