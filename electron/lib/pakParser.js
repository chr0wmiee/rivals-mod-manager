'use strict'

// Parsers for Unreal Engine .pak and IO Store .utoc containers, used to list the
// asset paths inside a mod so we can classify it (character / skin / audio / UI...).
//
// Format notes (from the UE source & FModel/repak community docs):
// - .pak: footer at EOF holds magic 0x5A6F12E1, version, index offset/size. Index v10+
//   is a "primary index" (mount point, counts, pointers) plus a Full Directory Index
//   blob elsewhere in the file that holds real dir/file name strings.
// - .utoc: FIoStoreTocHeader (144 bytes, magic "-==--==--==--==-"), fixed sections,
//   then an optional Directory Index (mount point + entry tree + string table).
// - Either index may be AES-256-ECB encrypted (Marvel Rivals' own paks are; mod
//   containers made with repak/UnrealReZen usually are not).

const fs = require('fs')
const crypto = require('crypto')
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const { characterName, detectCharactersFromText } = require('./characters')
const toolManager = require('./toolManager')

const DETECTION_VERSION = 4

const PAK_MAGIC = 0x5a6f12e1
const UTOC_MAGIC = Buffer.from('-==--==--==--==-', 'latin1')

function parseAesKey (keyStr) {
  if (!keyStr) return null
  const hex = String(keyStr).trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

function aesDecrypt (buf, key) {
  if (!key) return null
  try {
    const usable = buf.subarray(0, buf.length - (buf.length % 16))
    const d = crypto.createDecipheriv('aes-256-ecb', key, null)
    d.setAutoPadding(false)
    return Buffer.concat([d.update(usable), d.final()])
  } catch {
    return null
  }
}

// ---------- shared readers ----------

class Reader {
  constructor (buf) { this.buf = buf; this.pos = 0 }
  ok (n) { return this.pos + n <= this.buf.length }
  u8 () { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v }
  u16 () { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v }
  i32 () { const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v }
  u32 () { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v }
  i64 () { const v = this.buf.readBigInt64LE(this.pos); this.pos += 8; return Number(v) }
  u64 () { const v = this.buf.readBigUInt64LE(this.pos); this.pos += 8; return Number(v) }
  skip (n) { this.pos += n }
  bytes (n) { const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v }
  // UE FString: int32 length (negative => UTF-16), then chars incl. null terminator
  fstring (maxLen = 4096) {
    if (!this.ok(4)) throw new Error('eof')
    const len = this.i32()
    if (len === 0) return ''
    if (len > 0) {
      if (len > maxLen || !this.ok(len)) throw new Error('bad fstring')
      const s = this.buf.toString('latin1', this.pos, this.pos + len - 1)
      this.pos += len
      return s
    }
    const n = -len
    if (n > maxLen || !this.ok(n * 2)) throw new Error('bad fstring')
    const s = this.buf.toString('utf16le', this.pos, this.pos + (n - 1) * 2)
    this.pos += n * 2
    return s
  }
}

// Fallback: harvest path-looking printable strings from a binary buffer.
function scanStrings (buf) {
  const out = new Set()
  const re = /[ -~]{6,400}/g // printable ASCII runs
  // work in 1MB chunks to keep regex memory sane on big buffers
  const step = 1 << 20
  for (let off = 0; off < buf.length; off += step) {
    const chunk = buf.toString('latin1', off, Math.min(buf.length, off + step + 400))
    let m
    while ((m = re.exec(chunk)) !== null) {
      const s = m[0]
      if (s.includes('/') && /[A-Za-z]/.test(s)) out.add(s)
    }
  }
  return [...out]
}

// ---------- .pak ----------

function parsePakFooter (fd, fileSize) {
  const tail = Buffer.alloc(Math.min(4096, fileSize))
  fs.readSync(fd, tail, 0, tail.length, fileSize - tail.length)
  // find magic scanning backwards
  for (let i = tail.length - 8; i >= 0; i--) {
    if (tail.readUInt32LE(i) === PAK_MAGIC) {
      const version = tail.readInt32LE(i + 4)
      if (version < 1 || version > 13) continue
      const indexOffset = Number(tail.readBigInt64LE(i + 8))
      const indexSize = Number(tail.readBigInt64LE(i + 16))
      if (indexOffset < 0 || indexSize <= 0 || indexOffset + indexSize > fileSize) continue
      const encrypted = i >= 1 ? tail.readUInt8(i - 1) === 1 : false
      return { version, indexOffset, indexSize, encrypted }
    }
  }
  return null
}

function normalizeMount (mount) {
  return String(mount || '').replace(/\0/g, '').replace(/^(\.\.\/)+/, '').replace(/^\//, '')
}

function parsePakIndex (fd, footer, aesKey) {
  let index = Buffer.alloc(footer.indexSize)
  fs.readSync(fd, index, 0, footer.indexSize, footer.indexOffset)
  if (footer.encrypted) {
    const dec = aesDecrypt(index, aesKey)
    if (!dec) return { paths: [], encrypted: true, failed: true }
    index = dec
  }

  const paths = []
  try {
    const r = new Reader(index)
    const mount = normalizeMount(r.fstring())
    if (footer.version >= 10) {
      r.i32() // entry count
      r.u64() // path hash seed
      let fdiOffset = -1
      let fdiSize = 0
      if (r.i32() === 1) { r.i64(); r.i64(); r.skip(20) } // path-hash index ptr (unused)
      if (r.i32() === 1) { fdiOffset = r.i64(); fdiSize = r.i64(); r.skip(20) }
      if (fdiOffset > 0 && fdiSize > 0 && fdiSize < 256 * 1024 * 1024) {
        let fdi = Buffer.alloc(fdiSize)
        fs.readSync(fd, fdi, 0, fdiSize, fdiOffset)
        if (footer.encrypted) {
          const dec = aesDecrypt(fdi, aesKey)
          if (!dec) return { paths: [], encrypted: true, failed: true }
          fdi = dec
        }
        const fr = new Reader(fdi)
        const dirCount = fr.u32()
        for (let d = 0; d < dirCount && d < 100000; d++) {
          const dirName = fr.fstring().replace(/\0/g, '')
          const fileCount = fr.u32()
          for (let f = 0; f < fileCount && f < 200000; f++) {
            const fileName = fr.fstring().replace(/\0/g, '')
            fr.i32() // entry location index
            paths.push(mount + dirName + fileName)
          }
        }
      }
    } else {
      // v<=9: entries are inline "FString path + metadata struct" records. The struct
      // size varies by version, so parse name-by-name with resync via string scan on failure.
      const count = r.i32()
      for (let i = 0; i < count && i < 200000; i++) {
        const p = r.fstring()
        paths.push(mount + p.replace(/\0/g, ''))
        // skip entry: offset(8) size(8) uncompressed(8) method(4) hash(20)
        r.skip(48)
        if (footer.version >= 3) {
          // compressed block list may follow; bail to scan mode if things look off
          break
        }
      }
      if (paths.length < count) {
        for (const s of scanStrings(index)) paths.push(s)
      }
    }
  } catch {
    for (const s of scanStrings(index)) paths.push(s)
  }
  return { paths, encrypted: footer.encrypted, failed: false }
}

function listPakContents (pakPath, aesKeyStr) {
  const aesKey = parseAesKey(aesKeyStr)
  let fd = null
  try {
    fd = fs.openSync(pakPath, 'r')
    const fileSize = fs.fstatSync(fd).size
    if (fileSize < 64) return { paths: [], note: 'too-small' }
    const footer = parsePakFooter(fd, fileSize)
    if (!footer) {
      // not a standard pak — harvest strings from the tail & head as last resort
      const sample = Buffer.alloc(Math.min(fileSize, 4 << 20))
      fs.readSync(fd, sample, 0, sample.length, Math.max(0, fileSize - sample.length))
      return { paths: scanStrings(sample), note: 'no-footer' }
    }
    const res = parsePakIndex(fd, footer, aesKey)
    if (res.failed) return { paths: [], note: 'encrypted-no-key' }
    return { paths: res.paths, note: res.encrypted ? 'encrypted' : 'ok' }
  } catch (e) {
    return { paths: [], note: 'error: ' + e.message }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

// ---------- .utoc ----------

const UTOC_FLAG_ENCRYPTED = 1 << 1
const UTOC_FLAG_SIGNED = 1 << 2
const UTOC_FLAG_INDEXED = 1 << 3

function listUtocContents (utocPath, aesKeyStr) {
  const aesKey = parseAesKey(aesKeyStr)
  try {
    const buf = fs.readFileSync(utocPath)
    if (buf.length < 144 || !buf.subarray(0, 16).equals(UTOC_MAGIC)) {
      return { paths: scanStrings(buf), note: 'no-magic' }
    }
    const version = buf.readUInt8(16)
    const headerSize = buf.readUInt32LE(20)
    const entryCount = buf.readUInt32LE(24)
    const compressedBlockEntryCount = buf.readUInt32LE(28)
    const compressedBlockEntrySize = buf.readUInt32LE(32)
    const methodNameCount = buf.readUInt32LE(36)
    const methodNameLength = buf.readUInt32LE(40)
    const directoryIndexSize = buf.readUInt32LE(48)
    const containerFlags = buf.readUInt8(84)
    const perfectHashSeedsCount = buf.readUInt32LE(88)
    const chunksWithoutPerfectHashCount = buf.readUInt32LE(100)

    if (!(containerFlags & UTOC_FLAG_INDEXED) || directoryIndexSize === 0) {
      return { paths: scanStrings(buf), note: 'no-index' }
    }

    let off = headerSize || 144
    off += entryCount * 12 // chunk ids
    off += entryCount * 10 // offset+length entries
    if (version >= 4) off += perfectHashSeedsCount * 4
    if (version >= 5) off += chunksWithoutPerfectHashCount * 4
    off += compressedBlockEntryCount * (compressedBlockEntrySize || 12)
    off += methodNameCount * methodNameLength
    if (containerFlags & UTOC_FLAG_SIGNED) {
      const hashSize = buf.readUInt32LE(off)
      off += 4 + hashSize * 2 + compressedBlockEntryCount * 20
    }
    if (off < 0 || off + directoryIndexSize > buf.length) {
      return { paths: scanStrings(buf), note: 'index-offset-oob' }
    }

    let dirIndex = buf.subarray(off, off + directoryIndexSize)
    if (containerFlags & UTOC_FLAG_ENCRYPTED) {
      const dec = aesDecrypt(dirIndex, aesKey)
      if (!dec) return { paths: [], note: 'encrypted-no-key' }
      dirIndex = dec
    }

    // FIoDirectoryIndexResource
    const r = new Reader(dirIndex)
    const mount = normalizeMount(r.fstring())
    const dirCount = r.u32()
    const dirs = []
    for (let i = 0; i < dirCount && i < 200000; i++) {
      dirs.push({ name: r.u32(), firstChild: r.u32(), nextSibling: r.u32(), firstFile: r.u32() })
    }
    const fileCount = r.u32()
    const files = []
    for (let i = 0; i < fileCount && i < 400000; i++) {
      files.push({ name: r.u32(), next: r.u32() })
      r.u32() // user data
    }
    const strCount = r.u32()
    const strings = []
    for (let i = 0; i < strCount && i < 400000; i++) strings.push(r.fstring().replace(/\0/g, ''))

    const NONE = 0xffffffff
    const nameOf = idx => (idx !== NONE && strings[idx] !== undefined ? strings[idx] : '')
    const paths = []
    const walk = (dirIdx, prefix, depth) => {
      if (depth > 64) return
      while (dirIdx !== NONE && dirs[dirIdx]) {
        const d = dirs[dirIdx]
        const dirPath = prefix + (nameOf(d.name) ? nameOf(d.name) + '/' : '')
        let f = d.firstFile
        let guard = 0
        while (f !== NONE && files[f] && guard++ < 400000) {
          paths.push(mount + dirPath + nameOf(files[f].name))
          f = files[f].next
        }
        walk(d.firstChild, dirPath, depth + 1)
        dirIdx = d.nextSibling
      }
    }
    walk(0, '', 0)
    if (paths.length === 0) {
      // tree walk came up empty — string table alone still tells us plenty
      return { paths: strings.filter(s => s), note: 'string-table-only' }
    }
    return { paths, note: 'ok' }
  } catch (e) {
    try {
      return { paths: scanStrings(fs.readFileSync(utocPath)), note: 'error-scan: ' + e.message }
    } catch {
      return { paths: [], note: 'error: ' + e.message }
    }
  }
}

// Async child process runner. This used to be spawnSync, which blocked the
// Electron main process (and froze the whole app) for up to two minutes on
// imports — never run helpers synchronously here.
function runHelper (exe, args, options = {}) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(exe, args, { cwd: options.cwd || path.dirname(exe), windowsHide: true })
    } catch (e) {
      return resolve({ status: -1, stdout: '', stderr: String(e && e.message) })
    }
    let stdout = ''; let stderr = ''; let settled = false
    const finish = result => { if (!settled) { settled = true; clearTimeout(timer); resolve(result) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish({ status: -1, stdout, stderr: 'timeout' }) }, options.timeout || 30000)
    child.stdout.on('data', d => { stdout = (stdout + d).slice(-16 * 1024 * 1024) })
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-1024 * 1024) })
    child.on('error', e => finish({ status: -1, stdout, stderr: String(e && e.message) }))
    child.on('close', code => finish({ status: code, stdout, stderr }))
  })
}

