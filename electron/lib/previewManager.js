'use strict'

// Preview extraction pipeline with a persistent cache.
//
// Every extracted preview lives under userData/preview-cache:
//   mods/<modId>  — library mod previews, invalidated by a file fingerprint
//   keys/<key>    — keyed previews (e.g. Nexus file previews), reused as-is
//   tmp/<rand>    — ad-hoc previews (manually opened models), swept after a day
// Older builds created one throwaway directory per open and never cleaned up;
// cleanupStale() removes those legacy directories once per session.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { app } = require('electron')
const { walkFiles } = require('./archive')
const tools = require('./toolManager')
const bnk = require('./bnk')
const catalog = require('./audioCatalog')
const audioEditor = require('./audioEditor')
const assets = require('./assetServer')
const store = require('./store')
const modLibrary = require('./modLibrary')
const { describeRoot } = require('./gameLocator')

const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tga', '.dds'])
const AUDIO = new Set(['.wav', '.mp3', '.ogg', '.flac', '.m4a', '.aac'])
const MODEL = new Set(['.glb', '.gltf', '.obj'])

// Bump to invalidate every cached preview after a pipeline change.
const CACHE_VERSION = 3
const MANIFEST = 'preview.json'

let progressSink = null
let cleanedUp = false

function setProgressSink (fn) { progressSink = fn }
function emit (payload) { if (progressSink) progressSink(payload) }

function cacheRoot () { return path.join(app.getPath('userData'), 'preview-cache') }
function safeSegment (value) { return String(value).replace(/[^a-z0-9._-]/gi, '_').slice(0, 80) || 'x' }
function modCacheDir (id) { return path.join(cacheRoot(), 'mods', safeSegment(id)) }
function keyCacheDir (key) { return path.join(cacheRoot(), 'keys', safeSegment(key)) }

function cleanupStale () {
  if (cleanedUp) return
  cleanedUp = true
  try {
    const root = cacheRoot()
    if (!fs.existsSync(root)) return
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || ['mods', 'keys', 'tmp'].includes(entry.name)) continue
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true })
    }
    const tmp = path.join(root, 'tmp')
    if (fs.existsSync(tmp)) {
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000
      for (const entry of fs.readdirSync(tmp)) {
        const full = path.join(tmp, entry)
        try { if (fs.statSync(full).mtimeMs < dayAgo) fs.rmSync(full, { recursive: true, force: true }) } catch { /* in use */ }
      }
    }
  } catch { /* cache cleanup is best effort */ }
}

