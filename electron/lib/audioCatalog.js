'use strict'

const fs = require('fs')
const path = require('path')
const { app } = require('electron')
const { classifyAudioUsage, parseCharacterList, parseAudioIdList, parseCommunityWorkbook } = require('./communityParser')

const BUNDLED = path.join(__dirname, '..', 'data', 'communityData.json')
const RAW = 'https://raw.githubusercontent.com/BruhLookAtThis/soundKit_MR/main/'
const SHEET_XLSX = 'https://docs.google.com/spreadsheets/d/14gbnE0TD2O4e8zrn2jSJm9HsNl5vWxFYWm4ZsndQJlA/export?format=xlsx'

let cache = null
let progressSink = null
function setProgressSink (fn) { progressSink = fn }
function emit (payload) { if (progressSink) progressSink(payload) }
function cachePath () { return path.join(app.getPath('userData'), 'community-data.json') }

function load () {
  if (cache) return cache
  const preferred = cachePath()
  try {
    const saved = JSON.parse(fs.readFileSync(preferred, 'utf8'))
    if (!Number.isFinite(Number(saved.schema)) || Number(saved.schema) < 4) throw new Error('Outdated catalog cache')
    cache = saved
  } catch { cache = JSON.parse(fs.readFileSync(BUNDLED, 'utf8')) }
  return cache
}

function summary () {
  const data = load()
  return {
    version: data.version,
    updatedAt: data.updatedAt,
    sources: data.sources,
    characters: data.characters,
    costumes: data.costumes,
    targetCount: data.targets.length,
    voiceLineCount: data.voiceLines.length
  }
}

function allItems () {
  const data = load()
  return [...data.targets, ...data.voiceLines].map(item => item.usage === undefined ? { ...item, usage: classifyAudioUsage(item) } : item)
}

function query (opts = {}) {
  const heroId = Number(opts.heroId) || null
  const kind = opts.kind || 'all'
  const terms = String(opts.query || '').trim().toLowerCase()
  const page = Math.max(0, Number(opts.page) || 0)
  const pageSize = Math.min(200, Math.max(20, Number(opts.pageSize) || 80))
  let items = allItems()
  if (heroId) items = items.filter(x => Number(x.heroId) === heroId)
  if (kind === 'ultimate' || kind === 'ability') items = items.filter(x => x.usage === kind)
  else if (kind === 'sfx') items = items.filter(x => x.kind === 'sfx' || x.kind === 'media' || x.usage === 'ability' || x.usage === 'ultimate')
  else if (kind !== 'all') items = items.filter(x => x.kind === kind)
  if (terms) items = items.filter(x => `${x.label} ${x.spoken || ''} ${x.event || ''} ${x.bank} ${x.wemId} ${x.hero || ''}`.toLowerCase().includes(terms))
  items.sort((a, b) => (a.hero || '').localeCompare(b.hero || '') || (a.label || '').localeCompare(b.label || '') || a.wemId - b.wemId)
  return { items: items.slice(page * pageSize, (page + 1) * pageSize), total: items.length, page, pageSize }
}

function lookup (bank, wemId) {
  const base = path.basename(bank || '').toLowerCase()
  return allItems().find(x => x.wemId === Number(wemId) && x.bank && path.basename(x.bank).toLowerCase() === base) || null
}

function lookupAny (wemId) {
  const matches = allItems().filter(x => x.wemId === Number(wemId))
  return matches.length === 1 ? matches[0] : null
}

async function fetchText (url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'RivalsModManager/2.0' }, signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`Community data request failed (${res.status}).`)
  return res.text()
}

async function fetchBuffer (url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'RivalsModManager/2.0' }, signal: AbortSignal.timeout(60000) })
  if (!res.ok) throw new Error(`Community data request failed (${res.status}).`)
  return Buffer.from(await res.arrayBuffer())
}

async function refresh () {
  emit({ status: 'downloading', message: 'Fetching current Season data…' })
  const [charText, audioText, workbookBytes] = await Promise.all([
    fetchText(RAW + '0-CHARACTER-ID-LIST.txt'),
    fetchText(RAW + '0-AUDIO-ID-LIST.txt'),
    fetchBuffer(SHEET_XLSX)
  ])
  emit({ status: 'indexing', message: 'Indexing friendly audio names…' })
  const parsed = parseCharacterList(charText)
  const workbook = parseCommunityWorkbook(workbookBytes, parsed.characters)
  const curated = parseAudioIdList(audioText, parsed.characters)
  const targets = [...curated.filter(x => x.kind !== 'voice'), ...workbook.items.filter(x => x.kind !== 'voice')]
  const voiceLines = [...curated.filter(x => x.kind === 'voice'), ...workbook.items.filter(x => x.kind === 'voice')]
  const dedupe = list => [...new Map(list.map(x => [`${x.bank}|${x.wemId}`, x])).values()].map(item => ({ ...item, usage: classifyAudioUsage(item) }))
  cache = {
    schema: 4, version: 'live', updatedAt: new Date().toISOString(),
    sources: { soundkit: 'https://github.com/BruhLookAtThis/soundKit_MR', sheet: SHEET_XLSX },
    characters: parsed.characters, costumes: parsed.costumes,
    targets: dedupe(targets), voiceLines: dedupe(voiceLines)
  }
  fs.mkdirSync(path.dirname(cachePath()), { recursive: true })
  fs.writeFileSync(cachePath(), JSON.stringify(cache))
  emit({ status: 'done', message: 'Community catalog updated.' })
  return summary()
}

module.exports = { load, summary, query, lookup, lookupAny, refresh, setProgressSink }