// The native parser is deliberately lightweight. For encrypted/newer layouts,
// use the installed Rivals-aware helper as a second pass instead of leaving the
// library as Unknown. This runs only during import/re-scan and has a short cap.
async function listWithHelper (containerPath, aesKeyStr) {
  try {
    const exe = toolManager.executable('uassettool')
    if (!exe) return { paths: [], note: 'helper-unavailable' }
    const isPak = /\.pak$/i.test(containerPath)
    const args = [isPak ? 'list_pak' : 'list_iostore', containerPath]
    if (aesKeyStr) args.push('--aes', aesKeyStr)
    const result = await runHelper(exe, args, { timeout: 30000 })
    if (result.status !== 0) return { paths: [], note: 'helper-failed' }
    const output = `${result.stdout || ''}\n${result.stderr || ''}`
    const paths = []
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^\/?((?:Marvel|Engine|Plugins)\/[A-Za-z0-9_./ ()&+\-]+)$/i)
      if (match) paths.push(match[1])
    }
    return { paths: [...new Set(paths)], note: paths.length ? 'helper-index' : 'helper-empty' }
  } catch {
    return { paths: [], note: 'helper-failed' }
  }
}

function walkRelative (root, current = root, out = []) {
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const full = path.join(current, entry.name)
    if (entry.isDirectory()) walkRelative(root, full, out)
    else out.push(path.relative(root, full).replace(/\\/g, '/'))
  }
  return out
}

