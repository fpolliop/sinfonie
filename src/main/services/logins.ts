/**
 * Import logins from the user's Chromium browsers (Chrome, Arc, Brave, Edge) into a space's in-app
 * browser session, so they — and the agent — land already signed in instead of logging in again.
 *
 * How it works, all on the user's own machine and only on an explicit action: each browser stores its
 * cookies in a SQLite file, encrypted with an AES key kept in the macOS Keychain ("<Browser> Safe
 * Storage"). We read that key (which prompts for Keychain access the first time), copy the cookie DB,
 * read it with the system `sqlite3`, decrypt each value, and seed it into `persist:browser-<space>`.
 * It is a one-time snapshot, not a live sync. macOS only; other platforms report nothing to import.
 */
import { session } from 'electron'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { existsSync, mkdtempSync, copyFileSync, rmSync } from 'fs'
import { join, dirname } from 'path'
import { homedir, tmpdir } from 'os'
import { createHash, createDecipheriv, pbkdf2Sync } from 'crypto'
import type { LoginBrowser } from '@shared/types'

const exec = promisify(execFile)

interface BrowserDef {
  id: LoginBrowser['id']
  name: string
  /** Folder under ~/Library/Application Support that holds the profiles. */
  dir: string
  /** macOS Keychain service name holding the cookie-encryption key. */
  keychain: string
}
const BROWSERS: BrowserDef[] = [
  { id: 'chrome', name: 'Google Chrome', dir: 'Google/Chrome', keychain: 'Chrome Safe Storage' },
  { id: 'arc', name: 'Arc', dir: 'Arc/User Data', keychain: 'Arc Safe Storage' },
  { id: 'brave', name: 'Brave', dir: 'BraveSoftware/Brave-Browser', keychain: 'Brave Safe Storage' },
  { id: 'edge', name: 'Microsoft Edge', dir: 'Microsoft Edge', keychain: 'Microsoft Edge Safe Storage' }
]

const supportDir = (): string => join(homedir(), 'Library', 'Application Support')

/** The cookie DB for the browser's main profile, preferring Default; newer Chromium keeps it under Network/. */
function cookieDb(b: BrowserDef): string | null {
  const base = join(supportDir(), b.dir)
  if (!existsSync(base)) return null
  for (const profile of ['Default', 'Profile 1', 'Profile 2']) {
    for (const c of [join(base, profile, 'Network', 'Cookies'), join(base, profile, 'Cookies')]) {
      if (existsSync(c)) return c
    }
  }
  return null
}

/** Which supported browsers are installed with cookies to import. macOS only. */
export function detect(): LoginBrowser[] {
  if (process.platform !== 'darwin') return BROWSERS.map((b) => ({ id: b.id, name: b.name, available: false }))
  return BROWSERS.map((b) => ({ id: b.id, name: b.name, available: cookieDb(b) !== null }))
}

async function keychainKey(b: BrowserDef): Promise<Buffer> {
  let pw: string
  try {
    const { stdout } = await exec('security', ['find-generic-password', '-w', '-s', b.keychain])
    pw = stdout.trim()
  } catch {
    throw new Error(`Could not read ${b.name}'s encryption key from the Keychain. Allow access when macOS asks, then try again.`)
  }
  if (!pw) throw new Error(`${b.name} has no encryption key in the Keychain — is it set up on this Mac?`)
  return pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1')
}

/** Chromium stores time as microseconds since 1601-01-01; convert to unix seconds. 0 = session cookie. */
function toUnixSeconds(t: number): number | undefined {
  if (!t || Number.isNaN(t)) return undefined
  return Math.round(t / 1_000_000 - 11_644_473_600)
}

function decryptValue(enc: Buffer, key: Buffer, host: string): string | null {
  if (enc.length < 4) return enc.toString('utf8')
  const scheme = enc.subarray(0, 3).toString('ascii')
  if (scheme !== 'v10' && scheme !== 'v11') return enc.toString('utf8') // not encrypted by this key
  try {
    const iv = Buffer.alloc(16, 0x20)
    const d = createDecipheriv('aes-128-cbc', key, iv)
    d.setAutoPadding(false)
    let out = Buffer.concat([d.update(enc.subarray(3)), d.final()])
    const pad = out[out.length - 1]
    if (pad > 0 && pad <= 16) out = out.subarray(0, out.length - pad) // strip PKCS#7
    // Newer Chromium prepends a SHA-256 of the host to the plaintext; drop it when present.
    const h = createHash('sha256').update(host).digest()
    if (out.length >= 32 && out.subarray(0, 32).equals(h)) out = out.subarray(32)
    return out.toString('utf8')
  } catch {
    return null
  }
}

const US = '\x1f' // field separator; control chars never appear in cookie fields
const RS = '\x1e' // record separator

/** Import cookies from `browserId` into the space's browser session. Returns how many landed. */
export async function importLogins(spaceId: string | undefined, browserId: string): Promise<{ imported: number; skipped: number; browser: string }> {
  if (process.platform !== 'darwin') throw new Error('Importing logins is only supported on macOS.')
  const b = BROWSERS.find((x) => x.id === browserId)
  if (!b) throw new Error('Unknown browser.')
  const db = cookieDb(b)
  if (!db) throw new Error(`${b.name} is not installed on this Mac, or has no saved logins.`)
  const key = await keychainKey(b)

  const tmpDir = mkdtempSync(join(tmpdir(), 'sinfonie-cookies-'))
  const tmp = join(tmpDir, 'Cookies')
  let rows: string
  try {
    copyFileSync(db, tmp) // copy so we never touch the live DB, and read even while the browser runs
    const { stdout } = await exec('sqlite3', ['-readonly', '-separator', US, '-newline', RS, tmp, 'SELECT host_key,name,path,is_secure,is_httponly,expires_utc,quote(encrypted_value),value FROM cookies'], { maxBuffer: 128 * 1024 * 1024 })
    rows = stdout
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/EPERM|denied|operation not permitted/i.test(msg)) throw new Error(`macOS blocked reading ${b.name}'s data. Grant Sinfonie Full Disk Access in System Settings → Privacy & Security, then try again.`)
    throw new Error(`Could not read ${b.name}'s cookies: ${msg}`)
  } finally {
    try {
      rmSync(dirname(tmp), { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }

  const ses = session.fromPartition(`persist:browser-${spaceId || 'default'}`)
  let imported = 0
  let skipped = 0
  for (const row of rows.split(RS)) {
    if (!row) continue
    const c = row.split(US)
    if (c.length < 8) continue
    const [host, name, path, isSecure, isHttp, expires, encQ, rawVal] = c
    const enc = encQ.startsWith("X'") ? Buffer.from(encQ.slice(2, -1), 'hex') : Buffer.alloc(0)
    const value = enc.length ? decryptValue(enc, key, host) : rawVal || ''
    if (value == null || value === '' || !name) {
      skipped++
      continue
    }
    const secure = isSecure === '1'
    const hostNoDot = host.startsWith('.') ? host.slice(1) : host
    if (!hostNoDot) {
      skipped++
      continue
    }
    try {
      await ses.cookies.set({
        url: `${secure ? 'https' : 'http'}://${hostNoDot}${path || '/'}`,
        name,
        value,
        domain: host,
        path: path || '/',
        secure,
        httpOnly: isHttp === '1',
        expirationDate: toUnixSeconds(Number(expires))
      })
      imported++
    } catch {
      skipped++ // Electron rejects some cookies (invalid domain/url combos); skip them
    }
  }
  return { imported, skipped, browser: b.name }
}
