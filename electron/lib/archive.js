'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const ARCHIVE_EXTS = ['.zip', '.7z', '.rar']

function isArchive (p) {
  return ARCHIVE_EXTS.includes(path.extname(p).toLowerCase())
}

// Nexus serves newer files from extensionless CDN paths (uri looks like
// "a7/47/6d/a7476d01-..."), and plenty of uploads are a .7z named .zip. Trust
// the file's own header over its name.
const SIGNATURES = [
  { kind: 'zip', magic: [0x50, 0x4b, 0x03, 0x04] },
  { kind: 'zip', magic: [0x50, 0x4b, 0x05, 0x06] }, // empty archive
  { kind: 'zip', magic: [0x50, 0x4b, 0x07, 0x08] }, // spanned
  { kind: '7z', magic: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c] },
  { kind: 'rar', magic: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07] },
  { kind: 'gzip', magic: [0x1f, 0x8b] }
]

function sniffArchive (filePath) {
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const head = Buffer.alloc(8)
    const read = fs.readSync(fd, head, 0, 8, 0)
    for (const sig of SIGNATURES) {
      if (read >= sig.magic.length && sig.magic.every((b, i) => head[i] === b)) return sig.kind
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) try { fs.closeSync(fd) } catch { /* already gone */ }
  }
}

// Extension first (cheap), then the header. Directories are never archives.
function looksLikeArchive (p) {
  try { if (fs.statSync(p).isDirectory()) return false } catch { return false }
  return isArchive(p) || sniffArchive(p) !== null
}

function tempDir (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

// Prefer the bundled 7za child process: adm-zip extracts synchronously on the
// main thread and freezes the app on large archives. adm-zip stays as a
// fallback if the 7za binary is missing.
async function extractZip (archivePath, destDir) {
  try {
    await extract7z(archivePath, destDir)
  } catch {
    const AdmZip = require('adm-zip')
    new AdmZip(archivePath).extractAllTo(destDir, true)
  }
}

function resolve7zaPath (candidate = require('7zip-bin').path7za) {
  const asarSegment = `${path.sep}app.asar${path.sep}`
  const unpacked = candidate.includes(asarSegment)
    ? candidate.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : candidate
  return fs.existsSync(unpacked) ? unpacked : candidate
}

async function extract7z (archivePath, destDir) {
  const Seven = require('node-7z')
  const path7za = resolve7zaPath()
  if (!fs.existsSync(path7za)) throw new Error('The bundled 7-Zip extractor is missing. Reinstall or update Rivals Mod Manager.')
  await new Promise((resolve, reject) => {
    const stream = Seven.extractFull(archivePath, destDir, { $bin: path7za })
    stream.on('end', resolve)
    stream.on('error', reject)
  })
}

async function extractRar (archivePath, destDir) {
  const { createExtractorFromData } = require('node-unrar-js')
  const data = fs.readFileSync(archivePath)
  const extractor = await createExtractorFromData({ data: Uint8Array.from(data).buffer })
  const extracted = extractor.extract()
  for (const file of extracted.files) {
    const target = path.join(destDir, file.fileHeader.name)
    if (!path.resolve(target).startsWith(path.resolve(destDir))) continue // zip-slip guard
    if (file.fileHeader.flags.directory) {
      fs.mkdirSync(target, { recursive: true })
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, Buffer.from(file.extraction))
    }
  }
}

// Extract any supported archive into a fresh temp dir; returns the dir path.
async function extractArchive (archivePath) {
  const dest = tempDir('rvm-extract-')
  const ext = path.extname(archivePath).toLowerCase()
  const kind = sniffArchive(archivePath) ||
    (ext === '.zip' ? 'zip' : ext === '.7z' ? '7z' : ext === '.rar' ? 'rar' : null)

  try {
    if (kind === 'zip') await extractZip(archivePath, dest)
    else if (kind === 'rar') {
      try {
        await extractRar(archivePath, dest)
      } catch {
        // some RARv5 features unsupported by the wasm unrar — try 7za as a fallback
        await extract7z(archivePath, dest)
      }
    } else {
      // 7z, gzip/tar, and anything unrecognised: 7za reads far more formats
      // than we sniff for, so let it try before giving up.
      await extract7z(archivePath, dest)
    }
  } catch (e) {
    fs.rmSync(dest, { recursive: true, force: true })
    const name = path.basename(archivePath)
    throw new Error(kind
      ? `"${name}" is damaged or incomplete. Download it again.`
      : `"${name}" is not an archive this app can open.`)
  }
  return dest
}

// Archives built on macOS carry a resource-fork shadow of every file; treating
// those as real content produces phantom mods.
const JUNK_DIRS = new Set(['__macosx'])
const JUNK_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function walkFiles (dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (!JUNK_DIRS.has(e.name.toLowerCase())) walkFiles(full, out, depth + 1)
    } else if (!JUNK_FILES.has(e.name.toLowerCase()) && !e.name.startsWith('._')) {
      out.push(full)
    }
  }
  return out
}

module.exports = { isArchive, looksLikeArchive, sniffArchive, extractArchive, walkFiles, tempDir, resolve7zaPath, ARCHIVE_EXTS }
