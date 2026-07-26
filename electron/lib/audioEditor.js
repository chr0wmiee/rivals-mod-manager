'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { app } = require('electron')
const store = require('./store')
const catalog = require('./audioCatalog')
const bnk = require('./bnk')
const tools = require('./toolManager')
const assets = require('./assetServer')
const modLibrary = require('./modLibrary')
const { describeRoot } = require('./gameLocator')
const { walkFiles } = require('./archive')

const MONO_HEADER = Buffer.from('5249464658b0040057415645666d742018000000feff010080bb0000007701000200100006000000014100006861736810000000a56a88aab7bd54d3ec3cac9d65e1cd72', 'hex')
const STEREO_HEADER = Buffer.from('524946460000000057415645666d742018000000feff020080bb00000077010004001000060000000231000068617368100000004626e0bf912978dd7867999ca466ba216a756e6b0c00000000000000000000004a554e4b0400000000000000', 'hex')

function safeName (value) {
  return String(value || 'Audio_Mod').replace(/[^a-z0-9 _-]/gi, '').trim().replace(/\s+/g, '_').slice(0, 60) || 'Audio_Mod'
}

function pakFileName (value, fallback = 'Audio_Mod') {
  const base = String(value || fallback).replace(/\.pak$/i, '').replace(/_9999999_p$/i, '')
  return `${safeName(base)}_9999999_P.pak`
}

function wrapPcmAsWem (pcm, channels) {
  const header = Buffer.from(Number(channels) === 1 ? MONO_HEADER : STEREO_HEADER)
  const fileSize = (Number(channels) === 1 ? 68 : 88) + pcm.length
  header.writeUInt32LE(fileSize - 8, 4)
  const dataHeader = Buffer.alloc(8)
  dataHeader.write('data', 0, 'ascii')
  dataHeader.writeUInt32LE(pcm.length, 4)
  return Buffer.concat([header, dataHeader, pcm])
}

function loadBank (bankPath) {
  if (!fs.existsSync(bankPath)) throw new Error('BNK file not found.')
  const parsed = bnk.readBnk(bankPath)
  return {
    path: bankPath,
    name: path.basename(bankPath),
    entries: parsed.entries.map(entry => ({ ...entry, catalog: catalog.lookup(bankPath, entry.id) }))
  }
}

function wwisePak () {
  const gameRoot = store.get('gameRoot')
  if (!gameRoot) throw new Error('Set the game folder first.')
  const paks = describeRoot(gameRoot).paksPath
  const name = fs.readdirSync(paks).find(n => /Wwise.*\.pak$/i.test(n))
  if (!name) throw new Error('The game Wwise PAK was not found.')
  return path.join(paks, name)
}

