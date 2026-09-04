import React, { useEffect, useState } from 'react'
import { renameWorkspace } from '@/lib/rename'
import { InlineRename } from './InlineRename'
import { StagePicker } from './StagePicker'
import { SpacePicker } from './SpacePicker'
import { LabelPicker } from './LabelPicker'
import type { RepoSafety } from '@shared/types'
import { ManageReposDialog } from './ManageReposDialog'
import clsx from 'clsx'
import { Folder, Code2, TerminalSquare, Archive, Trash2, MoreHorizontal, Pencil, GitBranch, ExternalLink, RefreshCw, AlertTriangle } from 'lucide-react'
import { useGithub } from '@/stores/github'
import { useApp, type Tab } from '@/stores/app'
import { api } from '@/lib/api'
import { ChatPane } from './ChatPane'
import { ChangesPane } from './ChangesPane'
import { TerminalPane } from './TerminalPane'
import { RunPane } from './RunPane'
import { PrsPane } from './PrsPane'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'changes', label: 'Changes' },
  { id: 'prs', label: 'PRs' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'run', label: 'Run' }
]

export function WorkspaceView({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const { tab, setTab, setError } = useApp()
  const [menu, setMenu] = useState(false)
  const [archiveDlg, setArchiveDlg] = useState<null | 'archive' | 'delete'>(null)
  const [jiraRefreshing, setJiraRefreshing] = useState(false)
  const [moveDlg, setMoveDlg] = useState(false)
  const [reposDlg, setReposDlg] = useState(false)
  const [renameDlg, setRenameDlg] = useState<null | 'branch'>(null)
  const [editingTitle, setEditingTitle] = useState(false)
  const prs = useGithub((s) => s.byWorkspace[workspaceId]?.repos)
  useEffect(() => {
    // The sidebar's context menu asks the open workspace view to show its archive dialog.
    const onArchive = (e: Event): void => {
      const d = (e as CustomEvent<{ id: string; mode: 'archive' | 'delete' }>).detail
      if (d.id === workspaceId) setArchiveDlg(d.mode)
    }
    const onMove = (e: Event): void => {
      if ((e as CustomEvent<string>).detail === workspaceId) setMoveDlg(true)
    }
    window.addEventListener('sinfonie:archive', onArchive)
    window.addEventListener('sinfonie:moveSpace', onMove)
    return () => {
      window.removeEventListener('sinfonie:archive', onArchive)
      window.removeEventListener('sinfonie:moveSpace', onMove)
    }
  }, [workspaceId])
  const jiraKey = ws?.jira?.key
  const jiraStatusAt = ws?.jiraStatusAt
  useEffect(() => {
    // Refresh the ticket status when the workspace opens, unless it was checked in the last five minutes.
    if (!jiraKey) return
    if (jiraStatusAt && Date.now() - new Date(jiraStatusAt).getTime() < 5 * 60 * 1000) return
    api.invoke('workspaces:refreshJira', workspaceId).catch(() => undefined)
  }, [workspaceId, jiraKey, jiraStatusAt])
  if (!ws) return <div />
  const refreshJira = async (): Promise<void> => {
    setJiraRefreshing(true)
    try {
      await api.invoke('workspaces:refreshJira', ws.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setJiraRefreshing(false)
    }
  }

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-border px-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {editingTitle ? (
              <div className="no-drag w-72">
                <InlineRename
                  value={ws.name}
                  className="text-[14px] font-semibold"
                  onSave={(v) => {
                    setEditingTitle(false)
                    void renameWorkspace(ws, v)
                  }}
                  onCancel={() => setEditingTitle(false)}
                />
              </div>
            ) : (
              <h1 className="no-drag cursor-text truncate text-[14px] font-semibold" title="Double-click to rename" onDoubleClick={() => setEditingTitle(true)}>
                {ws.name}
              </h1>
            )}
            <StagePicker stage={ws.stage} disabled={ws.status === 'archived'} onChange={(stage) => run(() => api.invoke('workspaces:setStage', ws.id, stage))} />
            <SpacePicker pill value={ws.spaceId ?? ''} onChange={(id) => run(() => api.invoke('workspaces:setSpace', ws.id, id || null))} />
            <LabelPicker ws={ws} />
            {ws.status === 'creating' && <Badge tone="warn">creating</Badge>}
            {ws.status === 'error' && <Badge tone="danger">error</Badge>}
            {ws.status === 'archived' && <Badge>archived</Badge>}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <GitBranch size={11} /> <span className="truncate">{ws.repos[0]?.branch}</span> · port {ws.port}
            {ws.jira && (
              <span className="no-drag ml-1 inline-flex items-center gap-1">
                <button className="inline-flex items-center gap-1 text-accent hover:underline" title={ws.jira.summary} onClick={() => void api.invoke('shell:openExternal', ws.jira!.url)}>
                  {ws.jira.key} <ExternalLink size={10} />
                </button>
                <span className="rounded bg-panel-2 px-1.5 py-px text-[10px] text-text" title={ws.jiraStatusAt ? `Jira status, checked ${new Date(ws.jiraStatusAt).toLocaleTimeString()}` : 'Jira status'}>
                  {ws.jiraStatus ?? '…'}
                </span>
                <button className="text-muted hover:text-text" title="Refresh Jira status" onClick={() => void refreshJira()}>
                  <RefreshCw size={10} className={clsx(jiraRefreshing && 'animate-spin')} />
                </button>
              </span>
            )}
          </div>
        </div>
        <div className="ml-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {ws.repos.map((r) => {
            const pr = prs?.find((p) => p.repoId === r.repoId)?.pr
            const open = prs?.find((p) => p.repoId === r.repoId)?.threads.filter((t) => !t.isResolved).length ?? 0
            return (
              <button
                key={r.repoId}
                title={pr ? `${pr.title} (#${pr.number})` : shortPath(r.worktreePath)}
                onClick={() => setTab('prs')}
                className={clsx('no-drag inline-flex items-center gap-1 truncate rounded-full border border-border px-2 py-0.5 text-[11px]', r.repoId === ws.primaryRepoId ? 'text-accent border-accent/40' : 'text-muted')}
              >
                {r.repoName}
                {pr && (
                  <span className={clsx('h-1.5 w-1.5 rounded-full', pr.state === 'MERGED' ? 'bg-accent' : pr.state === 'CLOSED' ? 'bg-danger' : pr.reviewDecision === 'CHANGES_REQUESTED' || open > 0 ? 'bg-warn' : 'bg-ok')} />
                )}
                {open > 0 && <span className="text-warn">{open}</span>}
              </button>
            )
          })}
        </div>
        <nav className="no-drag ml-auto flex items-center gap-0.5 rounded-lg bg-panel p-0.5">
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} className={clsx('rounded-md px-3 py-1 text-[12px] font-medium', tab === t.id ? 'bg-panel-2 text-text' : 'text-muted hover:text-text')}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="no-drag relative">
          <button className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-text" onClick={() => setMenu(!menu)}>
            <MoreHorizontal size={16} />
          </button>
          {menu && (
            <div className="absolute right-0 top-8 z-20 w-56 rounded-lg border border-border bg-panel p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
              <MenuItem icon={<Folder size={14} />} label="Reveal in Finder" onClick={() => run(() => api.invoke('workspaces:openIn', ws.id, 'finder'))} />
              <MenuItem icon={<Code2 size={14} />} label="Open in VS Code" onClick={() => run(() => api.invoke('workspaces:openIn', ws.id, 'vscode'))} />
              <MenuItem icon={<Code2 size={14} />} label="Open in Cursor" onClick={() => run(() => api.invoke('workspaces:openIn', ws.id, 'cursor'))} />
              <MenuItem icon={<TerminalSquare size={14} />} label="Open in Terminal" onClick={() => run(() => api.invoke('workspaces:openIn', ws.id, 'terminal'))} />
              <div className="my-1 border-t border-border" />
              <MenuItem icon={<Folder size={14} />} label="Manage repositories…" onClick={() => setReposDlg(true)} disabled={ws.status !== 'ready'} />
              <MenuItem icon={<Pencil size={14} />} label="Rename workspace" onClick={() => setEditingTitle(true)} />
              <MenuItem icon={<GitBranch size={14} />} label="Rename branch only (all repos)" onClick={() => setRenameDlg('branch')} disabled={ws.status !== 'ready'} />
              <div className="my-1 border-t border-border" />
              {ws.status !== 'archived' ? (
                <>
                  <MenuItem icon={<Archive size={14} />} label="Archive workspace…" onClick={() => setArchiveDlg('archive')} />
                  <MenuItem icon={<Trash2 size={14} />} label="Delete workspace…" onClick={() => setArchiveDlg('delete')} danger />
                </>
              ) : (
                <MenuItem icon={<Trash2 size={14} />} label="Remove from list" onClick={() => run(() => api.invoke('workspaces:delete', ws.id))} danger />
              )}
            </div>
          )}
        </div>
      </header>

      {ws.status === 'error' && <div className="border-b border-danger/30 bg-danger/10 px-4 py-2 text-[12px] text-danger">{ws.error}</div>}

      <div className="min-h-0 flex-1">
        <div className={clsx('h-full', tab !== 'chat' && 'hidden')}>
          <ChatPane workspaceId={ws.id} />
        </div>
        <div className={clsx('h-full', tab !== 'changes' && 'hidden')}>{tab === 'changes' && <ChangesPane workspaceId={ws.id} />}</div>
        <div className={clsx('h-full', tab !== 'prs' && 'hidden')}>{tab === 'prs' && <PrsPane workspaceId={ws.id} />}</div>
        <div className={clsx('h-full', tab !== 'terminal' && 'hidden')}>
          <TerminalPane workspaceId={ws.id} visible={tab === 'terminal'} />
        </div>
        <div className={clsx('h-full', tab !== 'run' && 'hidden')}>
          <RunPane workspaceId={ws.id} />
        </div>
      </div>

      {archiveDlg && <ArchiveDialog workspaceId={ws.id} name={ws.name} mode={archiveDlg} onClose={() => setArchiveDlg(null)} />}
      {reposDlg && <ManageReposDialog workspaceId={ws.id} onClose={() => setReposDlg(false)} />}
      {moveDlg && (
        <Dialog title="Move to space" onClose={() => setMoveDlg(false)} width={380}>
          <SpacePicker
            value={ws.spaceId ?? ''}
            onChange={(id) => {
              run(() => api.invoke('workspaces:setSpace', ws.id, id || null))
              setMoveDlg(false)
            }}
          />
        </Dialog>
      )}
      {renameDlg && <BranchDialog initial={ws.repos[0]?.branch ?? ''} onClose={() => setRenameDlg(null)} onSubmit={(v) => run(() => api.invoke('workspaces:renameBranch', ws.id, v))} />}
    </div>
  )
}

