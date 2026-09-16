import { app, BrowserWindow, dialog, shell } from 'electron'
import { cpSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { registerIpc } from './ipc'
import { startUpdateChecks } from './services/updates'
import * as browser from './services/browser/service'
import * as images from './services/images'
import * as slack from './services/slack'
import { adoptShellPath } from './services/shell-path'
import * as cloud from './services/cloud'
import * as orgSpaces from './services/org-spaces'
import * as remote from './services/remote'
import { installCrashHandlers, rendererConsoleError, logError, startUsagePings } from './services/telemetry'
import { Menu, nativeImage } from 'electron'
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

function buildMenu(): void {
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
        { label: 'New Workspace…', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendToWindows('ui:newWorkspace', {}) },
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

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Sinfonie',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  browser.setWindow(win)
  win.on('ready-to-show', () => win.show())
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
function handleDeepLink(raw: string): void {
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
      if (err) logError('slack:oauth', new Error(err))
      if (code) void slack.finishAuth(code).catch((e) => logError('slack:oauth', e))
      focus()
    } else if (u.host === 'join' || u.host === 'redeem') {
      // An invite or coupon link: hand it to the Plan page, which acts on it (after sign-in if needed).
      const token = u.searchParams.get('token') || u.searchParams.get('code')
      if (token) for (const win of BrowserWindow.getAllWindows()) win.webContents.send('cloud:invite', { token, kind: u.host as 'join' | 'redeem' })
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
  images.registerProtocol()
  if (!process.env.SINFONIE_USER_DATA) migrateLegacyUserData()
  buildMenu()
  if (!app.isPackaged && process.platform === 'darwin') {
    // Packaged builds get the icon from the bundle; dev runs show Electron's unless we set it.
    const icon = nativeImage.createFromPath(join(process.cwd(), 'build', 'icon.png'))
    if (!icon.isEmpty()) app.dock?.setIcon(icon)
  }
  registerIpc()
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
