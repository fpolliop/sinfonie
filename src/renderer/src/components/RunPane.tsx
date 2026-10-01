import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Play, Square, Wrench, Trash2, Globe, Sparkles } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useScripts } from '@/stores/scripts'
import { friendlyError } from '@/lib/errors'
import { Badge, Button } from './ui'
import { GuidedRepoSetup } from './GuidedSetup'

export function RunPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const repos = useApp((s) => s.repos)
  const setError = useApp((s) => s.setError)
  const busy = useChat((s) => s.chats[workspaceId]?.busy ?? false)
  const { runs, key, clear } = useScripts()
  const [kind, setKind] = useState<'run' | 'setup'>('run')
  const [repoId, setRepoId] = useState(ws?.primaryRepoId ?? '')
  const preRef = useRef<HTMLPreElement>(null)
  const current = runs[key(workspaceId, repoId, kind)]

  useEffect(() => {
    const el = preRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [current?.output])

  if (!ws) return <div />
  const anyRunning = ws.repos.some((r) => runs[key(workspaceId, r.repoId, kind)]?.running)
  const repo = repos.find((r) => r.id === repoId)
  const script = repo?.config?.scripts?.[kind]
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(friendlyError(err))
    }
  }
  const notReady = ws.status === 'ready' ? null : ws.status === 'creating' ? 'Available once setup finishes.' : ws.status === 'error' ? 'Setup failed: retry setup in the banner above first.' : `The workspace is ${ws.status}.`
  // No script in the repository's sinfonie.json: the agent can write one on this branch (Run reads the worktree first).
  const askAgent = (): void => {
    const name = repo?.name ?? 'this repository'
    void useChat
      .getState()
      .send(
        workspaceId,
        `Set up how ${name} ${kind === 'run' ? 'starts' : 'installs'} in Sinfonie: add a sinfonie.json at the root of ${name} with a "${kind}" script${kind === 'run' ? ' that serves the app on $SINFONIE_PORT (this workspace has ports ' + ws.port + '–' + (ws.port + 9) + '), and "preview" if the page is not at the root' : ' that installs what the app needs (for example pnpm install)'}. Keep it to one command. Then ${kind === 'run' ? 'tell me, and I will press Run' : 'run it once to check it works'}.`
      )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <div className="flex rounded-md bg-panel p-0.5">
          {(['run', 'setup'] as const).map((k) => (
            <button key={k} onClick={() => setKind(k)} className={clsx('rounded px-2.5 py-0.5 text-[12px] capitalize', kind === k ? 'bg-panel-2' : 'text-muted')}>
              {k}
            </button>
          ))}
        </div>
        {anyRunning ? (
          <Button size="sm" variant="danger" onClick={() => go(() => api.invoke('workspaces:stopScript', workspaceId, kind))}>
            <Square size={12} /> Stop all
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={ws.status !== 'ready'} title={notReady ?? undefined} onClick={() => go(() => api.invoke('workspaces:runScript', workspaceId, kind))}>
            {kind === 'run' ? <Play size={12} /> : <Wrench size={12} />} {kind === 'run' ? 'Run all' : 'Setup all'}
          </Button>
        )}
        <span className="text-[11px] text-muted">
          {notReady ?? (
            <>
              Runs each repo's <code>{kind}</code> script from sinfonie.json with SINFONIE_PORT={ws.port}…{ws.port + 9}
            </>
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          title={`Open http://localhost:${ws.port} in the workspace browser`}
          onClick={() => go(async () => {
            await api.invoke('browser:open', workspaceId, `http://localhost:${ws.port}`)
            useApp.getState().setTab('browser')
          })}
        >
          <Globe size={12} /> Open in browser
        </Button>
        <Button size="sm" variant="ghost" onClick={() => clear(workspaceId, repoId, kind)}>
          <Trash2 size={12} /> Clear
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <aside className="w-[220px] max-w-[40%] shrink-0 border-r border-border">
          {ws.repos.map((r) => {
            const run = runs[key(workspaceId, r.repoId, kind)]
            const hasScript = Boolean(repos.find((x) => x.id === r.repoId)?.config?.scripts?.[kind])
            return (
              <button key={r.repoId} onClick={() => setRepoId(r.repoId)} className={clsx('flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]', r.repoId === repoId ? 'bg-panel-2' : 'hover:bg-panel')}>
                <span className="truncate">{r.repoName}</span>
                <span className="ml-auto">
                  {run?.running ? <Badge tone="ok">running</Badge> : run?.exitCode != null ? <Badge tone={run.exitCode === 0 ? 'muted' : 'danger'}>exit {run.exitCode}</Badge> : !hasScript ? <Badge>no script</Badge> : null}
                </span>
              </button>
            )
          })}
        </aside>
        {!current?.output && !script && repo ? (
          <div className="min-w-0 flex-1 overflow-auto p-4 text-[12px]">
            <p className="mb-1 text-[13px] font-medium">No {kind} script for {repo.name} yet</p>
            <p className="mb-3 max-w-[72ch] text-muted">
              {kind === 'run' ? 'Run starts each repository’s app on this workspace’s port and opens it in Preview.' : 'Setup runs once when a workspace is created, for example to install dependencies.'} Scripts live in the repository’s sinfonie.json. Write them below, or let the agent add one on this branch.
            </p>
            <div className="mb-3 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" disabled={ws.status !== 'ready' || busy} title={busy ? 'The agent is busy; try when it finishes' : notReady ?? undefined} onClick={askAgent}>
                <Sparkles size={12} aria-hidden /> Ask the agent to set it up
              </Button>
            </div>
            <div className="max-w-[640px]">
              <GuidedRepoSetup key={repo.id} repo={repo} />
            </div>
          </div>
        ) : (
          <pre ref={preRef} className="min-w-0 flex-1 overflow-auto bg-sunken p-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap">
            {current?.output || `$ ${script}\n(not started)`}
          </pre>
        )}
      </div>
    </div>
  )
}
