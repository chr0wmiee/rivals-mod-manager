'use strict'

const DISPLAY_NAMES = {
  ThePunisher: 'The Punisher', HumanTorch: 'Human Torch', DoctorStrange: 'Doctor Strange',
  CloakDagger: 'Cloak & Dagger', BlackPanther: 'Black Panther', MoonKnight: 'Moon Knight',
  LunaSnow: 'Luna Snow', SquirrelGirl: 'Squirrel Girl', BlackWidow: 'Black Widow',
  IronMan: 'Iron Man', SpiderMan: 'Spider-Man', ScarletWitch: 'Scarlet Witch',
  MrFantastic: 'Mister Fantastic', WinterSoldier: 'Winter Soldier', PeniParker: 'Peni Parker',
  StarLord: 'Star-Lord', AdamWarlock: 'Adam Warlock', RocketRaccoon: 'Rocket Raccoon',
  InvisibleWoman: 'Invisible Woman', TheThing: 'The Thing', IronFist: 'Iron Fist',
  EmmaFrost: 'Emma Frost', DareDevil: 'Daredevil', DevilDinosaur: 'Devil Dinosaur',
  ElsaBloodstone: 'Elsa Bloodstone', WhiteFox: 'White Fox', BlackCat: 'Black Cat',
  TheHood: 'The Hood', Jeff: 'Jeff the Land Shark'
}

function displayName (raw) {
  const clean = String(raw || '').replace(/^NPC_/, '').trim()
  return DISPLAY_NAMES[clean] || clean.replace(/([a-z])([A-Z])/g, '$1 $2')
}

function classifyAudioUsage (item = {}) {
  const event = String(item.event || '').toLowerCase()
  const description = `${item.label || ''} ${item.note || ''}`.toLowerCase()
  const curatedLabel = item.source === 'soundkit'
  if ((/(?:^|_)q(?:_|$)/.test(event) && !/quick_q_charge/.test(event)) || (curatedLabel && /\bult(?:imate)?\b/.test(description))) return 'ultimate'
  if (/ability|(?:^|_)(?:e|shift|right|left|space|teamup|normal_attack)(?:_|$)/.test(event) || (curatedLabel && /\babilit(?:y|ies)\b/.test(description))) return 'ability'
  return ''
}

function parseCharacterList (text) {
  const characters = []
  const costumes = []
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    const match = line.match(/^\s*(\d{4,7})\s*:\s*([^\r\n]+?)\s*$/)
    if (!match) continue
    const id = Number(match[1])
    const value = match[2].trim()
    const costume = value.match(/^(.+?)\s*\((.+)\)$/)
    if (match[1].length === 4 && id >= 1000 && id < 2000) {
      characters.push({ id, name: displayName(value) })
    } else if (match[1].length === 7 && id >= 1000000 && id < 2000000) {
      const heroId = Number(match[1].slice(0, 4))
      costumes.push({ id, heroId, hero: displayName(costume ? costume[1] : value), name: costume ? costume[2].trim() : 'Default' })
    }
  }
  return {
    characters: [...new Map(characters.map(x => [x.id, x])).values()].sort((a, b) => a.name.localeCompare(b.name)),
    costumes: [...new Map(costumes.map(x => [x.id, x])).values()]
  }
}

function parseAudioIdList (text, characters = []) {
  const byId = new Map(characters.map(c => [c.id, c.name]))
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean || clean.startsWith('#')) continue
    const idMatch = clean.match(/:\s*(\d+)\s*$/)
    const bankMatch = clean.match(/-(bnk_[^\s:\[]+)/i)
    if (!idMatch || !bankMatch) continue
    const wemId = Number(idMatch[1])
    const bank = bankMatch[1].replace(/\.bnk$/i, '') + '.bnk'
    const heroMatch = bank.match(/(1\d{3})\d{3}/)
    const heroId = heroMatch ? Number(heroMatch[1]) : null
    const note = (clean.match(/\[([^\]]+)\]/) || [])[1] || ''
    const label = clean.slice(0, bankMatch.index).trim()
    out.push({ wemId, bank, heroId, hero: byId.get(heroId) || '', label, note, kind: /\(VO\)|bnk_vo_/i.test(clean) ? 'voice' : 'sfx', source: 'soundkit' })
  }
  return out
}

function parseCsv (text) {
  const rows = []
  let row = []; let cell = ''; let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = '' }
    else cell += ch
  }
  if (cell || row.length) { row.push(cell); rows.push(row) }
  return rows
}

function parseCommunityAudioCsv (text) {
  const rows = parseCsv(String(text || ''))
  const out = []
  let bank = ''
  for (const row of rows.slice(1)) {
    if ((row[0] || '').trim()) bank = row[0].trim().replace(/\.bnk$/i, '') + '.bnk'
    const id = Number(((row[1] || '').match(/^\s*(\d+)/) || [])[1])
    if (!id) continue
    out.push({ wemId: id, bank, heroId: null, hero: '', label: (row[2] || '').trim() || (row[1] || '').replace(/^\d+-?/, ''), note: (row[3] || '').trim(), kind: 'ui', source: 'community-sheet' })
  }
  return out
}

function parseSubtitleText (text, heroId, hero, bank) {
  const out = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)-([^,]+),\s*"?(.*?)"?\s*$/)
    if (!match) continue
    const event = match[2].trim()
    const spoken = match[3].replace(/""/g, '"').replace(/"$/, '').trim()
    out.push({ wemId: Number(match[1]), bank, heroId, hero, label: event.replace(/^vo_\d+_?/, '').replace(/_play(?:_p\d+)?$/i, '').replace(/_/g, ' '), event, spoken, kind: 'voice', source: 'soundkit-subs' })
  }
  return out
}

