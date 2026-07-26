// Bridge to the Electron main process. When running in a plain browser (UI dev),
// a mock implementation is used so every page renders with sample data.

const MOCK_CHARACTERS = [
  { id: 1036, name: 'Spider-Man' }, { id: 1035, name: 'Venom' }, { id: 1031, name: 'Luna Snow' },
  { id: 1024, name: 'Hela' }, { id: 1049, name: 'Wolverine' }, { id: 1015, name: 'Storm' },
  { id: 1047, name: 'Jeff the Land Shark' }, { id: 1030, name: 'Moon Knight' }, { id: 1048, name: 'Psylocke' }
].sort((a, b) => a.name.localeCompare(b.name))

const MOCK_MODS = [
  {
    id: 'symbiote-spidey-a1b2c3',
    name: 'Symbiote Spider-Man (Movie Accurate)',
    enabled: true,
    deployed: true,
    addedAt: Date.now() - 86400000,
    files: ['SymbioteSpidey_P.pak', 'SymbioteSpidey_P.ucas', 'SymbioteSpidey_P.utoc'],
    detection: { characters: [{ id: 1036, name: 'Spider-Man' }], types: ['skin'], label: 'Skin', charSource: 'assets', pathCount: 42, samplePaths: ['Marvel/Content/Characters/1036/1036001/Meshes/...'] },
    source: { type: 'nexus', nexusModId: 123, author: 'WebHead' },
    warnings: []
  },
  {
    id: 'hela-voice-jp-d4e5f6',
    name: 'Hela Japanese Voice Pack',
    enabled: true,
    deployed: true,
    addedAt: Date.now() - 172800000,
    files: ['HelaVO_JP_P.pak'],
    detection: { characters: [{ id: 1024, name: 'Hela' }], types: ['voice', 'audio'], label: 'Voice', charSource: 'assets', pathCount: 18, samplePaths: [] },
    source: { type: 'local' },
    warnings: []
  },
  {
    id: 'clean-nameplates-g7h8i9',
    name: 'Minimal Nameplates and Banners',
    enabled: false,
    deployed: false,
    addedAt: Date.now() - 259200000,
    files: ['CleanUI_P.pak', 'CleanUI_P.ucas', 'CleanUI_P.utoc'],
    detection: { characters: [], types: ['ui'], label: 'UI / Visual', charSource: null, pathCount: 12, samplePaths: [] },
    source: { type: 'nexus', nexusModId: 456, author: 'UIWizard' },
    warnings: []
  },
  {
    id: 'team-audio-pack-x1y2z3',
    name: 'Epic Kill Sound Pack',
    enabled: false,
    deployed: false,
    addedAt: Date.now() - 350000000,
    files: ['KillSounds_P.pak'],
    detection: { characters: [{ id: 1049, name: 'Wolverine' }, { id: 1015, name: 'Storm' }], types: ['audio'], label: 'Audio', charSource: 'name', pathCount: 0, samplePaths: [] },
    source: { type: 'local' },
    warnings: ['"KillSounds_P.utoc" is missing its .ucas data file.']
  }
]

function mockNexusMod (i, opts = {}) {
  const names = ['Scarlet Symbiote Suit', 'Neon Luna Concert Skin', 'Classic Comic Hulk', 'Golden Hela Regalia', 'Cyberpunk Psylocke', 'Retro Arcade UI', 'Cinematic Kill Feed', 'Jeff Party Hat', 'X-Force Wolverine', 'Midnight Moon Knight', 'Emerald Loki Robes', 'Stealth Widow Suit']
  const cats = ['Characters', 'Skins', 'Audio', 'UI', 'Miscellaneous']
  return {
    modId: 1000 + i,
    name: names[i % names.length] + (i >= names.length ? ` ${Math.floor(i / names.length) + 1}` : ''),
    summary: 'A high quality mod for Marvel Rivals with custom textures and materials.',
    version: '1.' + (i % 9),
    author: ['WebHead', 'LunaFan', 'ModSmith', 'Asgardian'][i % 4],
    adult: opts.adult ?? (i % 7 === 3),
    thumbnailUrl: '',
    pictureUrl: '',
    downloads: 90000 - i * 1234,
    endorsements: 4200 - i * 55,
    createdAt: new Date(Date.now() - i * 86400000).toISOString(),
    updatedAt: new Date(Date.now() - i * 43200000).toISOString(),
    category: cats[i % cats.length],
    url: 'https://www.nexusmods.com/marvelrivals/mods/' + (1000 + i)
  }
}

