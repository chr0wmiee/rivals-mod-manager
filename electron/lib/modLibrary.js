'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const store = require('./store')
const { describeRoot } = require('./gameLocator')
const { isArchive, extractArchive, walkFiles } = require('./archive')
const { analyzeModFiles, DETECTION_VERSION } = require('./pakParser')

const CONTAINER_EXTS = ['.pak', '.utoc', '.ucas', '.sig']
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif']

function backupDir () {
  return store.get('backupDir') || store.defaultBackupDir()
}

function modsPath () {
  const root = store.get('gameRoot')
  if (!root) return null
  return describeRoot(root).modsPath
}

function ensureDirs () {
  fs.mkdirSync(backupDir(), { recursive: true })
  const mp = modsPath()
  if (mp) {
    try { fs.mkdirSync(mp, { recursive: true }) } catch { /* game dir may be gone */ }
  }
}

function slugify (s) {
  return String(s).toLowerCase().replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'mod'
}

function newId (name) {
  return `${slugify(name)}-${crypto.randomBytes(3).toString('hex')}`
}

function modDir (id) { return path.join(backupDir(), id) }
function filesDir (id) { return path.join(modDir(id), 'files') }
function manifestPath (id) { return path.join(modDir(id), 'mod.json') }

function readManifest (id) {
  try {
    return JSON.parse(fs.readFileSync(manifestPath(id), 'utf8'))
  } catch {
    return null
  }
}

function writeManifest (manifest) {
  fs.mkdirSync(modDir(manifest.id), { recursive: true })
  fs.writeFileSync(manifestPath(manifest.id), JSON.stringify(manifest, null, 2))
}

// files a mod places into ~mods get a uniform prefix so trios stay matched
// and two mods with the same file names can't collide
function deployedName (id, fileName) {
  return `${id}__${fileName}`
}

function isDeployed (manifest) {
  const mp = modsPath()
  if (!mp || !manifest.files || manifest.files.length === 0) return false
  return manifest.files.every(f => {
    try { return fs.existsSync(path.join(mp, deployedName(manifest.id, f))) } catch { return false }
  })
}

function deploy (manifest) {
  const mp = modsPath()
  if (!mp) throw new Error('Game folder is not configured yet.')
  fs.mkdirSync(mp, { recursive: true })
  for (const f of manifest.files) {
    fs.copyFileSync(path.join(filesDir(manifest.id), f), path.join(mp, deployedName(manifest.id, f)))
  }
}

function undeploy (manifest) {
  const mp = modsPath()
  if (!mp) return
  for (const f of manifest.files) {
    try { fs.rmSync(path.join(mp, deployedName(manifest.id, f)), { force: true }) } catch { /* ignore */ }
  }
  // also clean up any stale files with this mod's prefix (renamed manifests etc.)
  try {
    for (const entry of fs.readdirSync(mp)) {
      if (entry.startsWith(`${manifest.id}__`)) fs.rmSync(path.join(mp, entry), { force: true })
    }
  } catch { /* ~mods missing */ }
}

function toClientMod (manifest, deployed) {
  return { ...manifest, deployed }
}

function removeEmptyParents (start, stop) {
  let current = path.resolve(start)
  const root = path.resolve(stop)
  while (current.startsWith(root + path.sep) && current !== root) {
    try {
      if (fs.readdirSync(current).length) break
      fs.rmdirSync(current)
    } catch { break }
    current = path.dirname(current)
  }
}

function removeEmptyDirectories (root) {
  if (!root || !fs.existsSync(root)) return
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const full = path.join(root, entry.name)
    removeEmptyDirectories(full)
    try { if (fs.readdirSync(full).length === 0) fs.rmdirSync(full) } catch { /* in use or not empty */ }
  }
}

function groupContainersByStem (files) {
  const groups = new Map()
  for (const file of files) {
    const stem = path.basename(file, path.extname(file)).toLowerCase()
    if (!groups.has(stem)) groups.set(stem, [])
    groups.get(stem).push(file)
  }
  return [...groups.values()]
}

