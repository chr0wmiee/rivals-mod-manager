'use strict'

const fs = require('fs')
const path = require('path')
const { classifyAudioUsage, parseCharacterList, parseAudioIdList, parseCommunityWorkbook } = require('../electron/lib/communityParser')

const research = process.argv[2]
if (!research) throw new Error('Pass the rivals-v2-research directory.')
const soundkit = path.join(research, 'soundKit_MR')
const charText = fs.readFileSync(path.join(soundkit, '0-CHARACTER-ID-LIST.txt'), 'utf8')
const audioText = fs.readFileSync(path.join(soundkit, '0-AUDIO-ID-LIST.txt'), 'utf8')
const parsed = parseCharacterList(charText)
const curated = parseAudioIdList(audioText, parsed.characters)
const workbook = parseCommunityWorkbook(fs.readFileSync(path.join(research, 'community-audio.xlsx')), parsed.characters)
const voiceLines = [...curated.filter(x => x.kind === 'voice'), ...workbook.items.filter(x => x.kind === 'voice')]
const targets = [...curated.filter(x => x.kind !== 'voice'), ...workbook.items.filter(x => x.kind !== 'voice')]

const dedupe = list => [...new Map(list.map(x => [`${x.bank}|${x.wemId}`, x])).values()]
const withUsage = list => dedupe(list).map(item => ({ ...item, usage: classifyAudioUsage(item) }))
const output = {
  schema: 4,
  version: 'season-9',
  updatedAt: new Date().toISOString(),
  sources: {
    soundkit: 'https://github.com/BruhLookAtThis/soundKit_MR',
    sheet: 'https://docs.google.com/spreadsheets/d/14gbnE0TD2O4e8zrn2jSJm9HsNl5vWxFYWm4ZsndQJlA/edit'
  },
  characters: parsed.characters,
  costumes: parsed.costumes,
  targets: withUsage(targets),
  voiceLines: withUsage(voiceLines)
}
const dest = path.join(__dirname, '..', 'electron', 'data', 'communityData.json')
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.writeFileSync(dest, JSON.stringify(output))
console.log(JSON.stringify({ dest, characters: output.characters.length, costumes: output.costumes.length, targets: output.targets.length, voiceLines: output.voiceLines.length, bytes: fs.statSync(dest).size }))
