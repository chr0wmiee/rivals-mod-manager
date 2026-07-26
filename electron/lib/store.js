'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')

// Marvel Rivals pak AES key, community-documented for FModel use.
const DEFAULT_AES_KEY = '0x0C263D8C22DCB085894899C3A3796383E9BF9DE0CBFB08C9BF2DEF2E84F29D74'

const DEFAULTS = {
  setupComplete: false,
  gameRoot: null, // ...\MarvelRivals
  backupDir: null, // where disabled/downloaded mods live (source of truth)
  nexusWebAuthed: false, // signed into nexusmods.com via the app (enables free downloads)
  nexusWebUser: '',
  nexusWebEngineVersion: '', // invalidates stale Cloudflare challenge state after browser upgrades
  showAdult: false,
  aesKey: DEFAULT_AES_KEY,
  utocPatchInstalled: false,
  favorites: [], // [{modId, name, summary, thumbnailUrl, author, adult}]
  presets: [] // [{id, name, modIds: []}]
}

let cache = null
let filePath = null

function configPath () {
  if (!filePath) filePath = path.join(app.getPath('userData'), 'settings.json')
  return filePath
}

function load () {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(configPath(), 'utf8')
    const saved = JSON.parse(raw)
    const removedLegacyNexusCredentials = ['nexusApiKey', 'nexusIsPremium', 'nexusAccountName', 'registerNxm'].some(key => Object.prototype.hasOwnProperty.call(saved, key))
    delete saved.nexusApiKey
    delete saved.nexusIsPremium
    delete saved.nexusAccountName
    delete saved.registerNxm // nxm:// link handling was removed in 3.0
    cache = { ...DEFAULTS, ...saved }
    // Do not leave an old personal credential sitting in settings.json after an
    // upgrade. The persistent signed-in browser session is now the only account.
    if (removedLegacyNexusCredentials) save()
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

function save () {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true })
  fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2))
}

function get (key) {
  return load()[key]
}

function getAll () {
  return { ...load() }
}

function set (key, value) {
  load()
  cache[key] = value
  save()
  return cache[key]
}

function patch (obj) {
  load()
  Object.assign(cache, obj)
  save()
  return { ...cache }
}

function defaultBackupDir () {
  return path.join(app.getPath('documents'), 'RivalsModManager', 'ModBackups')
}

module.exports = { get, getAll, set, patch, defaultBackupDir, DEFAULT_AES_KEY }