function MenuItem({ icon, label, onClick, danger, disabled }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean }): React.JSX.Element {
  return (
    <button disabled={disabled} onClick={onClick} className={clsx('flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2', danger ? 'text-danger' : 'text-text')}>
      {icon} {label}
    </button>
  )
}

function ArchiveDialog({ workspaceId, name, mode, onClose }: { workspaceId: string; name: string; mode: 'archive' | 'delete'; onClose: () => void }): React.JSX.Element {
  const [deleteBranches, setDeleteBranches] = useState(mode === 'delete')
  const [busy, setBusy] = useState(false)
  const [safety, setSafety] = useState<RepoSafety[] | null>(null)
  const [ack, setAck] = useState(false)
  const setError = useApp((s) => s.setError)
  const select = useApp((s) => s.select)

  useEffect(() => {
    api
      .invoke('workspaces:safety', workspaceId)
      .then(setSafety)
      .catch((err) => setSafety([{ repoId: '', repoName: 'check failed', uncommitted: 0, unpushed: 0, hasUpstream: false, error: err instanceof Error ? err.message : String(err) }]))
  }, [workspaceId])

  const risky = (safety ?? []).filter((r) => r.uncommitted > 0 || r.unpushed > 0 || r.error)
  const hasRisk = risky.length > 0
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      const out = await api.invoke('workspaces:archive', workspaceId, { deleteBranches, forget: mode === 'delete' })
      if (!out) select(null)
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={`${mode === 'delete' ? 'Delete' : 'Archive'} "${name}"`} onClose={onClose} width={480}>
      <p className="mb-3 text-muted">
        {mode === 'delete'
          ? 'Removes every worktree and the workspace folder from disk, runs each repo\'s archive script first, and forgets the workspace and its chat.'
          : 'Removes every worktree and the workspace folder from disk and runs each repo\'s archive script first. The workspace stays in the archived list with its chat.'}
      </p>

      <div className="mb-3 rounded-lg border border-border">
        <div className="border-b border-border px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">What would be lost</div>
        {safety === null && <div className="px-3 py-2 text-[12px] text-muted">Checking worktrees…</div>}
        {safety?.map((r) => {
          const bad = r.uncommitted > 0 || r.unpushed > 0 || r.error
          return (
            <div key={r.repoId} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
              {bad ? <AlertTriangle size={13} className="shrink-0 text-warn" /> : <span className="inline-block h-[13px] w-[13px] shrink-0 text-center text-ok">✓</span>}
              <span className="font-medium">{r.repoName}</span>
              <span className={clsx('ml-auto text-right', bad ? 'text-warn' : 'text-muted')}>
                {r.error
                  ? r.error
                  : bad
                    ? [r.uncommitted > 0 && `${r.uncommitted} uncommitted file${r.uncommitted === 1 ? '' : 's'}`, r.unpushed > 0 && `${r.unpushed} commit${r.unpushed === 1 ? '' : 's'} not pushed${r.hasUpstream ? '' : ' (branch never pushed)'}`].filter(Boolean).join(' · ')
                    : 'clean and pushed'}
              </span>
            </div>
          )
        })}
      </div>

      {hasRisk && (
        <label className="mb-3 flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-3 text-[12px]">
          <input type="checkbox" className="mt-0.5" checked={ack} onChange={(e) => setAck(e.target.checked)} />
          <span>
            I understand the changes listed above will be <strong>permanently lost</strong>. Commit and push first if you want to keep them.
          </span>
        </label>
      )}

      <label className="mb-4 flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} /> Also delete the local branches
      </label>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy || safety === null || (hasRisk && !ack)}>
          {busy ? (mode === 'delete' ? 'Deleting…' : 'Archiving…') : mode === 'delete' ? 'Delete workspace' : 'Archive'}
        </Button>
      </div>
    </Dialog>
  )
}

function BranchDialog({ initial, onClose, onSubmit }: { initial: string; onClose: () => void; onSubmit: (v: string) => Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <Dialog title="Rename branch in every repo" onClose={onClose} width={440}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            await onSubmit(value)
            onClose()
          } finally {
            setBusy(false)
          }
        }}
      >
        <Field label="Branch name" hint="Applies to every repo in this workspace. Branches already on GitHub are renamed there too. The workspace name stays as it is.">
          <input autoFocus className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !value.trim() || value.trim() === initial}>
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
