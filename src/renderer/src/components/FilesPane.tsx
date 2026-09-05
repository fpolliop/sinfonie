import React, { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, File, Folder, FolderOpen, Copy, ExternalLink, MessageSquarePlus, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { Button, Spinner } from './ui'
import type { FsEntry, GitFileStatus } from '@shared/types'

type Node = FsEntry & { children?: Node[]; loading?: boolean }
const fmtSize = (n: number): string => (n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`)

/** Files tab: the worktrees of the workspace as a lazy tree, git status decorations, and a read-only viewer. */
export function FilesPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const setError = useApp((s) => s.setError)
  const setDraft = useChat((s) => s.setDraft)
  const draft = useChat((s) => s.chats[workspaceId]?.draft ?? '')
  const [trees, setTrees] = useState<Record<string, Node[]>>({})
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState<{ text: string; truncated: boolean; binary: boolean; size: number } | null>(null)
  const [status, setStatus] = useState<Record<string, Record<string, GitFileStatus>>>({})
  const [hidden, setHidden] = useState(false)
  const [filter, setFilter] = useState('')
  const roots = useMemo(() => (ws ? (ws.repos.length ? ws.repos.map((r) => ({ id: r.repoId, label: r.repoName, path: r.worktreePath })) : [{ id: 'root', label: ws.slug, path: ws.rootPath }]) : []), [ws])

  const load = async (path: string): Promise<Node[]> => {
    try {
      return await api.invoke('fs:list', workspaceId, path, hidden)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return []
    }
  }
  const refresh = async (): Promise<void> => {
    const next: Record<string, Node[]> = {}
    for (const r of roots) next[r.path] = await load(r.path)
    setTrees(next)
    try {
      const st = await api.invoke('git:status', workspaceId)
      const m: Record<string, Record<string, GitFileStatus>> = {}
      for (const r of st) {
        const wt = ws?.repos.find((x) => x.repoId === r.repoId)?.worktreePath
        if (!wt) continue
        m[wt] = Object.fromEntries(r.files.map((f) => [`${wt}/${f.path}`, f]))
      }
      setStatus(m)
    } catch {
      /* status is decoration only */
    }
  }
  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, roots.length, hidden])

  const toggle = async (root: string, node: Node): Promise<void> => {
    const willOpen = !open[node.path]
    setOpen((o) => ({ ...o, [node.path]: willOpen }))
    if (willOpen && !node.children) {
      const children = await load(node.path)
      setTrees((t) => ({ ...t, [root]: patchTree(t[root] ?? [], node.path, (n) => ({ ...n, children })) }))
    }
  }
  const pick = async (path: string): Promise<void> => {
    setSelected(path)
    setContent(null)
    try {
      setContent(await api.invoke('fs:read', workspaceId, path))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  const statusOf = (root: string, path: string): GitFileStatus | undefined => status[root]?.[path]
  const dirHasChanges = (root: string, dir: string): boolean => Object.keys(status[root] ?? {}).some((p) => p.startsWith(dir + '/'))

  const renderNodes = (root: string, nodes: Node[], depth: number): React.JSX.Element[] =>
    nodes
      .filter((n) => !filter || n.dir || n.name.toLowerCase().includes(filter.toLowerCase()))
      .map((n) => {
        const st = n.dir ? undefined : statusOf(root, n.path)
        const changed = n.dir ? dirHasChanges(root, n.path) : Boolean(st)
        return (
          <div key={n.path}>
            <button
              onClick={() => (n.dir ? void toggle(root, n) : void pick(n.path))}
              className={clsx('flex w-full items-center gap-1.5 rounded px-1 py-[3px] text-left text-[12.5px] hover:bg-panel-2', selected === n.path && 'bg-panel-2')}
              style={{ paddingLeft: 6 + depth * 14 }}
              title={n.path}
            >
              {n.dir ? <ChevronRight size={11} className={clsx('shrink-0 text-muted transition-transform', open[n.path] && 'rotate-90')} /> : <span className="w-[11px] shrink-0" />}
              {n.dir ? open[n.path] ? <FolderOpen size={13} className="shrink-0 text-accent/80" /> : <Folder size={13} className="shrink-0 text-accent/80" /> : <File size={13} className="shrink-0 text-muted" />}
              <span className={clsx('truncate', st?.status === '?' ? 'text-ok' : st ? 'text-warn' : changed ? 'text-text' : '')}>{n.name}</span>
              {st && <span className={clsx('ml-auto shrink-0 font-mono text-[10px]', st.status === '?' ? 'text-ok' : 'text-warn')}>{st.status}</span>}
              {n.dir && changed && !open[n.path] && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-warn" />}
            </button>
            {n.dir && open[n.path] && (n.children ? renderNodes(root, n.children, depth + 1) : <div className="py-1 pl-8 text-[11px] text-muted"><Spinner /></div>)}
          </div>
        )
      })

  const rel = (p: string): string => {
    const r = roots.find((x) => p.startsWith(x.path + '/'))
    return r ? `${r.label}/${p.slice(r.path.length + 1)}` : p
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-[320px] shrink-0 flex-col border-r border-border">
        <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
          <input className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-[12px] outline-none focus:border-accent" placeholder="Filter loaded files…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" title={hidden ? 'Hide dotfiles and build folders' : 'Show dotfiles and build folders'} onClick={() => setHidden(!hidden)}>
            {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button className="rounded p-1 text-muted hover:bg-panel-2 hover:text-text" title="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={13} />
          </button>
        </div>
        <div className="flex-1 overflow-auto p-1">
          {roots.length === 0 && <div className="p-3 text-[12px] text-muted">No repositories in this workspace yet.</div>}
          {roots.map((r) => (
            <div key={r.path} className="mb-2">
              <div className="flex items-center gap-1.5 px-1 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted" title={r.path}>
                {r.label}
                {Object.keys(status[r.path] ?? {}).length > 0 && <span className="rounded-full bg-warn/20 px-1.5 text-[10px] font-semibold normal-case text-warn">{Object.keys(status[r.path]).length} changed</span>}
              </div>
              {trees[r.path] ? renderNodes(r.path, trees[r.path], 0) : <div className="px-3 py-1 text-[11px] text-muted"><Spinner /></div>}
            </div>
          ))}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-[13px] text-muted">Pick a file to read it. Changed files are highlighted; the agent edits land here as they happen.</div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[12px]">
              <span className="truncate font-mono" title={selected}>
                {rel(selected)}
              </span>
              {content && <span className="shrink-0 text-muted">{fmtSize(content.size)}</span>}
              <span className="ml-auto flex shrink-0 items-center gap-1">
                <Button size="sm" variant="ghost" title="Add a reference to this file to the message" onClick={() => setDraft(workspaceId, `${draft}${draft && !draft.endsWith(' ') ? ' ' : ''}@${rel(selected)} `)}>
                  <MessageSquarePlus size={12} /> To message
                </Button>
                <Button size="sm" variant="ghost" title="Copy the absolute path" onClick={() => void navigator.clipboard.writeText(selected)}>
                  <Copy size={12} />
                </Button>
                <Button size="sm" variant="ghost" title="Open in the default app" onClick={() => void api.invoke('fs:open', workspaceId, selected).catch((e) => setError(String(e)))}>
                  <ExternalLink size={12} /> Open
                </Button>
                <Button size="sm" variant="ghost" title="Reveal in Finder" onClick={() => void api.invoke('fs:reveal', workspaceId, selected)}>
                  Finder
                </Button>
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto bg-bg">
              {!content && <div className="p-3 text-[12px] text-muted"><Spinner /></div>}
              {content?.binary && <div className="p-4 text-[12px] text-muted">Binary file ({fmtSize(content.size)}). Open it in its app instead.</div>}
              {content && !content.binary && (
                <div className="font-mono text-[11.5px] leading-[1.5]">
                  {content.text.split('\n').map((line, i) => (
                    <div key={i} className="flex">
                      <span className="w-12 shrink-0 select-none border-r border-border px-2 text-right text-muted/60">{i + 1}</span>
                      <pre className="m-0 whitespace-pre px-3">{line || ' '}</pre>
                    </div>
                  ))}
                  {content.truncated && <div className="px-3 py-2 text-[11px] text-muted">Showing the first 512 KB.</div>}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function patchTree(nodes: Node[], path: string, fn: (n: Node) => Node): Node[] {
  return nodes.map((n) => (n.path === path ? fn(n) : n.children ? { ...n, children: patchTree(n.children, path, fn) } : n))
}
