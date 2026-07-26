import { useEffect, useState } from 'react'
import api from '../api.js'
import Icon from '../components/Icon.jsx'
import { Modal, Spinner, useToast, ExtLink } from '../components/ui.jsx'
import { bbcodeToHtml, formatNumber, formatSizeKb, formatDate } from '../util.js'
import PreviewModal from '../components/PreviewModal.jsx'

export default function ModDetailModal ({ mod, settings, installed, isFavorite, onToggleFavorite, onClose }) {
  const toast = useToast()
  const [info, setInfo] = useState(null)
  const [files, setFiles] = useState(null)
  const [filesError, setFilesError] = useState(null)
  const [busyFile, setBusyFile] = useState(null)
  const [preview, setPreview] = useState(null) // { title, data|null }
  const [previewProgress, setPreviewProgress] = useState(null)

  useEffect(() => {
    let alive = true
    setInfo(null); setFiles(null); setFilesError(null)
    api.nexusModInfo(mod.modId)
      .then(i => { if (alive) setInfo(i) })
      .catch(() => { if (alive) setInfo(mod) })
    api.nexusModFiles(mod.modId)
      .then(f => { if (alive) setFiles(f) })
      .catch(e => { if (alive) setFilesError(e.message) })
    return () => { alive = false }
  }, [mod.modId])

  useEffect(() => api.onPreviewProgress(setPreviewProgress), [])

  const m = { ...mod, ...(info || {}) }

  const download = async file => {
    setBusyFile(file.fileId)
    try {
      const res = await api.nexusDownload({
        modId: m.modId,
        fileId: file.fileId,
        fileName: file.fileName,
        modMeta: {
          name: m.name,
          version: file.version || m.version,
          author: m.author,
          pictureUrl: m.pictureUrl || m.thumbnailUrl,
          summary: m.summary,
          adult: m.adult
        }
      })
      if (res && res.ok === false) {
        if (res.needsLogin) toast.warn('Sign in required', 'Sign in to Nexus in Settings, then press Install again.')
        else toast.err('Download failed', res.error)
      }
    } catch (e) {
      toast.err('Download failed', e.message)
    } finally {
      setBusyFile(null)
    }
  }

  const previewFile = async file => {
    setPreviewProgress(null)
    setPreview({ title: `${m.name} · ${file.name}`, data: null })
    try {
      const result = await api.nexusPreview({ modId: m.modId, fileId: file.fileId, fileName: file.fileName })
      if (result.ok === false) {
        setPreview(null)
        if (result.needsLogin) toast.warn('Sign in required', 'Sign in to Nexus in Settings to preview files.')
        else toast.warn('Preview unavailable', result.error)
      } else {
        setPreview(p => (p ? { ...p, data: result.preview } : p))
      }
    } catch (e) {
      setPreview(null)
      toast.err('Preview failed', e.message)
    }
  }

  const hero = m.pictureUrl || m.thumbnailUrl

  return (<>
    <Modal onClose={onClose}>
      <div className="modal-hero">
        {hero && <img src={hero} alt="" style={m.adult && !settings.showAdult ? { filter: 'blur(24px)' } : null} />}
        <div className="fade" />
        <div className="title-wrap">
          <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
            {m.adult && <span className="adult-tag" style={{ position: 'static' }}>18+</span>}
            {installed && <span className="installed-tag" style={{ position: 'static' }}><Icon name="check" size={10} />Installed</span>}
          </div>
          <div className="page-title" style={{ fontSize: 24 }}>{m.name}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 5, paddingLeft: 15, fontWeight: 600 }}>
            {m.author || 'unknown'}{m.category ? ` · ${m.category}` : ''}{m.version ? ` · v${m.version}` : ''}
          </div>
        </div>
      </div>

      <div className="modal-body">
        <div className="btn-row">
          <button className={`btn btn-sm ${isFavorite ? 'btn-primary' : 'btn-ghost'}`} onClick={() => onToggleFavorite(m)}>
            <Icon name="star" size={14} /> {isFavorite ? 'Favorited' : 'Favorite'}
          </button>
          <ExtLink href={m.url || `https://www.nexusmods.com/marvelrivals/mods/${m.modId}`} className="btn btn-ghost btn-sm">
            <Icon name="external" size={14} /> Nexus page
          </ExtLink>
        </div>

        <div className="stat-strip">
          <div className="cell"><span>Downloads</span><b>{formatNumber(m.downloads)}</b></div>
          <div className="cell"><span>Endorsements</span><b>{formatNumber(m.endorsements)}</b></div>
          <div className="cell"><span>Released</span><b>{formatDate(m.createdAt)}</b></div>
          <div className="cell"><span>Updated</span><b>{formatDate(m.updatedAt)}</b></div>
        </div>

        {m.summary && <div className="desc-body" style={{ fontSize: 14 }}>{m.summary}</div>}

        <div className="section-title" style={{ margin: '4px 0 0' }}><span className="tag">//</span>Files</div>
        {!files && !filesError && <Spinner />}
        {filesError && <div className="note warn">{filesError}</div>}
        {files && files.length === 0 && <div className="note">This mod has no downloadable files.</div>}
        {files && files.map(f => (
          <div key={f.fileId} className="file-row">
            <span className={`file-cat ${f.category}`}>{f.category}</span>
            <div className="file-info">
              <div className="file-name">{f.name}</div>
              <div className="file-meta">
                v{f.version || '?'} · {formatSizeKb(f.sizeKb)} · {formatDate(f.uploadedAt)}
              </div>
            </div>
            <div className="file-actions">
              {installed && (
                <button className="btn btn-ghost btn-sm" onClick={() => previewFile(f)}>
                  <Icon name="eye" size={13} /> Preview
                </button>
              )}
              <button className="btn btn-primary btn-sm" disabled={busyFile === f.fileId} onClick={() => download(f)}>
                <Icon name="download" size={13} /> {busyFile === f.fileId ? 'Starting…' : installed ? 'Reinstall' : 'Install'}
              </button>
            </div>
          </div>
        ))}

        {m.description && (
          <>
            <div className="section-title" style={{ margin: '8px 0 0' }}><span className="tag">//</span>Description</div>
            <div
              className="desc-body"
              onClick={e => {
                const a = e.target.closest('a[data-ext]')
                if (a) { e.preventDefault(); api.openExternal(a.href) }
              }}
              dangerouslySetInnerHTML={{ __html: bbcodeToHtml(m.description) }}
            />
          </>
        )}
      </div>
    </Modal>
    {preview && (
      <PreviewModal
        data={preview.data}
        progress={preview.data ? null : previewProgress}
        title={preview.title}
        onClose={() => setPreview(null)}
      />
    )}
  </>)
}
