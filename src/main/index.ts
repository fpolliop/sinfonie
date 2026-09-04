import { app, BrowserWindow, shell } from 'electron'
import { cpSync, existsSync, readdirSync } from 'fs'
import { dirname, join } from 'path'
import { registerIpc } from './ipc'
import { startUpdateChecks } from './services/updates'

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

  win.on('ready-to-show', () => win.show())
  // Renderer problems land in the terminal log, so a black window can be diagnosed.
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    if (level >= 2) console.error(`[renderer] ${message} (${sourceId}:${line})`)
  })
  win.webContents.on('render-process-gone', (_e, details) => console.error('[renderer] process gone:', details.reason))
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error(`[renderer] failed to load ${url}: ${code} ${desc}`))
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

app.whenReady().then(() => {
  migrateLegacyUserData()
  registerIpc()
  createWindow()
  startUpdateChecks()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
