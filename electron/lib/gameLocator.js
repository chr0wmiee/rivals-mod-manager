'use strict'

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

const STEAM_APP_ID = '2767030'
// Relative to the game root (the folder usually named "MarvelRivals")
const REL_PAKS = path.join('MarvelGame', 'Marvel', 'Content', 'Paks')
const REL_BIN = path.join('MarvelGame', 'Marvel', 'Binaries', 'Win64')
const SHIPPING_EXE = 'Marvel-Win64-Shipping.exe'
const LAUNCHER_EXE = 'MarvelRivals_Launcher.exe'
const LAUNCH_RECORD = 'launch_record'

function exists (p) {
  try { fs.accessSync(p); return true } catch { return false }
}

function isGameRoot (dir) {
  return exists(path.join(dir, REL_PAKS))
}

function describeRoot (dir) {
  return {
    gameRoot: dir,
    paksPath: path.join(dir, REL_PAKS),
    modsPath: path.join(dir, REL_PAKS, '~mods'),
    binPath: path.join(dir, REL_BIN),
    launcherPath: exists(path.join(dir, LAUNCHER_EXE)) ? path.join(dir, LAUNCHER_EXE) : null,
    shippingExe: path.join(dir, REL_BIN, SHIPPING_EXE)
  }
}

// Marvel Rivals checks this small file before opening its separate launcher.
// Writing 0 keeps the normal Steam/Epic launch route (and its anti-cheat), but
// tells the game to continue straight into the client instead of showing it.
function enableLauncherBypass (gameRoot) {
  const recordPath = path.join(gameRoot, LAUNCH_RECORD)
  try {
    // Some existing launcher-skip installs mark the file read-only. Make this
    // launch resilient without leaving it read-only, so game updates can reset it.
    if (exists(recordPath)) {
      try { fs.chmodSync(recordPath, 0o666) } catch { /* write will report the useful error */ }
    }
    fs.writeFileSync(recordPath, '0\n', { encoding: 'utf8', mode: 0o666 })
    return recordPath
  } catch (err) {
    throw new Error(`Could not enable direct launch: ${err.message}`)
  }
}

