'use strict'

// Free-user download support.
//
// Nexus's public v1 `download_link.json` only returns a CDN link without a
// key+expires pair for PREMIUM accounts. Free accounts get the link a different
// way: the website itself POSTs to an internal endpoint,
//   /Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl
// using the logged-in browser session, and gets back { url } — no premium, and
// the "please wait" countdown is purely client-side UI, so calling the endpoint
// directly skips it (exactly what the Nexus No Wait userscript does).
//
// We reproduce that here with the user's own Nexus web session: the user signs
// in through a real nexusmods.com window (they type their own credentials on
// Nexus's page — we never see or store them), the cookies live in a persistent
// Electron session partition, and we call the same endpoint with those cookies.

const { session, net, BrowserWindow, shell } = require('electron')
const store = require('./store')

const PARTITION = 'persist:nexus'
const GAME_DOMAIN = 'marvelrivals'
const LOGIN_URL = 'https://users.nexusmods.com/'
// Do not spoof Chrome here. Turnstile compares the user agent with other browser
// characteristics (including client hints); Electron's unmodified session identity
// is internally consistent, while a Chrome-only UA can be rejected as bot behavior.
const ENGINE_VERSION = `${String(process.versions.chrome || 'unknown')}|default-ua-v1`

function sess () {
  return session.fromPartition(PARTITION, { cache: true })
}

async function cookies () {
  try { return await sess().cookies.get({}) } catch { return [] }
}

function isChallengeCookie (name = '') {
  return /^(?:__cf_bm|cf_clearance|cf_chl_|cf_turnstile)/i.test(name)
}

async function removeCookie (nexusSession, cookie) {
  const host = String(cookie.domain || '').replace(/^\./, '')
  if (!host || !cookie.name) return
  const protocol = cookie.secure ? 'https://' : 'http://'
  try { await nexusSession.cookies.remove(`${protocol}${host}${cookie.path || '/'}`, cookie.name) } catch { /* best effort */ }
}

// Challenge clearance is tied to the browser fingerprint. When the embedded
// Chromium engine changes, retain the user's Nexus login but discard only stale
// Cloudflare state and cached challenge resources so the next check starts clean.
async function prepareSession () {
  const nexusSession = sess()
  const previousEngine = String(store.get('nexusWebEngineVersion') || '')
  if (previousEngine !== ENGINE_VERSION) {
    try { await nexusSession.clearCache() } catch { /* best effort */ }
    const allCookies = await cookies()
    await Promise.all(allCookies.filter(cookie => isChallengeCookie(cookie.name)).map(cookie => removeCookie(nexusSession, cookie)))
    store.set('nexusWebEngineVersion', ENGINE_VERSION)
  }
  return nexusSession
}

// Low-level request that rides the persistent Nexus session cookies.
function request (url, { method = 'GET', headers = {}, body = null, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const req = net.request({ url, method, session: sess(), useSessionCookies: true, redirect: 'follow' })
    for (const [k, v] of Object.entries(headers)) req.setHeader(k, v)
    const timer = setTimeout(() => { if (!settled) { settled = true; req.abort(); reject(new Error('Nexus request timed out.')) } }, timeout)
    req.on('response', res => {
      let data = ''
      res.on('data', chunk => { data += chunk.toString('utf8') })
      res.on('end', () => { if (!settled) { settled = true; clearTimeout(timer); resolve({ status: res.statusCode, url: res.url || url, headers: res.headers, text: data }) } })
      res.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    })
    req.on('error', err => { if (!settled) { settled = true; clearTimeout(timer); reject(err) } })
    if (body) req.write(body)
    req.end()
  })
}

function looksLikeCloudflare (text = '') {
  return /Just a moment|cf-browser-verification|id="challenge-form"|_cf_chl_opt|Attention Required|challenges\.cloudflare\.com/i.test(text)
}

function isNexusCookie (cookie) {
  return /(^|\.)nexusmods\.com$/i.test(String(cookie.domain || '').replace(/^\./, ''))
}

