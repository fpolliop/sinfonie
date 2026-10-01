import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { cpSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { getStore } from './store'
import { registerIpc } from './ipc'
import { startUpdateChecks } from './services/updates'
import * as browser from './services/browser/service'
import * as images from './services/images'
import * as slack from './services/slack'
import { adoptShellPath } from './services/shell-path'
import * as prereqs from './services/prereqs'
import type { CloneResult } from '@shared/types'
import type { SinfonieEvents } from '@shared/ipc'
import * as cloud from './services/cloud'
import * as orgSpaces from './services/org-spaces'
import * as remote from './services/remote'
import { installCrashHandlers, rendererConsoleError, logError, startUsagePings } from './services/telemetry'
import { Menu, nativeImage, nativeTheme } from 'electron'
import { checkForUpdate } from './services/updates'

function sendToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

/** Help → Check for Updates: the banner announces a newer release; otherwise say so here, since a silent click reads as broken. */
async function checkForUpdateFromMenu(): Promise<void> {
  const r = await checkForUpdate({ report: true })
  if (r.update) return
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const opts: Electron.MessageBoxOptions = r.error
    ? { type: 'warning', message: 'Could not check for updates', detail: r.error, buttons: ['OK'] }
    : { type: 'info', message: `You're on the latest version (${app.getVersion()}).`, buttons: ['OK'] }
  if (win) await dialog.showMessageBox(win, opts)
  else await dialog.showMessageBox(opts)
}

/** The mode the menu was last built for; the menu is rebuilt when Settings → mode changes. */
let menuMode: 'guided' | 'expert' = 'expert'

/**
 * Guided mode's menu speaks its words (New Task…); Maestro is in the menu in both modes.
 */
function buildMenu(): void {
  const guided = menuMode === 'guided'
  const settingsItem: Electron.MenuItemConstructorOptions = { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendToWindows('ui:openSettings', { scope: 'app', page: 'general' }) }
  const appMenu: Electron.MenuItemConstructorOptions =
    process.platform === 'darwin'
      ? {
          role: 'appMenu',
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            settingsItem,
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }
      : { role: 'appMenu' }
  // Packaged builds hide Reload, Force Reload and Developer Tools: they only confuse end users (and a reload drops the live agent state).
  const viewMenu: Electron.MenuItemConstructorOptions = app.isPackaged
    ? { label: 'View', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] }
    : { role: 'viewMenu' }
  const template: Electron.MenuItemConstructorOptions[] = [
    appMenu,
    {
      role: 'fileMenu',
      submenu: [
        { label: guided ? 'New Task…' : 'New Workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendToWindows('ui:newWorkspace', {}) },
        // Maestro is for everyone, under the same name, in both modes (docs/design/README.md, decision 1).
        { label: 'Maestro', accelerator: 'CmdOrCtrl+Shift+A', click: () => sendToWindows('ui:openMaestro', {}) },
        ...(process.platform === 'darwin' ? [{ type: 'separator' } as Electron.MenuItemConstructorOptions, { role: 'close' } as Electron.MenuItemConstructorOptions] : [{ type: 'separator' } as Electron.MenuItemConstructorOptions, settingsItem, { type: 'separator' } as Electron.MenuItemConstructorOptions, { role: 'quit' } as Electron.MenuItemConstructorOptions])
      ]
    },
    { role: 'editMenu' },
    viewMenu,
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Send Feedback…', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendToWindows('ui:openFeedback', { tab: 'feedback' }) },
        { label: 'Feedback & Diagnostics…', click: () => sendToWindows('ui:openFeedback', { tab: 'errors' }) },
        { type: 'separator' },
        { label: 'Setup Wizard…', click: () => sendToWindows('ui:openOnboarding', { kind: 'setup' }) },
        { label: 'Take the Tour', click: () => sendToWindows('ui:openOnboarding', { kind: 'tour' }) },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void checkForUpdateFromMenu().catch((err) => logError('updates:menu', err)) },
        { label: 'sinfonie.dev', click: () => void shell.openExternal('https://sinfonie.dev') },
        { label: 'Release Notes', click: () => void shell.openExternal('https://github.com/fpolliop/sinfonie-releases/releases') }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** Rebuild the menu whenever the stored mode changes (the store notifies on every write; the mode rarely changes). */
function watchModeForMenu(): void {
  const modeOf = (): 'guided' | 'expert' => (getStore().get().settings.mode === 'guided' ? 'guided' : 'expert')
  menuMode = modeOf()
  buildMenu()
  getStore().subscribe(() => {
    const next = modeOf()
    if (next === menuMode) return
    menuMode = next
    buildMenu()
  })
}

/**
 * Guided mode's "It's on GitHub": clone into ~/Sinfonie/<name> (or a folder name the person picked when that
 * one holds another app) and hand the path back for repos:addPaths. An existing checkout of the same app there is
 * reused. `repos:cloneApp` answers with a failure kind the screen turns into one action (Connect GitHub, pick
 * another folder name, install the developer tools). Progress goes out as
 * `repos:cloneProgress`, and `repos:cancelClone` stops it.
 */
/** Clones in flight, by destination, so a double submit waits for the first clone instead of racing it. */
const cloning = new Map<string, Promise<CloneResult>>()

function cloneApp(url: string, folderName?: string): Promise<CloneResult> {
  const m = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(String(url))
  if (!m || [m[1], m[2]].some((part) => part === '.' || part === '..')) return Promise.resolve({ ok: false, kind: 'not-found', message: 'That does not look like a GitHub link. Copy the address of the app’s GitHub page and paste it here.' })
  const name = folderName?.trim().replace(/[^\w.-]+/g, '-').replace(/^[-.]+/, '')
  // The app's own name (it becomes the name the person sees). Another app already there (a/app vs b/app) comes back
  // as folder-exists, and the person picks another folder name; the same app there is reused.
  const dest = join(homedir(), 'Sinfonie', name || m[2])
  const running = cloning.get(dest)
  if (running) return running
  const job = prereqs.cloneRepo(url, dest, (p) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('repos:cloneProgress', p)
  })
  cloning.set(dest, job)
  return job.then(async (r) => {
    if (r.ok) await prereqs.ensureIdentity(r.path).catch(() => undefined)
    return r
  }).finally(() => cloning.delete(dest))
}

function registerCloneHandler(): void {
  ipcMain.handle('repos:cloneApp', (_e, url: string, folderName?: string) => cloneApp(url, folderName))
  ipcMain.handle('repos:cancelClone', (_e, url: string) => prereqs.cancelClone(url))
}

/** The app used to be called Orchestra; move its data folder over on first launch. */
function migrateLegacyUserData(): void {
  const dir = app.getPath('userData')
  const legacy = join(dirname(dir), 'orchestra')
  try {
    const empty = !existsSync(dir) || readdirSync(dir).filter((f) => f.endsWith('.json')).length === 0
    if (empty && existsSync(join(legacy, 'orchestra.json')) && legacy.toLowerCase() !== dir.toLowerCase()) {
      cpSync(legacy, dir, { recursive: true, force: false, errorOnExist: false })
    }
  } catch (err) {
    console.error('userData migration failed', err)
  }
}

/** Light or dark ground for the window: the Preferences choice, else light for guided and dark for expert. */
function windowBackground(): string {
  const { theme, mode } = getStore().get().settings
  const pref = theme ?? (mode === 'guided' ? 'light' : 'dark')
  const light = pref === 'system' ? !nativeTheme.shouldUseDarkColors : pref === 'light'
  return light ? '#f6f5f2' : '#0f1115'
}

function createWindow(): void {
  rendererReady = false
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Sinfonie',
    titleBarStyle: 'hiddenInset',
    // Centred in the 84px rail and on the 52px top bars (Rail.tsx).
    trafficLightPosition: { x: 13, y: 19 },
    // The saved theme's ground, so a light start never flashes dark (lib/theme.ts resolveTheme, index.css tokens).
    backgroundColor: windowBackground(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  browser.setWindow(win)
  win.on('ready-to-show', () => win.show())
  // A reload drops the page's listeners: queue links again until the new page asks for them (ui:takePendingLinks).
  win.webContents.on('did-start-loading', () => (rendererReady = false))
  // Renderer problems land in the terminal log, so a black window can be diagnosed.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) {
      console.error(`[renderer] ${message} (${sourceId}:${line})`)
      rendererConsoleError(message, sourceId, line)
    }
  })
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer] process gone:', details.reason))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logError('renderer:did-fail-load', new Error(`${code} ${desc}`), { url }))
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

