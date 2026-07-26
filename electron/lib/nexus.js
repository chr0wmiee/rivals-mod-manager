'use strict'

// Nexus Mods integration.
// - Browse, details and file lists use Nexus's public GraphQL v2 endpoint.
// - Downloads use only the persistent Nexus website session created by Sign In.
//   Personal API keys are deliberately unsupported: Nexus reserves them for
//   personal scripts and testing, not distributed manager applications.

const fs = require('fs')
const path = require('path')
const os = require('os')
const store = require('./store')
const nexusAuth = require('./nexusAuth')

const GAME_DOMAIN = 'marvelrivals'
const GAME_ID = '7106' // Nexus numeric id for Marvel Rivals (needed for modId filters)
const GRAPHQL = 'https://api.nexusmods.com/v2/graphql'
const APP_HEADERS = {
  'Application-Name': 'RivalsModManager',
  'Application-Version': require('../../package.json').version
}
const UTOC_PATCH_MOD_ID = 2940

async function gql (query, variables) {
  const res = await fetch(GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...APP_HEADERS },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(20000)
  })
  if (!res.ok) throw new Error(`Nexus search error ${res.status}`)
  const j = await res.json()
  if (j.errors && j.errors.length) {
    const err = new Error(j.errors[0].message || 'GraphQL error')
    err.graphql = true
    throw err
  }
  return j.data
}

const MOD_FIELDS = `
  modId
  name
  summary
  version
  status
  adultContent
  thumbnailUrl
  pictureUrl
  downloads
  endorsements
  createdAt
  updatedAt
  uploader { name }
  modCategory { categoryId name }
`

function normalizeGqlMod (n) {
  return {
    modId: n.modId,
    name: n.name,
    summary: n.summary || '',
    version: n.version || '',
    author: n.uploader ? n.uploader.name : '',
    adult: !!n.adultContent,
    thumbnailUrl: n.thumbnailUrl || n.pictureUrl || '',
    pictureUrl: n.pictureUrl || n.thumbnailUrl || '',
    downloads: n.downloads || 0,
    endorsements: n.endorsements || 0,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    category: n.modCategory ? n.modCategory.name : '',
    url: `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${n.modId}`
  }
}

const SORT_MAP = {
  popular: 'endorsements',
  downloads: 'downloads',
  newest: 'createdAt',
  updated: 'updatedAt'
}

// Upload-period filter choices (days back from now), Nexus-style.
const PERIODS = { '1d': 1, '1w': 7, '1m': 30, '3m': 91, '6m': 182, '1y': 365 }

/**
 * Search / browse mods via the public GraphQL catalog.
 * Adult, category and period filters are applied server-side so pagination and
 * result counts stay correct; if the API rejects a filter field, that filter
 * falls back to client-side on the returned page.
 * @param {object} opts { terms, sort: popular|downloads|newest|updated, page, pageSize, includeAdult, category, period }
 */
