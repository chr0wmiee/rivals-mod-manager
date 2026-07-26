import { useEffect, useMemo, useState } from 'react'
import api from '../api.js'
import Icon from '../components/Icon.jsx'
import { useToast, TypeChips, ConfirmButton, Empty, Modal, Seg } from '../components/ui.jsx'
import { timeAgo } from '../util.js'
import PreviewModal from '../components/PreviewModal.jsx'

function modThumb (mod) {
  if (mod.previewFile) return `modimg://${mod.id}/${mod.previewFile}`
  if (mod.source && mod.source.pictureUrl) return mod.source.pictureUrl
  return null
}

function ModRow ({ mod, onChanged, onDeleted, onPreview }) {
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const toggle = async () => {
    if (busy) return
    setBusy(true)
    try {
      await api.setModEnabled(mod.id, !mod.enabled)
      onChanged()
    } catch (e) {
      toast.err(mod.enabled ? 'Could not disable' : 'Could not enable', e.message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await api.deleteMod(mod.id)
      toast.ok('Deleted', mod.name)
      onDeleted()
    } catch (e) {
      toast.err('Delete failed', e.message)
      setBusy(false)
    }
  }

  const reanalyze = async () => {
    setBusy(true)
    try {
      await api.reanalyzeMod(mod.id)
      onChanged()
      toast.ok('Re-scanned', mod.name)
    } catch (e) {
      toast.err('Scan failed', e.message)
    } finally {
      setBusy(false)
    }
  }

  const thumb = modThumb(mod)
  const initial = (mod.name || '?').trim().charAt(0).toUpperCase()

  return (
    <div className={`mod-row ${mod.enabled ? 'on' : 'off'}`}>
      <div className="mod-thumb">
        {thumb ? <img src={thumb} alt="" loading="lazy" /> : initial}
      </div>
      <div className="mod-info">
        <div className="mod-name" title={mod.files.join('\n')}>
          {mod.name}
          <span className="src">
            {mod.source?.type === 'nexus' ? `Nexus #${mod.source.nexusModId}` : mod.source?.type === 'audio-editor' ? 'Audio Editor' : 'Local'}
            {mod.source?.author ? ` · ${mod.source.author}` : ''}
            {` · ${timeAgo(mod.addedAt)}`}
          </span>
        </div>
        <TypeChips detection={mod.detection} />
      </div>
      <div className="mod-side">
        {mod.warnings && mod.warnings.length > 0 && (
          <span className="warn-ico" title={mod.warnings.join('\n')}><Icon name="alert" size={16} /></span>
        )}
        <button className="icon-btn" title="Preview" onClick={() => onPreview(mod)} disabled={busy}>
          <Icon name="eye" size={16} />
        </button>
        <button className="icon-btn" title="Re-scan" onClick={reanalyze} disabled={busy}>
          <Icon name="refresh" size={14} />
        </button>
        <ConfirmButton className="icon-btn danger" title="Delete" onConfirm={remove}>
          <Icon name="trash" size={14} />
        </ConfirmButton>
        <div
          className={`switch ${mod.enabled ? 'on' : ''}`}
          title={mod.enabled ? 'Click to disable' : 'Click to enable'}
          onClick={toggle}
          style={busy ? { opacity: 0.5 } : null}
        />
      </div>
    </div>
  )
}

function PresetEditor ({ preset, mods, onSave, onClose }) {
  const [name, setName] = useState(preset?.name || '')
  const [selected, setSelected] = useState(new Set(preset?.modIds || []))

  const toggle = id => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelected(next)
  }

  return (
    <Modal onClose={onClose} width={540}>
      <div className="modal-body" style={{ paddingTop: 24 }}>
        <div className="page-title" style={{ fontSize: 20 }}>{preset?.id ? 'Edit Preset' : 'New Preset'}</div>
        <div className="field">
          <label>Name</label>
          <input className="input" value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Competitive, All skins…" autoFocus />
        </div>
        <div className="field">
          <label>Mods in this preset ({selected.size})</label>
          <div style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--line)' }}>
            {mods.length === 0 && <div style={{ padding: 14, color: 'var(--dim)' }}>Your library is empty.</div>}
            {mods.map(m => (
              <div key={m.id} className="check-row" onClick={() => toggle(m.id)}>
                <div className={`check-box ${selected.has(m.id) ? 'on' : ''}`}>{selected.has(m.id) ? '✓' : ''}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13 }}>{m.name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--dim)' }}>{m.detection?.label}{m.detection?.characters?.length ? ' · ' + m.detection.characters.map(c => c.name).join(', ') : ''}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="btn-row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn btn-primary"
            disabled={!name.trim()}
            onClick={() => onSave({ ...(preset || {}), name: name.trim(), modIds: [...selected] })}
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  )
}