// Some IoStore mods deliberately omit their directory index. The helper can
// still resolve package IDs against the installed game's global metadata; use
// that slower route only when both parsers found nothing.
async function extractIndexlessUtocPaths (utocPath) {
  let out = null
  try {
    const exe = toolManager.executable('uassettool')
    if (!exe || !fs.existsSync(utocPath.replace(/\.utoc$/i, '.ucas'))) return { paths: [], note: 'deep-scan-unavailable' }
    const store = require('./store')
    const { describeRoot } = require('./gameLocator')
    const gameRoot = store.get('gameRoot')
    if (!gameRoot) return { paths: [], note: 'deep-scan-no-game' }
    const gamePaks = describeRoot(gameRoot).paksPath
    if (!fs.existsSync(gamePaks)) return { paths: [], note: 'deep-scan-no-game' }
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-detect-'))
    const result = await runHelper(exe, ['extract_iostore_legacy', gamePaks, out, '--mod', utocPath], { timeout: 120000 })
    if (result.status !== 0) return { paths: [], note: 'deep-scan-failed' }
    const paths = walkRelative(out)
    return { paths, note: paths.length ? 'helper-extracted' : 'deep-scan-empty' }
  } catch {
    return { paths: [], note: 'deep-scan-failed' }
  } finally {
    if (out) fs.rmSync(out, { recursive: true, force: true })
  }
}