function xmlText (value) {
  return String(value || '').replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
}

function columnIndex (ref) {
  const letters = (String(ref).match(/^[A-Z]+/i) || ['A'])[0].toUpperCase()
  let value = 0
  for (const ch of letters) value = value * 26 + ch.charCodeAt(0) - 64
  return value - 1
}

function worksheetRows (xml, shared) {
  const rows = []
  for (const rowMatch of String(xml || '').matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = []
    // Remove empty self-closing cells first; otherwise a regex match can start at
    // one of them and consume the following populated cell as its body.
    const cellsXml = rowMatch[1].replace(/<c\b[^>]*\/>/g, '')
    for (const cellMatch of cellsXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1]; const body = cellMatch[2]
      const ref = (attrs.match(/\br="([^"]+)"/) || [])[1]
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1]
      const raw = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1]
      const inline = [...body.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x => xmlText(x[1])).join('')
      let value = inline
      if (raw !== undefined) value = type === 's' ? (shared[Number(raw)] || '') : xmlText(raw)
      row[ref ? columnIndex(ref) : row.length] = value
    }
    rows.push(row.map(x => x ?? ''))
  }
  return rows
}

function parseCommunitySheetRows (sheetName, rows, characters = []) {
  const headerIndex = rows.slice(0, 8).findIndex(row => row.some(cell => /wem\s*id/i.test(String(cell))))
  if (headerIndex < 0) return []
  const header = rows[headerIndex].map(x => String(x || '').trim())
  const idCol = header.findIndex(x => /wem\s*id/i.test(x))
  const labelCol = header.findIndex(x => /voice\s*line|event|audio\s*name|description/i.test(x))
  const noteCol = header.findIndex(x => /^note/i.test(x))
  const bankCol = header.findIndex(x => /^bnk\b/i.test(x)) >= 0 ? header.findIndex(x => /^bnk\b/i.test(x)) : 0
  if (idCol < 0) return []
  const normalizedSheet = sheetName.replace(/[^a-z0-9]/gi, '').toLowerCase()
  const sheetHero = characters.find(c => normalizedSheet.startsWith(c.name.replace(/[^a-z0-9]/gi, '').toLowerCase()))
  // Sheet names such as "MEDIA SFX" and "MUSIC Formal SFX" contain SFX,
  // but they are global/streamed media rather than character ability banks.
  const kind = /^UI[_\s]/i.test(sheetName)
    ? 'ui'
    : /music|media/i.test(sheetName)
      ? 'media'
      : /\bVO\b/i.test(sheetName)
        ? 'voice'
        : 'sfx'
  const out = []
  let bank = ''
  for (const row of rows.slice(headerIndex + 1)) {
    const bankCell = String(row[bankCol] || '')
    const bankMatch = bankCell.match(/bnk_[a-z0-9_]+/i)
    if (bankMatch) bank = bankMatch[0].replace(/\.bnk$/i, '') + '.bnk'
    else if (/no\s*bnk/i.test(bankCell)) bank = ''
    const idCell = String(row[idCol] || '')
    const ids = [...idCell.matchAll(/(?:^|\n|\s)(\d{5,})(?:-([^\n]+))?/g)]
    if (!ids.length) continue
    const labels = String(labelCol >= 0 ? row[labelCol] || '' : '').split(/\n+/)
    for (let index = 0; index < ids.length; index++) {
      const wemId = Number(ids[index][1]); if (!wemId) continue
      const event = String(ids[index][2] || '').trim()
      const heroMatch = bank.match(/_(1\d{3})\d{3}/)
      const heroId = heroMatch ? Number(heroMatch[1]) : (sheetHero?.id || null)
      const hero = characters.find(c => c.id === heroId)?.name || sheetHero?.name || ''
      const label = (labels[index] || labels[0] || event || `Sound ${wemId}`).trim()
      out.push({
        wemId, bank, heroId, hero, label, event,
        spoken: kind === 'voice' ? label : '',
        note: String(noteCol >= 0 ? row[noteCol] || '' : '').trim(),
        kind, source: `community-sheet:${sheetName}`, verified: true
      })
    }
  }
  return out
}

function parseCommunityWorkbook (buffer, characters = []) {
  const AdmZip = require('adm-zip')
  const zip = new AdmZip(buffer)
  const read = name => zip.getEntry(name)?.getData().toString('utf8') || ''
  const sharedXml = read('xl/sharedStrings.xml')
  const shared = [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(match => [...match[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x => xmlText(x[1])).join(''))
  const workbook = read('xl/workbook.xml')
  const rels = read('xl/_rels/workbook.xml.rels')
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*\/>/g)].map(m => [m[1], m[2].replace(/^\//, '')]))
  const sheets = []
  for (const match of workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const name = xmlText(match[1]); const target = targets.get(match[2])
    // The KEY AUDIO sheet mirrors 0-AUDIO-ID-LIST.txt. Parsing it again used to
    // classify its explicitly marked VO rows as SFX and create misleading
    // duplicates in the ability filter. The soundkit text parser handles those
    // rows (and their VO/SFX type) exactly.
    if (!target || /announcement|information|character id list|filename dictionary|key audios id list|ignore/i.test(name)) continue
    const entryName = target.startsWith('xl/') ? target : `xl/${target}`
    const rows = worksheetRows(read(entryName), shared)
    const items = parseCommunitySheetRows(name, rows, characters)
    if (items.length) sheets.push({ name, count: items.length, items })
  }
  return { sheets, items: sheets.flatMap(x => x.items) }
}

module.exports = { displayName, classifyAudioUsage, parseCharacterList, parseAudioIdList, parseCommunityAudioCsv, parseSubtitleText, parseCommunitySheetRows, parseCommunityWorkbook }
