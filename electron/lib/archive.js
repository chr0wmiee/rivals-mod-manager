'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

const ARCHIVE_EXTS = ['.zip', '.7z', '.rar']

function isArchive (p) {
  return ARCHIVE_EXTS.includes(path.extname(p).toLowerCase())
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
  if (ext === '.zip') await extractZip(archivePath, dest)
  else if (ext === '.7z') await extract7z(archivePath, dest)
  else if (ext === '.rar') {
    try {
      await extractRar(archivePath, dest)
    } catch (e) {
      // some RARv5 features unsupported by the wasm unrar — try 7za as a fallback
      await extract7z(archivePath, dest)
    }
  } else throw new Error(`Unsupported archive type: ${ext}`)
  return dest
}

function walkFiles (dir, out = [], depth = 0) {
  if (depth > 12) return out
  let entries = []
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) walkFiles(full, out, depth + 1)
    else out.push(full)
  }
  return out
}

module.exports = { isArchive, extractArchive, walkFiles, tempDir, resolve7zaPath, ARCHIVE_EXTS }