// ---------- classification ----------

const RE_CHAR_PATH = /(?:characters|character)\/(\d{4})(?:\d{3})?(?:[/_]|$)/gi
// 7-digit costume/bank IDs are commonly adjacent to underscores (a word
// character), so numeric boundaries are used instead of \b.
const RE_ID_COSTUME = /(?:^|[^0-9])(1\d{3})(\d{3})(?=$|[^0-9])/g
// bare character-id folder segments (audio banks, VFX etc. use e.g. .../Media/1024/...)
const RE_ID_SEGMENT = /\/([148]\d{3})\//g
const RE_AUDIO = /wwiseaudio|wwise|\.bnk|\.wem|akaudio|\/audio\//i
const RE_VO = /\/vo[_/]|_vo_|\bvo_|voice/i
const RE_UI = /\/ui\/|nameplate|banner|portrait|headicon|spray|emote|mvp\b|killfeed|hud|crosshair|loadingscreen|\/gallery\//i
const RE_VFX = /\/vfx\/|niagara|particles/i
const RE_MOVIE = /\.bk2|\/movies\//i
const RE_SKIN = /meshes|skeletalmesh|staticmesh|textures|materials|costume|marveldesign|\/skin|\.uasset|\.uexp|\.ubulk/i
const RE_MAP = /\/maps\/|\/map\/|level/i

