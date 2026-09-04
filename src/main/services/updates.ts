import { app, BrowserWindow } from 'electron'
import type { UpdateInfo } from '@shared/types'

const REPO = 'fpolliop/sinfonie'
const INTERVAL_MS = 6 * 60 * 60 * 1000
let latest: UpdateInfo | null = null

function newer(a: string, b: string): boolean {
  const pa = a.replace(/^v/, '').split('.').map(Number)
  const pb = b.replace(/^v/, '').split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false
  }
  return false
}

/**
 * Unsigned builds cannot self-update on macOS, so this only tells the user a
 * newer release exists and hands them the download link.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { 'User-Agent': `sinfonie/${app.getVersion()}`, Accept: 'application/vnd.github+json' } })
    if (!res.ok) return null
    const rel = (await res.json()) as { tag_name: string; html_url: string; body?: string; assets?: { name: string; browser_download_url: string }[] }
    const version = rel.tag_name.replace(/^v/, '')
    if (!newer(version, app.getVersion())) return null
    const dmg = rel.assets?.find((a) => a.name.endsWith('.dmg') && a.name.includes(process.arch === 'arm64' ? 'arm64' : 'x64')) ?? rel.assets?.find((a) => a.name.endsWith('.dmg'))
    latest = { version, current: app.getVersion(), url: dmg?.browser_download_url ?? rel.html_url, releaseUrl: rel.html_url, notes: (rel.body ?? '').slice(0, 2000) }
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:available', latest)
    return latest
  } catch (err) {
    console.warn('update check failed', err)
    return null
  }
}

export function latestKnownUpdate(): UpdateInfo | null {
  return latest
}

export function startUpdateChecks(): void {
  if (!app.isPackaged) return
  setTimeout(() => void checkForUpdate(), 8_000)
  setInterval(() => void checkForUpdate(), INTERVAL_MS).unref()
}
