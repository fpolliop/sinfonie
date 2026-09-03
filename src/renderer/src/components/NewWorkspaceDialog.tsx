import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Search, X, ExternalLink } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'
import type { JiraIssue, WorkspaceJira } from '@shared/types'

/** "SD-3281" + "Relevance ranked packages" -> "sd-3281-relevance-ranked-packages" */
export function suggestName(issue: { key: string; summary: string }): string {
  const words = issue.summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w && !['a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'from', 'as', 'at', 'by', 'is', 'be'].includes(w))
  let out = issue.key.toLowerCase()
  for (const w of words) {
    if ((out + '-' + w).length > 48) break
    out += '-' + w
  }
  return out
}

interface Pick {
  repoId: string
  baseBranch: string
  branches: string[]
}

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { repos, select, setShowSettings, setError, settings } = useApp()
  const setDraft = useChat((s) => s.setDraft)
  const [name, setName] = useState('')
  const [jira, setJira] = useState<WorkspaceJira | null>(null)
  const jiraReady = Boolean(settings.jira.siteUrl && settings.jira.email && settings.jira.hasToken)
  const [picks, setPicks] = useState<Record<string, Pick>>({})
  const [primary, setPrimary] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [lastUsed] = useState<string[]>(() => JSON.parse(localStorage.getItem('orchestra.lastRepos') ?? '[]'))

  useEffect(() => {
    // Preselect the repos used last time, so the common "frontend + backend" pair is one click.
    for (const id of lastUsed) if (repos.some((r) => r.id === id)) void toggle(id, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (repoId: string, on?: boolean): Promise<void> => {
    const isOn = on ?? !picks[repoId]
    if (!isOn) {
      setPicks((p) => {
        const n = { ...p }
        delete n[repoId]
        return n
      })
      if (primary === repoId) setPrimary('')
      return
    }
    const repo = repos.find((r) => r.id === repoId)!
    let branches: string[] = []
    try {
      branches = await api.invoke('repos:branches', repoId)
    } catch {
      /* ignore */
    }
    setPicks((p) => ({ ...p, [repoId]: { repoId, baseBranch: repo.defaultBranch, branches } }))
    setPrimary((cur) => cur || repoId)
  }

  const selected = Object.values(picks)
  const submit = async (): Promise<void> => {
    if (!name.trim() || selected.length === 0) return
    setBusy(true)
    try {
      localStorage.setItem('orchestra.lastRepos', JSON.stringify(selected.map((s) => s.repoId)))
      const ws = await api.invoke('workspaces:create', {
        name,
        repos: selected.map((s) => ({ repoId: s.repoId, baseBranch: s.baseBranch })),
        primaryRepoId: primary || selected[0].repoId,
        ...(jira ? { jira } : {})
      })
      select(ws.id)
      onClose()
      if (jira) {
        // Pre-fill the first message with the ticket so the agent starts from the real spec.
        try {
          const full = await api.invoke('jira:issue', jira.key)
          setDraft(ws.id, `Implement ${full.key}: ${full.summary}\n${full.url}\n\n${(full.description ?? '').trim() || '(no description in Jira)'}\n\nStart by reading the relevant code in each repo and propose a plan before changing anything.`)
        } catch {
          setDraft(ws.id, `Implement ${jira.key}: ${jira.summary}\n${jira.url}`)
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="New workspace" onClose={onClose} width={560}>
      <JiraPicker
        enabled={jiraReady}
        selected={jira}
        onSelect={(issue) => {
          if (!issue) {
            setJira(null)
            return
          }
          setJira({ key: issue.key, summary: issue.summary, url: issue.url })
          setName(suggestName(issue))
        }}
        onConfigure={() => (onClose(), setShowSettings(true))}
      />
      <Field label="Name" hint="Becomes the branch name in every selected repo and the folder name on disk.">
        <input autoFocus className={inputCls} placeholder="e.g. checkout-redesign" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
      </Field>
      <div className="mb-1 text-[12px] font-medium text-muted">Repositories</div>
      {repos.length === 0 && (
        <div className="mb-3 rounded-md border border-border p-3 text-muted">
          No repositories added yet.{' '}
          <button className="text-accent" onClick={() => (onClose(), setShowSettings(true))}>
            Add one in Settings
          </button>
          .
        </div>
      )}
      <div className="mb-4 flex flex-col gap-1.5">
        {repos.map((r) => {
          const p = picks[r.id]
          return (
            <div key={r.id} className={clsx('rounded-lg border px-3 py-2', p ? 'border-accent/50 bg-accent/5' : 'border-border')}>
              <div className="flex items-center gap-3">
                <input type="checkbox" className="shrink-0" checked={Boolean(p)} onChange={() => void toggle(r.id)} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{r.name}</div>
                  <div className="truncate text-[11px] text-muted">{shortPath(r.path)}</div>
                </div>
                {p && (
                  <div className="flex shrink-0 items-center gap-3">
                    <label className="flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-[11px] text-muted" title="Claude Code's working directory">
                      <input type="radio" name="primary" checked={primary === r.id} onChange={() => setPrimary(r.id)} /> primary
                    </label>
                    <select className="max-w-[180px] rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={p.baseBranch} onChange={(e) => setPicks((s) => ({ ...s, [r.id]: { ...p, baseBranch: e.target.value } }))}>
                      {(p.branches.length ? p.branches : [p.baseBranch]).map((b) => (
                        <option key={b} value={b}>
                          from {b}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <p className="mb-4 text-[11px] text-muted">The primary repo is Claude Code's working directory; the others are added as extra directories. Setup scripts run in every repo after all worktrees exist.</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" onClick={submit} disabled={busy || !name.trim() || selected.length === 0}>
          {busy ? 'Creating…' : `Create ${selected.length || ''} worktree${selected.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Dialog>
  )
}

function JiraPicker({ enabled, selected, onSelect, onConfigure }: { enabled: boolean; selected: WorkspaceJira | null; onSelect: (i: JiraIssue | null) => void; onConfigure: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<JiraIssue[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  const run = async (q: string): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      setResults(await api.invoke('jira:search', q))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    if (!open) return
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => void run(query), query ? 300 : 0)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, open])

  if (selected) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-accent/40 bg-accent/5 px-3 py-2">
        <Badge tone="accent">{selected.key}</Badge>
        <span className="min-w-0 flex-1 truncate text-[13px]">{selected.summary}</span>
        <button className="text-muted hover:text-text" title="Open in Jira" onClick={() => void api.invoke('shell:openExternal', selected.url)}>
          <ExternalLink size={13} />
        </button>
        <button className="text-muted hover:text-text" title="Clear" onClick={() => onSelect(null)}>
          <X size={13} />
        </button>
      </div>
    )
  }
  if (!open) {
    return (
      <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
        {enabled ? (
          <button className="text-accent hover:underline" onClick={() => setOpen(true)}>
            Create from a Jira ticket…
          </button>
        ) : (
          <>
            <span>Create from a Jira ticket?</span>
            <button className="text-accent hover:underline" onClick={onConfigure}>
              Connect Jira in Settings
            </button>
          </>
        )}
      </div>
    )
  }
  return (
    <div className="mb-3 rounded-lg border border-border">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Search size={13} className="text-muted" />
        <input autoFocus className="flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted" placeholder="Ticket key or words in the summary… (empty = your open tickets)" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button className="text-muted hover:text-text" onClick={() => setOpen(false)}>
          <X size={13} />
        </button>
      </div>
      <div className="max-h-56 overflow-auto">
        {error && <div className="px-3 py-2 text-[12px] text-danger">{error}</div>}
        {loading && results.length === 0 && <div className="px-3 py-2 text-[12px] text-muted">Searching…</div>}
        {!loading && !error && results.length === 0 && <div className="px-3 py-2 text-[12px] text-muted">No tickets found.</div>}
        {results.map((i) => (
          <button key={i.key} onClick={() => onSelect(i)} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-panel-2">
            <Badge tone="accent">{i.key}</Badge>
            <span className="min-w-0 flex-1 truncate text-[13px]">{i.summary}</span>
            <span className="shrink-0 text-[11px] text-muted">{i.type} · {i.status}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
