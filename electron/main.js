'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, protocol } = require('electron')
const path = require('path')
const fs = require('fs')

const store = require('./lib/store')
const gameLocator = require('./lib/gameLocator')
const modLibrary = require('./lib/modLibrary')
const nexus = require('./lib/nexus')
const gameProcess = require('./lib/gameProcess')
const { allCharacters } = require('./lib/characters')
const toolManager = require('./lib/toolManager')
const audioCatalog = require('./lib/audioCatalog')
const audioEditor = require('./lib/audioEditor')
const assetServer = require('./lib/assetServer')
const previewManager = require('./lib/previewManager')
const updater = require('./lib/updater')

protocol.registerSchemesAsPrivileged([
  { scheme: 'preview', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
])

let mainWindow = null

// The 3.0.2 rename ("Rivals Mod Manager" → "Marvel Rivals Mod Manager") moved
// Electron's userData folder. Copy the old profile once so settings, the mod
// library index and the signed-in Nexus session survive the rename.
try {
  const newDir = app.getPath('userData')
  const oldDir = path.join(path.dirname(newDir), 'Rivals Mod Manager')
  if (!fs.existsSync(path.join(newDir, 'settings.json')) && fs.existsSync(path.join(oldDir, 'settings.json'))) {
    fs.cpSync(oldDir, newDir, { recursive: true, force: false, errorOnExist: false })
  }
} catch { /* fresh install or copy race — settings simply start clean */ }

// ---------- single instance ----------

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

// ---------- window ----------

function createWindow () {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1120,
    minHeight: 700,
    backgroundColor: '#0c0c0e',
    title: 'Marvel Rivals Mod Manager',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  Menu.setApplicationMenu(null)

  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) {
    mainWindow.loadURL(devUrl)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  if (process.env.RIVALS_DEV_WATCH === '1') {
    let timer = null
    const dist = path.join(__dirname, '..', 'dist')
    const watcher = fs.watch(dist, { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.reloadIgnoringCache()
      }, 180)
    })
    mainWindow.on('closed', () => watcher.close())
  }

  // open target=_blank / external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => { mainWindow = null })

  nexus.setProgressSink(payload => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('download-progress', payload)
  })
  toolManager.setProgressSink(payload => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tool-progress', payload)
  })
  previewManager.setProgressSink(payload => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('preview-progress', payload)
  })
  updater.setProgressSink(payload => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('update-progress', payload)
  })
}