async function searchMods (opts = {}) {
  const { terms = '', sort = 'popular', page = 0, pageSize = 24, includeAdult = false, category = '', period = '' } = opts
  const sortField = SORT_MAP[sort] || 'endorsements'
  const sortObj = { [sortField]: { direction: 'DESC' } }
  const query = `query Browse($filter: ModsFilter, $sort: [ModsSort!], $count: Int, $offset: Int) {
    mods(filter: $filter, sort: $sort, count: $count, offset: $offset) {
      nodes { ${MOD_FIELDS} }
      totalCount
    }
  }`

  const base = { gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' } }
  if (terms && terms.trim()) base.name = { value: terms.trim(), op: 'WILDCARD' }
  const full = { ...base }
  if (!includeAdult) full.adultContent = { value: 'false', op: 'EQUALS' }
  if (category) full.categoryName = { value: category, op: 'EQUALS' }
  const sinceIso = PERIODS[period] ? new Date(Date.now() - PERIODS[period] * 86400000).toISOString() : null
  if (sinceIso) full.createdAt = { value: sinceIso, op: 'GT' }

  // Try the richest filter first, then strip fields the schema may not accept.
  const ladder = [{ filter: full, server: { adult: !includeAdult, category: !!category, period: !!sinceIso } }]
  if (full.createdAt) {
    const f = { ...full }; delete f.createdAt
    ladder.push({ filter: f, server: { adult: !includeAdult, category: !!category, period: false } })
  }
  if (full.categoryName) {
    const f = { ...full }; delete f.categoryName; delete f.createdAt
    ladder.push({ filter: f, server: { adult: !includeAdult, category: false, period: false } })
  }
  ladder.push({ filter: base, server: { adult: false, category: false, period: false } })

  let data = null; let server = null; let lastError = null
  for (const attempt of ladder) {
    try {
      data = await gql(query, { filter: attempt.filter, sort: sortObj, count: pageSize, offset: page * pageSize })
      server = attempt.server
      break
    } catch (e) {
      lastError = e
      if (!e.graphql) throw e
    }
  }
  if (!data) throw lastError

  let nodes = (data.mods.nodes || []).map(normalizeGqlMod)
  if (!includeAdult && !server.adult) nodes = nodes.filter(m => !m.adult)
  if (category && !server.category) nodes = nodes.filter(m => m.category === category)
  if (sinceIso && !server.period) nodes = nodes.filter(m => Date.parse(m.createdAt) >= Date.parse(sinceIso))
  return { mods: nodes, totalCount: data.mods.totalCount || 0, page, pageSize }
}

// Distinct category names, sampled from the most-downloaded mods and cached.
let categoriesCache = null
async function getCategories () {
  if (categoriesCache && Date.now() - categoriesCache.at < 12 * 3600 * 1000) return categoriesCache.list
  const data = await gql(`query Cats($filter: ModsFilter, $sort: [ModsSort!]) {
    mods(filter: $filter, sort: $sort, count: 100) { nodes { modCategory { name } } }
  }`, { filter: { gameDomainName: { value: GAME_DOMAIN, op: 'EQUALS' } }, sort: { downloads: { direction: 'DESC' } } })
  const list = [...new Set((data.mods.nodes || []).map(n => n.modCategory && n.modCategory.name).filter(Boolean))].sort()
  categoriesCache = { at: Date.now(), list }
  return list
}

// Home-page style sections from the public v2 catalog.
async function homeSections (includeAdult) {
  const [popular, newest, updated] = await Promise.all([
    searchMods({ sort: 'downloads', pageSize: 12, includeAdult }),
    searchMods({ sort: 'newest', pageSize: 12, includeAdult }),
    searchMods({ sort: 'updated', pageSize: 12, includeAdult })
  ])
  return {
    trending: popular.mods,
    trendingIsLive: false,
    newest: newest.mods,
    updated: updated.mods,
    popular: popular.mods
  }
}

// Full mod info from the public v2 catalog, including the BBCode description
// when the schema exposes it (falls back to summary-only when it doesn't).
async function getModInfo (modId) {
  const filter = { gameId: { value: GAME_ID, op: 'EQUALS' }, modId: { value: String(modId), op: 'EQUALS' } }
  try {
    const data = await gql(`query One($filter: ModsFilter) {
      mods(filter: $filter, count: 1) { nodes { ${MOD_FIELDS} description } }
    }`, { filter })
    const n = data.mods.nodes && data.mods.nodes[0]
    if (!n) throw Object.assign(new Error('Mod not found'), { notFound: true })
    return { ...normalizeGqlMod(n), description: n.description || '', hasDescription: !!n.description }
  } catch (e) {
    if (!e.graphql || e.notFound) throw e
    const data = await gql(`query One($filter: ModsFilter) {
      mods(filter: $filter, count: 1) { nodes { ${MOD_FIELDS} } }
    }`, { filter })
    const n = data.mods.nodes && data.mods.nodes[0]
    if (!n) throw new Error('Mod not found')
    return { ...normalizeGqlMod(n), hasDescription: false }
  }
}

// File categories that should never be offered for install.
const HIDDEN_FILE_CATEGORIES = new Set(['OLD_VERSION', 'ARCHIVED', 'REMOVED', 'DELETED'])

async function getModFiles (modId) {
  const data = await gql(`query Files($modId: ID!, $gameId: ID!) {
    modFiles(modId: $modId, gameId: $gameId) {
      fileId name version category size sizeInBytes date description uri
    }
  }`, { modId: String(modId), gameId: GAME_ID })
  return (data.modFiles || []).filter(f => !HIDDEN_FILE_CATEGORIES.has(String(f.category).toUpperCase())).map(f => ({
    fileId: Number(f.fileId),
    name: f.name,
    version: f.version,
    category: f.category,
    sizeKb: Number(f.size) || Math.ceil(Number(f.sizeInBytes || 0) / 1024),
    fileName: f.uri,
    uploadedAt: f.date ? Number(f.date) * 1000 : null,
    description: f.description || ''
  })).sort((a, b) => {
    const rank = c => (c === 'MAIN' ? 0 : c === 'UPDATE' ? 1 : c === 'OPTIONAL' ? 2 : 3)
    return rank(a.category) - rank(b.category) || (b.uploadedAt || 0) - (a.uploadedAt || 0)
  })
}

// Resolve a direct CDN link through the user's signed Nexus browser session.
// nxm key/expires values are intentionally ignored: there is no personal v1 API
// credential behind them anymore.
async function resolveDownloadUrl ({ modId, fileId }) {
  let sessionError = null
  if (nexusAuth.isAuthed()) {
    try {
      return await nexusAuth.generateDownloadUrl(modId, fileId, GAME_ID)
    } catch (e) {
      sessionError = e
      if (e.code === 'CF') throw e // interactive challenge — user must act
    }
  }

  const err = new Error(sessionError && sessionError.code === 'AUTH'
    ? sessionError.message
    : 'Sign in to Nexus (Settings → Nexus account) to download mods as a free user.')
  err.code = 'NEED_LOGIN'
  throw err
}

async function installUtocPatchFromNexus () {
  const files = await getModFiles(UTOC_PATCH_MOD_ID)
  const main = files.find(f => String(f.category).toUpperCase() === 'MAIN') || files[0]
  if (!main) throw new Error('Nexus returned no UTOC patch files.')
  const result = await downloadMod({
    modId: UTOC_PATCH_MOD_ID,
    fileId: main.fileId,
    fileName: main.fileName,
    modMeta: { name: 'UTOC Signature Patch', version: main.version }
  })
  return { ...result, modId: UTOC_PATCH_MOD_ID, fileId: main.fileId }
}

// ---------- downloads ----------

let downloadSeq = 0
const activeDownloads = new Map()
let progressSink = null // set by main.js → webContents.send

function setProgressSink (fn) { progressSink = fn }

function emitProgress (payload) {
  if (progressSink) progressSink(payload)
}

/**
 * Download a Nexus file and hand it to the mod library (or the UTOC patch installer).
 * Account authorization comes from the persistent signed Nexus session.
 */
async function downloadMod ({ modId, fileId, fileName, modMeta }) {
  const dlId = 'dl' + (++downloadSeq)
  const label = (modMeta && modMeta.name) || fileName || `Mod ${modId}`
  emitProgress({ id: dlId, name: label, status: 'starting', received: 0, total: 0 })
  activeDownloads.set(dlId, { modId, fileId })
  try {
    const url = await resolveDownloadUrl({ modId, fileId })
    const res = await fetch(url, { headers: APP_HEADERS })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0

    let name = fileName
    if (!name) {
      const cd = res.headers.get('content-disposition') || ''
      const m = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i)
      name = m ? decodeURIComponent(m[1]) : `nexus-${modId}-${fileId}.zip`
    }
    name = name.replace(/[\\/:*?"<>|]/g, '_')
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-dl-'))
    const dest = path.join(tmpDir, name)

    const file = fs.createWriteStream(dest)
    const reader = res.body.getReader()
    let received = 0
    let lastEmit = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.length
      await new Promise((resolve, reject) => file.write(Buffer.from(value), err => (err ? reject(err) : resolve())))
      const now = Date.now()
      if (now - lastEmit > 150) {
        lastEmit = now
        emitProgress({ id: dlId, name: label, status: 'downloading', received, total })
      }
    }
    await new Promise(resolve => file.end(resolve))
    emitProgress({ id: dlId, name: label, status: 'installing', received, total })

    const modLibrary = require('./modLibrary')
    let result
    if (Number(modId) === UTOC_PATCH_MOD_ID) {
      const r = await modLibrary.installUtocPatch(dest)
      result = { utocPatch: true, ...r }
    } else {
      const meta = {
        nexusModId: Number(modId),
        fileId: Number(fileId),
        name: (modMeta && modMeta.name) || name.replace(/\.[a-z0-9]+$/i, ''),
        version: modMeta && modMeta.version,
        author: modMeta && modMeta.author,
        pictureUrl: modMeta && modMeta.pictureUrl,
        summary: modMeta && modMeta.summary,
        adult: modMeta && modMeta.adult
      }
      const results = await modLibrary.importPaths([dest], meta)
      const failed = results.find(r => !r.ok)
      if (failed && !results.some(r => r.ok)) throw new Error(failed.error)
      result = { imported: results.filter(r => r.ok).map(r => r.mod) }
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
    emitProgress({ id: dlId, name: label, status: 'done', received, total, result })
    return { ok: true, ...result }
  } catch (e) {
    const friendly = e.message
    const needsLogin = e.code === 'NEED_LOGIN' || e.code === 'AUTH'
    emitProgress({ id: dlId, name: label, status: 'error', error: friendly, needsLogin })
    return { ok: false, error: friendly, needsLogin }
  } finally {
    activeDownloads.delete(dlId)
  }
}

async function previewModFile ({ modId, fileId, fileName }) {
  const previewManager = require('./previewManager')
  const cacheKey = `nexus-${modId}-${fileId}`
  // Re-opening a preview should be instant: reuse the extracted cache.
  const cached = previewManager.cachedForKey(cacheKey)
  if (cached) return { ok: true, preview: cached }

  const dlId = 'preview' + (++downloadSeq)
  const label = fileName || `Mod ${modId} preview`
  emitProgress({ id: dlId, name: label, status: 'starting', received: 0, total: 0, preview: true })
  let tmpDir = null
  let extractDir = null
  try {
    const url = await resolveDownloadUrl({ modId, fileId })
    const res = await fetch(url, { headers: APP_HEADERS })
    if (!res.ok || !res.body) throw new Error(`Preview download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-preview-'))
    const name = (fileName || `nexus-${modId}-${fileId}.zip`).replace(/[\\/:*?"<>|]/g, '_')
    const dest = path.join(tmpDir, name)
    const file = fs.createWriteStream(dest); const reader = res.body.getReader(); let received = 0
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      received += value.length
      await new Promise((resolve, reject) => file.write(Buffer.from(value), e => e ? reject(e) : resolve()))
      emitProgress({ id: dlId, name: label, status: 'downloading', received, total, preview: true })
    }
    await new Promise(resolve => file.end(resolve))
    emitProgress({ id: dlId, name: label, status: 'previewing', received, total, preview: true })
    const { extractArchive, isArchive, walkFiles } = require('./archive')
    let inputs = [dest]
    if (isArchive(dest)) {
      extractDir = await extractArchive(dest)
      inputs = walkFiles(extractDir)
    }
    const preview = await previewManager.preparePaths(inputs, { cacheKey })
    emitProgress({ id: dlId, name: label, status: 'done', received, total, preview: true })
    return { ok: true, preview }
  } catch (e) {
    const needsLogin = e.code === 'NEED_LOGIN' || e.code === 'AUTH'
    const error = needsLogin ? 'Sign in to Nexus in Settings to preview files in the app.' : e.message
    emitProgress({ id: dlId, name: label, status: 'error', error, needsLogin, preview: true })
    return { ok: false, error, needsLogin }
  } finally {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
    if (extractDir) fs.rmSync(extractDir, { recursive: true, force: true })
  }
}

// ---------- favorites (stored locally) ----------

function getFavorites () { return store.get('favorites') || [] }

function toggleFavorite (mod) {
  const favs = getFavorites()
  const i = favs.findIndex(f => f.modId === mod.modId)
  if (i >= 0) favs.splice(i, 1)
  else {
    favs.unshift({
      modId: mod.modId,
      name: mod.name,
      summary: mod.summary,
      thumbnailUrl: mod.thumbnailUrl,
      author: mod.author,
      adult: mod.adult,
      category: mod.category,
      url: mod.url,
      savedAt: Date.now()
    })
  }
  store.set('favorites', favs)
  return favs
}

// ---------- web-session sign-in (free downloads) ----------

function webLogin (parentWindow) { return nexusAuth.openLogin(parentWindow) }
function webLogout () { return nexusAuth.logout() }
function webStatus () { return nexusAuth.status() }
function webVerify () { return nexusAuth.verify() }

module.exports = {
  searchMods,
  getCategories,
  homeSections,
  getModInfo,
  getModFiles,
  installUtocPatchFromNexus,
  downloadMod,
  previewModFile,
  setProgressSink,
  getFavorites,
  toggleFavorite,
  webLogin,
  webLogout,
  webStatus,
  webVerify,
  GAME_DOMAIN,
  UTOC_PATCH_MOD_ID
}
