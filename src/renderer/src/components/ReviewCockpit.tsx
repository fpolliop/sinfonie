import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { RefreshCw, ExternalLink, Square, Trash2, Send, CheckSquare, Sparkles, ChevronRight, ArrowDownWideNarrow, ArrowUpNarrowWide, Filter } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useReviews, keyOf, STATUS_FILTERS, type StatusFilter } from '@/stores/reviews'
import { AccountPicker } from './AccountPicker'
import { Badge, Button, Spinner, inputCls } from './ui'
import { timeAgo } from '@/lib/format'
import type { ReviewFinding, ReviewPr, ReviewRun, ReviewSeverity, ReviewVerdict } from '@shared/types'


export function ReviewCockpit(): React.JSX.Element {
  const { owners, repos: spaceRepos, mode, prs, runs, selectedKey, loadingOrgs, loadingPrs, error, init, useSpace, setMode, refreshPrs, select, repoFilter, statusFilter, sortDir, setRepoFilter, setStatusFilter, setSortDir } = useReviews()
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

  // Every repository of the space shows up, with or without open PRs, plus any repo a configured owner brought in.
  const repos = useMemo(() => Array.from(new Set([...spaceRepos, ...prs.map((p) => p.nameWithOwner)])).sort(), [spaceRepos, prs])
  const countBy = useMemo(() => prs.reduce<Record<string, number>>((m, p) => ((m[p.nameWithOwner] = (m[p.nameWithOwner] ?? 0) + 1), m), {}), [prs])

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
    for (const r of repos) if (!repoFilter || r === repoFilter) m.set(r, [])
    for (const p of filtered) m.set(p.nameWithOwner, [...(m.get(p.nameWithOwner) ?? []), p])
    // Repositories with PRs first, then the quiet ones, each group alphabetical.
    return Array.from(m.entries()).sort((a, b) => Number(b[1].length > 0) - Number(a[1].length > 0) || a[0].localeCompare(b[0]))
  }, [filtered, repos, repoFilter])

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
          <span className="text-muted">· {spaceRepos.length ? `${spaceRepos.length} repositor${spaceRepos.length === 1 ? 'y' : 'ies'}` : ''}{spaceRepos.length && owners.length ? ' + ' : ''}{owners.length ? `all of ${owners.join(', ')}` : ''}{!spaceRepos.length && !owners.length ? (loadingOrgs ? '…' : 'no repositories') : ''}</span>
        </button>
        <div className="no-drag flex rounded-md bg-panel p-0.5">
          {(['all', 'requested'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} title={m === 'requested' ? 'Only PRs where your review was explicitly requested' : 'Every open PR in these repositories'} className={clsx('rounded px-2.5 py-0.5 text-[12px]', mode === m ? 'bg-panel-2' : 'text-muted')}>
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
              {r.split('/')[1]} ({countBy[r] ?? 0})
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
              {spaceRepos.length === 0 && owners.length === 0 ? 'This space has no GitHub repositories yet. Add repositories to it, or pick owners in the space settings.' : mode === 'requested' ? 'No pull requests in this space are waiting for your review. Switch to "All open" to see everything.' : 'No open pull requests in this space.'}
            </div>
          )}
          {!loadingPrs && prs.length > 0 && filtered.length === 0 && repos.length === 0 && <div className="p-4 text-[12px] text-muted">Nothing matches the current filters.</div>}
          {grouped.map(([repo, list]) => (
            <div key={repo}>
              <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted" title={repo}>
                {repo.split('/')[1]} <span className="normal-case text-muted/70">{list.length}</span>
                {spaceRepos.includes(repo) && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-accent/60" title="Registered in this space" />}
              </div>
              {list.length === 0 && <div className="px-3 py-1.5 text-[11px] text-muted/70">{mode === 'requested' ? 'nothing waiting on you' : 'no open pull requests'}</div>}
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

const SEV_ORDER: ReviewSeverity[] = ['critical', 'major', 'minor', 'nit']
const DECISION: Record<ReviewVerdict['decision'], { label: string; verb: string; tone: string; badge: 'ok' | 'danger' | 'muted' }> = {
  approve: { label: 'Approve', verb: 'approve', tone: 'text-ok', badge: 'ok' },
  request_changes: { label: 'Request changes', verb: 'request changes', tone: 'text-danger', badge: 'danger' },
  comment: { label: 'Comment', verb: 'comment', tone: 'text-muted', badge: 'muted' }
}

function PrDetail({ pr, run, onStart }: { pr: ReviewPr; run?: ReviewRun; onStart: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [submitting, setSubmitting] = useState(false)
  const [hidden, setHidden] = useState<Set<ReviewSeverity>>(new Set())
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const busy = run?.status === 'preparing' || run?.status === 'running'
  const findings = run?.findings ?? []
  const approvedCount = findings.filter((f) => f.approved).length
  const counts = SEV_ORDER.map((sev) => [sev, findings.filter((f) => f.severity === sev).length] as const)
  const visible = findings.filter((f) => !hidden.has(f.severity))
  const byFile = useMemo(() => {
    const m = new Map<string, ReviewFinding[]>()
    for (const f of [...visible].sort((x, y) => SEV_ORDER.indexOf(x.severity) - SEV_ORDER.indexOf(y.severity) || (x.line ?? 0) - (y.line ?? 0))) m.set(f.path, [...(m.get(f.path) ?? []), f])
    return Array.from(m.entries())
  }, [visible])
  const decision = run?.verdict?.decision ?? 'comment'
  const d = DECISION[decision]
  const readOnly = run?.status === 'submitted'
  const submit = async (all: boolean): Promise<void> => {
    if (!run) return
    setSubmitting(true)
    await act(async () => {
      if (all && approvedCount < findings.length) await api.invoke('reviews:setAll', run.key, true)
      await api.invoke('reviews:submit', run.key)
    })
    setSubmitting(false)
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-5 pb-24">
      <div>
        <div className="flex items-center gap-2">
          <h2 className="text-[15px] font-semibold">{pr.title}</h2>
          <button className="text-muted hover:text-text" onClick={() => void api.invoke('shell:openExternal', pr.url)} title="Open on GitHub">
            <ExternalLink size={13} />
          </button>
          {pr.isDraft && <Badge>draft</Badge>}
        </div>
        <div className="text-[12px] text-muted">
          {pr.nameWithOwner} #{pr.number} · by {pr.author} · updated {timeAgo(pr.updatedAt)}
          {run?.baseRefName && (
            <>
              {' '}
              · <span className="font-mono">{run.headRefName}</span> → <span className="font-mono">{run.baseRefName}</span>
            </>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!busy && (
          <Button variant={run ? 'subtle' : 'primary'} onClick={onStart}>
            <Sparkles size={13} /> {run ? 'Run AI review again' : 'Run AI review'}
          </Button>
        )}
        {busy && (
          <Button variant="danger" onClick={() => act(() => api.invoke('reviews:cancel', run!.key))}>
            <Square size={12} /> Cancel
          </Button>
        )}
        {run && !busy && !readOnly && (
          <Button variant="ghost" onClick={() => act(() => api.invoke('reviews:discard', run.key))}>
            <Trash2 size={13} /> Discard
          </Button>
        )}
        {run?.status === 'done' && (
          <span className="text-[12px] text-muted">
            Reviewed {timeAgo(run.finishedAt)} · {run.phase} · ${(run.costUsd ?? 0).toFixed(2)}
          </span>
        )}
        {run?.submittedUrl && (
          <button className="inline-flex items-center gap-1 text-[12px] text-accent hover:underline" onClick={() => void api.invoke('shell:openExternal', run.submittedUrl!)}>
            View the submitted review <ExternalLink size={11} />
          </button>
        )}
      </div>

      {busy && (
        <div className="rounded-xl border border-border bg-panel p-4">
          <div className="flex items-center gap-2 text-[13px]">
            <Spinner /> <span className="font-medium">{run?.status === 'preparing' ? 'Preparing' : 'Reviewing'}</span>
            <span className="text-muted">{run?.phase}</span>
          </div>
          <p className="mt-1 text-[12px] text-muted">The reviewer checks out the branch, reads the diff and the code around it, and returns findings with a verdict. A few minutes for a large PR.</p>
        </div>
      )}
      {run?.status === 'error' && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-[12px]">
          <div className="mb-1 font-medium text-danger">The review failed</div>
          <div className="text-muted">{run.error}</div>
          <div className="mt-2">
            <Button size="sm" variant="primary" onClick={onStart}>
              <Sparkles size={12} /> Try again
            </Button>
          </div>
        </div>
      )}

      {run && (run.status === 'done' || run.status === 'submitted') && (
        <>
          {/* the verdict: what the reviewer concluded, editable */}
          <VerdictEditor run={run} disabled={readOnly} />

          {/* what was found, at a glance */}
          <section>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">Findings</h3>
              {counts.map(([sev, n]) => (
                <button
                  key={sev}
                  disabled={n === 0}
                  onClick={() => setHidden((h) => (h.has(sev) ? new Set([...h].filter((x) => x !== sev)) : new Set([...h, sev])))}
                  className={clsx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]', n === 0 ? 'border-border text-muted/50' : hidden.has(sev) ? 'border-border text-muted line-through' : 'border-border')}
                  title={n === 0 ? `No ${sev} findings` : hidden.has(sev) ? `Show ${sev}` : `Hide ${sev}`}
                >
                  <span className={clsx('h-1.5 w-1.5 rounded-full', SEV_DOT[sev])} /> {n} {sev}
                </button>
              ))}
              <span className="ml-auto text-[11px] text-muted">{approvedCount} of {findings.length} will be posted</span>
              {!readOnly && findings.length > 0 && (
                <>
                  <button className="text-[11px] text-accent hover:underline" onClick={() => act(() => api.invoke('reviews:setAll', run.key, approvedCount < findings.length))}>
                    {approvedCount < findings.length ? 'Select all' : 'Clear all'}
                  </button>
                </>
              )}
            </div>
            {findings.length === 0 && <div className="rounded-xl border border-border bg-panel p-4 text-[12px] text-muted">Nothing worth a comment. The verdict above goes out on its own.</div>}
            <div className="flex flex-col gap-3">
              {byFile.map(([path, list]) => (
                <div key={path} className="overflow-hidden rounded-xl border border-border">
                  <div className="flex items-center gap-2 border-b border-border bg-panel px-3 py-1.5">
                    <span className="truncate font-mono text-[11.5px]">{path}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-muted">{list.length} finding{list.length === 1 ? '' : 's'}</span>
                  </div>
                  {list.map((f) => (
                    <FindingCard key={f.id} runKey={run.key} finding={f} readOnly={readOnly} />
                  ))}
                </div>
              ))}
            </div>
          </section>

          {!readOnly && (
            <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-2 border-t border-border bg-bg px-5 py-3">
              <span className="mr-auto text-[12px] text-muted">
                One GitHub review: the verdict as the body and the selected findings as inline comments.
                {run.verdict && <span className={clsx('ml-1', d.tone)}>Reviewer says {d.verb}.</span>}
              </span>
              {approvedCount < findings.length && findings.length > 0 && (
                <Button variant="subtle" disabled={submitting || !run.verdict} onClick={() => submit(true)} title={`Select all ${findings.length} findings and ${d.verb}`}>
                  <CheckSquare size={13} /> Comment all {findings.length} and {d.verb}
                </Button>
              )}
              <Button variant="primary" disabled={submitting || !run.verdict} onClick={() => submit(false)}>
                <Send size={13} /> {submitting ? 'Submitting…' : approvedCount === 0 ? `Submit and ${d.verb}` : `Comment ${approvedCount} and ${d.verb}`}
              </Button>
            </div>
          )}
        </>
      )}
      {!run && (
        <div className="rounded-xl border border-border bg-panel p-4 text-[12px] text-muted">Run the AI review to get findings with severities, a suggested verdict, and inline comments you approve one by one before anything is posted.</div>
      )}
    </div>
  )
}

const SEV_DOT: Record<ReviewSeverity, string> = { critical: 'bg-danger', major: 'bg-warn', minor: 'bg-accent', nit: 'bg-muted' }

function VerdictEditor({ run, disabled }: { run: ReviewRun; disabled: boolean }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [v, setV] = useState<ReviewVerdict>(run.verdict ?? { decision: 'comment', summary: '' })
  // The reviewer's own recommendation, remembered for this run so the user can see when they diverge.
  const [recommended] = useState(run.verdict?.decision)
  useEffect(() => setV(run.verdict ?? { decision: 'comment', summary: '' }), [run.key, run.verdict])
  const save = (next: ReviewVerdict): void => {
    setV(next)
    api.invoke('reviews:setVerdict', run.key, next).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const d = DECISION[v.decision]
  return (
    <section className={clsx('rounded-xl border p-3', v.decision === 'approve' ? 'border-ok/40 bg-ok/5' : v.decision === 'request_changes' ? 'border-danger/40 bg-danger/5' : 'border-border bg-panel')}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-[12px] font-medium uppercase tracking-wide text-muted">Verdict</h3>
        <Badge tone={d.badge}>{d.label}</Badge>
        {recommended && recommended !== v.decision && <span className="text-[11px] text-muted">reviewer suggested {DECISION[recommended].verb}</span>}
        <div className="ml-auto flex rounded-md bg-bg p-0.5">
          {(['approve', 'comment', 'request_changes'] as const).map((id) => (
            <button key={id} disabled={disabled} onClick={() => save({ ...v, decision: id })} className={clsx('rounded px-2.5 py-0.5 text-[12px]', v.decision === id ? `bg-panel-2 ${DECISION[id].tone}` : 'text-muted hover:text-text')}>
              {DECISION[id].label}
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
    <div className={clsx('border-b border-border last:border-b-0', f.approved && 'bg-ok/5')}>
      <div className="flex items-center gap-2 px-3 py-2">
        <input type="checkbox" disabled={readOnly} checked={f.approved} onChange={(e) => patch({ approved: e.target.checked })} title="Post this finding as an inline comment" />
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => setOpen(!open)}>
          <ChevronRight size={12} className={clsx('shrink-0 text-muted transition-transform', open && 'rotate-90')} />
          <span className={clsx('h-2 w-2 shrink-0 rounded-full', SEV_DOT[f.severity])} title={f.severity} />
          <span className={clsx('truncate text-[13px]', f.approved ? 'font-medium' : '')}>{f.title}</span>
          {f.suggestion && <span className="shrink-0 rounded bg-panel-2 px-1 text-[10px] uppercase tracking-wide text-muted">suggestion</span>}
          <span className="ml-auto shrink-0 font-mono text-[11px] text-muted">{f.line != null ? `L${f.line}` : 'file'}</span>
        </button>
      </div>
      {open && (
        <div className="border-t border-border/60 px-3 py-2 pl-9">
          {readOnly ? <div className="whitespace-pre-wrap text-[12.5px]">{f.body}</div> : <textarea rows={Math.min(10, Math.max(2, body.split('\n').length + 1))} className={clsx(inputCls, 'font-sans')} value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => body !== f.body && patch({ body })} />}
          {f.suggestion && (
            <div className="mt-2">
              <div className="mb-1 text-[11px] text-muted">Suggested change, posted as a GitHub suggestion the author can apply in one click</div>
              <pre className="overflow-auto rounded-md border border-ok/30 bg-ok/5 p-2 font-mono text-[11.5px]">{f.suggestion}</pre>
            </div>
          )}
          {!readOnly && (
            <div className="mt-2 flex items-center gap-2">
              <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={f.severity} onChange={(e) => patch({ severity: e.target.value as ReviewSeverity })} title="Severity">
                {SEV_ORDER.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <Button size="sm" variant={f.approved ? 'subtle' : 'primary'} onClick={() => patch({ approved: !f.approved })}>
                {f.approved ? 'Leave out' : 'Post this one'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