function isLikelyLoginCookie (cookie) {
  if (!isNexusCookie(cookie) || isChallengeCookie(cookie.name)) return false
  return /(?:member|pass|auth|login|session|remember|token|^sid$|user)/i.test(String(cookie.name || ''))
}

function isStrongLoginCookie (cookie) {
  if (!isLikelyLoginCookie(cookie)) return false
  // nexusmods_session also exists for signed-out visitors. It is useful only
  // when compared with the pre-login value, not as proof by itself.
  return !/^nexusmods_session$/i.test(String(cookie.name || ''))
}

function cookieSignature (cookie) {
  return `${cookie.domain || ''}\n${cookie.path || '/'}\n${cookie.name || ''}`
}

function containsLoginForm (html = '') {
  return /type=["']password["']|name=["']password["']|Log in to Nexus Mods|You need to log in before continuing/i.test(html)
}

// Source-of-truth login probe. Nexus moved authentication from the old
// www.nexusmods.com/users/sign_in route to users.nexusmods.com, so probe the
// current portal first and use the session cookies as a fallback for redirect/
// error pages that no longer contain the old site's logout markup.
async function probeLoggedIn () {
  try {
    await prepareSession()
    const portal = await request(LOGIN_URL, { headers: { Accept: 'text/html' } })
    if (looksLikeCloudflare(portal.text) || containsLoginForm(portal.text)) return false
    const cks = await cookies()
    if (cks.some(isStrongLoginCookie)) return true
    if (/logout|sign out|account settings|site preferences|data-user-id|"is_premium"|"user_id"/i.test(portal.text)) return true

    const account = await request('https://www.nexusmods.com/users/myaccount', { headers: { Accept: 'text/html' } })
    if (looksLikeCloudflare(account.text) || containsLoginForm(account.text)) return false
    return /\/users\/logout|sign out|GetLatestNotifications|data-user-id|id=["']profile|"is_premium"|"user_id"/i.test(account.text)
  } catch {
    return false
  }
}

// Cheap flag (no network) for UI and hot-path gating. Set true only after a
// probe confirmed login; cleared on logout or an auth failure mid-download.
function isAuthed () { return !!store.get('nexusWebAuthed') }

async function status () {
  return { loggedIn: isAuthed(), user: store.get('nexusWebUser') || '' }
}

function grabUserName (html = '') {
  const m = html.match(/"name"\s*:\s*"([^"]{1,40})"/) || html.match(/data-username=["']([^"']{1,40})["']/i)
  return m ? m[1] : ''
}

