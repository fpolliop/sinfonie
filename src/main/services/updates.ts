import { app, BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from '@shared/types'

const REPO = 'fpolliop/sinfonie-releases'
const INTERVAL_MS = 6 * 60 * 60 * 1000
let latest: UpdateInfo | null = null

function send(info: UpdateInfo): void {
  latest = info
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:available', info)
}
function releaseUrl(version: string): string {
  return `https://github.com/${REPO}/releases/tag/v${version}`
}

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}

let wired = false
/**
 * Signed builds update in place: electron-updater reads latest-mac.yml from the public releases
 * repo, downloads the zip on request, verifies its signature against the running app, and swaps
 * the bundle on restart. Nothing downloads without the user pressing the button.
 */
function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: () => undefined, warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug: () => undefined }
  autoUpdater.on('update-available', (u) => send({ state: 'available', version: u.version, current: app.getVersion(), url: releaseUrl(u.version), releaseUrl: releaseUrl(u.version), notes: typeof u.releaseNotes === 'string' ? u.releaseNotes.slice(0, 2000) : '' }))
  autoUpdater.on('download-progress', (p) => latest && send({ ...latest, state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (u) => send({ state: 'ready', version: u.version, current: app.getVersion(), url: releaseUrl(u.version), releaseUrl: releaseUrl(u.version), notes: latest?.notes ?? '' }))
  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message)
    // Only surface errors the user can act on: a failed download of an update they asked for.
    if (latest && latest.state !== 'available') send({ ...latest, state: 'error', error: err.message })
  })
}

/** Ask GitHub what the latest release is (dev builds and packaged builds alike). */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  if (app.isPackaged) {
    wire()
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      console.warn('update check failed', err)
    }
    return latest
  }
  // In development there is no app-update.yml, so just report what is out there.
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': `sinfonie/${app.getVersion()}`, Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const rel = (await res.json()) as { tag_name: string; html_url: string; body?: string }
    const version = rel.tag_name.replace(/^v/, '')
    if (!newer(version, app.getVersion())) return null
    send({ state: 'available', version, current: app.getVersion(), url: rel.html_url, releaseUrl: rel.html_url, notes: (rel.body ?? '').slice(0, 2000) })
    return latest
  } catch (err) {
    console.warn('update check failed', err)
    return null
  }
}

/** Start downloading the update the banner announced. Progress and completion arrive as update:available events. */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) throw new Error('In-app updates only work in the installed app. Download it from the release page.')
  wire()
  if (latest) send({ ...latest, state: 'downloading', percent: 0 })
  await autoUpdater.downloadUpdate()
}

/** Quit and relaunch into the downloaded version. */
export function installUpdate(): void {
  autoUpdater.quitAndInstall(false, true)
}

export function latestKnownUpdate(): UpdateInfo | null {
  return latest
}

export function startUpdateChecks(): void {
  if (!app.isPackaged) return
  setTimeout(() => void checkForUpdate(), 8_000)
  setInterval(() => void checkForUpdate(), INTERVAL_MS).unref()
}