// The user may pick the wrong folder (Paks itself, MarvelGame, steamapps, a parent, ...).
// Walk up up to 6 levels and probe a few well-known descendants at each level.
function resolveGameRoot (selected) {
  if (!selected) return null
  let dir = path.resolve(selected)
  for (let i = 0; i < 7 && dir; i++) {
    if (isGameRoot(dir)) return dir
    // probe downward from this level
    const probes = [
      path.join(dir, 'MarvelRivals'),
      path.join(dir, 'MarvelRivals', 'MarvelRivals'), // some manual installs nest twice
      path.join(dir, 'steamapps', 'common', 'MarvelRivals'),
      path.join(dir, 'common', 'MarvelRivals')
    ]
    for (const p of probes) {
      if (isGameRoot(p)) return p
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// Explain what went wrong with a user-selected path so the wizard can guide them.
function diagnosePath (selected) {
  if (!selected) return { ok: false, reason: 'No folder selected.' }
  if (!exists(selected)) return { ok: false, reason: 'That folder does not exist.' }
  const root = resolveGameRoot(selected)
  if (root) {
    const corrected = path.resolve(selected) !== root
    return { ok: true, ...describeRoot(root), corrected, selected }
  }
  const base = path.basename(selected).toLowerCase()
  let hint = 'Could not find MarvelGame\\Marvel\\Content\\Paks under this folder or its parents.'
  if (base.includes('steam') && !base.includes('steamapps')) {
    hint += ' If this is your Steam folder, pick steamapps\\common\\MarvelRivals instead.'
  } else if (base === 'paks' || base === 'content' || base === 'marvel' || base === 'marvelgame') {
    hint += ' It looks like you selected a subfolder of the game, but the game files were not found there.'
  }
  return { ok: false, reason: hint }
}

function regQuery (keyPath, valueName) {
  return new Promise(resolve => {
    execFile('reg', ['query', keyPath, '/v', valueName], { windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null)
      const m = stdout.match(/REG_SZ\s+(.+)/)
      resolve(m ? m[1].trim() : null)
    })
  })
}

function parseLibraryFolders (vdfText) {
  // libraryfolders.vdf: grab every "path" "X:\\..." entry
  const libs = []
  const re = /"path"\s+"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(vdfText)) !== null) {
    libs.push(m[1].replace(/\\\\/g, '\\'))
  }
  return libs
}

async function findSteamInstall () {
  const candidates = []
  const steamPath =
    (await regQuery('HKCU\\Software\\Valve\\Steam', 'SteamPath')) ||
    (await regQuery('HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath')) ||
    (await regQuery('HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'))
  if (steamPath) {
    const norm = steamPath.replace(/\//g, '\\')
    candidates.push(norm)
    const vdf = path.join(norm, 'steamapps', 'libraryfolders.vdf')
    if (exists(vdf)) {
      try {
        for (const lib of parseLibraryFolders(fs.readFileSync(vdf, 'utf8'))) candidates.push(lib)
      } catch { /* unreadable vdf — fall through to defaults */ }
    }
  }
  for (const lib of candidates) {
    const manifest = path.join(lib, 'steamapps', `appmanifest_${STEAM_APP_ID}.acf`)
    const dir = path.join(lib, 'steamapps', 'common', 'MarvelRivals')
    if (exists(manifest) && isGameRoot(dir)) return { root: dir, store: 'steam' }
    if (isGameRoot(dir)) return { root: dir, store: 'steam' }
  }
  return null
}

function findEpicInstall () {
  const manifestsDir = path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'Epic', 'EpicGamesLauncher', 'Data', 'Manifests')
  if (!exists(manifestsDir)) return null
  try {
    for (const f of fs.readdirSync(manifestsDir)) {
      if (!f.endsWith('.item')) continue
      try {
        const item = JSON.parse(fs.readFileSync(path.join(manifestsDir, f), 'utf8'))
        const name = `${item.DisplayName || ''} ${item.AppName || ''}`.toLowerCase()
        if (name.includes('marvel rivals') || name.includes('marvelrivals')) {
          const root = resolveGameRoot(item.InstallLocation)
          if (root) return { root, store: 'epic' }
        }
      } catch { /* skip malformed manifest */ }
    }
  } catch { /* manifests dir unreadable */ }
  return null
}

function findCommonPaths () {
  const guesses = []
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    guesses.push(
      `${drive}:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals`,
      `${drive}:\\Program Files\\Steam\\steamapps\\common\\MarvelRivals`,
      `${drive}:\\SteamLibrary\\steamapps\\common\\MarvelRivals`,
      `${drive}:\\Steam\\steamapps\\common\\MarvelRivals`,
      `${drive}:\\Games\\MarvelRivals`,
      `${drive}:\\Program Files\\Epic Games\\MarvelRivals`,
      `${drive}:\\MarvelRivals`
    )
  }
  for (const g of guesses) {
    if (isGameRoot(g)) return { root: g, store: 'unknown' }
  }
  return null
}

async function autoDetect () {
  const steam = await findSteamInstall()
  if (steam) return { ...describeRoot(steam.root), store: steam.store }
  const epic = findEpicInstall()
  if (epic) return { ...describeRoot(epic.root), store: epic.store }
  const common = findCommonPaths()
  if (common) return { ...describeRoot(common.root), store: common.store }
  return null
}

function detectStore (gameRoot) {
  if (!gameRoot) return 'unknown'
  const p = gameRoot.toLowerCase()
  if (p.includes('steamapps')) return 'steam'
  if (p.includes('epic games')) return 'epic'
  return 'unknown'
}

module.exports = {
  autoDetect,
  resolveGameRoot,
  diagnosePath,
  describeRoot,
  enableLauncherBypass,
  isGameRoot,
  detectStore,
  STEAM_APP_ID,
  SHIPPING_EXE,
  LAUNCHER_EXE,
  LAUNCH_RECORD,
  REL_PAKS,
  REL_BIN
}