// Extracting from the multi-GB Wwise PAK is slow, so decoded previews and
// extracted banks are cached per game version (the PAK's mtime). Caches from
// older game versions are dropped automatically.
function audioCacheDir () {
  const pak = wwisePak()
  const stamp = String(Math.floor(fs.statSync(pak).mtimeMs))
  const root = path.join(app.getPath('userData'), 'audio-cache')
  try {
    if (fs.existsSync(root)) {
      for (const entry of fs.readdirSync(root)) {
        if (entry !== stamp) fs.rmSync(path.join(root, entry), { recursive: true, force: true })
      }
    }
  } catch { /* best effort */ }
  const dir = path.join(root, stamp)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function tryAudioCacheDir () {
  try { return audioCacheDir() } catch { return null }
}

async function extractFullMedia (wemId, bankName, outputRoot) {
  const args = ['extract_pak', wwisePak(), outputRoot, '--filter', `${Number(wemId)}.wem`]
  const key = String(store.get('aesKey') || '').replace(/^0x/i, '')
  if (key) args.push('--aes', key)
  await tools.run('uassettool', args)
  const matches = walkFiles(outputRoot).filter(f => path.basename(f).toLowerCase() === `${Number(wemId)}.wem`)
  const wantsEnglish = /^bnk_vo_|^bnk_display_breath_/i.test(path.basename(bankName || ''))
  return wantsEnglish
    ? (matches.find(f => /[\\/]English\(US\)[\\/]/i.test(f)) || matches[0] || null)
    : (matches.find(f => !/[\\/](?:Chinese\(CN\)|English\(US\)|Japanese\(JP\))[\\/]/i.test(f)) || matches[0] || null)
}

function wavDetails (filePath) {
  const bytes = fs.readFileSync(filePath)
  let channels = null; let sampleRate = null; let bits = null; let dataBytes = null
  for (let pos = 12; pos + 8 <= bytes.length;) {
    const id = bytes.toString('ascii', pos, pos + 4)
    const size = bytes.readUInt32LE(pos + 4)
    if (id === 'fmt ' && size >= 16) {
      channels = bytes.readUInt16LE(pos + 10)
      sampleRate = bytes.readUInt32LE(pos + 12)
      bits = bytes.readUInt16LE(pos + 22)
    } else if (id === 'data') dataBytes = size
    pos += 8 + size + (size % 2)
  }
  const bytesPerSecond = channels && sampleRate && bits ? channels * sampleRate * bits / 8 : 0
  return { channels, sampleRate, duration: bytesPerSecond && dataBytes != null ? dataBytes / bytesPerSecond : null }
}

async function previewWem (bankPath, wemId, bankName) {
  const cacheDir = tryAudioCacheDir()
  const cacheStem = `${Number(wemId)}-${safeName(path.basename(bankName || bankPath || 'loose'))}`
  const cachedWav = cacheDir ? path.join(cacheDir, 'previews', `${cacheStem}.wav`) : null
  if (cachedWav && fs.existsSync(cachedWav) && fs.existsSync(cachedWav + '.json')) {
    try {
      const meta = JSON.parse(fs.readFileSync(cachedWav + '.json', 'utf8'))
      const token = assets.registerRoot(path.dirname(cachedWav))
      return { ...meta, url: assets.assetUrl(token, cachedWav), cached: true }
    } catch { /* corrupt cache entry — rebuild it */ }
  }

  const root = fs.mkdtempSync(path.join(app.getPath('temp'), 'rmm-audio-preview-'))
  try {
    const wem = path.join(root, `${wemId}.wem`)
    const wav = path.join(root, `${wemId}.wav`)
    // Wwise banks commonly embed only a 10-100ms prefetch. The complete stream is
    // stored separately under WwiseAudio/Media and uses the same decimal media ID.
    // Prefer that full file, matching the supplied soundKit_MR workflow.
    const full = await extractFullMedia(wemId, bankName || bankPath, path.join(root, 'media'))
    let meta
    let source
    if (full) {
      fs.copyFileSync(full, wem)
      meta = bnk.sniffWem(fs.readFileSync(wem))
      source = 'full-media'
    } else {
      if (!bankPath) throw new Error(`Full game media ${wemId} was not found. The community mapping may be outdated.`)
      meta = bnk.extractWem(bankPath, wemId, wem)
      source = 'bank-embedded'
    }
    await tools.decodeWem(wem, wav)
    const details = wavDetails(wav)
    const result = {
      source,
      channels: details.channels || meta.channels,
      sampleRate: details.sampleRate || meta.sampleRate,
      duration: details.duration,
      bytes: fs.statSync(wem).size
    }
    if (cachedWav) {
      fs.mkdirSync(path.dirname(cachedWav), { recursive: true })
      fs.copyFileSync(wav, cachedWav)
      fs.writeFileSync(cachedWav + '.json', JSON.stringify(result))
      const token = assets.registerRoot(path.dirname(cachedWav))
      return { ...result, url: assets.assetUrl(token, cachedWav) }
    }
    // No game folder (no cache) — serve from the temp dir and keep it alive.
    const token = assets.registerRoot(root)
    return { ...result, url: assets.assetUrl(token, wav) }
  } finally {
    if (cachedWav) fs.rmSync(root, { recursive: true, force: true })
  }
}

async function extractBankFromGame (bankName) {
  const root = store.get('gameRoot')
  if (!root) throw new Error('Set the game folder first.')
  // The cached copy must keep the exact original file name — buildMod stages
  // the bank into the PAK under this name.
  const cached = path.join(audioCacheDir(), 'banks', path.basename(bankName))
  if (fs.existsSync(cached)) return loadBank(cached)

  const pak = wwisePak()
  const out = fs.mkdtempSync(path.join(app.getPath('temp'), 'rmm-bank-'))
  try {
    const args = ['extract_pak', pak, out, '--filter', path.basename(bankName, '.bnk')]
    const key = String(store.get('aesKey') || '').replace(/^0x/i, '')
    if (key) args.push('--aes', key)
    await tools.run('uassettool', args)
    const matches = walkFiles(out).filter(f => path.basename(f).toLowerCase() === path.basename(bankName).toLowerCase())
    const wantsLanguage = /^bnk_vo_|^bnk_display_breath_/i.test(bankName)
    const found = wantsLanguage ? (matches.find(f => /[\\/]English\(US\)[\\/]/i.test(f)) || matches[0]) : matches[0]
    if (!found) throw new Error(`${bankName} was not found in the extracted game audio.`)
    fs.mkdirSync(path.dirname(cached), { recursive: true })
    fs.copyFileSync(found, cached)
    return loadBank(cached)
  } finally {
    fs.rmSync(out, { recursive: true, force: true })
  }
}

async function buildMod (payload) {
  const bankPath = payload.bankPath
  if (!bankPath || !fs.existsSync(bankPath)) throw new Error('Open the original BNK before building.')
  const pcm = Buffer.from(payload.pcm instanceof Uint8Array ? payload.pcm : new Uint8Array(payload.pcm || []))
  if (!pcm.length) throw new Error('The edited audio is empty.')
  const channels = Math.max(1, Math.min(2, Number(payload.channels) || 1))
  const wem = wrapPcmAsWem(pcm, channels)
  const job = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-audio-build-'))
  const bankName = path.basename(bankPath)
  const isLanguage = /^bnk_vo_|^bnk_display_breath_/i.test(bankName) && !/^bnk_sfx_1039303/i.test(bankName)
  const relative = path.join('Marvel', 'Content', 'WwiseAudio', ...(isLanguage ? ['English(US)'] : []), bankName)
  const stagedBank = path.join(job, 'stage', relative)
  bnk.replaceWem(bankPath, payload.wemId, wem, stagedBank)

  const outputDir = payload.outputDir || path.join(app.getPath('documents'), 'RivalsModManager', 'Exports')
  fs.mkdirSync(outputDir, { recursive: true })
  const output = path.join(outputDir, pakFileName(payload.fileName, payload.modName))
  await tools.createPak(output, path.join(job, 'stage'))

  let imported = null
  if (payload.install) imported = await modLibrary.importPaths([output], { name: payload.modName || path.basename(output, '.pak'), audioEditor: true })
  fs.rmSync(job, { recursive: true, force: true })
  return { outputPath: output, imported, wemBytes: wem.length, bank: bankName, internalPath: relative.replace(/\\/g, '/') }
}

module.exports = { loadBank, previewWem, extractBankFromGame, buildMod, wrapPcmAsWem, pakFileName }
