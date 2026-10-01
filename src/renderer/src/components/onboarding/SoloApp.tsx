import React, { useEffect, useState } from 'react'
import { CheckCircle2, FolderOpen, Loader2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Button, inputCls } from '../ui'
import { friendlyError } from '@/lib/errors'
import { repoLabel } from '@/lib/labels'
import { addSoloPath, normalizeGithubLink, pickAppFolder } from '@/lib/soloApp'
import { ConnectGitHubCard, FixPrerequisiteCard } from '../ConnectGitHub'
import type { CloneFailure, CloneProgress } from '@shared/types'

/** What stands between the person and their app, with the one action that clears it. */
type Blocker =
  | { kind: 'clone'; failure: CloneFailure; message: string; url: string }
  | { kind: 'not-set-up'; path: string }
  | { kind: 'needs-git'; retry: () => void }

/**
 * Adds one app on its own: a folder on this Mac, or a GitHub link. Every dead end has one way forward:
 * a plain folder → "Set this folder up for Sinfonie"; a folder inside an app → its top folder, automatically;
 * git missing → install Apple's developer tools; a private app → Connect GitHub, then it downloads by itself;
 * the download folder taken → pick another name. Downloads show progress and can be cancelled.
 */
export function SoloApp({ source, onSpace, onAdded }: { source: 'mac' | 'github'; onSpace: (id: string) => void; onAdded?: () => void }): React.JSX.Element {
  const repos = useApp((s) => s.repos)
  const spaces = useApp((s) => s.spaces)
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [blocker, setBlocker] = useState<Blocker | null>(null)
  const [progress, setProgress] = useState<CloneProgress | null>(null)
  const [folderName, setFolderName] = useState('')
  const [added, setAdded] = useState<string[]>([])
  const mine = repos.filter((r) => added.includes(r.id))
  const personal = spaces.find((s) => !s.orgId && repos.some((r) => r.spaceId === s.id && added.includes(r.id)))
  useEffect(() => api.on('repos:cloneProgress', (p) => setProgress((cur) => (cur && cur.url === p.url ? p : cur))), [])

  const done = (repoId: string, spaceId: string): void => {
    setAdded((a) => (a.includes(repoId) ? a : [...a, repoId]))
    onSpace(spaceId)
    setLink('')
    setBlocker(null)
    onAdded?.()
  }

  /** A new attempt (or an edit of the link): the last attempt's "is ready" line and notes no longer apply. */
  const clearStatus = (): void => {
    setAdded([])
    setNote(null)
    setErr(null)
  }

  const addFolder = async (path: string): Promise<void> => {
    setBusy(true)
    clearStatus()
    try {
      const k = await api.invoke('repos:inspectFolder', path)
      if (k.kind === 'needs-git') return setBlocker({ kind: 'needs-git', retry: () => void addFolder(path) })
      if (k.kind === 'unsafe') return setErr('That folder holds much more than one app. Choose the folder of one app.')
      if (k.kind === 'not-repo') return setBlocker({ kind: 'not-set-up', path: k.path })
      if (k.kind === 'inside-repo') setNote(`That folder is part of a bigger app, so Sinfonie added the whole app (${k.path.split('/').pop()}).`)
      const { repo, spaceId } = await addSoloPath(k.path)
      done(repo.id, spaceId)
    } catch (e) {
      setErr(friendlyError(e, 'That folder is not an app Sinfonie can work with. Choose the folder that holds your whole app, or ask a teammate which one it is.'))
    } finally {
      setBusy(false)
    }
  }

  const setUp = async (path: string): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      const top = await api.invoke('repos:initFolder', path)
      const { repo, spaceId } = await addSoloPath(top)
      done(repo.id, spaceId)
    } catch (e) {
      setErr(friendlyError(e, 'Sinfonie could not set that folder up. Try again, or ask a teammate.'))
    } finally {
      setBusy(false)
    }
  }

  const download = async (raw: string, name?: string): Promise<void> => {
    const url = normalizeGithubLink(raw)
    clearStatus()
    if (!url) return setErr('That does not look like a GitHub link. Copy the address of the app’s GitHub page and paste it here.')
    setBusy(true)
    setBlocker(null)
    setProgress({ url, phase: 'starting' })
    try {
      const r = await api.invoke('repos:cloneApp', url, name)
      if (!r.ok) {
        if (r.kind === 'cancelled') return
        if (r.kind === 'needs-git') return setBlocker({ kind: 'needs-git', retry: () => void download(raw, name) })
        return setBlocker({ kind: 'clone', failure: r.kind, message: r.message, url: raw })
      }
      const { repo, spaceId } = await addSoloPath(r.path)
      done(repo.id, spaceId)
    } catch (e) {
      setErr(friendlyError(e, 'Sinfonie could not download that app. Check the link, and that your GitHub account can open it.'))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const pick = async (): Promise<void> => {
    const path = await pickAppFolder()
    if (path) await addFolder(path)
  }
  const cancel = (): void => {
    const url = progress?.url ?? normalizeGithubLink(link)
    if (url) void api.invoke('repos:cancelClone', url)
  }

  return (
    <div className="rounded-xl border border-border bg-panel/40 px-4 py-3">
      {source === 'mac' ? (
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-[12px] text-muted">Choose the top folder of your app, the one that holds all of its files.</div>
          <Button variant="primary" disabled={busy} onClick={() => void pick()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} {busy ? 'Adding…' : mine.length ? 'Add another app…' : 'Choose folder…'}
          </Button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (link.trim()) void download(link)
          }}
        >
          <input className={inputCls} aria-label="Link to your app on GitHub" placeholder="https://github.com/your-team/your-app" value={link} autoFocus disabled={busy} onChange={(e) => {
              setLink(e.target.value)
              clearStatus()
            }} />
          <Button type="submit" variant="primary" disabled={busy || !link.trim()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : null} {busy ? 'Downloading…' : 'Add app'}
          </Button>
        </form>
      )}
      {busy && source === 'github' && (
        <div role="status" className="mt-2 flex items-center gap-2 text-[12px] text-muted">
          <div className="h-1.5 w-40 overflow-hidden rounded-full bg-panel-2" aria-hidden>
            <div className="h-full rounded-full bg-accent transition-all" style={{ width: `${progress?.percent ?? 4}%` }} />
          </div>
          {progress?.phase === 'resolving' ? 'Almost done…' : progress?.percent !== undefined ? `Downloading your app… ${progress.percent}%` : 'Downloading your app. Large apps can take a minute.'}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={cancel}>
            Cancel
          </Button>
        </div>
      )}
      {blocker?.kind === 'needs-git' && <FixPrerequisiteCard what="xcode" className="mt-3" onFixed={blocker.retry} />}
      {blocker?.kind === 'not-set-up' && (
        <div className="mt-3 rounded-lg border border-border bg-bg px-3 py-2.5">
          <div className="text-[13px] font-medium">This folder is not set up for Sinfonie yet</div>
          <p className="mt-0.5 text-[12px] text-muted">Sinfonie keeps a history of every change so you can always go back. Setting the folder up starts that history; your files stay as they are.</p>
          <div className="mt-2 flex gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void setUp(blocker.path)}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : null} Set this folder up for Sinfonie
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => void pick()}>
              Choose another folder
            </Button>
          </div>
        </div>
      )}
      {blocker?.kind === 'clone' && blocker.failure === 'needs-github' && <ConnectGitHubCard className="mt-3" reason={blocker.message} onConnected={() => void download(blocker.url)} />}
      {blocker?.kind === 'clone' && blocker.failure === 'folder-exists' && (
        <form
          className="mt-3 rounded-lg border border-border bg-bg px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault()
            if (folderName.trim()) void download(blocker.url, folderName.trim())
          }}
        >
          <div className="text-[12px] text-muted">{blocker.message}</div>
          <div className="mt-2 flex items-center gap-2">
            <input className={inputCls} aria-label="New folder name" placeholder="e.g. my-app-2" value={folderName} autoFocus onChange={(e) => setFolderName(e.target.value)} />
            <Button type="submit" size="sm" variant="primary" disabled={busy || !folderName.trim()}>
              Download into this folder
            </Button>
          </div>
        </form>
      )}
      {blocker?.kind === 'clone' && !['needs-github', 'folder-exists'].includes(blocker.failure) && (
        <div role="alert" className="mt-3 flex items-center gap-2 text-[12px]">
          <span className="min-w-0 flex-1 text-danger">{blocker.message}</span>
          <Button size="sm" onClick={() => void download(blocker.url)} disabled={busy}>
            Try again
          </Button>
        </div>
      )}
      {err && (
        <p role="alert" className="mt-2 text-[12px] text-danger">
          {err}
        </p>
      )}
      {note && <p className="mt-2 text-[12px] text-muted">{note}</p>}
      {mine.length > 0 && (
        <div className="mt-3 flex flex-col gap-1">
          {mine.map((r) => (
            <div key={r.id} className="flex items-center gap-2 text-[13px]">
              <CheckCircle2 size={14} className="shrink-0 text-ok" /> {repoLabel(r)} is ready{personal ? ` in ${personal.name}` : ''}.
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
