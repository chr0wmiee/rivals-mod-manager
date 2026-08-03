'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { classifyAudioUsage, parseCharacterList, parseAudioIdList, parseCommunityAudioCsv } = require('../electron/lib/communityParser')
const { parseBnkBuffer, replaceWem } = require('../electron/lib/bnk')
const { classifyPaths } = require('../electron/lib/pakParser')
const { characterName, detectCharactersFromText } = require('../electron/lib/characters')
const assetServer = require('../electron/lib/assetServer')
const { pakFileName } = require('../electron/lib/audioEditor')
const { resolve7zaPath, isArchive, looksLikeArchive, sniffArchive, extractArchive, walkFiles } = require('../electron/lib/archive')
const { modelMaterials } = require('../electron/lib/previewManager')
const { enableLauncherBypass } = require('../electron/lib/gameLocator')

function chunk (id, data) {
  const header = Buffer.alloc(8); header.write(id, 0, 'ascii'); header.writeUInt32LE(data.length, 4)
  return Buffer.concat([header, data])
}

function fakeBnk () {
  const one = Buffer.from('RIFF1111WAVEfmt ')
  const two = Buffer.from('RIFF22222222WAVEfmt ')
  const didx = Buffer.alloc(24)
  didx.writeUInt32LE(101, 0); didx.writeUInt32LE(0, 4); didx.writeUInt32LE(one.length, 8)
  didx.writeUInt32LE(202, 12); didx.writeUInt32LE(one.length, 16); didx.writeUInt32LE(two.length, 20)
  return Buffer.concat([chunk('BKHD', Buffer.alloc(8)), chunk('DIDX', didx), chunk('DATA', Buffer.concat([one, two]))])
}

test('Season 9 character mappings are current and not swapped', () => {
  assert.equal(characterName(1055), 'Daredevil')
  assert.equal(characterName(1056), 'Angela')
  assert.equal(characterName(1062), 'Devil Dinosaur')
  assert.equal(characterName(1063), 'Cyclops')
  assert.equal(characterName(1064), 'Jubilee')
  assert.equal(characterName(1066), 'The Hood')
})

test('launching marks the game to skip its separate launcher', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-launch-'))
  const record = path.join(root, 'launch_record')
  fs.writeFileSync(record, '6\n')
  enableLauncherBypass(root)
  assert.equal(fs.readFileSync(record, 'utf8'), '0\n')
  fs.rmSync(root, { recursive: true, force: true })
})

test('community parsers produce friendly heroes, costumes and audio targets', () => {
  const parsed = parseCharacterList('1063: Cyclops\n1063001: Cyclops (Default)\n1066: TheHood\n')
  assert.deepEqual(parsed.characters, [{ id: 1063, name: 'Cyclops' }, { id: 1066, name: 'The Hood' }])
  assert.equal(parsed.costumes[0].name, 'Default')
  const audio = parseAudioIdList('Cyclops Ult (VO) (Default)-bnk_vo_1063001: 12345', parsed.characters)
  assert.equal(audio[0].hero, 'Cyclops')
  assert.equal(audio[0].kind, 'voice')
  const sheet = parseCommunityAudioCsv('bnk,Decimal Wem ID,Event,Note,Contributor\nbnk_ui_battle,38632907,Ping,pinging,test\n')
  assert.equal(sheet[0].label, 'Ping')
  assert.equal(classifyAudioUsage({ event: 'vo_10630413_q_p13_play' }), 'ultimate')
  assert.equal(classifyAudioUsage({ event: 'vo_10630419_ability_e_02_play' }), 'ability')
  assert.equal(classifyAudioUsage({ event: 'vo_10630440_quick_q_charge_100_01_play' }), '')
  assert.equal(classifyAudioUsage({ event: 'vo_10630330_interact_01_play', label: 'Control their abilities.' }), '')
})

