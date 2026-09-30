/**
 * A new Sinfonie release, on every screen: a Rail item that appears when the update needs the person (to download,
 * to restart, or because it failed), opening this card. State lives in stores/updates, subscribed once for the app.
 */
import React from 'react'
import { api } from '@/lib/api'
import { useApp } from '@/stores/app'
import { useUpdates } from '@/stores/updates'
import { friendlyError } from '@/lib/errors'
import type { UpdateInfo } from '@shared/types'

const primary = 'rounded-md bg-primary px-2 py-1 text-[11px] text-white hover:bg-primary-hover'
const quiet = 'text-[11px] text-muted hover:text-text'

export function UpdateCard({ info, onClose }: { info: UpdateInfo; onClose?: () => void }): React.JSX.Element {
  const setError = useApp((s) => s.setError)
  const dismiss = useUpdates((s) => s.dismiss)
  const download = (): void => {
    api.invoke('updates:download').catch((err) => setError(err))
  }
  const manual = (): void => void api.invoke('shell:openExternal', info.url || info.releaseUrl)
  const later = (key: string): void => {
    dismiss(key)
    onClose?.()
  }
  return (
    <div className="rounded-lg border border-accent/40 bg-accent/10 p-2 text-[12px]">
      {info.state === 'available' && (
        <>
          <div className="mb-1 font-medium">Sinfonie {info.version} is available</div>
          <div className="mb-2 text-[11px] text-muted">You have {info.current}. The update downloads in the background; you restart when it is ready.</div>
          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={download}>
              Download
            </button>
            <button className={quiet} onClick={() => void api.invoke('shell:openExternal', info.releaseUrl)}>
              What's new
            </button>
            <button className={`ml-auto ${quiet}`} onClick={() => later(info.version)}>
              Later
            </button>
          </div>
        </>
      )}
      {info.state === 'downloading' && (
        <>
          <div className="mb-1 font-medium">{info.auto ? `Getting Sinfonie ${info.version} ready…` : `Downloading Sinfonie ${info.version}…`}</div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-panel-2" role="progressbar" aria-valuenow={info.percent ?? 0} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full rounded-full bg-accent transition-all duration-300" style={{ width: `${info.percent ?? 0}%` }} />
          </div>
          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted">
            <span>{info.percent ?? 0}%</span>
            <button className={`ml-auto ${quiet}`} onClick={manual} title="Get the installer from the release page instead">
              Download manually
            </button>
            <button className={quiet} onClick={() => void api.invoke('updates:cancel').catch((err) => setError(err))}>
              Cancel
            </button>
          </div>
        </>
      )}
      {info.state === 'ready' && (
        <>
          <div className="mb-1 font-medium">Sinfonie {info.version} is ready</div>
          <div className="mb-2 text-[11px] text-muted">
            {info.installWhenIdle ? 'It restarts by itself once nothing is running and you have stepped away for a minute. Work carries on where it was.' : 'Restart to start using it. Work carries on where it was.'}
          </div>
          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={() => void api.invoke('updates:install').catch((err) => setError(err))}>
              Restart to update
            </button>
            {info.installWhenIdle ? (
              <button className={quiet} onClick={() => void api.invoke('updates:installWhenIdle', false)}>
                Cancel automatic restart
              </button>
            ) : (
              <button className="rounded-md border border-border px-2 py-1 text-[11px] hover:bg-panel-2" title="Restarts when nothing is running and you have been away for a minute" onClick={() => void api.invoke('updates:installWhenIdle', true)}>
                Restart when idle
              </button>
            )}
            <button className={`ml-auto ${quiet}`} onClick={() => later(`${info.version}@ready`)} title="The update installs the next time you quit">
              On next quit
            </button>
          </div>
        </>
      )}
      {info.state === 'error' && (
        <>
          <div className="mb-1 font-medium">{info.phase === 'install' ? `Couldn't install ${info.version}` : `Couldn't download ${info.version}`}</div>
          <div className="mb-2 text-[11px] text-muted">
            {info.phase === 'install' ? 'Move Sinfonie to your Applications folder and try again, or download it manually.' : friendlyError(info.error ?? '', 'The download stopped. Try again, or download it manually.')}
          </div>
          {info.error && (
            <details className="mb-2" data-expert-ok="">
              <summary className="w-fit cursor-pointer select-none text-[11px] text-muted hover:text-text">Show details</summary>
              <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-muted">{info.error}</pre>
            </details>
          )}
          <div className="flex flex-wrap gap-2">
            <button className={primary} onClick={info.phase === 'install' ? () => void api.invoke('updates:install').catch((err) => setError(err)) : download}>
              Try again
            </button>
            <button className={quiet} onClick={manual}>
              Download manually
            </button>
            {onClose && (
              <button className={`ml-auto ${quiet}`} onClick={onClose}>
                Close
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