// Ask Nexus for a direct CDN link the free-user way, using the web session.
async function generateDownloadUrl (modId, fileId, gameId) {
  await prepareSession()
  const referer = `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${modId}?tab=files&file_id=${fileId}`
  const res = await request('https://www.nexusmods.com/Core/Libs/Common/Managers/Downloads?GenerateDownloadUrl', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: 'https://www.nexusmods.com',
      Referer: referer,
      Accept: 'application/json, text/javascript, */*; q=0.01'
    },
    body: `fid=${encodeURIComponent(fileId)}&game_id=${encodeURIComponent(gameId)}`
  })
  const text = (res.text || '').trim()
  if (looksLikeCloudflare(text)) {
    const e = new Error('Nexus is showing a Cloudflare check. Open "Sign in to Nexus" in Settings, complete it, and try again.')
    e.code = 'CF'
    throw e
  }
  let url = null
  try {
    const j = JSON.parse(text)
    if (j && j.url) url = String(j.url).replace(/&amp;/g, '&')
  } catch { /* not JSON */ }
  if (!url) {
    const m = text.match(/https?:\/\/[a-z0-9-]+\.nexus-cdn\.com[^"'\\]+/i)
    if (m) url = m[0].replace(/&amp;/g, '&')
  }
  if (!url) {
    // A logged-in, valid session returns { url }. Anything else (an empty [] array,
    // a 401/403, a "not logged in" body) means the web session lapsed — clear the
    // flag so the UI prompts a fresh sign-in.
    store.set('nexusWebAuthed', false)
    const e = new Error('Your Nexus sign-in has expired or was not accepted. Sign in to Nexus again in Settings.')
    e.code = 'AUTH'
    throw e
  }
  return url
}

let loginWin = null

async function openLogin (parent) {
  if (loginWin && !loginWin.isDestroyed()) { loginWin.focus(); return { ok: false, alreadyOpen: true } }
  await prepareSession()
  loginWin = new BrowserWindow({
    parent: parent && !parent.isDestroyed() ? parent : undefined,
    width: 1040,
    height: 860,
    title: 'Sign in to Nexus Mods',
    autoHideMenuBar: true,
    backgroundColor: '#0a0d16',
    webPreferences: {
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      backgroundThrottling: false
    }
  })
  loginWin.webContents.setWindowOpenHandler(({ url }) => {
    let parsed
    try { parsed = new URL(url) } catch { return { action: 'deny' } }
    const isNexus = /(^|\.)nexusmods\.com$/i.test(parsed.hostname)
    const isCloudflare = parsed.hostname.toLowerCase() === 'challenges.cloudflare.com'
    if (parsed.protocol === 'https:' && (isNexus || isCloudflare)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            partition: PARTITION,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            webSecurity: true
          }
        }
      }
    }
    if (parsed.protocol === 'https:') shell.openExternal(url).catch(() => {})
    return { action: 'deny' }
  })
  loginWin.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '')
    const reload = input.type === 'keyDown' && (key === 'F5' || ((input.control || input.meta) && key.toLowerCase() === 'r'))
    if (reload) {
      event.preventDefault()
      if (!loginWin.isDestroyed()) loginWin.webContents.reloadIgnoringCache()
    }
  })
  try {
    await loginWin.loadURL(LOGIN_URL)
  } catch { /* user may still complete via redirects */ }
  const initialCookies = await cookies()
  let initialPageNeedsAuthentication = true
  try {
    initialPageNeedsAuthentication = await loginWin.webContents.executeJavaScript(`(() => {
      const text = (document.body && document.body.innerText) || ''
      if (/welcome back|sign out/i.test(text)) return false
      const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
      const authInput = [...document.querySelectorAll('input[type="password"], input[name="password"], input[autocomplete="one-time-code"]')].find(visible)
      if (authInput) return true
      const codeInput = [...document.querySelectorAll('input[name*="otp" i], input[name*="totp" i], input[name*="verification" i], input[name*="authenticator" i]')].find(visible)
      return !!codeInput && /two[- ]?factor|verification code|authenticator code|one[- ]?time code|enter.*code/i.test(text)
    })()`, true)
  } catch { /* keep true */ }

  // If the persistent browser session was already signed in, Nexus redirects
  // away from the login form before loadURL resolves. Accept that existing
  // session immediately instead of opening a window that waits forever.
  if (!initialPageNeedsAuthentication && initialCookies.some(isLikelyLoginCookie)) {
    store.set('nexusWebAuthed', true)
    if (loginWin && !loginWin.isDestroyed()) loginWin.close()
    loginWin = null
    return { ok: true, loggedIn: true }
  }

  const loginCookieBaseline = new Map(initialCookies.filter(isLikelyLoginCookie).map(cookie => [cookieSignature(cookie), cookie.value]))

  return new Promise(resolve => {
    let done = false
    let verifying = false
    const win = loginWin
    const wc = win.webContents

    const cleanup = () => {
      if (localTimer) clearInterval(localTimer)
      if (wc && !wc.isDestroyed()) {
        wc.removeListener('did-navigate', onNav)
        wc.removeListener('did-navigate-in-page', onNav)
        wc.removeListener('did-finish-load', onLoad)
      }
    }
    const finish = async result => {
      if (done) return
      done = true
      cleanup()
      if (result.ok) {
        store.set('nexusWebAuthed', true)
        try {
          const page = await request('https://www.nexusmods.com/users/myaccount', { headers: { Accept: 'text/html' } })
          const name = grabUserName(page.text)
          if (name) store.set('nexusWebUser', name)
        } catch { /* name is optional */ }
      }
      if (win && !win.isDestroyed()) win.close()
      loginWin = null
      resolve(result)
    }

    // The current Nexus login lives at users.nexusmods.com/ (the root path), so
    // URL matching alone cannot distinguish the login form from its post-login
    // redirect/error page. Inspect only coarse page state; credentials never
    // leave the Nexus renderer and are never read by the app.
    const pageStillNeedsAuthentication = async () => {
      if (!wc || wc.isDestroyed()) return true
      try {
        return await wc.executeJavaScript(`(() => {
          const text = (document.body && document.body.innerText) || ''
          if (/welcome back|sign out/i.test(text)) return false
          const visible = element => !!element && !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length)
          const authInput = [...document.querySelectorAll('input[type="password"], input[name="password"], input[autocomplete="one-time-code"]')].find(visible)
          if (authInput) return true
          const codeInput = [...document.querySelectorAll('input[name*="otp" i], input[name*="totp" i], input[name*="verification" i], input[name*="authenticator" i]')].find(visible)
          return !!codeInput && /two[- ]?factor|verification code|authenticator code|one[- ]?time code|enter.*code/i.test(text)
        })()`, true)
      } catch { return true }
    }

    const loginCookieChanged = async () => {
      const current = (await cookies()).filter(isLikelyLoginCookie)
      return current.some(cookie => loginCookieBaseline.get(cookieSignature(cookie)) !== cookie.value)
    }

    // Confirm login only AFTER the browser leaves the auth/captcha pages, so our
    // one verification request never races the Cloudflare challenge.
    const maybeVerify = async url => {
      if (done || verifying) return
      let pathname = ''
      try {
        const u = new URL(url)
        if (!/(^|\.)nexusmods\.com$/i.test(u.hostname)) return
        pathname = u.pathname
      } catch { return }
      // Nexus may keep /auth/sign_in as the final URL even after a successful
      // POST and render a broken return page there. The actual form/page state is
      // authoritative; URL path alone must not keep the app waiting forever.
      if (await pageStillNeedsAuthentication()) return
      verifying = true
      try {
        if (await loginCookieChanged() || await probeLoggedIn()) return finish({ ok: true, loggedIn: true })
      } finally { verifying = false }
    }
    const onNav = (_e, url) => { maybeVerify(url) }
    const onLoad = () => { maybeVerify(wc.getURL()) }
    wc.on('did-navigate', onNav)
    wc.on('did-navigate-in-page', onNav)
    wc.on('did-finish-load', onLoad)

    // Local (no-network) backup: watch the session cookies for a login marker, then
    // verify once. No repeated network traffic during the captcha.
    const localTimer = setInterval(async () => {
      if (done || verifying) return
      const cks = await cookies()
      const hasLoginCookie = cks.some(isLikelyLoginCookie)
      if (hasLoginCookie && !(await pageStillNeedsAuthentication())) {
        verifying = true
        try {
          if (await loginCookieChanged() || await probeLoggedIn()) return finish({ ok: true, loggedIn: true })
        } finally { verifying = false }
      }
    }, 2500)

    // Covers an already-authenticated session whose redirect completed inside
    // loadURL before the navigation listeners above were attached.
    setImmediate(() => maybeVerify(wc.getURL()))

    win.on('closed', () => {
      cleanup()
      loginWin = null
      if (!done) { done = true; resolve({ ok: false, cancelled: true }) }
    })
  })
}

async function verify () {
  const loggedIn = await probeLoggedIn()
  store.set('nexusWebAuthed', loggedIn)
  return { loggedIn, user: store.get('nexusWebUser') || '' }
}

async function logout () {
  try { await sess().clearStorageData({ storages: ['cookies'] }) } catch { /* ignore */ }
  store.set('nexusWebAuthed', false)
  store.set('nexusWebUser', '')
  return { loggedIn: false }
}

module.exports = { openLogin, logout, status, verify, isAuthed, probeLoggedIn, generateDownloadUrl, PARTITION }
