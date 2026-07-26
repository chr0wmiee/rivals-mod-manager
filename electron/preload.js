'use strict'

const { contextBridge, ipcRenderer, webUtils } = require('electron')

async function invoke (channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args)
  if (!res || res.ok !== true) {
    throw new Error((res && res.error) || 'Unknown error')
  }
  return res.data
}

function listen (channel, cb) {
  const wrapped = (_e, payload) => cb(payload)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

contextBridge.exposeInMainWorld('rivals', {
  isElectron: true,

  getSettings: () => invoke('settings:get'),
  patchSettings: obj => invoke('settings:patch', obj),
  detectGame: () => invoke('setup:detect'),
  validateGamePath: p => invoke('setup:validatePath', p),

  chooseDirectory: (title, defaultPath) => invoke('dialog:chooseDirectory', title, defaultPath),
  chooseFiles: (title, filters) => invoke('dialog:chooseFiles', title, filters),

  listMods: () => invoke('library:list'),
  importPaths: (paths, meta) => invoke('library:import', paths, meta),
  setModEnabled: (id, enabled) => invoke('library:setEnabled', id, enabled),
  deleteMod: id => invoke('library:delete', id),
  reanalyzeMod: id => invoke('library:reanalyze', id),
  previewMod: id => invoke('preview:mod', id),
  readPreviewAsset: url => invoke('preview:readAsset', url),
  savePreviewAsset: (url, suggestedName) => invoke('preview:saveAsset', url, suggestedName),
  exportPreviewAssets: urls => invoke('preview:exportAssets', urls),
  savePreviewBytes: (suggestedName, bytes) => invoke('preview:saveBytes', suggestedName, bytes),
  clearPreviewCache: () => invoke('preview:clearCache'),
  openModsFolder: () => invoke('library:openMods'),
  openBackupFolder: () => invoke('library:openBackup'),

  listPresets: () => invoke('presets:list'),
  savePreset: preset => invoke('presets:save', preset),
  deletePreset: id => invoke('presets:delete', id),
  applyPreset: id => invoke('presets:apply', id),

  nexusSearch: opts => invoke('nexus:search', opts),
  nexusCategories: () => invoke('nexus:categories'),
  nexusHome: includeAdult => invoke('nexus:home', includeAdult),
  nexusModInfo: modId => invoke('nexus:modInfo', modId),
  nexusModFiles: modId => invoke('nexus:modFiles', modId),
  nexusDownload: payload => invoke('nexus:download', payload),
  nexusPreview: payload => invoke('nexus:preview', payload),
  installUtocPatchFromNexus: () => invoke('nexus:installUtocPatch'),
  getFavorites: () => invoke('nexus:favorites'),
  toggleFavorite: mod => invoke('nexus:toggleFavorite', mod),
  nexusWebLogin: () => invoke('nexus:webLogin'),
  nexusWebLogout: () => invoke('nexus:webLogout'),
  nexusWebStatus: () => invoke('nexus:webStatus'),
  nexusWebVerify: () => invoke('nexus:webVerify'),

  launchGame: () => invoke('game:launch'),
  stopGame: () => invoke('game:stop'),
  isGameRunning: () => invoke('game:isRunning'),

  installUtocPatch: p => invoke('utoc:installFromArchive', p),
  toolsStatus: () => invoke('tools:status'),
  installTools: names => invoke('tools:install', names),
  audioCatalogSummary: () => invoke('audio:catalogSummary'),
  audioCatalogQuery: opts => invoke('audio:catalogQuery', opts),
  extractAudioBank: bank => invoke('audio:extractBank', bank),
  previewWem: (bank, wemId, bankName) => invoke('audio:previewWem', bank, wemId, bankName),
  buildAudioMod: payload => invoke('audio:buildMod', payload),
  openExternal: url => invoke('shell:openExternal', url),

  appVersion: () => invoke('app:version'),
  checkForUpdates: () => invoke('updates:check'),
  downloadUpdate: info => invoke('updates:download', info),
  installUpdate: () => invoke('updates:install'),

  // drag & drop: DOM File -> absolute path (must run in preload)
  pathForFile: file => {
    try { return webUtils.getPathForFile(file) } catch { return null }
  },

  onDownloadProgress: cb => listen('download-progress', cb),
  onToolProgress: cb => listen('tool-progress', cb),
  onPreviewProgress: cb => listen('preview-progress', cb),
  onUpdateProgress: cb => listen('update-progress', cb),
  onUpdateAvailable: cb => listen('update-available', cb)
})
