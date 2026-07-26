import { useCallback, useEffect, useRef, useState } from 'react'
import api from './api.js'
import logo from './assets/logo.png'
import Icon from './components/Icon.jsx'
import { ToastProvider, useToast } from './components/ui.jsx'
import SetupWizard from './pages/SetupWizard.jsx'
import LibraryPage from './pages/LibraryPage.jsx'
import ExplorePage from './pages/ExplorePage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import AudioEditorPage from './pages/AudioEditorPage.jsx'
import ModDetailModal from './pages/ModDetailModal.jsx'
import DownloadTray from './components/DownloadTray.jsx'
import { useUpdater, UpdatePill, UpdateModal } from './components/Updater.jsx'

const NAV = [
  { key: 'mods', label: 'Mods', icon: 'library' },
  { key: 'explore', label: 'Explore', icon: 'explore' },
  { key: 'audio', label: 'Audio Editor', icon: 'audio' },
  { key: 'settings', label: 'Settings', icon: 'gear' }
]

function Shell () {
  const toast = useToast()
  const [settings, setSettings] = useState(null)
  const [page, setPage] = useState('mods')
  const [running, setRunning] = useState(false)
  const [launchBusy, setLaunchBusy] = useState(false)
  const [stopBusy, setStopBusy] = useState(false)
  const [library, setLibrary] = useState({ mods: [], restored: 0 })
  const [favorites, setFavorites] = useState([])
  const [downloads, setDownloads] = useState([])
  const [detailMod, setDetailMod] = useState(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const updater = useUpdater()

  const refreshSettings = useCallback(async () => {
    const s = await api.getSettings()
    setSettings(s)
    return s
  }, [])

  const refreshLibrary = useCallback(async () => {
    try {
      const lib = await api.listMods()
      setLibrary(lib)
      if (lib.restored > 0) toast.ok('Mods restored', `${lib.restored} enabled mod(s) were missing from ~mods and were restored from backup.`)
      if (lib.adopted > 0) toast.ok('Existing mods adopted', `${lib.adopted} mod(s) found in ~mods were backed up and added to your library.`)
      if (lib.split > 0) toast.ok('Library updated', `${lib.split} bundled mod(s) are now listed separately.`)
      return lib
    } catch (e) {
      toast.err('Could not read mod library', e.message)
      return { mods: [], restored: 0 }
    }
  }, [toast])

  const refreshFavorites = useCallback(async () => {
    try { setFavorites(await api.getFavorites()) } catch { /* ignore */ }
  }, [])

  useEffect(() => {
    refreshSettings()
    refreshFavorites()
  }, [refreshSettings, refreshFavorites])

  useEffect(() => {
    if (settings && settings.setupComplete) refreshLibrary()
  }, [settings && settings.setupComplete]) // eslint-disable-line

  // game running poll
  useEffect(() => {
    let alive = true
    const tick = async () => {
      try { const r = await api.isGameRunning(); if (alive) setRunning(r) } catch { /* ignore */ }
    }
    tick()
    const t = setInterval(tick, 6000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  // download progress events
  useEffect(() => {
    const off = api.onDownloadProgress(p => {
      setDownloads(list => {
        const i = list.findIndex(d => d.id === p.id)
        return i >= 0 ? [...list.slice(0, i), { ...list[i], ...p }, ...list.slice(i + 1)] : [...list, p]
      })
      if (p.status === 'done') {
        if (!p.preview) {
          toast.ok('Installed', `${p.name} is in your library.`)
          refreshLibrary()
        }
        setTimeout(() => setDownloads(list => list.filter(d => d.id !== p.id)), p.preview ? 800 : 4000)
      }
      if (p.status === 'error') {
        toast.err(p.preview ? 'Preview failed' : 'Download failed', p.error)
        setTimeout(() => setDownloads(list => list.filter(d => d.id !== p.id)), 8000)
      }
    })
    return () => off()
  }, [toast, refreshLibrary])

  // global drag & drop import
  useEffect(() => {
    const enter = e => { e.preventDefault(); dragDepth.current++; setDragging(true) }
    const leave = e => { e.preventDefault(); if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false) } }
    const over = e => e.preventDefault()
    const drop = async e => {
      if (e.defaultPrevented) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = [...(e.dataTransfer?.files || [])]
      const paths = files.map(f => api.pathForFile(f)).filter(Boolean)
      if (paths.length === 0) return
      toast.info('Importing…', `${paths.length} item(s)`)
      try {
        const results = await api.importPaths(paths)
        for (const r of results) {
          if (r.ok) {
            const det = r.mod.detection
            const who = det.characters.map(c => c.name).join(', ')
            toast.ok(`Added: ${r.mod.name}`, `${det.label}${who ? ' · ' + who : ''}`)
            if (r.mod.warnings && r.mod.warnings.length) toast.warn('Heads up', r.mod.warnings.join(' '))
          } else {
            toast.err('Import failed', r.error)
          }
        }
        refreshLibrary()
        setPage('mods')
      } catch (err) {
        toast.err('Import failed', err.message)
      }
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [toast, refreshLibrary])

  const toggleFavorite = useCallback(async mod => {
    setFavorites(await api.toggleFavorite(mod))
  }, [])

  const launch = async () => {
    setLaunchBusy(true)
    try {
      await api.launchGame()
      toast.ok('Launching Marvel Rivals')
      setTimeout(async () => setRunning(await api.isGameRunning().catch(() => false)), 8000)
    } catch (e) {
      toast.err('Launch failed', e.message)
    } finally {
      setLaunchBusy(false)
    }
  }

  const stop = async () => {
    setStopBusy(true)
    try {
      await api.stopGame()
      toast.ok('Marvel Rivals closed')
      setRunning(false)
    } catch (e) {
      toast.err('Could not quit the game', e.message)
    } finally {
      setStopBusy(false)
    }
  }

  if (!settings) {
    return <div className="center-load" style={{ height: '100%' }}><div className="spinner" /></div>
  }

  if (!settings.setupComplete) {
    return (
      <SetupWizard
        settings={settings}
        onDone={async () => { await refreshSettings(); refreshLibrary() }}
      />
    )
  }

  const enabledCount = library.mods.filter(m => m.enabled).length
  const installedNexusIds = new Set(library.mods.map(m => m.source?.nexusModId).filter(Boolean))

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img className="brand-logo" src={logo} alt="Marvel Rivals Mods" />
        </div>
        <nav className="tabs">
          {NAV.map(n => (
            <button key={n.key} className={`tab ${page === n.key ? 'active' : ''}`} onClick={() => setPage(n.key)}>
              <Icon name={n.icon} size={16} />
              <span>{n.label}</span>
              {n.key === 'mods' && library.mods.length > 0 && <span className="count">{enabledCount}/{library.mods.length}</span>}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          <UpdatePill updater={updater} />
          {running && <div className="game-status on">In game</div>}
          {running
            ? <button className="btn btn-danger btn-sm" onClick={stop} disabled={stopBusy}><Icon name="stop" size={14} /> {stopBusy ? 'Quitting…' : 'Quit'}</button>
            : <button className="btn btn-primary" onClick={launch} disabled={launchBusy}><Icon name="play" size={15} /> {launchBusy ? 'Launching…' : 'Launch'}</button>}
        </div>
      </header>

      <main className="content">
        <div className="page" key={page}>
          {page === 'mods' && (
            <LibraryPage library={library} refresh={refreshLibrary} settings={settings} />
          )}
          {page === 'explore' && (
            <ExplorePage
              settings={settings}
              favorites={favorites}
              installedIds={installedNexusIds}
              onToggleFavorite={toggleFavorite}
              onOpenMod={setDetailMod}
              refreshSettings={refreshSettings}
            />
          )}
          {page === 'audio' && <AudioEditorPage onLibraryChanged={refreshLibrary} />}
          {page === 'settings' && (
            <SettingsPage settings={settings} refreshSettings={refreshSettings} refreshLibrary={refreshLibrary} updater={updater} />
          )}
        </div>
      </main>

      {detailMod && (
        <ModDetailModal
          mod={detailMod}
          settings={settings}
          installed={installedNexusIds.has(detailMod.modId)}
          isFavorite={favorites.some(f => f.modId === detailMod.modId)}
          onToggleFavorite={toggleFavorite}
          onClose={() => setDetailMod(null)}
        />
      )}

      <UpdateModal updater={updater} />

      <DownloadTray downloads={downloads} />

      {dragging && (
        <div className="drop-overlay">
          <div className="drop-box">
            <h2>Drop to install</h2>
            <p>.zip / .7z / .rar archives or loose .pak + .utoc + .ucas files</p>
          </div>
        </div>
      )}
    </div>
  )
}

export default function App () {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  )
}
