import React, { useState } from 'react'
import clsx from 'clsx'
import { Folder, Code2, TerminalSquare, Archive, Trash2, MoreHorizontal, Pencil, GitBranch } from 'lucide-react'
import { useApp, type Tab } from '@/stores/app'
import { api } from '@/lib/api'
import { ChatPane } from './ChatPane'
import { ChangesPane } from './ChangesPane'
import { TerminalPane } from './TerminalPane'
import { RunPane } from './RunPane'
import { Badge, Button, Dialog, Field, inputCls } from './ui'
import { shortPath } from '@/lib/format'

const TABS: { id: Tab; label: string }[] = [
  { id: 'chat', label: 'Chat' },
  { id: 'changes', label: 'Changes' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'run', label: 'Run' }
]

export function WorkspaceView({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const { tab, setTab, setError } = useApp()
  const [menu, setMenu] = useState(false)
  const [archiveDlg, setArchiveDlg] = useState(false)
  const [renameDlg, setRenameDlg] = useState<null | 'name' | 'branch'>(null)
  if (!ws) return <div />

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
            <h1 className="truncate text-[14px] font-semibold">{ws.name}</h1>
            {ws.status === 'creating' && <Badge tone="warn">creating</Badge>}
            {ws.status === 'error' && <Badge tone="danger">error</Badge>}
            {ws.status === 'archived' && <Badge>archived</Badge>}
          </div>
          <div className="flex items-center gap-1 text-[11px] text-muted">
            <GitBranch size={11} /> <span className="truncate">{ws.repos[0]?.branch}</span> · port {ws.port}
          </div>
        </div>
        <div className="ml-2 flex min-w-0 items-center gap-1.5 overflow-hidden">
          {ws.repos.map((r) => (
            <span key={r.repoId} title={shortPath(r.worktreePath)} className={clsx('no-drag truncate rounded-full border border-border px-2 py-0.5 text-[11px]', r.repoId === ws.primaryRepoId ? 'text-accent border-accent/40' : 'text-muted')}>
              {r.repoName}
            </span>
          ))}
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
              <MenuItem icon={<Pencil size={14} />} label="Rename workspace" onClick={() => setRenameDlg('name')} />
              <MenuItem icon={<GitBranch size={14} />} label="Rename branch (all repos)" onClick={() => setRenameDlg('branch')} disabled={ws.status === 'archived'} />
              <div className="my-1 border-t border-border" />
              {ws.status !== 'archived' ? (
                <MenuItem icon={<Archive size={14} />} label="Archive workspace" onClick={() => setArchiveDlg(true)} danger />
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
        <div className={clsx('h-full', tab !== 'terminal' && 'hidden')}>
          <TerminalPane workspaceId={ws.id} visible={tab === 'terminal'} />
        </div>
        <div className={clsx('h-full', tab !== 'run' && 'hidden')}>
          <RunPane workspaceId={ws.id} />
        </div>
      </div>

      {archiveDlg && <ArchiveDialog workspaceId={ws.id} name={ws.name} repoCount={ws.repos.length} onClose={() => setArchiveDlg(false)} />}
      {renameDlg && (
        <RenameDialog
          kind={renameDlg}
          initial={renameDlg === 'name' ? ws.name : ws.repos[0]?.branch ?? ''}
          onClose={() => setRenameDlg(null)}
          onSubmit={(v) => run(() => (renameDlg === 'name' ? api.invoke('workspaces:rename', ws.id, v) : api.invoke('workspaces:renameBranch', ws.id, v)))}
        />
      )}
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

function ArchiveDialog({ workspaceId, name, repoCount, onClose }: { workspaceId: string; name: string; repoCount: number; onClose: () => void }): React.JSX.Element {
  const [deleteBranches, setDeleteBranches] = useState(false)
  const [busy, setBusy] = useState(false)
  const setError = useApp((s) => s.setError)
  const submit = async (): Promise<void> => {
    setBusy(true)
    try {
      await api.invoke('workspaces:archive', workspaceId, { deleteBranches })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog title={`Archive "${name}"`} onClose={onClose} width={440}>
      <p className="mb-3 text-muted">
        This removes the {repoCount} worktree{repoCount === 1 ? '' : 's'} and the workspace folder from disk, and runs each repo's archive script first. Commits that were pushed are safe. Uncommitted changes are lost.
      </p>
      <label className="mb-4 flex items-center gap-2 text-[13px]">
        <input type="checkbox" checked={deleteBranches} onChange={(e) => setDeleteBranches(e.target.checked)} /> Also delete the local branches
      </label>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="danger" onClick={submit} disabled={busy}>
          {busy ? 'Archiving…' : 'Archive'}
        </Button>
      </div>
    </Dialog>
  )
}

function RenameDialog({ kind, initial, onClose, onSubmit }: { kind: 'name' | 'branch'; initial: string; onClose: () => void; onSubmit: (v: string) => Promise<void> }): React.JSX.Element {
  const [value, setValue] = useState(initial)
  return (
    <Dialog title={kind === 'name' ? 'Rename workspace' : 'Rename branch in every repo'} onClose={onClose} width={420}>
      <form
        onSubmit={async (e) => {
          e.preventDefault()
          await onSubmit(value)
          onClose()
        }}
      >
        <Field label={kind === 'name' ? 'Workspace name' : 'Branch name'}>
          <input autoFocus className={inputCls} value={value} onChange={(e) => setValue(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary">
            Save
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