installCrashHandlers()

// A separate data folder, e.g. to try the app as a new user: SINFONIE_USER_DATA=/tmp/sinfonie-fresh pnpm dev
if (process.env.SINFONIE_USER_DATA) app.setPath('userData', process.env.SINFONIE_USER_DATA)
images.registerScheme()
// sinfonie:// links: the Slack OAuth callback on sinfonie.dev bounces the code back through one.
// Only the installed app claims the scheme: a dev instance registering it sends links to a bare Electron.
if (app.isPackaged && !app.isDefaultProtocolClient('sinfonie')) app.setAsDefaultProtocolClient('sinfonie')
/**
 * Links that arrive before the renderer listens (a cold start from a link, or a reload) wait here. The renderer pulls
 * them with `ui:takePendingLinks` once its listeners are mounted (App.tsx), rather than on did-finish-load, which
 * fires before React has subscribed.
 */
let rendererReady = false
const pendingLinks: string[] = []
function flushDeepLinks(): void {
  rendererReady = true
  for (const raw of pendingLinks.splice(0)) handleDeepLink(raw)
}
ipcMain.handle('ui:takePendingLinks', () => flushDeepLinks())
const sendToRenderer = <C extends keyof SinfonieEvents>(channel: C, payload: SinfonieEvents[C]): void => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}
function handleDeepLink(raw: string): void {
  if (!rendererReady || !app.isReady()) {
    pendingLinks.push(raw)
    return
  }
  try {
    const u = new URL(raw)
    const focus = (): void => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win) {
        win.show()
        win.focus()
      }
    }
    if (u.host === 'oauth' && u.pathname === '/slack') {
      const code = u.searchParams.get('code')
      const err = u.searchParams.get('error')
      // Either way the Slack card hears about a failure, in plain words, instead of waiting for a sign-in that never lands.
      if (err) {
        logError('slack:oauth', new Error(err))
        sendToRenderer('slack:authFailed', { message: err === 'access_denied' ? 'Slack sign-in was cancelled. Try again when you are ready.' : 'Slack did not finish the sign-in. Try again.' })
      } else if (code) {
        void slack.finishAuth(code).catch((e) => {
          logError('slack:oauth', e)
          sendToRenderer('slack:authFailed', { message: e instanceof Error && /start the slack sign-in again/i.test(e.message) ? e.message : 'Slack sign-in could not be finished. Try again.' })
        })
      } else sendToRenderer('slack:authFailed', { message: 'Slack did not send back a sign-in code. Try again.' })
      focus()
    } else if (u.host === 'join' || u.host === 'redeem') {
      // An invite or coupon link: hand it to the Plan page, which acts on it (after sign-in if needed).
      const token = u.searchParams.get('token') || u.searchParams.get('code')
      if (token) for (const win of BrowserWindow.getAllWindows()) win.webContents.send('cloud:invite', { token, kind: u.host as 'join' | 'redeem' })
      focus()
    } else {
      // workspace/…, agent/…, settings/…, notes and the rest: the renderer knows where they go.
      sendToRenderer('ui:openLink', { href: raw })
      focus()
    }
  } catch (e) {
    logError('deep-link', e, { raw })
  }
}
app.on('open-url', (e, url) => {
  e.preventDefault()
  handleDeepLink(url)
})

// Development aid: SINFONIE_CDP_PORT=9333 pnpm dev exposes the renderer over CDP for scripted checks.
if (process.env.SINFONIE_CDP_PORT && !app.isPackaged) app.commandLine.appendSwitch('remote-debugging-port', process.env.SINFONIE_CDP_PORT)

app.whenReady().then(async () => {
  await adoptShellPath()
  // The GitHub tool Sinfonie downloaded (if any) is found by every spawn, after the person's own (prereqs.ts).
  prereqs.ensureToolsOnPath()
  images.registerProtocol()
  if (!process.env.SINFONIE_USER_DATA) migrateLegacyUserData()
  if (!app.isPackaged && process.platform === 'darwin') {
    // Packaged builds get the icon from the bundle; dev runs show Electron's unless we set it.
    const icon = nativeImage.createFromPath(join(process.cwd(), 'build', 'icon.png'))
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  registerIpc()
  registerCloneHandler()
  watchModeForMenu()
  createWindow()
  startUpdateChecks()
  startUsagePings()
  cloud.start()
  orgSpaces.start()
  remote.start()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
