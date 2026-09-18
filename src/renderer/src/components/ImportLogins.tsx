import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { KeyRound, Loader2, Check, AlertTriangle } from 'lucide-react'
import { api } from '@/lib/api'
import type { LoginBrowser } from '@shared/types'
import { Button } from './ui'

/**
 * Import saved logins (cookies) from the user's Chrome / Arc / Brave / Edge into a space's in-app
 * browser, so they land already signed in. Renders a button per installed browser; returns null when
 * none are available (unless `alwaysShow`, which then explains why). macOS only.
 */
export function ImportLogins({ spaceId, onImported, alwaysShow }: { spaceId?: string; onImported?: () => void; alwaysShow?: boolean }): React.JSX.Element | null {
  const [browsers, setBrowsers] = useState<LoginBrowser[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    void api
      .invoke('logins:detect')
      .then(setBrowsers)
      .catch(() => setBrowsers([]))
  }, [])
  const available = (browsers ?? []).filter((b) => b.available)
  if (browsers === null) return null // still detecting
  if (available.length === 0) return alwaysShow ? <div className="text-[11px] text-muted">No Chrome, Arc, Brave or Edge logins found on this Mac to import.</div> : null

  const doImport = async (b: LoginBrowser): Promise<void> => {
    setBusy(b.id)
    setResult(null)
    try {
      const r = await api.invoke('logins:import', spaceId, b.id)
      setResult({ ok: true, text: r.imported > 0 ? `Imported ${r.imported} login${r.imported === 1 ? '' : 's'} from ${r.browser}. Reload the page to use them.` : `No logins found to import from ${r.browser}.` })
      if (r.imported > 0) onImported?.()
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className="flex flex-wrap items-center justify-center gap-2">
        {available.map((b) => (
          <Button key={b.id} size="sm" disabled={busy !== null} onClick={() => void doImport(b)}>
            {busy === b.id ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />} Import logins from {b.name}
          </Button>
        ))}
      </div>
      {result && (
        <div className={clsx('flex items-center gap-1 text-[11px]', result.ok ? 'text-ok' : 'text-warn')}>
          {result.ok ? <Check size={11} /> : <AlertTriangle size={11} />} {result.text}
        </div>
      )}
    </div>
  )
}