const mockList = n => Array.from({ length: n }, (_, i) => mockNexusMod(i))

let mockSettings = {
  setupComplete: false,
  gameRoot: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals',
  backupDir: null,
  nexusWebAuthed: false,
  nexusWebUser: '',
  showAdult: false,
  aesKey: '0x0C263D8C22DCB085894899C3A3796383E9BF9DE0CBFB08C9BF2DEF2E84F29D74',
  utocPatchInstalled: false,
  favorites: [],
  presets: [{ id: 'default-abc', name: 'Competitive (no skins)', modIds: ['hela-voice-jp-d4e5f6'] }],
  rootInfo: {
    gameRoot: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\MarvelRivals',
    paksPath: 'C:\\...\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks',
    modsPath: 'C:\\...\\MarvelRivals\\MarvelGame\\Marvel\\Content\\Paks\\~mods'
  },
  effectiveBackupDir: 'C:\\Users\\you\\Documents\\RivalsModManager\\ModBackups',
  defaultBackupDir: 'C:\\Users\\you\\Documents\\RivalsModManager\\ModBackups',
  store: 'steam',
  characters: MOCK_CHARACTERS
}

let mockFavs = []
const sleep = ms => new Promise(r => setTimeout(r, ms))

const mock = {
  isElectron: false,
  getSettings: async () => ({ ...mockSettings }),
  patchSettings: async obj => { mockSettings = { ...mockSettings, ...obj }; return { ...mockSettings } },
  detectGame: async () => { await sleep(600); return { gameRoot: mockSettings.gameRoot, paksPath: mockSettings.rootInfo.paksPath, modsPath: mockSettings.rootInfo.modsPath, store: 'steam' } },
  validateGamePath: async p => ({ ok: true, gameRoot: p, corrected: false, paksPath: p + '\\MarvelGame\\Marvel\\Content\\Paks' }),
  chooseDirectory: async () => 'C:\\Some\\Chosen\\Folder',
  chooseFiles: async () => [],
  listMods: async () => ({ mods: MOCK_MODS, restored: 0 }),
  importPaths: async paths => paths.map(p => ({ ok: true, mod: MOCK_MODS[0] })),
  setModEnabled: async (id, enabled) => {
    const m = MOCK_MODS.find(m => m.id === id)
    if (m) { m.enabled = enabled; m.deployed = enabled }
    return { ...m }
  },
  deleteMod: async () => true,
  reanalyzeMod: async id => MOCK_MODS.find(m => m.id === id),
  previewMod: async () => { await sleep(1200); return { images: [], audio: [], models: [], notes: ['Install helper tools to extract this mod.'], counts: { files: 3, images: 0, audio: 0, models: 0 } } },
  readPreviewAsset: async () => { throw new Error('3D previews only work in the desktop app.') },
  savePreviewAsset: async () => null,
  exportPreviewAssets: async () => null,
  savePreviewBytes: async () => null,
  clearPreviewCache: async () => true,
  openModsFolder: async () => true,
  openBackupFolder: async () => true,
  listPresets: async () => mockSettings.presets,
  savePreset: async p => { mockSettings.presets = [...mockSettings.presets.filter(x => x.id !== p.id), { ...p, id: p.id || 'p' + Date.now() }]; return mockSettings.presets },
  deletePreset: async id => { mockSettings.presets = mockSettings.presets.filter(p => p.id !== id); return mockSettings.presets },
  applyPreset: async id => ({ applied: 'Preset', changed: 2 }),
  nexusSearch: async opts => { await sleep(500); let mods = mockList(24); if (!opts.includeAdult) mods = mods.filter(m => !m.adult); if (opts.category) mods = mods.filter(m => m.category === opts.category); return { mods, totalCount: 300, page: opts.page || 0, pageSize: 24 } },
  nexusCategories: async () => ['Audio', 'Characters', 'Miscellaneous', 'Skins', 'UI'],
  nexusHome: async includeAdult => {
    await sleep(500)
    let l = mockList(12)
    if (!includeAdult) l = l.filter(m => !m.adult)
    return { trending: l, trendingIsLive: false, newest: l.slice().reverse(), updated: l, popular: l }
  },
  nexusModInfo: async modId => ({ ...mockNexusMod(modId - 1000), hasDescription: false }),
  nexusModFiles: async () => [{ fileId: 1, name: 'Main file', version: '1.0', category: 'MAIN', sizeKb: 1024, fileName: 'main-file.7z', uploadedAt: Date.now(), description: '' }],
  nexusDownload: async () => ({ ok: false, error: 'Downloads only work in the desktop app.' }),
  nexusPreview: async () => ({ ok: false, error: 'Previews only work in the desktop app.' }),
  getFavorites: async () => mockFavs,
  toggleFavorite: async mod => {
    const i = mockFavs.findIndex(f => f.modId === mod.modId)
    if (i >= 0) mockFavs.splice(i, 1)
    else mockFavs.unshift({ ...mod, savedAt: Date.now() })
    return [...mockFavs]
  },
  nexusWebLogin: async () => { mockSettings.nexusWebAuthed = true; mockSettings.nexusWebUser = 'DemoUser'; return { ok: true, loggedIn: true } },
  nexusWebLogout: async () => { mockSettings.nexusWebAuthed = false; mockSettings.nexusWebUser = ''; return { loggedIn: false } },
  nexusWebStatus: async () => ({ loggedIn: !!mockSettings.nexusWebAuthed, user: mockSettings.nexusWebUser || '' }),
  nexusWebVerify: async () => ({ loggedIn: !!mockSettings.nexusWebAuthed, user: mockSettings.nexusWebUser || '' }),
  launchGame: async () => ({ via: 'steam' }),
  stopGame: async () => true,
  isGameRunning: async () => false,
  installUtocPatch: async () => ({ copied: 3 }),
  installUtocPatchFromNexus: async () => ({ ok: true, copied: 3 }),
  toolsStatus: async () => ({ vgmstream: { installed: false, label: 'vgmstream' }, uassettool: { installed: false, label: 'UAssetTool Rivals' } }),
  installTools: async () => ({ status: { vgmstream: { installed: true }, uassettool: { installed: true } } }),
  audioCatalogSummary: async () => ({ version: 'season-9', updatedAt: new Date().toISOString(), characters: MOCK_CHARACTERS, costumes: [], targetCount: 948, voiceLineCount: 23985 }),
  audioCatalogQuery: async () => ({ total: 3, items: [
    { heroId: 1031, hero: 'Luna Snow', kind: 'voice', bank: 'bnk_vo_1031001.bnk', wemId: 466157259, label: 'Ultimate voice', spoken: 'Ultimate voice line' },
    { heroId: 1063, hero: 'Cyclops', kind: 'voice', bank: 'bnk_vo_1063001.bnk', wemId: 132855017, label: 'Ability E KO', spoken: 'Mission accomplished.' },
    { heroId: null, hero: '', kind: 'ui', bank: 'bnk_ui_battle.bnk', wemId: 436944636, label: 'Ultimate fully charged' }
  ] }),
  extractAudioBank: async () => { throw new Error('Install helper tools in the desktop app.') },
  previewWem: async () => ({ url: '', channels: 1 }),
  buildAudioMod: async () => ({ outputPath: 'C:\\Exports\\Audio_Mod_9999999_P.pak' }),
  openExternal: async url => window.open(url, '_blank'),
  appVersion: async () => '0.0.0-dev',
  checkForUpdates: async () => {
    await sleep(600)
    return {
      current: '0.0.0-dev',
      latest: '3.2.0',
      updateAvailable: true,
      name: 'v3.2.0',
      notes: '- Sample release notes for the browser preview.',
      publishedAt: new Date().toISOString(),
      pageUrl: 'https://github.com/chr0wmiee/rivals-mod-manager/releases/latest',
      installer: { name: 'Marvel-Rivals-Mod-Manager-Setup-3.2.0.exe', size: 123456789, url: '' },
      ready: false
    }
  },
  downloadUpdate: async () => { throw new Error('Updates only install in the desktop app.') },
  installUpdate: async () => { throw new Error('Updates only install in the desktop app.') },
  pathForFile: () => null,
  onDownloadProgress: () => () => {},
  onToolProgress: () => () => {},
  onPreviewProgress: () => () => {},
  onUpdateProgress: () => () => {},
  onUpdateAvailable: () => () => {}
}

const api = window.rivals || mock
export default api
