import React, { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Play, Square, Wrench, Trash2, Globe } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useScripts } from '@/stores/scripts'
import { Badge, Button } from './ui'

export function RunPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const ws = useApp((s) => s.workspaces.find((w) => w.id === workspaceId))
  const repos = useApp((s) => s.repos)
  const setError = useApp((s) => s.setError)
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
  const script = repos.find((r) => r.id === repoId)?.config?.scripts?.[kind]
  const go = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
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
          <Button size="sm" variant="primary" disabled={ws.status !== 'ready'} onClick={() => go(() => api.invoke('workspaces:runScript', workspaceId, kind))}>
            {kind === 'run' ? <Play size={12} /> : <Wrench size={12} />} {kind === 'run' ? 'Run all' : 'Setup all'}
          </Button>
        )}
        <span className="text-[11px] text-muted">
          Runs each repo's <code>{kind}</code> script from sinfonie.json with SINFONIE_PORT={ws.port}…{ws.port + 9}
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
        <aside className="w-[220px] shrink-0 border-r border-border">
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
        <pre ref={preRef} className="min-w-0 flex-1 overflow-auto bg-[#0b0d11] p-3 font-mono text-[12px] leading-[18px] whitespace-pre-wrap">
          {current?.output || (script ? `$ ${script}\n(not started)` : 'No script configured. Add a sinfonie.json to the repo:\n\n{\n  "scripts": {\n    "setup": "pnpm install",\n    "run": "pnpm dev --port $SINFONIE_PORT",\n    "archive": "..."\n  }\n}')}
        </pre>
      </div>
    </div>
  )
}