function classifyPaths (paths, extraText) {
  const chars = new Set()
  const rootedChars = new Set()
  const types = new Set()

  // Helpers on Windows return backslashes while Unreal container indexes usually
  // use forward slashes. Normalize first so character-root ownership works for
  // both sources.
  const joined = paths.join('\n').replace(/\\/g, '/')

  let m
  RE_CHAR_PATH.lastIndex = 0
  while ((m = RE_CHAR_PATH.exec(joined)) !== null) {
    const id = Number(m[1])
    if (characterName(id)) rootedChars.add(id)
  }
  for (const id of rootedChars) chars.add(id)

  // A Characters/<hero id>/ directory is authoritative. Character packages
  // commonly reuse textures whose *file names* contain another hero/costume id;
  // treating those borrowed names as ownership made Cyclops mods appear as Rogue
  // mods. Only fall back to loose costume/path ids for packages without a
  // character root (notably Wwise banks and some older mods).
  if (rootedChars.size === 0) {
    RE_ID_COSTUME.lastIndex = 0
    while ((m = RE_ID_COSTUME.exec(joined)) !== null) {
      const id = Number(m[1])
      if (characterName(id)) chars.add(id)
    }
    RE_ID_SEGMENT.lastIndex = 0
    while ((m = RE_ID_SEGMENT.exec(joined)) !== null) {
      const id = Number(m[1])
      if (characterName(id)) chars.add(id)
    }
  }

  const hasAudio = RE_AUDIO.test(joined)
  const hasUI = RE_UI.test(joined)
  const hasVFX = RE_VFX.test(joined)
  const hasMovie = RE_MOVIE.test(joined)
  const hasSkinAssets = RE_SKIN.test(joined)
  const hasMap = RE_MAP.test(joined) && !hasSkinAssets

  if (hasAudio) types.add(RE_VO.test(joined) ? 'voice' : 'audio')
  if (hasUI) types.add('ui')
  if (hasVFX) types.add('vfx')
  if (hasMovie) types.add('cinematic')
  if (hasSkinAssets && chars.size > 0) types.add('skin')
  if (hasMap) types.add('map')

  // No characters found in paths? Try the mod/file name text.
  let charSource = chars.size > 0 ? 'assets' : null
  if (chars.size === 0 && extraText) {
    for (const id of detectCharactersFromText(extraText)) chars.add(id)
    if (chars.size > 0) charSource = 'name'
  }


  // Filename/title clues are valuable when a mod intentionally encrypts its
  // index or uses an unusual container. Keep these conservative and explicit.
  const named = String(extraText || '').toLowerCase().replace(/[_\-.]+/g, ' ')
  if (!types.size && /(?:^|\s)(skin|costume|outfit|body ?reshape)(?:\s|$)/i.test(named)) types.add('skin')
  if (!types.size && /(?:voice ?line|voiceover|voice pack|\bvo\b)/i.test(named)) types.add('voice')
  if (!types.size && /(?:audio|sound|\bsfx\b|music|soundtrack|louder|quieter)/i.test(named)) types.add('audio')
  if (!types.size && /(?:vfx|visual effects?|particles?)/i.test(named)) types.add('vfx')

  // Character assets present but no recognizable type → assume skin (most common)
  if (chars.size > 0 && types.size === 0 && (hasSkinAssets || paths.length > 0)) types.add('skin')
  if (types.size === 0 && paths.length > 0 && hasSkinAssets) types.add('visual')

  return {
    characters: [...chars].sort().map(id => ({ id, name: characterName(id) })),
    types: [...types],
    charSource,
    pathCount: paths.length
  }
}