function PresetStrip ({ library, refreshLibrary }) {
  const toast = useToast()
  const [presets, setPresets] = useState([])
  const [editing, setEditing] = useState(null)
  const [applying, setApplying] = useState(null)

  const load = async () => { try { setPresets(await api.listPresets()) } catch { /* ignore */ } }
  useEffect(() => { load() }, [])

  const apply = async preset => {
    setApplying(preset.id)
    try {
      const r = await api.applyPreset(preset.id)
      toast.ok(`"${preset.name}" applied`, `${r.changed} mod(s) toggled`)
      refreshLibrary()
    } catch (e) {
      toast.err('Could not apply preset', e.message)
    } finally {
      setApplying(null)
    }
  }

  const save = async preset => {
    await api.savePreset(preset)
    setEditing(null)
    await load()
    toast.ok('Preset saved', preset.name)
  }

  const remove = async preset => {
    await api.deletePreset(preset.id)
    await load()
  }

  const saveCurrent = () => {
    const enabled = library.mods.filter(m => m.enabled).map(m => m.id)
    setEditing({ name: '', modIds: enabled })
  }

  return (
    <div className="preset-strip">
      <span className="label"><Icon name="layers" size={13} style={{ verticalAlign: -2, marginRight: 5 }} />Presets</span>
      {presets.map(p => (
        <div key={p.id} className={`preset-chip ${applying === p.id ? 'applying' : ''}`}>
          <b title="Apply this preset" onClick={() => apply(p)}>
            {applying === p.id ? 'Applying…' : p.name}
          </b>
          <span className="n">{(p.modIds || []).length}</span>
          <button className="mini" title="Edit" onClick={() => setEditing(p)}><Icon name="pencil" size={12} /></button>
          <button className="mini danger" title="Delete" onClick={() => remove(p)}><Icon name="x" size={12} /></button>
        </div>
      ))}
      <button className="preset-add" onClick={saveCurrent}><Icon name="plus" size={13} /> Save current setup</button>
      {editing && (
        <PresetEditor preset={editing.id ? editing : editing} mods={library.mods} onSave={save} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

const TYPE_FILTERS = [
  ['all', 'All'],
  ['skin', 'Skins'],
  ['audio', 'Audio'],
  ['ui', 'UI'],
  ['vfx', 'VFX'],
  ['other', 'Other']
]

export default function LibraryPage ({ library, refresh, settings }) {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [preview, setPreview] = useState(null) // { title, data|null }
  const [previewProgress, setPreviewProgress] = useState(null)

  useEffect(() => api.onPreviewProgress(setPreviewProgress), [])

  const openPreview = async mod => {
    setPreviewProgress(null)
    setPreview({ title: mod.name, data: null })
    try {
      const data = await api.previewMod(mod.id)
      setPreview(p => (p && p.title === mod.name ? { ...p, data } : p))
    } catch (e) {
      setPreview(null)
      toast.err('Preview failed', e.message)
    }
  }

  const mods = useMemo(() => {
    let list = library.mods
    if (query.trim()) {
      const q = query.trim().toLowerCase()
      list = list.filter(m =>
        m.name.toLowerCase().includes(q) ||
        (m.detection?.characters || []).some(c => c.name.toLowerCase().includes(q)))
    }
    if (typeFilter !== 'all') {
      list = list.filter(m => {
        const types = m.detection?.types || []
        if (typeFilter === 'other') return types.length === 0
        if (typeFilter === 'audio') return types.includes('audio') || types.includes('voice')
        return types.includes(typeFilter)
      })
    }
    return list
  }, [library.mods, query, typeFilter])

  const addViaDialog = async () => {
    const paths = await api.chooseFiles('Select mod archives or pak files')
    if (!paths || paths.length === 0) return
    const results = await api.importPaths(paths)
    for (const r of results) {
      if (r.ok) toast.ok(`Added: ${r.mod.name}`, r.mod.detection.label)
      else toast.err('Import failed', r.error)
    }
    refresh()
  }

  const enabled = library.mods.filter(m => m.enabled).length

  return (
    <>
      <div className="page-title">
        My Mods
        <small>{library.mods.length} installed · {enabled} enabled</small>
      </div>

      <div className="toolbar">
        <div className="search-wrap">
          <Icon name="search" size={15} />
          <input className="input" placeholder="Filter by name or hero…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
        <Seg options={TYPE_FILTERS} value={typeFilter} onChange={setTypeFilter} />
        <div className="grow" />
        <button className="icon-btn" title="Open ~mods folder" onClick={() => api.openModsFolder()}><Icon name="folder" size={15} /></button>
        <button className="icon-btn" title="Open backup vault" onClick={() => api.openBackupFolder()}><Icon name="package" size={15} /></button>
        <button className="btn btn-primary" onClick={addViaDialog}><Icon name="plus" size={15} /> Add Mods</button>
      </div>

      <PresetStrip library={library} refreshLibrary={refresh} />

      {library.mods.length === 0 ? (
        <Empty title="No mods yet">
          Drag & drop mod archives anywhere in this window,<br />
          or grab something from <b>Explore</b>.
        </Empty>
      ) : mods.length === 0 ? (
        <Empty title="No matches">Try a different search or filter.</Empty>
      ) : (
        <div className="mod-list">
          {mods.map(m => (
            <ModRow key={m.id} mod={m} onChanged={refresh} onDeleted={refresh} onPreview={openPreview} />
          ))}
        </div>
      )}

      {preview && (
        <PreviewModal
          data={preview.data}
          progress={preview.data ? null : previewProgress}
          title={preview.title}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  )
}