function tmpCacheDir () {
  const root = path.join(cacheRoot(), 'tmp', `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

// Invalidate when the mod files change or when helper tools appear/disappear
// (a preview extracted without tools has no textures/audio/models).
function fingerprintFiles (files) {
  const stats = files.map(f => {
    try { const s = fs.statSync(f); return `${path.basename(f)}|${s.size}|${Math.floor(s.mtimeMs)}` } catch { return path.basename(f) }
  })
  const toolStatus = tools.status()
  const toolState = Object.entries(toolStatus).map(([name, t]) => `${name}:${t.installed ? 1 : 0}`).join(',')
  return crypto.createHash('sha1').update([CACHE_VERSION, toolState, ...stats.sort()].join('\n')).digest('hex')
}

function readManifest (root) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8'))
    return m && m.version === CACHE_VERSION ? m : null
  } catch { return null }
}

function writeManifest (root, { fingerprint, notes, audioMetadata }) {
  const audioMeta = {}
  for (const [file, meta] of audioMetadata) audioMeta[path.relative(root, file).replace(/\\/g, '/')] = meta
  fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify({
    version: CACHE_VERSION, fingerprint, notes, audioMeta, createdAt: Date.now()
  }))
}

function describeCached (root, manifest) {
  const audioMetadata = new Map()
  for (const [rel, meta] of Object.entries(manifest.audioMeta || {})) {
    audioMetadata.set(path.join(root, ...rel.split('/')), meta)
  }
  return describe(root, manifest.notes || [], audioMetadata)
}

// ---------- extraction pipeline ----------

function copyInto (files, root) {
  const dest = path.join(root, 'source')
  fs.mkdirSync(dest, { recursive: true })
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue
    fs.copyFileSync(file, path.join(dest, path.basename(file)))
  }
  return dest
}

async function extractContainers (source, root, notes, report = emit) {
  const status = tools.status()
  if (!status.uassettool.installed) { notes.push('Install the helper tools in Audio Editor to inspect assets inside PAK/UTOC containers.'); return }
  const out = path.join(root, 'extracted')
  fs.mkdirSync(out, { recursive: true })
  const key = String(store.get('aesKey') || '').replace(/^0x/i, '')
  const gameRoot = store.get('gameRoot')
  const gamePaks = gameRoot ? describeRoot(gameRoot).paksPath : null
  const containers = walkFiles(source).filter(f => /\.(pak|utoc)$/i.test(f))
  let done = 0
  for (const file of containers) {
    report({ stage: 'extract', message: `Extracting ${path.basename(file)}…`, current: ++done, total: containers.length })
    try {
      if (/\.pak$/i.test(file)) {
        const args = ['extract_pak', file, out]
        if (key) args.push('--aes', key)
        await tools.run('uassettool', args, { timeout: 8 * 60 * 1000 })
      } else if (/\.utoc$/i.test(file) && gamePaks) {
        await tools.run('uassettool', ['extract_iostore_legacy', gamePaks, out, '--mod', file], { timeout: 8 * 60 * 1000 })
      }
    } catch (e) { notes.push(`${path.basename(file)}: ${e.message.split(/\r?\n/)[0]}`) }
  }

  const usmap = tools.marvelMappingsFile()
  if (walkFiles(out).some(f => /\.uasset$/i.test(f))) {
    report({ stage: 'textures', message: 'Converting textures…' })
    try {
      await tools.run('uassettool', ['batch_extract_texture', out, path.join(root, 'textures'), '--usmap', usmap], { timeout: 8 * 60 * 1000 })
    } catch { notes.push('No compatible Texture2D assets were exported from this mod.') }
    report({ stage: 'meshes', message: 'Converting 3D meshes…' })
    try {
      const result = await tools.exportMeshes(out, path.join(root, 'models'), { gamePaks, aesKey: key })
      const count = result.models?.length || 0
      if (!count && result.packagesInspected) notes.push('No StaticMesh or SkeletalMesh assets were found in this mod.')
      if (result.errors?.length) notes.push(`${result.errors.length} cooked asset${result.errors.length === 1 ? '' : 's'} could not be converted; compatible meshes were still kept.`)
    } catch (error) {
      notes.push(`3D mesh conversion: ${error.message.split(/\r?\n/)[0]}`)
    }
  }
}

function entryBytes (parsed, entry) {
  return parsed.data.data.subarray(entry.offset, entry.offset + entry.size)
}

function friendlyAudio (bankName, wemId) {
  const match = bankName ? catalog.lookup(bankName, wemId) : catalog.lookupAny(wemId)
  return match ? {
    title: match.spoken || match.label || match.event || `Sound ${wemId}`,
    event: match.event || '', kind: match.kind || 'audio', usage: match.usage || '', hero: match.hero || ''
  } : { title: `Unmapped game sound ${wemId}`, event: '', kind: 'audio', usage: '', hero: '' }
}

function modelMaterials (root, token, all) {
  const imagesByStem = new Map()
  for (const file of all.filter(file => IMAGE.has(path.extname(file).toLowerCase()))) {
    const stem = path.basename(file, path.extname(file)).toLowerCase()
    if (!imagesByStem.has(stem)) imagesByStem.set(stem, file)
  }
  const result = {}
  const select = (entries, exact, pattern) => {
    const found = entries.find(([key]) => exact.includes(key)) || entries.find(([key]) => pattern.test(key))
    if (!found) return null
    const objectName = String(found[1]).split('/').pop().split('.')[0].toLowerCase()
    const file = imagesByStem.get(objectName)
    return file ? assets.assetUrl(token, file) : null
  }
  for (const file of all.filter(file => file.startsWith(path.join(root, 'models')) && /\.json$/i.test(file))) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      const entries = Object.entries(parsed.Textures || parsed.textures || {})
      const diffuse = select(entries, ['PM_Diffuse', 'BaseColor', 'Diffuse', 'Albedo'], /diff|albedo|base.?color|color.?texture/i)
      const normal = select(entries, ['PM_Normals', 'Normal', 'Normals'], /normal|normals|_n$/i)
      const emissive = select(entries, ['PM_Emissive', 'Emissive'], /emiss/i)
      const specular = select(entries, ['PM_SpecularMasks', 'SpecularMasks', 'ORM', 'MRAO'], /spec|orm|mrao|rough/i)
      const opacity = select(entries, ['OpacityMask', 'Opacity', 'AlphaMask'], /opacity|alpha.?mask/i)
      const parameters = parsed.Parameters || parsed.parameters || {}
      const overrides = parameters.Properties?.BasePropertyOverrides || parameters.properties?.basePropertyOverrides || {}
      const colors = parameters.Colors || parameters.colors || {}
      const color = colors.BaseColor || colors['Base Color'] || colors.Color || colors.DiffuseColor || null
      result[path.basename(file, '.json')] = {
        diffuse, normal, emissive, specular, opacity, color,
        blendMode: Number(parameters.BlendMode ?? parameters.blendMode ?? 0),
        twoSided: !!(overrides.TwoSided ?? overrides.twoSided)
      }
    } catch { /* unrelated or incomplete material metadata */ }
  }
  return result
}

function wavDuration (file) {
  const data = fs.readFileSync(file)
  if (data.length < 44 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') return 0
  let byteRate = 0; let dataBytes = 0; let pos = 12
  while (pos + 8 <= data.length) {
    const id = data.toString('ascii', pos, pos + 4)
    const size = data.readUInt32LE(pos + 4)
    if (id === 'fmt ' && size >= 12 && pos + 16 <= data.length) byteRate = data.readUInt32LE(pos + 12)
    if (id === 'data') { dataBytes = Math.min(size, data.length - pos - 8); break }
    pos += 8 + size + (size % 2)
  }
  return byteRate > 0 && dataBytes > 0 ? dataBytes / byteRate : 0
}

function validateDecoded (file) {
  const duration = wavDuration(file)
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The decoded sound contained no playable audio samples.')
  return duration
}

async function decodeAudio (root, notes, report = emit) {
  const metadata = new Map()
  if (!tools.status().vgmstream.installed) { notes.push('Install the helper tools in Audio Editor to play WEM/BNK audio.'); return metadata }
  const decoded = path.join(root, 'decoded-audio')
  fs.mkdirSync(decoded, { recursive: true })
  const sources = walkFiles(root).filter(file => !file.startsWith(decoded) && /\.(wem|bnk)$/i.test(file))
  let done = 0
  for (const file of sources) {
    report({ stage: 'audio', message: `Decoding ${path.basename(file)}…`, current: ++done, total: sources.length })
    try {
      if (/\.wem$/i.test(file)) {
        const wemId = Number((path.basename(file).match(/^(\d+)/) || [])[1]) || null
        const output = path.join(decoded, `${path.basename(file, '.wem')}.wav`)
        await tools.decodeWem(file, output)
        const duration = validateDecoded(output)
        const friendly = friendlyAudio('', wemId)
        metadata.set(output, { ...friendly, wemId, originalName: path.basename(file), bankName: '', duration })
      } else {
        const parsed = bnk.readBnk(file)
        const bankName = path.basename(file)
        let changed = parsed.entries
        try {
          const vanilla = await audioEditor.extractBankFromGame(bankName)
          const original = bnk.readBnk(vanilla.path)
          const originalById = new Map(original.entries.map(entry => [entry.id, entryBytes(original, entry)]))
          let obsoletePrefetch = 0
          changed = parsed.entries.filter(entry => {
            const before = originalById.get(entry.id)
            if (!before && entry.size < 2048) { obsoletePrefetch++; return false }
            return !before || !before.equals(entryBytes(parsed, entry))
          })
          if (obsoletePrefetch) notes.push(`${bankName}: ignored ${obsoletePrefetch} obsolete prefetch fragment${obsoletePrefetch === 1 ? '' : 's'} from an older game bank.`)
        } catch {
          notes.push(`${bankName}: the current vanilla bank could not be compared, so all ${parsed.entries.length} embedded sounds are shown.`)
        }
        if (!changed.length) notes.push(`${bankName}: no audio payloads differ from the current game bank.`)
        for (const entry of changed) {
          const stem = `${path.basename(file, '.bnk')}-${entry.id}`
          const wem = path.join(decoded, `${stem}.wem`)
          const wav = path.join(decoded, `${stem}.wav`)
          bnk.extractWem(file, entry.id, wem)
          await tools.decodeWem(wem, wav)
          const duration = validateDecoded(wav)
          metadata.set(wav, {
            ...friendlyAudio(bankName, entry.id),
            wemId: entry.id,
            originalName: `${entry.id}.wem`,
            bankName,
            duration
          })
        }
      }
    } catch (e) { notes.push(`${path.basename(file)} audio: ${e.message.split(/\r?\n/)[0]}`) }
  }
  return metadata
}

// Original (pre-conversion) game files that belong to a converted asset,
// matched by file stem: .uasset/.uexp/.ubulk for models and textures, .wem for
// decoded audio.
const ORIGINAL_EXTS = new Set(['.uasset', '.uexp', '.ubulk', '.wem', '.bnk'])

function describe (root, notes, audioMetadata = new Map()) {
  const token = assets.registerRoot(root)
  const all = walkFiles(root).filter(f => path.basename(f) !== MANIFEST)

  const originalsByStem = new Map()
  for (const file of all) {
    if (!ORIGINAL_EXTS.has(path.extname(file).toLowerCase())) continue
    const stem = path.basename(file, path.extname(file)).toLowerCase()
    if (!originalsByStem.has(stem)) originalsByStem.set(stem, [])
    originalsByStem.get(stem).push(file)
  }
  const originalsFor = (file, exts) => (originalsByStem.get(path.basename(file, path.extname(file)).toLowerCase()) || [])
    .filter(f => exts.includes(path.extname(f).toLowerCase()))
    .map(f => ({ name: path.basename(f), url: assets.assetUrl(token, f) }))

  const asItems = files => files.map(file => ({ name: path.basename(file), url: assets.assetUrl(token, file), file }))
  const images = asItems(all.filter(f => IMAGE.has(path.extname(f).toLowerCase())).slice(0, 80))
    .map(item => ({ ...item, originals: originalsFor(item.file, ['.uasset', '.uexp', '.ubulk']) }))
  const audio = all.filter(f => AUDIO.has(path.extname(f).toLowerCase())).map(file => ({
    name: path.basename(file), url: assets.assetUrl(token, file), file,
    ...(audioMetadata.get(file) || {}),
    originals: originalsFor(file, ['.wem'])
  }))
  const materials = modelMaterials(root, token, all)
  const models = asItems(all.filter(f => MODEL.has(path.extname(f).toLowerCase())).slice(0, 20))
    .map(model => ({ ...model, materials, originals: originalsFor(model.file, ['.uasset', '.uexp', '.ubulk']) }))
  return { token, images, audio, models, notes: [...new Set(notes)].slice(0, 20), counts: { files: all.length, images: images.length, audio: audio.length, models: models.length } }
}

async function runPipeline (root, files, options = {}) {
  const notes = []
  const report = options.quiet ? () => {} : emit
  report({ stage: 'copy', message: 'Collecting mod files…' })
  const source = copyInto(files, root)
  if (options.extract !== false) await extractContainers(source, root, notes, report)
  const audioMetadata = await decodeAudio(root, notes, report)
  report({ stage: 'done', message: 'Preview ready' })
  return { notes, audioMetadata }
}

// ---------- public API ----------

// Foreground (user-visible) preparations get priority over the background
// prewarmer, which pauses between mods whenever one is in flight.
let foregroundActive = 0
let prewarming = false

async function preparePaths (paths, options = {}) {
  cleanupStale()
  if (options.cacheKey) {
    const root = keyCacheDir(options.cacheKey)
    const cached = readManifest(root)
    if (cached) return describeCached(root, cached)
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    const { notes, audioMetadata } = await runPipeline(root, paths, options)
    writeManifest(root, { fingerprint: options.cacheKey, notes, audioMetadata })
    return describe(root, notes, audioMetadata)
  }
  const root = tmpCacheDir()
  const { notes, audioMetadata } = await runPipeline(root, paths, options)
  return describe(root, notes, audioMetadata)
}

function cachedForKey (cacheKey) {
  const root = keyCacheDir(cacheKey)
  const cached = readManifest(root)
  return cached ? describeCached(root, cached) : null
}

async function prepareMod (id, options = {}) {
  cleanupStale()
  const dir = path.join(modLibrary.modDir(id), 'files')
  if (!fs.existsSync(dir)) throw new Error('Mod backup files were not found.')
  const files = walkFiles(dir)
  for (const entry of fs.readdirSync(modLibrary.modDir(id), { withFileTypes: true })) {
    const candidate = path.join(modLibrary.modDir(id), entry.name)
    if (entry.isFile() && IMAGE.has(path.extname(entry.name).toLowerCase())) files.push(candidate)
  }
  const fingerprint = fingerprintFiles(files)
  const root = modCacheDir(id)
  const cached = readManifest(root)
  if (cached && cached.fingerprint === fingerprint) return describeCached(root, cached)

  if (!options.quiet) foregroundActive++
  try {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
    const { notes, audioMetadata } = await runPipeline(root, files, options)
    writeManifest(root, { fingerprint, notes, audioMetadata })
    return describe(root, notes, audioMetadata)
  } finally {
    if (!options.quiet) foregroundActive--
  }
}

// Extract every library mod in the background right after launch (and after
// installs) so opening a preview is a cache hit instead of a long wait.
async function prewarmLibrary () {
  if (prewarming) return
  prewarming = true
  try {
    const root = modLibrary.backupDir()
    let entries = []
    try { entries = fs.readdirSync(root, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (!fs.existsSync(path.join(root, entry.name, 'mod.json'))) continue
      while (foregroundActive > 0) await new Promise(resolve => setTimeout(resolve, 1000))
      try { await prepareMod(entry.name, { quiet: true }) } catch { /* skip broken mods */ }
    }
  } finally {
    prewarming = false
  }
}

function clearCache () {
  try { fs.rmSync(cacheRoot(), { recursive: true, force: true }) } catch { /* files may be in use */ }
  cleanedUp = false
}

module.exports = { preparePaths, prepareMod, prewarmLibrary, cachedForKey, clearCache, modelMaterials, setProgressSink }