app.whenReady().then(() => {
  // serve mod preview images from the backup folder: modimg://<modId>/<file>
  protocol.handle('modimg', req => {
    try {
      const u = new URL(req.url)
      const id = decodeURIComponent(u.hostname)
      const file = decodeURIComponent(u.pathname.replace(/^\//, ''))
      if (id.includes('..') || file.includes('..') || file.includes('/') || file.includes('\\')) {
        return new Response('bad path', { status: 400 })
      }
      const p = path.join(modLibrary.modDir(id), file)
      const data = fs.readFileSync(p)
      const mime = file.endsWith('.png') ? 'image/png' : file.endsWith('.webp') ? 'image/webp' : file.endsWith('.gif') ? 'image/gif' : 'image/jpeg'
      return new Response(data, { headers: { 'Content-Type': mime } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })

  protocol.handle('preview', req => {
    const served = assetServer.responseForRequest(req.url, req.headers.get('range'), req.method)
    if (!served) return new Response('not found', { status: 404 })
    return new Response(served.body, { status: served.status, headers: served.headers })
  })

  // Older versions registered as the nxm:// handler — undo that registration.
  try { app.removeAsDefaultProtocolClient('nxm') } catch { /* registry access can fail */ }
  createWindow()

  // Pre-extract every library mod in the background so previews open instantly.
  setTimeout(() => { previewManager.prewarmLibrary().catch(() => {}) }, 5000)

  // Look for a new release once at startup. Failures are silent — the Settings
  // page has a manual check for when the user wants an answer.
  setTimeout(() => {
    updater.check()
      .then(result => {
        if (result.updateAvailable && mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('update-available', result)
        }
      })
      .catch(() => {})
  }, 3500)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

// ---------- IPC ----------

function handle (channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await fn(...args) }
    } catch (e) {
      return { ok: false, error: e.message || String(e) }
    }
  })
}

// settings / setup
handle('settings:get', () => {
  const s = store.getAll()
  const rootInfo = s.gameRoot && gameLocator.isGameRoot(s.gameRoot) ? gameLocator.describeRoot(s.gameRoot) : null
  return {
    ...s,
    rootInfo,
    effectiveBackupDir: s.backupDir || store.defaultBackupDir(),
    defaultBackupDir: store.defaultBackupDir(),
    store: gameLocator.detectStore(s.gameRoot),
    characters: allCharacters()
  }
})
handle('settings:patch', obj => {
  const allowed = ['setupComplete', 'gameRoot', 'backupDir', 'showAdult', 'aesKey', 'utocPatchInstalled']
  const clean = {}
  for (const k of allowed) if (k in obj) clean[k] = obj[k]
  const result = store.patch(clean)
  if (clean.gameRoot || clean.backupDir) modLibrary.ensureDirs()
  return result
})
handle('setup:detect', () => gameLocator.autoDetect())
handle('setup:validatePath', p => gameLocator.diagnosePath(p))

// dialogs
handle('dialog:chooseDirectory', async (title, defaultPath) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title,
    defaultPath: defaultPath || undefined,
    properties: ['openDirectory']
  })
  return r.canceled ? null : r.filePaths[0]
})
handle('dialog:chooseFiles', async (title, filters) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title,
    filters: filters || [{ name: 'Mod files', extensions: ['zip', '7z', 'rar', 'pak', 'utoc', 'ucas'] }],
    properties: ['openFile', 'multiSelections']
  })
  return r.canceled ? [] : r.filePaths
})

// Deploying or removing pak files under a live game breaks it (and the game
// re-reads ~mods only on boot) — refuse mod changes while it runs.
async function assertGameClosed () {
  if (await gameProcess.isRunning()) {
    throw new Error('Marvel Rivals is running. Quit the game first.')
  }
}

// After anything lands in the library, warm its preview cache in the background.
function prewarmSoon () {
  setTimeout(() => { previewManager.prewarmLibrary().catch(() => {}) }, 1500)
}

