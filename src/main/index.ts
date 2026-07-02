import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerAgentIpc } from './ipc/agent.ipc'
import { registerMiscIpc } from './ipc/misc.ipc'
import { handle } from './ipc/router'
import { registerTasksIpc } from './ipc/tasks.ipc'
import { registerTerminalIpc } from './ipc/terminal.ipc'
import { closeDb, getDb } from './db/database'
import { sessionManager } from './terminal/SessionManager'
import { captureLoginShellEnv } from './terminal/shellEnv'

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 500,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0d1017',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  // Never open windows; external links go to the OS browser.
  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })
  // Block all navigation away from the bundled app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (!(is.dev && devUrl && url.startsWith(devUrl))) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.orchebary.app')

  if (process.env.ORB_SMOKE === '1') {
    void import('./smoke').then((m) => m.runSmokeTest())
    return
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Warm the login-shell env cache before the first terminal spawns.
  void captureLoginShellEnv()

  getDb() // open + migrate before any handler touches it

  handle('app:ping', null, () => ({ pong: true as const, version: app.getVersion() }))
  registerTerminalIpc()
  registerMiscIpc()
  registerTasksIpc()
  registerAgentIpc()

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  // PTY sessions do not survive restarts: kill the whole tree on the way out.
  sessionManager.disposeAll()
  closeDb()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
