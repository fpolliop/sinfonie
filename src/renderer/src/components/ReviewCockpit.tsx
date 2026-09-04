import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, ExternalLink, Play, Square, Trash2, Send, CheckSquare, Square as SquareIcon, Sparkles, ChevronRight, ArrowDownWideNarrow, ArrowUpNarrowWide, Filter } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useReviews, keyOf, STATUS_FILTERS, type StatusFilter } from '@/stores/reviews'
import { AccountPicker } from './AccountPicker'
import { Badge, Button, Spinner, inputCls } from './ui'
import { timeAgo } from '@/lib/format'
import type { ReviewFinding, ReviewPr, ReviewRun, ReviewSeverity, ReviewVerdict } from '@shared/types'

const SEV_TONE: Record<ReviewSeverity, 'danger' | 'warn' | 'accent' | 'muted'> = { critical: 'danger', major: 'warn', minor: 'accent', nit: 'muted' }

export function ReviewCockpit(): React.JSX.Element {
  const { owners, mode, prs, runs, selectedKey, loadingOrgs, loadingPrs, error, init, useSpace, setMode, refreshPrs, select, repoFilter, statusFilter, sortDir, setRepoFilter, setStatusFilter, setSortDir } = useReviews()
  const defaultAccount = useApp((s) => s.settings.defaultClaudeAccountId)
  const spaces = useApp((s) => s.spaces)
  const activeSpaceId = useApp((s) => s.activeSpaceId)
  const space = spaces.find((s) => s.id === activeSpaceId)
  const configuredOwners = space?.githubOwners
  const openSettings = useApp((s) => s.openSettings)
  const setOpenSpaceSettings = (v: boolean): void => {
    if (v && space) openSettings({ scope: 'space', spaceId: space.id, page: 'github' })
  }
  const setError = useApp((s) => s.setError)
  const [accountId, setAccountId] = useState(defaultAccount)

  useEffect(() => {
    void init()
  }, [init])

  // Follow the sidebar's space: its owners drive the PR list; its account is the review default.
  const ownersKey = (configuredOwners ?? []).join(',')
  useEffect(() => {
    if (loadingOrgs) return
    void useSpace(space?.id ?? '', configuredOwners)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [space?.id, ownersKey, loadingOrgs])
  useEffect(() => {
    setAccountId(space?.claudeAccountId ?? defaultAccount)
  }, [space?.id, space?.claudeAccountId, defaultAccount])

  const repos = useMemo(() => Array.from(new Set(prs.map((p) => p.nameWithOwner))).sort(), [prs])

  const matchesStatus = (pr: ReviewPr, f: StatusFilter): boolean => {
    const run = runs[keyOf(pr)]
    switch (f) {
      case 'all':
        return true
      case 'ready':
        return !pr.isDraft
      case 'draft':
        return pr.isDraft
      case 'unreviewed':
        return !run || run.status === 'cancelled'
      case 'running':
        return run?.status === 'preparing' || run?.status === 'running'
      case 'reviewed':
        return run?.status === 'done'
      case 'submitted':
        return run?.status === 'submitted'
      case 'failed':
        return run?.status === 'error'
    }
  }

  const filtered = useMemo(() => {
    const list = prs.filter((p) => (!repoFilter || p.nameWithOwner === repoFilter) && matchesStatus(p, statusFilter))
    list.sort((a, b) => (sortDir === 'desc' ? b.updatedAt.localeCompare(a.updatedAt) : a.updatedAt.localeCompare(b.updatedAt)))
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prs, runs, repoFilter, statusFilter, sortDir])

  const grouped = useMemo(() => {
    const m = new Map<string, ReviewPr[]>()
    for (const p of filtered) m.set(p.nameWithOwner, [...(m.get(p.nameWithOwner) ?? []), p])
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [filtered])

  const selectedPr = prs.find((p) => keyOf(p) === selectedKey) ?? runs[selectedKey ?? '']?.pr
  const selectedRun = selectedKey ? runs[selectedKey] : undefined

  const start = async (pr: ReviewPr): Promise<void> => {
    try {
      await api.invoke('reviews:start', pr, accountId)
      select(keyOf(pr))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <h1 className="text-[14px] font-semibold">Review cockpit</h1>
        <button className="no-drag inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] hover:bg-panel-2" title="Space settings: pick the GitHub orgs this space reviews" onClick={() => space && setOpenSpaceSettings(true)}>
          <span className="h-2 w-2 rounded-full" style={{ background: space?.color ?? '#8b93a1' }} />
          {space?.name ?? 'All'}
          <span className="text-muted">· {owners.length ? owners.join(', ') : loadingOrgs ? '…' : 'no owners'}</span>
        </button>
        <div className="no-drag flex rounded-md bg-panel p-0.5">
          {(['requested', 'all'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={clsx('rounded px-2.5 py-0.5 text-[12px]', mode === m ? 'bg-panel-2' : 'text-muted')}>
              {m === 'requested' ? 'Waiting on me' : 'All open'}
            </button>
          ))}
        </div>
        <Button size="sm" variant="ghost" onClick={() => void refreshPrs()} disabled={loadingPrs}>
          <RefreshCw size={13} className={clsx(loadingPrs && 'animate-spin')} />
        </Button>
        <span className="ml-auto" />
        <AccountPicker value={accountId} onChange={setAccountId} className="no-drag" always engine="claude-code" />
      </header>
      {error && <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">{error}</div>}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <Filter size={13} className="text-muted" />
        <select className="max-w-[240px] rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} title="Repository">
          <option value="">All repositories{repos.length ? ` (${repos.length})` : ''}</option>
          {repos.map((r) => (
            <option key={r} value={r}>
              {r.split('/')[1]}
            </option>
          ))}
        </select>
        <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)} title="Status">
          {STATUS_FILTERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <button
          onClick={() => setSortDir(sortDir === 'desc' ? 'asc' : 'desc')}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-bg px-2 py-1 text-[12px] hover:bg-panel-2"
          title={sortDir === 'desc' ? 'Newest first. Click for oldest first.' : 'Oldest first. Click for newest first.'}
        >
          {sortDir === 'desc' ? <ArrowDownWideNarrow size={13} /> : <ArrowUpNarrowWide size={13} />} Updated {sortDir === 'desc' ? 'newest' : 'oldest'} first
        </button>
        <span className="ml-auto text-[11px] text-muted">
          {filtered.length} of {prs.length}
        </span>
        {(repoFilter || statusFilter !== 'all') && (
          <button
            className="text-[11px] text-accent hover:underline"
            onClick={() => {
              setRepoFilter('')
              setStatusFilter('all')
            }}
          >
            Clear
          </button>
        )}
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-[360px] shrink-0 overflow-auto border-r border-border">
          {loadingPrs && prs.length === 0 && <div className="p-4 text-[12px] text-muted">Loading pull requests…</div>}
          {!loadingPrs && prs.length === 0 && (
            <div className="p-4 text-[12px] text-muted">
              {owners.length === 0 ? 'This space has no GitHub owners yet. Add repositories to it, or pick orgs in the space settings.' : mode === 'requested' ? `No pull requests in ${owners.join(', ')} are waiting for your review.` : `No open pull requests in ${owners.join(', ')}.`}
            </div>
          )}
          {!loadingPrs && prs.length > 0 && filtered.length === 0 && <div className="p-4 text-[12px] text-muted">Nothing matches the current filters.</div>}
          {grouped.map(([repo, list]) => (
            <div key={repo}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                {repo.split('/')[1]} <span className="normal-case text-muted/70">{list.length}</span>
              </div>
              {list.map((pr) => {
                const k = keyOf(pr)
                const run = runs[k]
                return (
                  <button key={k} onClick={() => select(k)} className={clsx('flex w-full flex-col gap-0.5 border-b border-border px-3 py-2 text-left', selectedKey === k ? 'bg-panel-2' : 'hover:bg-panel')}>
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{pr.title}</span>
                      <span className="ml-auto shrink-0">
                        <RunBadge run={run} />
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-muted">
                      #{pr.number} · {pr.author} · {timeAgo(pr.updatedAt)}
                      {pr.isDraft && <Badge>draft</Badge>}
                    </div>
                  </button>
                )
              })}
            </div>
          ))}
          {Object.values(runs).filter((r) => !prs.some((p) => keyOf(p) === r.key)).length > 0 && (
            <div>
              <div className="sticky top-0 z-10 border-b border-border bg-panel px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">Earlier reviews</div>
              {Object.values(runs)
                .filter((r) => !prs.some((p) => keyOf(p) === r.key))
                .map((r) => (
                  <button key={r.key} onClick={() => select(r.key)} className={clsx('flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left', selectedKey === r.key ? 'bg-panel-2' : 'hover:bg-panel')}>
                    <span className="truncate text-[12px]">{r.pr.title}</span>
                    <span className="ml-auto shrink-0">
                      <RunBadge run={r} />
                    </span>
                  </button>
                ))}
            </div>
          )}
        </aside>
        <div className="min-w-0 flex-1 overflow-auto">
          {!selectedPr ? (
            <div className="flex h-full items-center justify-center text-muted">Pick a pull request.</div>
          ) : (
            <PrDetail pr={selectedPr} run={selectedRun} onStart={() => start(selectedPr)} />
          )}
        </div>
      </div>
    </div>
  )
}

function RunBadge({ run }: { run?: ReviewRun }): React.JSX.Element | null {
  if (!run) return null
  if (run.status === 'preparing' || run.status === 'running') return <Spinner />
  if (run.status === 'submitted') return <Badge tone="ok">submitted</Badge>
  if (run.status === 'error') return <Badge tone="danger">failed</Badge>
  if (run.status === 'cancelled') return <Badge>cancelled</Badge>
  const crit = run.findings.filter((f) => f.severity === 'critical' || f.severity === 'major').length
  return <Badge tone={crit ? 'warn' : 'accent'}>{run.findings.length} finding{run.findings.length === 1 ? '' : 's'}</Badge>
}

function PrDetail({ pr, run, onStart }: { pr: ReviewPr; run?: ReviewRun; onStart: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [submitting, setSubmitting] = useState(false)
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const busy = run?.status === 'preparing' || run?.status === 'running'
  const approvedCount = run?.findings.filter((f) => f.approved).length ?? 0
  const allApproved = run ? run.findings.length > 0 && approvedCount === run.findings.length : false

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-5">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">{pr.title}</h2>
          <button className="text-muted hover:text-text" onClick={() => void api.invoke('shell:openExternal', pr.url)} title="Open on GitHub">
            <ExternalLink size={13} />
          </button>
        </div>
        <div className="text-[12px] text-muted">
          {pr.nameWithOwner} #{pr.number} · by {pr.author} · updated {timeAgo(pr.updatedAt)}
          {run?.baseRefName && (
            <>
              {' '}
              · {run.headRefName} → {run.baseRefName}
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!busy && (
          <Button variant="primary" onClick={onStart}>
            <Sparkles size={13} /> {run ? 'Run AI review again' : 'Run AI review'}
          </Button>
        )}
        {busy && (
          <Button variant="danger" onClick={() => act(() => api.invoke('reviews:cancel', run!.key))}>
            <Square size={12} /> Cancel
          </Button>
        )}
        {run && !busy && (
          <Button variant="ghost" onClick={() => act(() => api.invoke('reviews:discard', run.key))}>
            <Trash2 size={13} /> Discard
          </Button>
        )}
        {run && (
          <span className="text-[12px] text-muted">
            {busy && <Spinner />} {busy ? run.phase : run.status === 'done' ? `Done · ${run.phase} · $${(run.costUsd ?? 0).toFixed(2)} · ${timeAgo(run.finishedAt)}` : run.status === 'error' ? `Failed: ${run.error}` : run.status}
          </span>
        )}
        {run?.submittedUrl && (
          <button className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', run.submittedUrl!)}>
            View submitted review <ExternalLink size={11} />
          </button>
        )}
      </div>

      {run && run.status !== 'preparing' && run.status !== 'running' && run.status !== 'error' && (
        <>
          <VerdictEditor run={run} disabled={run.status === 'submitted'} />
          <section>
            <div className="mb-2 flex items-center gap-2">
              <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">
                Findings · {approvedCount}/{run.findings.length} approved
              </h3>
              {run.findings.length > 0 && run.status !== 'submitted' && (
                <Button size="sm" variant="ghost" className="ml-auto" onClick={() => act(() => api.invoke('reviews:setAll', run.key, !allApproved))}>
                  {allApproved ? <SquareIcon size={13} /> : <CheckSquare size={13} />} {allApproved ? 'Unapprove all' : 'Approve all'}
                </Button>
              )}
            </div>
            {run.findings.length === 0 && <div className="rounded-md border border-border p-3 text-[12px] text-muted">No findings. The review found nothing worth commenting on.</div>}
            <div className="flex flex-col gap-2">
              {run.findings.map((f) => (
                <FindingCard key={f.id} runKey={run.key} finding={f} readOnly={run.status === 'submitted'} />
              ))}
            </div>
          </section>
          {run.status !== 'submitted' && (
            <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-bg py-3">
              <span className="text-[12px] text-muted">
                Posts one GitHub review: the verdict as the body, the {approvedCount} approved finding{approvedCount === 1 ? '' : 's'} as inline comments.
              </span>
              <Button
                variant="primary"
                className="ml-auto"
                disabled={submitting || !run.verdict}
                onClick={async () => {
                  setSubmitting(true)
                  await act(() => api.invoke('reviews:submit', run.key))
                  setSubmitting(false)
                }}
              >
                <Send size={13} /> {submitting ? 'Submitting…' : `Submit ${run.verdict?.decision === 'approve' ? 'approval' : run.verdict?.decision === 'request_changes' ? 'changes requested' : 'review'}`}
              </Button>
            </div>
          )}
        </>
      )}
      {run?.status === 'running' && (
        <div className="rounded-md border border-border p-4 text-[12px] text-muted">
          Reading the diff and the surrounding code. Findings appear here when the review finishes.
        </div>
      )}
    </div>
  )
}

function VerdictEditor({ run, disabled }: { run: ReviewRun; disabled: boolean }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [v, setV] = useState<ReviewVerdict>(run.verdict ?? { decision: 'comment', summary: '' })
  useEffect(() => setV(run.verdict ?? { decision: 'comment', summary: '' }), [run.key, run.verdict])
  const save = (next: ReviewVerdict): void => {
    setV(next)
    api.invoke('reviews:setVerdict', run.key, next).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <section className="rounded-xl border border-border bg-panel p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">Verdict</h3>
        <div className="ml-auto flex rounded-md bg-bg p-0.5">
          {(
            [
              ['approve', 'Approve', 'text-ok'],
              ['comment', 'Comment', 'text-muted'],
              ['request_changes', 'Request changes', 'text-danger']
            ] as const
          ).map(([id, label, tone]) => (
            <button key={id} disabled={disabled} onClick={() => save({ ...v, decision: id })} className={clsx('rounded px-2.5 py-0.5 text-[12px]', v.decision === id ? `bg-panel-2 ${tone}` : 'text-muted')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <textarea disabled={disabled} rows={4} className={inputCls} value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} onBlur={() => v.summary !== run.verdict?.summary && save(v)} placeholder="Review summary, posted as the review body" />
    </section>
  )
}

function FindingCard({ runKey, finding: f, readOnly }: { runKey: string; finding: ReviewFinding; readOnly: boolean }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [open, setOpen] = useState(f.severity === 'critical' || f.severity === 'major')
  const [body, setBody] = useState(f.body)
  useEffect(() => setBody(f.body), [f.body])
  const patch = (p: Partial<ReviewFinding>): void => {
    api.invoke('reviews:updateFinding', runKey, f.id, p).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <div className={clsx('rounded-lg border', f.approved ? 'border-ok/40 bg-ok/5' : 'border-border')}>
      <div className="flex items-center gap-2 px-3 py-2">
        <input type="checkbox" disabled={readOnly} checked={f.approved} onChange={(e) => patch({ approved: e.target.checked })} title="Approve: include in the submitted review" />
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={clsx('shrink-0 transition-transform', open && 'rotate-90')} />
          <Badge tone={SEV_TONE[f.severity]}>{f.severity}</Badge>
          <span className="truncate text-[13px] font-medium">{f.title}</span>
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">
            {f.path}
            {f.line != null && `:${f.line}`}
          </span>
        </button>
      </div>
      {open && (
        <div className="border-t border-border px-3 py-2">
          <textarea disabled={readOnly} rows={Math.min(10, Math.max(3, body.split('\n').length + 1))} className={clsx(inputCls, 'font-sans')} value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== f.body && patch({ body })} />
          {f.suggestion && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] text-muted">Suggested replacement (posted as a GitHub suggestion)</div>
              <pre className="overflow-auto rounded-md border border-border bg-bg p-2 font-mono text-[11.5px]">{f.suggestion}</pre>
            </div>
          )}
          {!readOnly && (
            <div className="mt-2 flex gap-2">
              <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={f.severity} onChange={(e) => patch({ severity: e.target.value as ReviewSeverity })}>
                {(['critical', 'major', 'minor', 'nit'] as const).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Button size="sm" variant={f.approved ? 'subtle' : 'primary'} onClick={() => patch({ approved: !f.approved })}>
                {f.approved ? 'Unapprove' : 'Approve'}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => patch({ approved: false, body: `${f.body}` })} title="Leave unapproved">
                Skip
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

void Play
