import React, { useEffect, useState } from 'react'
import { Check, Copy, Smartphone, Unlink } from 'lucide-react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { Badge, Button, Field, inputCls } from './ui'
import type { RemoteSettings, RemoteStatus } from '@shared/types'

const EMPTY: RemoteSettings = {}

/**
 * Application → Phone: pair a phone with this Mac. The QR carries the pairing key in the URL
 * fragment; the relay only ever sees encrypted envelopes and notification titles.
 */
export function RemotePage(): React.JSX.Element {
  const remote = useApp((s) => s.settings.remote)
  const settings = remote ?? EMPTY
  const setError = useApp((s) => s.setError)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [pairing, setPairing] = useState<{ url: string; qrSvg: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    void api.invoke('remote:status').then(setStatus)
    return api.on('remote:status', setStatus)
  }, [])
  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const pair = (): Promise<void> =>
    run(async () => {
      setPairing(await api.invoke('remote:pair'))
      setStatus(await api.invoke('remote:status'))
    })
  const unpair = (): Promise<void> =>
    run(async () => {
      setPairing(null)
      setStatus(await api.invoke('remote:unpair'))
    })
  const update = (patch: Record<string, unknown>): void => {
    void api.invoke('remote:updateSettings', patch).catch((err) => setError(err instanceof Error ? err.message : String(err)))
  }
  const copy = async (): Promise<void> => {
    if (!pairing) return
    await navigator.clipboard.writeText(pairing.url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-[820px]">
      <section className="mb-5 rounded-lg border border-border p-3">
        <div className="flex items-center gap-2 text-[13px]">
          <Smartphone size={14} className="text-muted" />
          <span className="font-medium">{status?.paired ? 'Phone paired' : 'No phone paired'}</span>
          {status?.paired && <Badge tone={status.connected ? 'ok' : 'warn'}>{status.connected ? 'relay connected' : 'relay offline'}</Badge>}
          {status?.paired && status.connected && <Badge>{status.phones} phone{status.phones === 1 ? '' : 's'} online</Badge>}
          <span className="ml-auto flex items-center gap-1">
            {status?.paired ? (
              <>
                <Button size="sm" disabled={busy} onClick={() => void pair()}>
                  Show QR again
                </Button>
                <Button size="sm" variant="danger" disabled={busy} onClick={() => void unpair()} title="Forget the key; paired phones stop working">
                  <Unlink size={12} /> Unpair
                </Button>
              </>
            ) : (
              <Button size="sm" variant="primary" disabled={busy} onClick={() => void pair()}>
                Pair a phone
              </Button>
            )}
          </span>
        </div>
        {status?.lastError && <div className="mt-1 text-[12px] text-warn">{status.lastError}</div>}
        {pairing && (
          <div className="mt-3 flex gap-4">
            <div className="h-[220px] w-[220px] shrink-0 rounded-md bg-panel-2 p-2 [&>svg]:h-full [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: pairing.qrSvg }} />
            <div className="text-[12px] text-muted">
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>Install Sinfonie on the phone (App Store or Google Play) and scan this code from its Pair screen.</li>
                <li>Or scan it with the camera: it opens sinfonie.dev/m, a web version you can add to the home screen.</li>
                <li>Tap "Enable notifications" on the phone so it can wake you when an agent needs you.</li>
              </ol>
              <p className="mt-2">The link holds the pairing key, so treat it like a password. Anyone who has it can read and reply to your workspaces. Unpair here if a phone is lost.</p>
              <Button size="sm" className="mt-2" onClick={() => void copy()}>
                {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy link instead'}
              </Button>
            </div>
          </div>
        )}
        {!pairing && !status?.paired && (
          <p className="mt-2 text-[12px] text-muted">Continue conversations from your phone and get a push when an agent waits for permission, asks a question, or finishes. Messages are encrypted end to end between the Mac and the phone; sinfonie.dev relays them and sees only notification titles.</p>
        )}
      </section>

      <section className="rounded-lg border border-border p-3">
        <div className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted">Notifications</div>
        <Field label="Only when I have been away from the Mac for" hint="Prompts and results are pushed only if the Mac has had no input for this long. Set 0 to always push.">
          <div className="flex items-center gap-2">
            <input type="number" min={0} max={120} className={`${inputCls} w-24`} value={settings.awayMinutes ?? 1} onChange={(e) => update({ awayMinutes: Math.max(0, Math.min(120, Number(e.target.value) || 0)) })} />
            <span className="text-[12px] text-muted">minutes</span>
          </div>
        </Field>
        <div className="mt-2 space-y-1.5 text-[13px]">
          {(
            [
              ['notifyPrompts', 'Permission prompts and questions'],
              ['notifyFinished', 'Agent finished a turn'],
              ['notifyErrors', 'Errors']
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">
              <input type="checkbox" checked={settings[k] !== false} onChange={(e) => update({ [k]: e.target.checked })} />
              {label}
            </label>
          ))}
        </div>
        <p className="mt-3 text-[11px] text-muted">While a phone is connected and an agent is running, Sinfonie keeps the Mac from sleeping. The lid still has to stay open, or the Mac connected to power with sleep disabled in System Settings.</p>
      </section>
    </div>
  )
}