test('classification detects multi-character Season 9 audio mods', () => {
  const result = classifyPaths([
    'Marvel/Content/WwiseAudio/English(US)/bnk_vo_1063001.bnk',
    'Marvel/Content/WwiseAudio/English(US)/bnk_vo_1064001.bnk'
  ])
  assert.deepEqual(result.characters.map(x => x.name).sort(), ['Cyclops', 'Jubilee'])
  assert.ok(result.types.includes('voice'))
})

test('character roots outrank borrowed texture ids from another hero', () => {
  const result = classifyPaths([
    'Marvel\\Content\\Marvel\\Characters\\1063\\1063001\\Models\\SK_1063001.uasset',
    'Marvel\\Content\\Marvel\\Characters\\1063\\1063001\\Textures\\T_1065001_Hair_D.uasset'
  ])
  assert.deepEqual(result.characters.map(x => x.name), ['Cyclops'])
})

test('multiple explicit character roots still identify a true multi-character mod', () => {
  const result = classifyPaths([
    'Marvel/Content/Marvel/Characters/1063/1063001/Models/SK_1063001.uasset',
    'Marvel/Content/Marvel/Characters/1065/1065001/Models/SK_1065001.uasset'
  ])
  assert.deepEqual(result.characters.map(x => x.name), ['Cyclops', 'Rogue'])
})

test('classification recognizes joined character names and clear filename types', () => {
  assert.deepEqual(detectCharactersFromText('SIT-MuscularBlackPanther_Skin').map(characterName), ['Black Panther'])
  assert.deepEqual(detectCharactersFromText('MuscularDrStrange_Default').map(characterName), ['Doctor Strange'])
  assert.deepEqual(detectCharactersFromText('WinterSoldier_Default').map(characterName), ['Winter Soldier'])
  assert.deepEqual(detectCharactersFromText('ordinary author notes'), [])
  const result = classifyPaths([], 'MuscularHumanTorch Skin Default')
  assert.deepEqual(result.characters.map(x => x.name), ['Human Torch'])
  assert.ok(result.types.includes('skin'))
})

test('preview media supports byte ranges used by the audio scrubber', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-range-'))
  const file = path.join(tmp, 'sound.wav')
  fs.writeFileSync(file, Buffer.from('0123456789'))
  const token = assetServer.registerRoot(tmp)
  const url = assetServer.assetUrl(token, file)
  const response = assetServer.responseForRequest(url, 'bytes=3-6')
  assert.equal(response.status, 206)
  assert.equal(response.headers['Accept-Ranges'], 'bytes')
  assert.equal(response.headers['Content-Range'], 'bytes 3-6/10')
  assert.equal(response.headers['Access-Control-Allow-Origin'], '*')
  assert.equal(response.body.toString(), '3456')
  const direct = assetServer.readAsset(url)
  assert.equal(direct.name, 'sound.wav')
  assert.equal(direct.bytes.toString(), '0123456789')
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('audio export respects a user filename without duplicating the game suffix', () => {
  assert.equal(pakFileName('My Luna Edit'), 'My_Luna_Edit_9999999_P.pak')
  assert.equal(pakFileName('My Luna Edit_9999999_P.pak'), 'My_Luna_Edit_9999999_P.pak')
  assert.equal(pakFileName('Bad:* Name?.pak'), 'Bad_Name_9999999_P.pak')
})

test('packaged archive extraction runs 7-Zip from app.asar.unpacked', () => {
  const packaged = path.join('C:', 'Rivals Mod Manager', 'resources', 'app.asar', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
  const expected = packaged.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)
  const originalExists = fs.existsSync
  fs.existsSync = candidate => candidate === expected
  try { assert.equal(resolve7zaPath(packaged), expected) } finally { fs.existsSync = originalExists }
})

test('FModel material metadata maps Unreal diffuse textures into the 3D viewer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-material-'))
  const models = path.join(root, 'models', 'Marvel', 'Materials')
  const textures = path.join(root, 'textures', 'Marvel', 'Textures')
  fs.mkdirSync(models, { recursive: true }); fs.mkdirSync(textures, { recursive: true })
  const png = path.join(textures, 'T_Jubilee_Body_D.png')
  const mask = path.join(textures, 'T_Jubilee_Hair_M.png')
  const json = path.join(models, 'MI_Jubilee_Body.json')
  fs.writeFileSync(png, Buffer.from('png'))
  fs.writeFileSync(mask, Buffer.from('png'))
  fs.writeFileSync(json, JSON.stringify({ Textures: { PM_Diffuse: 'Marvel/Textures/T_Jubilee_Body_D.T_Jubilee_Body_D', OpacityMask: 'Marvel/Textures/T_Jubilee_Hair_M.T_Jubilee_Hair_M' }, Parameters: { BlendMode: 1, Properties: { BasePropertyOverrides: { TwoSided: true } } } }))
  const token = assetServer.registerRoot(root)
  const mapped = modelMaterials(root, token, [png, mask, json])
  assert.match(mapped.MI_Jubilee_Body.diffuse, /^preview:\/\//)
  assert.match(mapped.MI_Jubilee_Body.opacity, /^preview:\/\//)
  assert.equal(mapped.MI_Jubilee_Body.twoSided, true)
  fs.rmSync(root, { recursive: true, force: true })
})