// library
handle('library:list', () => modLibrary.listMods())
handle('library:import', async (paths, meta) => {
  const results = await modLibrary.importPaths(paths, meta)
  if (results.some(r => r.ok)) prewarmSoon()
  return results
})
handle('library:setEnabled', async (id, enabled) => { await assertGameClosed(); return modLibrary.setEnabled(id, enabled) })
handle('library:delete', async id => { await assertGameClosed(); return modLibrary.deleteMod(id) })
handle('library:reanalyze', id => modLibrary.reanalyze(id))
handle('preview:mod', id => previewManager.prepareMod(id))
handle('preview:readAsset', url => assetServer.readAsset(url))
handle('preview:clearCache', () => {
  previewManager.clearCache()
  try { fs.rmSync(path.join(app.getPath('userData'), 'audio-cache'), { recursive: true, force: true }) } catch { /* in use */ }
  return true
})
handle('preview:saveAsset', async (url, suggestedName) => {
  const file = assetServer.resolveRequest(url)
  if (!file) throw new Error('This asset is no longer available. Reopen the preview.')
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save asset',
    defaultPath: path.join(app.getPath('downloads'), (suggestedName || path.basename(file)).replace(/[\\/:*?"<>|]/g, '_'))
  })
  if (r.canceled || !r.filePath) return null
  fs.copyFileSync(file, r.filePath)
  return r.filePath
})
// Copy a set of preview assets (e.g. a model's .uasset/.uexp/.ubulk trio) into
// a folder the user picks.
handle('preview:exportAssets', async urls => {
  const files = (urls || []).map(u => assetServer.resolveRequest(u)).filter(Boolean)
  if (!files.length) throw new Error('These files are no longer available. Reopen the preview.')
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose where to save the files',
    defaultPath: app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory']
  })
  if (r.canceled || !r.filePaths[0]) return null
  const dir = r.filePaths[0]
  let copied = 0
  for (const file of files) {
    fs.copyFileSync(file, path.join(dir, path.basename(file)))
    copied++
  }
  return { dir, copied }
})
// Save renderer-produced bytes (e.g. an MP3 encoded in the page).
handle('preview:saveBytes', async (suggestedName, bytes) => {
  const r = await dialog.showSaveDialog(mainWindow, {
    title: 'Save file',
    defaultPath: path.join(app.getPath('downloads'), String(suggestedName || 'export').replace(/[\\/:*?"<>|]/g, '_'))
  })
  if (r.canceled || !r.filePath) return null
  fs.writeFileSync(r.filePath, Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)))
  return r.filePath
})
handle('library:openMods', () => {
  const mp = modLibrary.modsPath()
  if (mp) { fs.mkdirSync(mp, { recursive: true }); shell.openPath(mp) }
  return !!mp
})
handle('library:openBackup', () => {
  modLibrary.ensureDirs()
  shell.openPath(modLibrary.backupDir())
  return true
})

// presets
handle('presets:list', () => modLibrary.getPresets())
handle('presets:save', preset => modLibrary.savePreset(preset))
handle('presets:delete', id => modLibrary.deletePreset(id))
handle('presets:apply', async id => { await assertGameClosed(); return modLibrary.applyPreset(id) })

// nexus
handle('nexus:search', opts => nexus.searchMods(opts))
handle('nexus:categories', () => nexus.getCategories())
handle('nexus:home', includeAdult => nexus.homeSections(includeAdult))
handle('nexus:modInfo', modId => nexus.getModInfo(modId))
handle('nexus:modFiles', modId => nexus.getModFiles(modId))
handle('nexus:download', async payload => {
  const result = await nexus.downloadMod(payload)
  if (result && result.imported && result.imported.length) prewarmSoon()
  return result
})
handle('nexus:preview', payload => nexus.previewModFile(payload))
handle('nexus:installUtocPatch', () => nexus.installUtocPatchFromNexus())
handle('nexus:favorites', () => nexus.getFavorites())
handle('nexus:toggleFavorite', mod => nexus.toggleFavorite(mod))
handle('nexus:webLogin', () => nexus.webLogin(mainWindow))
handle('nexus:webLogout', () => nexus.webLogout())
handle('nexus:webStatus', () => nexus.webStatus())
handle('nexus:webVerify', () => nexus.webVerify())

// game
handle('game:launch', () => gameProcess.launch())
handle('game:stop', () => gameProcess.stop())
handle('game:isRunning', () => gameProcess.isRunning())

// utoc patch
handle('utoc:installFromArchive', p => modLibrary.installUtocPatch(p))

// Audio Editor + helper tools
handle('tools:status', () => toolManager.status())
handle('tools:install', names => toolManager.install(names))
handle('audio:catalogSummary', () => audioCatalog.summary())
handle('audio:catalogQuery', opts => audioCatalog.query(opts))
handle('audio:extractBank', bank => audioEditor.extractBankFromGame(bank))
handle('audio:previewWem', (bank, wemId, bankName) => audioEditor.previewWem(bank, wemId, bankName))
handle('audio:buildMod', payload => audioEditor.buildMod(payload))

// updates
handle('app:version', () => app.getVersion())
handle('updates:check', () => updater.check())
handle('updates:download', info => updater.download(info))
handle('updates:install', () => updater.install())

// misc
handle('shell:openExternal', url => {
  if (typeof url === 'string' && /^https:\/\//.test(url)) return shell.openExternal(url)
  throw new Error('Only https links can be opened.')
})
