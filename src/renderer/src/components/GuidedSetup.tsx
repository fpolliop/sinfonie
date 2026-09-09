import React, { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Wand2 } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import type { Repo, Space } from '@shared/types'
import { Button, Field, inputCls } from './ui'

/**
 * The tech lead's setup that makes a space usable by guided-mode teammates: a friendly name and a description
 * per app, its run/setup/check scripts and preview URL (written to the repo's sinfonie.json), and, on the
 * space, who reviews and how the assistant should behave. Everything here travels with the shared definition.
 */
export function GuidedRepoSetup({ repo }: { repo: Repo }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const setError = useApp((s) => s.setError)
  const [name, setName] = useState(repo.displayName ?? '')
  const [desc, setDesc] = useState(repo.description ?? '')
  const [scripts, setScripts] = useState({ setup: repo.config?.scripts?.setup ?? '', run: repo.config?.scripts?.run ?? '', check: repo.config?.scripts?.check ?? '' })
  const [preview, setPreview] = useState(repo.config?.preview ?? '')
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setSaved(false)
    try {
      await fn()
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const saveMeta = (): Promise<void> => run(() => api.invoke('repos:setMeta', repo.id, { displayName: name, description: desc }))
  const saveConfig = (): Promise<void> => run(() => api.invoke('repos:writeConfig', repo.id, { scripts, preview }))
  return (
    <div className="mt-1.5 rounded-md border border-border/70 bg-bg/40">
      <button className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] font-medium text-muted hover:text-text" onClick={() => setOpen(!open)}>
        <ChevronRight size={11} className={clsx('transition-transform', open && 'rotate-90')} />
        <Wand2 size={11} /> Guided setup
        {(repo.displayName || repo.config?.preview) && !open && <span className="ml-1 rounded-full bg-panel-2 px-1.5 text-[10px]">set</span>}
      </button>
      {open && (
        <div className="border-t border-border/70 p-3">
          <p className="mb-3 text-[11px] text-muted">What guided-mode teammates see for this app, and how it starts and is checked. Saved to the app’s sinfonie.json and shared with the team.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Friendly name" hint="Shown instead of the repo name.">
              <input className={inputCls} placeholder={repo.name} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => (name !== (repo.displayName ?? '') || desc !== (repo.description ?? '')) && void saveMeta()} />
            </Field>
            <Field label="Preview URL" hint="Opened in Preview. ${PORT} is the task's port.">
              <input className={inputCls} placeholder="http://localhost:${PORT}/" value={preview} onChange={(e) => setPreview(e.target.value)} />
            </Field>
          </div>
          <Field label="What this app is" hint="One line. The assistant uses it to pick the right apps for a task.">
            <input className={inputCls} placeholder="e.g. The customer-facing shop, Astro + Node" value={desc} onChange={(e) => setDesc(e.target.value)} onBlur={() => (name !== (repo.displayName ?? '') || desc !== (repo.description ?? '')) && void saveMeta()} />
          </Field>
          <div className="mt-1 grid grid-cols-1 gap-3">
            <Field label="Start the app (run)" hint="What serves the app. It runs with SINFONIE_PORT set.">
              <input className={inputCls} placeholder="pnpm dev --port $SINFONIE_PORT" value={scripts.run} onChange={(e) => setScripts((s) => ({ ...s, run: e.target.value }))} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="First-time setup (optional)" hint="Runs once when the task's folders are created.">
                <input className={inputCls} placeholder="pnpm install" value={scripts.setup} onChange={(e) => setScripts((s) => ({ ...s, setup: e.target.value }))} />
              </Field>
              <Field label="Check before review (optional)" hint="Build, tests, lint. A failure blocks Send for review.">
                <input className={inputCls} placeholder="pnpm build && pnpm test" value={scripts.check} onChange={(e) => setScripts((s) => ({ ...s, check: e.target.value }))} />
              </Field>
            </div>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" variant="primary" disabled={busy} onClick={() => void saveConfig()}>
              Save scripts
            </Button>
            {saved && <span className="text-[11px] text-ok">Saved</span>}
          </div>
        </div>
      )}
    </div>
  )
}

/** Space-level guided settings: reviewers and the assistant's instructions. */
export function GuidedSpaceSection({ space }: { space: Space }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const [reviewers, setReviewers] = useState((space.guided?.reviewers ?? []).join(', '))
  const [instructions, setInstructions] = useState(space.guided?.instructions ?? '')
  const [askChannel, setAskChannel] = useState(space.guided?.askChannel ?? '')
  const save = (patch: Partial<NonNullable<Space['guided']>>): void => {
    const next = { ...(space.guided ?? {}), ...patch }
    api.invoke('spaces:update', space.id, { guided: next }).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  return (
    <section className="mt-6 border-t border-border pt-4">
      <div className="mb-1 flex items-center gap-2 text-[12px] font-semibold">
        <Wand2 size={13} className="text-accent" /> Guided mode
      </div>
      <p className="mb-3 text-[11px] text-muted">For teammates who build with AI without writing code. These settings, and each app’s guided setup, travel with the space when you share it.</p>
      <Field label="Reviewers" hint="GitHub usernames, comma-separated. Requested on every pull request a guided task opens.">
        <input className={inputCls} placeholder="ana, diego" value={reviewers} onChange={(e) => setReviewers(e.target.value)} onBlur={() => save({ reviewers: reviewers.split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean) })} />
      </Field>
      <Field label="Instructions for the assistant" hint="Added to its prompt for guided tasks: product words to use, what not to touch, where things live.">
        <textarea className={`${inputCls} min-h-[90px]`} placeholder="Call the checkout the 'basket'. Never change anything under infra/. Copy lives in src/content." value={instructions} onChange={(e) => setInstructions(e.target.value)} onBlur={() => save({ instructions: instructions.trim() || undefined })} />
      </Field>
      <Field label="Questions channel" hint="Slack channel where a guided user's 'Ask a teammate' goes. Needs this space's Slack connected (Integrations).">
        <input className={inputCls} placeholder="#team-help" value={askChannel} onChange={(e) => setAskChannel(e.target.value)} onBlur={() => save({ askChannel: askChannel.trim().replace(/^#/, '') || undefined })} />
      </Field>
    </section>
  )
}