test('BNK replacement rebuilds DIDX offsets and preserves other media', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-test-'))
  const input = path.join(tmp, 'in.bnk'); const output = path.join(tmp, 'out.bnk')
  fs.writeFileSync(input, fakeBnk())
  replaceWem(input, 101, Buffer.from('replacement media payload'), output)
  const parsed = parseBnkBuffer(fs.readFileSync(output))
  assert.equal(parsed.entries.length, 2)
  assert.equal(parsed.entries[0].size, 25)
  assert.equal(parsed.entries[1].id, 202)
  assert.ok(parsed.entries[1].offset >= parsed.entries[0].size)
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('bundled catalog includes every spreadsheet category, not only the first tab', () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'electron', 'data', 'communityData.json'), 'utf8'))
  assert.ok(data.targets.length > 900)
  assert.ok(data.voiceLines.length > 23000)
  assert.ok(data.targets.some(x => x.hero === 'Cyclops' && x.bank === 'bnk_sfx_1063001.bnk' && /Ult Windup/.test(x.label)))
  assert.deepEqual(
    data.targets.filter(x => x.hero === 'Cyclops' && x.bank === 'bnk_sfx_1063001.bnk').map(x => x.wemId).sort((a, b) => a - b),
    [46135770, 62712100, 491059255, 532318299, 873739719]
  )
  assert.ok(data.targets.some(x => x.bank === 'bnk_ui_interface.bnk' && x.kind === 'ui'))
  assert.ok(data.targets.some(x => x.source.includes('MEDIA SFX') && x.kind === 'media'))
  assert.equal(data.targets.some(x => x.kind === 'voice'), false)
  assert.equal(data.voiceLines.find(x => x.wemId === 954136546)?.usage, 'ultimate')
  assert.equal(data.voiceLines.find(x => x.wemId === 942494679)?.usage, 'ability')
})

