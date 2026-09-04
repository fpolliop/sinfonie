import { app, BrowserWindow, shell } from 'electron'
import { cpSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { registerIpc } from './ipc'
import { startUpdateChecks } from './services/updates'
import * as browser from './services/browser/service'
import { installCrashHandlers, rendererConsoleError, logError, startUsagePings } from './services/telemetry'
import { Menu, nativeImage } from 'electron'
import { checkForUpdate } from './services/updates'

function sendToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Send Feedback…', accelerator: 'CmdOrCtrl+Shift+F', click: () => sendToWindows('ui:openFeedback', { tab: 'feedback' }) },
        { label: 'Errors and Diagnostics…', click: () => sendToWindows('ui:openFeedback', { tab: 'errors' }) },
        { type: 'separator' },
        { label: 'Setup Assistant…', click: () => sendToWindows('ui:openOnboarding', { kind: 'setup' }) },
        { label: 'Take the Tour', click: () => sendToWindows('ui:openOnboarding', { kind: 'tour' }) },
        { type: 'separator' },
        { label: 'Check for Updates…', click: () => void checkForUpdate() },
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

app.whenReady().then(() => {
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
