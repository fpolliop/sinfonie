/**
 * Claude Design, phase 1: the designs linked to a workspace, in the workspace panel next to Preview.
 *
 * A design is a canvas link and/or the artboards exported from it. Sinfonie's agents can't open a canvas
 * (only the Claude app has that tool), so "Build this design" sends the exported artboards as images with a
 * short brief. The canvas itself opens in this space's browser, which needs the person's claude.ai sign-in.
 */
import React, { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { ExternalLink, FileText, Globe, ImagePlus, Link2, PenTool, Send, Trash2, X } from 'lucide-react'
import type { DesignLink } from '@shared/types'
import { api } from '@/lib/api'
import { friendlyError } from '@/lib/errors'
import { useGuided } from '@/lib/guided'
import { timeAgo } from '@/lib/format'
import { useApp } from '@/stores/app'
import { Button, Dialog, IconButton, Spinner, inputCls } from './ui'

export function DesignPane({ workspaceId }: { workspaceId: string }): React.JSX.Element {
  const guided = useGuided()
  const notify = useApp((s) => s.notify)
  const setTab = useApp((s) => s.setTab)
  const [designs, setDesigns] = useState<DesignLink[] | null>(null)
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<{ url: string; name: string } | null>(null)
  const art = guided ? 'screens' : 'artboards'

  const run = useCallback((p: Promise<DesignLink[]>) => {
    setError(null)
    void p.then(setDesigns).catch((err) => setError(friendlyError(err)))
  }, [])
  useEffect(() => run(api.invoke('designs:list', workspaceId)), [workspaceId, run])

  const link = (): void => {
    if (!url.trim()) return
    run(api.invoke('designs:link', workspaceId, url.trim()))
    setUrl('')
  }
  const openHere = (u: string): void => {
    void api
      .invoke('browser:open', workspaceId, u)
      .then(() => setTab('browser'))
      .catch((err) => setError(friendlyError(err)))
  }

  // Exported artboards dropped anywhere on the pane become a new design (or join the only one there is).
  const onDrop = (e: React.DragEvent): void => {
    const files = Array.from(e.dataTransfer.files).filter((f) => /\.(png|jpe?g|webp|pdf)$/i.test(f.name))
    if (!files.length) return
    e.preventDefault()
    void Promise.all(files.map(async (f) => ({ name: f.name, data: await toBase64(f) }))).then((list) => run(api.invoke('designs:addData', workspaceId, list, designs?.length === 1 ? designs[0].id : undefined)))
  }

  return (
    <div className="flex h-full flex-col" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {zoom && (
        <Dialog title={zoom.name} onClose={() => setZoom(null)} width={1100}>
          <img src={zoom.url} alt={zoom.name} className="max-h-[75vh] w-full object-contain" />
        </Dialog>
      )}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted">Design</span>
        <span className="ml-auto" />
        <label className="relative flex min-w-0 flex-1 items-center">
          <Link2 size={12} className="pointer-events-none absolute left-2 text-muted" aria-hidden />
          <input
            className={clsx(inputCls, 'h-[26px] py-0 pl-6 text-[12px]')}
            placeholder={guided ? 'Paste the link to your design' : 'Paste a Claude Design canvas link'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && link()}
            aria-label="Design link"
          />
        </label>
        <Button size="sm" variant="ghost" onClick={link} disabled={!url.trim()}>
          Link
        </Button>
        <Button size="sm" variant="ghost" onClick={() => run(api.invoke('designs:addFiles', workspaceId))}>
          <ImagePlus size={13} aria-hidden /> Add {art}
        </Button>
      </div>
      {error && (
        <div role="alert" className="border-b border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!designs && (
          <div className="flex items-center gap-2 py-10 text-[12px] text-muted">
            <Spinner /> Loading designs…
          </div>
        )}
        {designs?.length === 0 && (
          <div className="mx-auto max-w-[60ch] py-10 text-center text-[13px] text-muted">
            <PenTool size={22} className="mx-auto mb-3" aria-hidden />
            {guided
              ? 'Add the design you want built: paste its link, and add the screens you exported from it (PNG, JPG or PDF). Then press Build this design.'
              : 'Link a Claude Design canvas, and add (or drop here) the artboards you exported from it as PNG or PDF. The agent builds from the artboards; it cannot open the canvas itself.'}
          </div>
        )}
        {designs?.map((d) => (
          <DesignCard key={d.id} workspaceId={workspaceId} design={d} art={art} guided={guided} onChange={setDesigns} onError={setError} onZoom={setZoom} onOpenHere={openHere} notify={(text) => notify({ kind: 'success', text })} />
        ))}
      </div>
    </div>
  )
}

function toBase64(f: File): Promise<string> {
  return f.arrayBuffer().then((b) => {
    let bin = ''
    const bytes = new Uint8Array(b)
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(bin)
  })
}

function DesignCard({
  workspaceId,
  design: d,
  art,
  guided,
  onChange,
  onError,
  onZoom,
  onOpenHere,
  notify
}: {
  workspaceId: string
  design: DesignLink
  art: string
  guided: boolean
  onChange: (d: DesignLink[]) => void
  onError: (e: string) => void
  onZoom: (z: { url: string; name: string }) => void
  onOpenHere: (url: string) => void
  notify: (text: string) => void
}): React.JSX.Element {
  const [title, setTitle] = useState(d.title)
  const [notes, setNotes] = useState(d.notes ?? '')
  const [extra, setExtra] = useState('')
  const [sending, setSending] = useState(false)
  useEffect(() => setNotes(d.notes ?? ''), [d.notes])
  const call = (p: Promise<DesignLink[]>): void => void p.then(onChange).catch((err) => onError(friendlyError(err)))
  const images = d.files.filter((f) => f.kind === 'image')
  const pdfs = d.files.filter((f) => f.kind === 'pdf')
  const canBuild = d.files.length > 0 || Boolean(d.url)

  const build = (): void => {
    setSending(true)
    void api
      .invoke('designs:build', workspaceId, d.id, extra)
      .then(() => {
        setExtra('')
        notify(guided ? 'Sent the design. Follow along in the chat.' : `Sent "${d.title}" to the agent with ${images.length} ${art}.`)
        return api.invoke('designs:list', workspaceId).then(onChange)
      })
      .catch((err) => onError(friendlyError(err)))
      .finally(() => setSending(false))
  }

  return (
    <section className="mb-3 rounded-lg border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <input
          className="min-w-0 flex-1 bg-transparent text-[13px] font-semibold outline-none"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title !== d.title && call(api.invoke('designs:update', workspaceId, d.id, { title }))}
          aria-label="Design name"
        />
        <span className="shrink-0 text-[11px] text-muted">{d.sentAt ? `sent ${timeAgo(d.sentAt)}` : `added ${timeAgo(d.linkedAt)}`}</span>
        <IconButton label={`Unlink ${d.title}`} onClick={() => call(api.invoke('designs:remove', workspaceId, d.id))}>
          <Trash2 size={13} />
        </IconButton>
      </div>
      <div className="space-y-3 p-3">
        {d.url && (
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            <code className="min-w-0 flex-1 truncate text-muted" title={d.url}>
              {d.url}
            </code>
            <Button size="sm" variant="ghost" onClick={() => onOpenHere(d.url!)} title="Opens in this space's browser; sign in to claude.ai there once">
              <Globe size={12} aria-hidden /> Open here
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void api.invoke('shell:openExternal', d.url!)}>
              <ExternalLink size={12} aria-hidden /> Open in Claude
            </Button>
          </div>
        )}
        {d.url && <div className="text-[11px] text-muted">Opening it here needs your claude.ai sign-in in this space&apos;s browser (once). The agent works from the exported {art}, not from the link.</div>}
        {images.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-2">
            {images.map((f) => (
              <figure key={f.id} className="group relative overflow-hidden rounded-md border border-border bg-bg">
                <button type="button" className="block w-full" onClick={() => onZoom({ url: f.url!, name: f.name })} title={`Show ${f.name}`}>
                  <img src={f.url} alt={f.name} className="h-28 w-full object-contain" />
                </button>
                <figcaption className="truncate px-2 py-1 text-[11px] text-muted">{f.name}</figcaption>
                <IconButton label={`Remove ${f.name}`} className="reveal-on-focus absolute right-1 top-1 bg-panel/80 opacity-0 group-hover:opacity-100" onClick={() => call(api.invoke('designs:removeFile', workspaceId, d.id, f.id))}>
                  <X size={12} />
                </IconButton>
              </figure>
            ))}
          </div>
        )}
        {pdfs.length > 0 && (
          <ul className="flex flex-wrap gap-2">
            {pdfs.map((f) => (
              <li key={f.id} className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[12px]">
                <FileText size={12} aria-hidden />
                <button type="button" className="hover:text-accent" onClick={() => void api.invoke('designs:openFile', workspaceId, d.id, f.id).catch((err) => onError(friendlyError(err)))}>
                  {f.name}
                </button>
                <IconButton label={`Remove ${f.name}`} onClick={() => call(api.invoke('designs:removeFile', workspaceId, d.id, f.id))}>
                  <X size={12} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}
        <Button size="sm" variant="ghost" onClick={() => call(api.invoke('designs:addFiles', workspaceId, d.id))}>
          <ImagePlus size={12} aria-hidden /> Add {art}
        </Button>
        <label className="block">
          <span className="mb-1 block text-[11px] font-medium text-muted">{guided ? 'Where these screens go (the agent adds to this)' : 'Where each artboard maps: repository, route, component (the agent adds to this)'}</span>
          <textarea
            className={clsx(inputCls, 'h-16 resize-y text-[12px]')}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => notes !== (d.notes ?? '') && call(api.invoke('designs:update', workspaceId, d.id, { notes }))}
            placeholder={guided ? 'e.g. The checkout screen is the payment page' : 'e.g. Checkout → web, /checkout, components/Checkout.tsx'}
          />
        </label>
        <div className="flex items-center gap-2">
          <input className={clsx(inputCls, 'h-[30px] min-w-0 flex-1 py-0 text-[12px]')} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Anything to add (optional)" aria-label="Instructions to send with the design" />
          <Button variant="primary" onClick={build} disabled={!canBuild || sending} title={canBuild ? undefined : `Add the exported ${art} first`}>
            {sending ? <Spinner /> : <Send size={13} aria-hidden />} Build this design
          </Button>
        </div>
      </div>
    </section>
  )
}