test('extensionless Nexus CDN downloads are still recognized as archives', async () => {
  const AdmZip = require('adm-zip')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-sniff-'))
  try {
    const zip = new AdmZip()
    zip.addFile('FINALVERSIONUI/Skin_9999999_P.pak', Buffer.from('pak'))
    zip.addFile('FINALVERSIONUI/Skin_9999999_P.utoc', Buffer.from('utoc'))
    // Nexus returns uri "a7/47/6d/<guid>" for newer files; slashes become _
    const blob = path.join(dir, 'a7_47_6d_a7476d01-9daf-4c9f-b3d8-72f947b48140')
    zip.writeZip(blob)

    assert.equal(isArchive(blob), false, 'no extension to go on')
    assert.equal(sniffArchive(blob), 'zip')
    assert.equal(looksLikeArchive(blob), true)

    const out = await extractArchive(blob)
    const names = walkFiles(out).map(f => path.basename(f))
    assert.ok(names.includes('Skin_9999999_P.pak'))
    assert.ok(names.includes('Skin_9999999_P.utoc'))
    fs.rmSync(out, { recursive: true, force: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a 7z uploaded under a .zip name extracts by header, not by extension', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-mislabel-'))
  try {
    const mislabeled = path.join(dir, 'totally-a-zip.zip')
    // 7z magic followed by junk: sniffing must win over the extension
    fs.writeFileSync(mislabeled, Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0, 0]))
    assert.equal(sniffArchive(mislabeled), '7z')
    await assert.rejects(extractArchive(mislabeled), /"totally-a-zip\.zip" is damaged or incomplete/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('macOS resource forks and OS junk never count as mod files', async () => {
  const AdmZip = require('adm-zip')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rvm-junk-'))
  try {
    const zip = new AdmZip()
    zip.addFile('__MACOSX/._Skin_P.pak', Buffer.from('fork'))
    zip.addFile('.DS_Store', Buffer.from('junk'))
    zip.addFile('Thumbs.db', Buffer.from('junk'))
    zip.addFile('Real/Skin_P.pak', Buffer.from('pak'))
    const archive = path.join(dir, 'junky.zip')
    zip.writeZip(archive)

    const out = await extractArchive(archive)
    const found = walkFiles(out).map(f => path.basename(f))
    assert.deepEqual(found, ['Skin_P.pak'])
    fs.rmSync(out, { recursive: true, force: true })
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('Nexus descriptions mixing raw HTML with BBCode render as readable text', async () => {
  const { bbcodeToHtml } = await import('../src/util.js')
  const src = [
    '\u{1F6E1} VANGUARD ([b]TANK[/b]) MODS : ',
    '<br />[i][b]DR STRANGE[/b][/i] ( Zombie Strange ) : [url=https://www.nexusmods.com/marvelrivals/mods/10487]https://www.nexusmods.com/marvelrivals/mods/10487[/url]',
    '<br />[i][b]MAGNETO[/b][/i] ( Benary Sword ) : https://www.nexusmods.com/marvelrivals/mods/9557',
    '<br />',
    '<br />-----------------------------------------------------------',
    '<br />',
    '<br />\u2694 DUELIST MODS :'
  ].join('\n')
  const html = bbcodeToHtml(src)

  assert.ok(!/&lt;br/.test(html), '<br /> must not survive as visible text')
  assert.equal((html.match(/<a /g) || []).length, 2, 'both the BBCode link and the bare URL link')
  assert.ok(!/<a[^>]*>[^<]*<a /.test(html), 'a BBCode link must not be linkified twice')
  assert.equal((html.match(/<hr\/>/g) || []).length, 1, 'the dash run becomes one divider')
  assert.ok(!/(?:<br\/>){3,}/.test(html), 'no towering stacks of line breaks')
  assert.ok(html.includes('<b>TANK</b>') && html.includes('<i><b>DR STRANGE</b></i>'))
})

test('description markup cannot smuggle scripts or javascript: links', async () => {
  const { bbcodeToHtml } = await import('../src/util.js')
  const html = bbcodeToHtml('hi <script>alert(1)</script> <img src=x onerror=alert(2)> ' +
    '<a href="javascript:alert(3)">x</a> [url=javascript:alert(4)]y[/url]')
  assert.ok(!/<script/i.test(html))
  assert.ok(!/<img/i.test(html))
  assert.ok(!/onerror/i.test(html))
  assert.ok(!/href="javascript:/i.test(html))
  assert.ok(html.includes('<a href="#" data-ext="1">y</a>'), 'unsafe url falls back to #')
})