function friendlyUnitName (stem) {
  return String(stem).replace(/_9999999_p$/i, '').replace(/_p$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
}

// v2.0 initially collapsed every container stem inside an adopted folder into
// one library row. Split those combined manifests into independently toggleable
// mods, preserving enabled state and expanding preset references atomically.
async function splitMultiUnitManifests () {
  let addedRows = 0
  let entries = []
  try { entries = fs.readdirSync(backupDir(), { withFileTypes: true }) } catch { return 0 }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const original = readManifest(entry.name)
    if (!original) continue
    const groups = groupContainersByStem((original.files || []).filter(f => CONTAINER_EXTS.includes(path.extname(f).toLowerCase())))
      .filter(files => files.some(f => /\.(pak|utoc)$/i.test(f)))
    if (groups.length <= 1) continue

    const created = []
    try {
      for (let index = 0; index < groups.length; index++) {
        const files = groups[index]
        const stem = path.basename(files[0], path.extname(files[0]))
        const id = newId(stem)
        fs.mkdirSync(filesDir(id), { recursive: true })
        for (const file of files) fs.copyFileSync(path.join(filesDir(original.id), file), path.join(filesDir(id), file))
        if (original.previewFile && fs.existsSync(path.join(modDir(original.id), original.previewFile))) {
          fs.copyFileSync(path.join(modDir(original.id), original.previewFile), path.join(modDir(id), original.previewFile))
        }
        const detection = await analyzeModFiles(files.filter(f => /\.(pak|utoc)$/i.test(f)).map(f => path.join(filesDir(id), f)), store.get('aesKey'), `${friendlyUnitName(stem)} ${files.join(' ')}`)
        const manifest = {
          ...original,
          id,
          name: friendlyUnitName(stem) || `${original.name} ${index + 1}`,
          files,
          detection,
          addedAt: (original.addedAt || Date.now()) + index,
          splitFrom: original.id
        }
        writeManifest(manifest)
        created.push(manifest)
      }

      undeploy(original)
      if (original.enabled) for (const manifest of created) deploy(manifest)
      const replacementIds = created.map(x => x.id)
      store.set('presets', (store.get('presets') || []).map(preset => ({
        ...preset,
        modIds: (preset.modIds || []).flatMap(id => id === original.id ? replacementIds : [id])
      })))
      fs.rmSync(modDir(original.id), { recursive: true, force: true })
      addedRows += created.length - 1
    } catch {
      for (const manifest of created) {
        try { undeploy(manifest) } catch { /* ignore */ }
        fs.rmSync(modDir(manifest.id), { recursive: true, force: true })
      }
      try { if (original.enabled) deploy(original) } catch { /* leave backup intact */ }
    }
  }
  return addedRows
}