const TYPE_LABELS = {
  skin: 'Skin',
  audio: 'Audio',
  voice: 'Voice',
  ui: 'UI / Visual',
  vfx: 'VFX',
  cinematic: 'Cinematic',
  map: 'Map',
  visual: 'Visual',
  gameplay: 'Gameplay'
}

// Analyze a whole mod: a list of container files (.pak/.utoc; .ucas has no readable index)
async function analyzeModFiles (containerPaths, aesKeyStr, extraText) {
  const allPaths = []
  const notes = []
  for (const p of containerPaths) {
    const lower = p.toLowerCase()
    let res = null
    if (lower.endsWith('.pak')) res = listPakContents(p, aesKeyStr)
    else if (lower.endsWith('.utoc')) res = listUtocContents(p, aesKeyStr)
    if (res && res.paths.length === 0) {
      const helper = await listWithHelper(p, aesKeyStr)
      if (helper.paths.length) res = helper
      else if (lower.endsWith('.utoc')) {
        const deep = await extractIndexlessUtocPaths(p)
        if (deep.paths.length) res = deep
        else notes.push(helper.note, deep.note)
      } else notes.push(helper.note)
    }
    if (res) {
      notes.push(res.note)
      for (const ap of res.paths) allPaths.push(ap)
    }
  }
  const cls = classifyPaths(allPaths, extraText)
  let label
  if (cls.types.length === 0 && cls.characters.length === 0) {
    label = allPaths.length === 0 ? 'Unclassified' : 'Other'
  } else {
    const t = cls.types.map(t => TYPE_LABELS[t] || t).join(' + ')
    label = t || 'Character content'
  }
  return {
    ...cls,
    version: DETECTION_VERSION,
    label,
    notes,
    samplePaths: allPaths.filter(p => /characters|wwise|\/ui\/|vfx/i.test(p)).slice(0, 12)
  }
}

module.exports = { DETECTION_VERSION, listPakContents, listUtocContents, listWithHelper, extractIndexlessUtocPaths, classifyPaths, analyzeModFiles, TYPE_LABELS }
