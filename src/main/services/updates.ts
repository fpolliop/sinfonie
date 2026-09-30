import { app, BrowserWindow, powerMonitor } from 'electron'
import { autoUpdater, CancellationToken } from 'electron-updater'
import { getStore } from '../store'
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
/** The download in flight, so Cancel can stop it. */
let downloadToken: CancellationToken | null = null
/** Set while quitAndInstall runs: an updater error then is an install failure, not a download one. */
let installing = false
let idleTimer: NodeJS.Timeout | null = null
let isIdle: () => boolean = () => true
/** Tell the updater how to know that nothing is running (agents, reviews, on-call); wired from ipc. */
export function setIdleProbe(fn: () => boolean): void {
  isIdle = fn
}
/** Restart into the downloaded update once no agent runs and the user has been away for a bit. */
export function installWhenIdle(on: boolean): void {
  if (idleTimer) clearInterval(idleTimer)
  idleTimer = null
  if (latest) send({ ...latest, installWhenIdle: on })
  if (!on) return
  idleTimer = setInterval(() => {
    if (latest?.state !== 'ready') return
    if (!isIdle() || powerMonitor.getSystemIdleTime() < 45) return
    if (idleTimer) clearInterval(idleTimer)
    idleTimer = null
    installUpdate()
  }, 20_000)
  idleTimer.unref()
}
/**
 * Signed builds update in place: electron-updater reads latest-mac.yml from the public releases
 * repo, downloads the zip (on its own unless auto-download is off), verifies its signature against
 * the running app, and swaps the bundle on restart: now, when idle, or on the next quit.
 */
function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.logger = { info: () => undefined, warn: (m) => console.warn('[updater]', m), error: (m) => console.error('[updater]', m), debug: () => undefined }
  autoUpdater.on('update-available', (u) => {
    const auto = getStore().get().settings.autoDownloadUpdates !== false
    send({ state: auto ? 'downloading' : 'available', auto, percent: 0, version: u.version, current: app.getVersion(), url: releaseUrl(u.version), releaseUrl: releaseUrl(u.version), notes: typeof u.releaseNotes === 'string' ? u.releaseNotes.slice(0, 2000) : '' })
    if (auto) startDownload().catch((err) => console.warn('[updater] auto-download', err))
  })
  // Progress only while a download is ours and live: a late event after Cancel must not flip the card back.
  autoUpdater.on('download-progress', (p) => latest && downloadToken && !downloadToken.cancelled && send({ ...latest, state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (u) => send({ state: 'ready', auto: latest?.auto, installWhenIdle: Boolean(idleTimer), version: u.version, current: app.getVersion(), url: releaseUrl(u.version), releaseUrl: releaseUrl(u.version), notes: latest?.notes ?? '' }))
  autoUpdater.on('error', (err) => {
    console.warn('[updater]', err.message)
    if (!latest) return
    // A restart that could not swap the app (most often: Sinfonie is not in Applications, or the disk image is still mounted).
    if (installing) {
      installing = false
      send({ ...latest, state: 'error', phase: 'install', error: err.message })
      return
    }
    // Only surface errors the user can act on: a failed download of an update they asked for (a cancel is not one).
    if (latest.state !== 'available' && !/cancel/i.test(err.message)) send({ ...latest, state: 'error', phase: 'download', error: err.message })
  })
}

/** Outcome of one explicit check: the update the banner shows (if any), or why the check could not tell. */
export interface UpdateCheckResult {
  update: UpdateInfo | null
  error?: string
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Ask GitHub what the latest release is (dev builds and packaged builds alike). */
export async function checkForUpdate(): Promise<UpdateInfo | null>
export async function checkForUpdate(opts: { report: true }): Promise<UpdateCheckResult>
export async function checkForUpdate(opts?: { report: true }): Promise<UpdateInfo | null | UpdateCheckResult> {
  const r = await runCheck()
  return opts?.report ? r : r.update
}

async function runCheck(): Promise<UpdateCheckResult> {
  if (app.isPackaged) {
    wire()
    try {
      const res = await autoUpdater.checkForUpdates()
      // electron-updater fires update-available (which fills `latest`) before resolving; without a newer
      // release it resolves with the current version and `latest` keeps whatever an earlier check found.
      const found = res?.updateInfo?.version
      if (found && newer(found, app.getVersion())) return { update: latest }
      return { update: latest && newer(latest.version, app.getVersion()) ? latest : null }
    } catch (err) {
      console.warn('update check failed', err)
      return { update: null, error: errorText(err) }
    }
  }
  // In development there is no app-update.yml, so just report what is out there.
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': `sinfonie/${app.getVersion()}`, Accept: 'application/vnd.github+json' } })
    if (!res.ok) return { update: null, error: `GitHub answered ${res.status}` }
    const rel = (await res.json()) as { tag_name: string; html_url: string; body?: string }
    const version = rel.tag_name.replace(/^v/, '')
    if (!newer(version, app.getVersion())) return { update: null }
    send({ state: 'available', version, current: app.getVersion(), url: rel.html_url, releaseUrl: rel.html_url, notes: (rel.body ?? '').slice(0, 2000) })
    return { update: latest }
  } catch (err) {
    console.warn('update check failed', err)
    return { update: null, error: errorText(err) }
  }
}

/** Start downloading the update the banner announced. Progress and completion arrive as update:available events. */
export async function downloadUpdate(): Promise<void> {
  if (!app.isPackaged) throw new Error('In-app updates only work in the installed app. Download it from the release page.')
  wire()
  if (latest) send({ ...latest, state: 'downloading', auto: false, percent: 0, error: undefined, phase: undefined })
  await startDownload()
}
async function startDownload(): Promise<void> {
  downloadToken?.cancel()
  const token = new CancellationToken()
  downloadToken = token
  try {
    await autoUpdater.downloadUpdate(token)
  } catch (err) {
    // A cancelled download is not a failure: cancelDownload already put the offer back.
    if (token.cancelled) return
    throw err
  } finally {
    if (downloadToken === token) downloadToken = null
  }
}

/** Stop the download in flight and offer the update again. */
export function cancelDownload(): void {
  downloadToken?.cancel()
  downloadToken = null
  if (latest && latest.state === 'downloading') send({ ...latest, state: 'available', auto: false, percent: 0 })
}

/** Quit and relaunch into the downloaded version. A failure shows on the update card with a manual download. */
export function installUpdate(): void {
  installing = true
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    installing = false
    if (latest) send({ ...latest, state: 'error', phase: 'install', error: errorText(err) })
    return
  }
  // quitAndInstall returns before the app quits; if nothing happened after a while, the swap failed quietly.
  setTimeout(() => {
    if (!installing) return
    installing = false
    if (latest) send({ ...latest, state: 'error', phase: 'install', error: 'The app did not restart into the update.' })
  }, 20_000).unref()
}

export function latestKnownUpdate(): UpdateInfo | null {
  return latest
}

export function startUpdateChecks(): void {
  if (!app.isPackaged) return
  setTimeout(() => void checkForUpdate(), 8_000)
  setInterval(() => void checkForUpdate(), INTERVAL_MS).unref()
}