// Adopt files that were placed in ~mods before this manager knew about them.
// The backup is completed first; originals are only replaced with managed copies
// after the manifest and every source file have been safely written.
async function adoptUnmanagedMods () {
  const mp = modsPath()
  if (!mp || !fs.existsSync(mp)) return 0
  const known = new Set()
  try {
    for (const entry of fs.readdirSync(backupDir(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const manifest = readManifest(entry.name)
      if (!manifest) continue
      for (const file of manifest.files || []) known.add(deployedName(manifest.id, file).toLowerCase())
    }
  } catch { /* empty library */ }

  const groups = []
  const loose = new Map()
  for (const entry of fs.readdirSync(mp, { withFileTypes: true })) {
    const full = path.join(mp, entry.name)
    if (entry.isDirectory()) {
      const containers = walkFiles(full).filter(f => CONTAINER_EXTS.includes(path.extname(f).toLowerCase()))
      for (const files of groupContainersByStem(containers)) {
        if (!files.some(f => /\.(pak|utoc)$/i.test(f))) continue
        const stem = path.basename(files[0], path.extname(files[0]))
        groups.push({ name: friendlyUnitName(stem) || entry.name, files, cleanupRoot: full })
      }
      continue
    }
    const ext = path.extname(entry.name).toLowerCase()
    if (!CONTAINER_EXTS.includes(ext) || known.has(entry.name.toLowerCase())) continue
    const stem = path.basename(entry.name, ext).toLowerCase()
    if (!loose.has(stem)) loose.set(stem, [])
    loose.get(stem).push(full)
  }
  for (const [stem, files] of loose) {
    if (files.some(f => /\.(pak|utoc)$/i.test(f))) groups.push({ name: path.basename(files[0], path.extname(files[0])).replace(/^[^_]+__/, '') || stem, files })
  }

  let adopted = 0
  for (const group of groups) {
    const id = newId(group.name)
    try {
      const plan = planFileNames(group.files)
      fs.mkdirSync(filesDir(id), { recursive: true })
      for (const item of plan) fs.copyFileSync(item.src, path.join(filesDir(id), item.name))
      const fileNames = plan.map(x => x.name)
      const detection = await analyzeModFiles(fileNames.filter(f => /\.(pak|utoc)$/i.test(f)).map(f => path.join(filesDir(id), f)), store.get('aesKey'), `${group.name} ${fileNames.join(' ')}`)
      const manifest = {
        id, name: group.name, files: fileNames, enabled: true, addedAt: Date.now(),
        source: { type: 'local', adoptedFrom: group.cleanupRoot || mp }, detection, previewFile: null,
        warnings: [], adopted: true
      }
      writeManifest(manifest)
      for (const original of group.files) fs.rmSync(original, { force: true })
      if (group.cleanupRoot) removeEmptyParents(group.cleanupRoot, mp)
      deploy(manifest)
      adopted++
    } catch {
      fs.rmSync(modDir(id), { recursive: true, force: true })
    }
  }
  removeEmptyDirectories(mp)
  return adopted
}

// List all mods; auto-restores enabled mods whose files vanished from ~mods
// (e.g. the game update wiped the ~mods folder).
async function listMods () {
  ensureDirs()
  const out = []
  let restored = 0
  const split = await splitMultiUnitManifests()
  const adopted = await adoptUnmanagedMods()
  let entries = []
  try { entries = fs.readdirSync(backupDir(), { withFileTypes: true }) } catch { return { mods: [], restored, adopted, split } }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const manifest = readManifest(e.name)
    if (!manifest) continue
    if ((manifest.detection?.version || 0) < DETECTION_VERSION) {
      const containers = (manifest.files || [])
        .filter(f => /\.(pak|utoc)$/i.test(f))
        .map(f => path.join(filesDir(manifest.id), f))
      manifest.detection = await analyzeModFiles(containers, store.get('aesKey'), `${manifest.name} ${(manifest.files || []).join(' ')}`)
      writeManifest(manifest)
    }
    let deployed = isDeployed(manifest)
    if (manifest.enabled && !deployed) {
      try {
        deploy(manifest)
        deployed = true
        restored++
      } catch { /* game folder unavailable */ }
    }
    out.push(toClientMod(manifest, deployed))
  }
  out.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
  return { mods: out, restored, adopted, split }
}

function setEnabled (id, enabled) {
  const manifest = readManifest(id)
  if (!manifest) throw new Error('Mod not found: ' + id)
  if (enabled) {
    deploy(manifest)
  } else {
    undeploy(manifest)
  }
  manifest.enabled = !!enabled
  writeManifest(manifest)
  return toClientMod(manifest, enabled)
}

function deleteMod (id) {
  const manifest = readManifest(id)
  if (manifest) undeploy(manifest)
  fs.rmSync(modDir(id), { recursive: true, force: true })
  // drop it from any presets
  const presets = store.get('presets') || []
  store.set('presets', presets.map(p => ({ ...p, modIds: (p.modIds || []).filter(m => m !== id) })))
  return true
}

async function reanalyze (id) {
  const manifest = readManifest(id)
  if (!manifest) throw new Error('Mod not found: ' + id)
  const containers = manifest.files
    .filter(f => /\.(pak|utoc)$/i.test(f))
    .map(f => path.join(filesDir(id), f))
  manifest.detection = await analyzeModFiles(containers, store.get('aesKey'), `${manifest.name} ${manifest.files.join(' ')}`)
  writeManifest(manifest)
  return toClientMod(manifest, isDeployed(manifest))
}

// ---------- import ----------

// Collect mod container files from a directory tree; flattens any subfolder mess.
function collectContainers (rootDir) {
  const all = walkFiles(rootDir)
  const containers = all.filter(f => CONTAINER_EXTS.includes(path.extname(f).toLowerCase()))
  const images = all.filter(f => IMAGE_EXTS.includes(path.extname(f).toLowerCase()))
  return { containers, images, all }
}

// Group sibling container files by directory + stem so trios rename together.
function planFileNames (containers) {
  const groups = new Map()
  for (const f of containers) {
    const stem = path.basename(f, path.extname(f)).toLowerCase()
    const key = path.dirname(f).toLowerCase() + '|' + stem
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(f)
  }
  const usedStems = new Set()
  const plan = []
  for (const [, files] of groups) {
    const first = files[0]
    let stem = path.basename(first, path.extname(first))
    if (usedStems.has(stem.toLowerCase())) {
      const parent = slugify(path.basename(path.dirname(first)))
      let candidate = `${parent}-${stem}`
      let n = 2
      while (usedStems.has(candidate.toLowerCase())) candidate = `${parent}${n++}-${stem}`
      stem = candidate
    }
    usedStems.add(stem.toLowerCase())
    for (const f of files) {
      plan.push({ src: f, name: stem + path.extname(f) })
    }
  }
  return plan
}

/**
 * Import one dropped/downloaded item (archive, folder, or loose container file).
 * @param {string} sourcePath
 * @param {string[]} [siblingFiles] loose files dropped together (for pak+utoc+ucas trios)
 * @param {object} [meta] nexus metadata { nexusModId, fileId, version, name, author, pictureUrl, summary, adult }
 */
async function importItem (sourcePath, siblingFiles, meta) {
  ensureDirs()
  const ext = path.extname(sourcePath).toLowerCase()
  let workDir = null
  let containers = []
  let images = []
  let displayName = meta?.name || path.basename(sourcePath).replace(/\.[a-z0-9]+$/i, '')

  if (isArchive(sourcePath)) {
    workDir = await extractArchive(sourcePath)
    const found = collectContainers(workDir)
    containers = found.containers
    images = found.images
  } else if (fs.statSync(sourcePath).isDirectory()) {
    const found = collectContainers(sourcePath)
    containers = found.containers
    images = found.images
  } else if (CONTAINER_EXTS.includes(ext)) {
    // loose file(s): gather the trio siblings that were dropped along with it
    const stem = path.basename(sourcePath, ext).toLowerCase()
    const dir = path.dirname(sourcePath)
    const sibs = (siblingFiles || []).filter(f =>
      path.dirname(f) === dir &&
      path.basename(f, path.extname(f)).toLowerCase() === stem &&
      CONTAINER_EXTS.includes(path.extname(f).toLowerCase()))
    containers = [...new Set([sourcePath, ...sibs])]
  } else {
    throw new Error(`"${path.basename(sourcePath)}" is not a mod archive or .pak/.utoc/.ucas file.`)
  }

  const hasRealContainer = containers.some(f => /\.(pak|utoc)$/i.test(f))
  if (!hasRealContainer) {
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
    throw new Error(`No .pak or .utoc files found in "${path.basename(sourcePath)}".`)
  }

  // sanity: a .utoc without its .ucas will crash the game
  const stems = new Map()
  for (const f of containers) {
    const stem = path.basename(f, path.extname(f)).toLowerCase()
    if (!stems.has(stem)) stems.set(stem, new Set())
    stems.get(stem).add(path.extname(f).toLowerCase())
  }
  const warnings = []
  for (const [stem, exts] of stems) {
    if (exts.has('.utoc') && !exts.has('.ucas')) warnings.push(`"${stem}.utoc" is missing its .ucas data file.`)
    if (exts.has('.ucas') && !exts.has('.utoc')) warnings.push(`"${stem}.ucas" is missing its .utoc index file.`)
  }

  const id = newId(displayName)
  const plan = planFileNames(containers)
  fs.mkdirSync(filesDir(id), { recursive: true })
  for (const { src, name } of plan) {
    fs.copyFileSync(src, path.join(filesDir(id), name))
  }

  // keep the first image as a preview thumbnail for the library card
  let previewFile = null
  if (images.length > 0) {
    previewFile = 'preview' + path.extname(images[0]).toLowerCase()
    try { fs.copyFileSync(images[0], path.join(modDir(id), previewFile)) } catch { previewFile = null }
  }

  const fileNames = plan.map(p => p.name)
  const containerPaths = fileNames.filter(f => /\.(pak|utoc)$/i.test(f)).map(f => path.join(filesDir(id), f))
  const detection = await analyzeModFiles(containerPaths, store.get('aesKey'), `${displayName} ${path.basename(sourcePath)} ${fileNames.join(' ')}`)

  const manifest = {
    id,
    name: displayName,
    files: fileNames,
    enabled: true,
    addedAt: Date.now(),
    source: meta?.nexusModId
      ? { type: 'nexus', ...meta }
      : meta
        ? { type: meta.audioEditor ? 'audio-editor' : 'generated', ...meta }
        : { type: 'local', originalPath: sourcePath },
    detection,
    previewFile,
    warnings
  }
  writeManifest(manifest)
  try {
    deploy(manifest)
  } catch (e) {
    manifest.enabled = false
    writeManifest(manifest)
    warnings.push('Imported to backup, but could not copy into ~mods: ' + e.message)
  }

  if (workDir) fs.rmSync(workDir, { recursive: true, force: true })
  return toClientMod(manifest, manifest.enabled)
}

async function importPaths (paths, meta) {
  const results = []
  const looseHandled = new Set()
  for (const p of paths) {
    if (looseHandled.has(p)) continue
    try {
      const ext = path.extname(p).toLowerCase()
      if (CONTAINER_EXTS.includes(ext)) {
        // mark trio siblings as consumed so we don't import them twice
        const stem = path.basename(p, ext).toLowerCase()
        for (const other of paths) {
          if (other !== p && path.dirname(other) === path.dirname(p) &&
            path.basename(other, path.extname(other)).toLowerCase() === stem) {
            looseHandled.add(other)
          }
        }
      }
      const mod = await importItem(p, paths, meta)
      results.push({ ok: true, mod })
    } catch (e) {
      results.push({ ok: false, error: e.message, path: p })
    }
  }
  return results
}

// ---------- presets ----------

function getPresets () { return store.get('presets') || [] }

function savePreset (preset) {
  const presets = getPresets()
  if (!preset.id) preset.id = newId(preset.name || 'preset')
  const i = presets.findIndex(p => p.id === preset.id)
  if (i >= 0) presets[i] = preset
  else presets.push(preset)
  store.set('presets', presets)
  return presets
}

function deletePreset (id) {
  store.set('presets', getPresets().filter(p => p.id !== id))
  return getPresets()
}

async function applyPreset (id) {
  const preset = getPresets().find(p => p.id === id)
  if (!preset) throw new Error('Preset not found')
  const wanted = new Set(preset.modIds || [])
  const { mods } = await listMods()
  const changed = []
  for (const m of mods) {
    const shouldEnable = wanted.has(m.id)
    if (m.enabled !== shouldEnable) {
      try {
        setEnabled(m.id, shouldEnable)
        changed.push(m.id)
      } catch { /* keep going */ }
    }
  }
  return { applied: preset.name, changed: changed.length }
}

// ---------- UTOC signature patch ----------

// The patch archive's contents go straight into MarvelGame\Marvel\Binaries\Win64
async function installUtocPatch (archivePath) {
  const root = store.get('gameRoot')
  if (!root) throw new Error('Set the game folder first.')
  const binPath = describeRoot(root).binPath
  if (!fs.existsSync(binPath)) throw new Error('Game Binaries\\Win64 folder not found at ' + binPath)
  const workDir = await extractArchive(archivePath)
  let sourceRoot = workDir
  const win64 = walkFiles(workDir).map(f => path.dirname(f)).find(d => path.basename(d).toLowerCase() === 'win64')
  if (win64) sourceRoot = win64
  else {
    // Most downloads have one harmless archive-name wrapper folder. Strip it so
    // DLLs land beside Marvel-Win64-Shipping.exe instead of one level too deep.
    while (true) {
      const entries = fs.readdirSync(sourceRoot, { withFileTypes: true })
      const dirs = entries.filter(e => e.isDirectory())
      const filesHere = entries.filter(e => e.isFile())
      if (filesHere.length || dirs.length !== 1) break
      sourceRoot = path.join(sourceRoot, dirs[0].name)
    }
  }
  const files = walkFiles(sourceRoot)
  if (files.length === 0) throw new Error('The archive appears to be empty.')
  let copied = 0
  for (const f of files) {
    const rel = path.relative(sourceRoot, f)
    const target = path.join(binPath, rel)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(f, target)
    copied++
  }
  fs.rmSync(workDir, { recursive: true, force: true })
  store.set('utocPatchInstalled', true)
  return { copied, binPath }
}

module.exports = {
  ensureDirs,
  listMods,
  setEnabled,
  deleteMod,
  reanalyze,
  importPaths,
  importItem,
  getPresets,
  savePreset,
  deletePreset,
  applyPreset,
  installUtocPatch,
  backupDir,
  modsPath,
  modDir
}
