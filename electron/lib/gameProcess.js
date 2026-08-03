'use strict'

const { execFile, spawn } = require('child_process')
const { shell } = require('electron')
const path = require('path')
const fs = require('fs')
const store = require('./store')
const { describeRoot, detectStore, enableLauncherBypass, STEAM_APP_ID, SHIPPING_EXE, LAUNCHER_EXE } = require('./gameLocator')

const PROCESS_NAMES = [SHIPPING_EXE, LAUNCHER_EXE, 'MarvelRivals.exe', 'MarvelGame.exe']

function delay (ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function tasklist () {
  return new Promise(resolve => {
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? '' : (stdout || ''))
    })
  })
}

async function isRunning () {
  const list = (await tasklist()).toLowerCase()
  return PROCESS_NAMES.some(n => list.includes(`"${n.toLowerCase()}"`))
}

async function launch () {
  const root = store.get('gameRoot')
  if (!root) throw new Error('Game folder is not configured.')
  const info = describeRoot(root)
  enableLauncherBypass(root)
  if (detectStore(root) === 'steam') {
    await shell.openExternal(`steam://rungameid/${STEAM_APP_ID}`)
    return { via: 'steam-direct' }
  }
  const launcher = info.launcherPath
  if (launcher && fs.existsSync(launcher)) {
    const child = spawn(launcher, [], { detached: true, stdio: 'ignore', cwd: path.dirname(launcher) })
    child.unref()
    return { via: 'launcher-direct' }
  }
  if (fs.existsSync(info.shippingExe)) {
    const child = spawn(info.shippingExe, [], { detached: true, stdio: 'ignore', cwd: path.dirname(info.shippingExe) })
    child.unref()
    return { via: 'exe' }
  }
  // last resort: try steam anyway
  await shell.openExternal(`steam://rungameid/${STEAM_APP_ID}`)
  return { via: 'steam-fallback' }
}

function killProcess (name) {
  return new Promise(resolve => {
    execFile('taskkill', ['/F', '/T', '/IM', name], { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ name, ok: !err, output: `${stdout || ''}\n${stderr || ''}`.trim() })
    })
  })
}

// The game and its launcher normally run elevated (anti-cheat), so a plain
// taskkill from this unelevated app fails with "Access is denied". Retry once
// with an elevated taskkill.exe directly (single UAC prompt for the real
// Windows tool, not a command prompt). taskkill accepts repeated /IM filters.
function killElevated (names) {
  return new Promise(resolve => {
    const args = ['/F', '/T', ...names.flatMap(n => ['/IM', n])].map(a => `'${a}'`).join(',')
    execFile('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Start-Process -FilePath taskkill.exe -ArgumentList ${args} -Verb RunAs -WindowStyle Hidden -Wait`
    ], { windowsHide: true, timeout: 90000 }, err => resolve(!err))
  })
}

async function stop () {
  if (!(await isRunning())) return { stopped: true, wasRunning: false }

  await Promise.all(PROCESS_NAMES.map(killProcess))
  await delay(700)
  if (!(await isRunning())) return { stopped: true }

  // Still alive — the game holds higher privileges. Ask Windows once.
  await killElevated(PROCESS_NAMES)
  for (let i = 0; i < 10; i++) {
    await delay(500)
    if (!(await isRunning())) return { stopped: true, elevated: true }
  }
  throw new Error('Windows refused to close Marvel Rivals. Accept the admin prompt when quitting, or close the game from its own menu.')
}

module.exports = { launch, stop, isRunning }
