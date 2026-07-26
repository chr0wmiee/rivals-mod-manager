'use strict'

// Checks GitHub Releases for a newer build, downloads the NSIS installer and
// hands it to Windows. The repo is public, so the API works without a token
// (60 requests/hour per IP, far more than this app needs).

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const { app, shell } = require('electron')

const REPO = 'chr0wmiee/rivals-mod-manager'
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`
const USER_AGENT = 'RivalsModManager-Updater'

// Release assets are served from these hosts. Anything else is refused so a
// tampered API response can't point the installer download somewhere hostile.
const ALLOWED_HOSTS = /^(github\.com|.*\.githubusercontent\.com)$/i

let progressSink = null
function setProgressSink (fn) { progressSink = fn }
function emit (payload) { if (progressSink) progressSink(payload) }

let downloaded = null // { version, file }

function currentVersion () { return app.getVersion() }

// "v3.2.0" / "3.2.0-beta.1" -> { nums: [3,2,0], pre: 'beta.1' }
function parseVersion (raw) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(raw || '').trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || '' }
}

// > 0 when a is newer than b. A release without a prerelease tag beats the same
// numbers with one (3.2.0 > 3.2.0-rc.1).
function compareVersions (a, b) {
  const va = parseVersion(a)
  const vb = parseVersion(b)
  if (!va || !vb) return 0
  for (let i = 0; i < 3; i++) {
    if (va.nums[i] !== vb.nums[i]) return va.nums[i] - vb.nums[i]
  }
  if (va.pre === vb.pre) return 0
  if (!va.pre) return 1
  if (!vb.pre) return -1
  return va.pre > vb.pre ? 1 : -1
}

function pickInstaller (release) {
  const assets = release.assets || []
  const exe = assets.find(a => /\.exe$/i.test(a.name || '') && /setup/i.test(a.name || '')) ||
    assets.find(a => /\.exe$/i.test(a.name || ''))
  if (!exe) return null
  let host = ''
  try { host = new URL(exe.browser_download_url).hostname } catch { return null }
  if (!ALLOWED_HOSTS.test(host)) return null
  return { name: exe.name, size: exe.size || 0, url: exe.browser_download_url }
}

async function check () {
  const res = await fetch(RELEASES_URL, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(20000)
  })
  if (res.status === 404) {
    return { current: currentVersion(), latest: null, updateAvailable: false, reason: 'No releases published yet.' }
  }
  if (!res.ok) throw new Error(`GitHub returned ${res.status}. Try again later.`)
  const release = await res.json()

  const latest = String(release.tag_name || release.name || '').replace(/^v/i, '')
  const installer = pickInstaller(release)
  const updateAvailable = !!latest && compareVersions(latest, currentVersion()) > 0

  return {
    current: currentVersion(),
    latest,
    updateAvailable,
    name: release.name || `v${latest}`,
    notes: (release.body || '').slice(0, 8000),
    publishedAt: release.published_at || null,
    pageUrl: release.html_url || RELEASES_PAGE,
    installer,
    // Set once download() has finished, so the UI can jump straight to Install.
    ready: !!(downloaded && latest && downloaded.version === latest && fs.existsSync(downloaded.file))
  }
}

function updatesDir () {
  const dir = path.join(app.getPath('userData'), 'updates')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function download (info) {
  const installer = info && info.installer
  if (!installer || !installer.url) throw new Error('That release has no Windows installer attached.')
  let host = ''
  try { host = new URL(installer.url).hostname } catch { throw new Error('The download link is not valid.') }
  if (!ALLOWED_HOSTS.test(host)) throw new Error('The download link is not a GitHub release asset.')

  const version = String(info.latest || 'latest')
  if (downloaded && downloaded.version === version && fs.existsSync(downloaded.file)) {
    emit({ status: 'done', version, received: 1, total: 1 })
    return { file: downloaded.file, version }
  }

  const dir = updatesDir()
  // Clear older downloads so the folder doesn't grow with every update.
  for (const name of fs.readdirSync(dir)) {
    try { fs.rmSync(path.join(dir, name), { force: true }) } catch { /* still locked by a running installer */ }
  }

  const safeName = path.basename(installer.name || 'update.exe').replace(/[^\w.\-]/g, '_')
  const tmp = path.join(dir, `${safeName}.part`)
  const dest = path.join(dir, safeName)

  emit({ status: 'downloading', version, received: 0, total: installer.size || 0 })
  const res = await fetch(installer.url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' },
    signal: AbortSignal.timeout(15 * 60 * 1000)
  })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}).`)

  const total = Number(res.headers.get('content-length')) || installer.size || 0
  const file = fs.createWriteStream(tmp)
  const reader = res.body.getReader()
  let received = 0
  let lastEmit = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      await new Promise((resolve, reject) => file.write(Buffer.from(value), e => e ? reject(e) : resolve()))
      const now = Date.now()
      if (now - lastEmit > 120) {
        lastEmit = now
        emit({ status: 'downloading', version, received, total })
      }
    }
  } finally {
    await new Promise(resolve => file.end(resolve))
  }

  if (total && received !== total) {
    fs.rmSync(tmp, { force: true })
    throw new Error('The download was cut short. Check your connection and try again.')
  }
  fs.rmSync(dest, { force: true })
  fs.renameSync(tmp, dest)
  downloaded = { version, file: dest }
  emit({ status: 'done', version, received, total: total || received })
  return { file: dest, version }
}

// Launch the installer detached and quit — NSIS can't replace files that the
// running app still holds open.
async function install () {
  if (!downloaded || !fs.existsSync(downloaded.file)) {
    throw new Error('Download the update first.')
  }
  const file = downloaded.file
  try {
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false })
    child.unref()
  } catch {
    await shell.openPath(file)
  }
  setTimeout(() => app.quit(), 700)
  return { launched: true, file }
}

module.exports = { check, download, install, setProgressSink, compareVersions, currentVersion, REPO, RELEASES_PAGE }
