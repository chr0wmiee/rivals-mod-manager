import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../api.js'
import Icon from './Icon.jsx'
import { Modal, ExtLink } from './ui.jsx'
import { formatBytes, formatDate } from '../util.js'

const RELEASES_URL = 'https://github.com/chr0wmiee/rivals-mod-manager/releases'

// Shared update state: the startup check pushed from the main process, plus
// manual checks from Settings. One instance lives in App and is passed down.
export function useUpdater () {
  const [version, setVersion] = useState('')
  const [info, setInfo] = useState(null)
  const [checking, setChecking] = useState(false)
  const [phase, setPhase] = useState('idle') // idle | downloading | ready | installing
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(false)
  const seen = useRef('')

  useEffect(() => { api.appVersion().then(setVersion).catch(() => {}) }, [])

  useEffect(() => api.onUpdateProgress(p => {
    setProgress(p)
    if (p.status === 'done') setPhase('ready')
  }), [])

  // Startup check from the main process.
  useEffect(() => api.onUpdateAvailable(result => {
    setInfo(result)
    if (result.ready) setPhase('ready')
    if (seen.current !== result.latest) {
      seen.current = result.latest
      setOpen(true)
    }
  }), [])

  const check = useCallback(async () => {
    setChecking(true)
    setError('')
    try {
      const result = await api.checkForUpdates()
      setInfo(result)
      if (result.ready) setPhase('ready')
      return result
    } catch (e) {
      setError(e.message)
      throw e
    } finally {
      setChecking(false)
    }
  }, [])

  const download = useCallback(async () => {
    if (!info) return
    setError('')
    setPhase('downloading')
    setProgress({ status: 'downloading', received: 0, total: info.installer?.size || 0 })
    try {
      await api.downloadUpdate(info)
      setPhase('ready')
    } catch (e) {
      setError(e.message)
      setPhase('idle')
    }
  }, [info])

  const install = useCallback(async () => {
    setError('')
    setPhase('installing')
    try {
      await api.installUpdate()
    } catch (e) {
      setError(e.message)
      setPhase('ready')
    }
  }, [])

  return { version, info, checking, phase, progress, error, open, setOpen, check, download, install }
}

// GitHub release notes are markdown. Only bullets and headings show up in
// practice, so render those and leave everything else as plain lines.
function Notes ({ text }) {
  const lines = String(text || '').split(/\r?\n/)
  if (!lines.some(l => l.trim())) return <div className="note">No release notes were provided.</div>
  return (
    <div className="release-notes">
      {lines.map((raw, i) => {
        const line = raw.trim()
        if (!line) return <div key={i} style={{ height: 6 }} />
        if (/^#{1,6}\s/.test(line)) return <h4 key={i}>{line.replace(/^#{1,6}\s*/, '')}</h4>
        if (/^[-*+]\s/.test(line)) return <div key={i} className="rn-item">{line.replace(/^[-*+]\s*/, '')}</div>
        return <div key={i}>{line}</div>
      })}
    </div>
  )
}

export function UpdatePill ({ updater }) {
  if (!updater.info || !updater.info.updateAvailable) return null
  return (
    <button className="update-pill" onClick={() => updater.setOpen(true)} title={`Version ${updater.info.latest} is available`}>
      <Icon name="download" size={13} />
      <span>Update</span>
    </button>
  )
}

export function UpdateModal ({ updater }) {
  const { info, phase, progress, error } = updater
  if (!updater.open || !info) return null

  const pct = progress && progress.total > 0
    ? Math.min(100, Math.round((progress.received / progress.total) * 100))
    : null
  const size = info.installer ? formatBytes(info.installer.size) : ''

  return (
    <Modal onClose={() => updater.setOpen(false)} width={620}>
      <div className="modal-body">
        <div>
          <div className="wiz-kicker">Update available</div>
          <div className="update-versions">
            <span className="uv-old">{info.current}</span>
            <Icon name="chevR" size={16} />
            <span className="uv-new">{info.latest}</span>
          </div>
          <div className="file-meta" style={{ marginTop: 4 }}>
            {info.name}{info.publishedAt ? ` · released ${formatDate(info.publishedAt)}` : ''}{size ? ` · ${size}` : ''}
          </div>
        </div>

        <Notes text={info.notes} />

        {error && <div className="path-status bad"><Icon name="alert" size={16} /><div style={{ flex: 1 }}>{error}</div></div>}

        {phase === 'downloading' && (
          <div className="progress-banner">
            <div className="spinner" />
            <span>Downloading…</span>
            <div className={`bar ${pct == null ? 'indet' : ''}`}><div style={{ width: pct != null ? pct + '%' : '40%' }} /></div>
            <b>{pct != null ? pct + '%' : ''}</b>
          </div>
        )}

        {phase === 'ready' && (
          <div className="note good">
            Downloaded and ready. Installing closes the app, runs the installer and reopens it on the new version.
            Your mods, settings and backups stay where they are.
          </div>
        )}

        <div className="btn-row">
          {phase === 'ready'
            ? <button className="btn btn-primary" onClick={updater.install} disabled={phase === 'installing'}>
              <Icon name="check" size={15} /> {phase === 'installing' ? 'Starting…' : 'Install and restart'}
            </button>
            : <button className="btn btn-primary" onClick={updater.download} disabled={phase === 'downloading' || !info.installer}>
              <Icon name="download" size={15} /> {phase === 'downloading' ? 'Downloading…' : 'Download update'}
            </button>}
          <button className="btn btn-ghost" onClick={() => updater.setOpen(false)}>Later</button>
          <ExtLink href={info.pageUrl || RELEASES_URL} className="btn btn-ghost btn-sm">
            <Icon name="external" size={13} /> View on GitHub
          </ExtLink>
        </div>

        {!info.installer && (
          <div className="note warn">This release has no Windows installer attached. Download it from the GitHub release page.</div>
        )}
      </div>
    </Modal>
  )
}

export { RELEASES_URL }
