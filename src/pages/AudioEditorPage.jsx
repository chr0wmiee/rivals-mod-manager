import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import api from '../api.js'
import Icon from '../components/Icon.jsx'
import AudioPlayer from '../components/AudioPlayer.jsx'
import { Empty, Spinner, useToast } from '../components/ui.jsx'
import { activateAudioController, claimAudioController, registerAudioController } from '../audioHotkeys.js'

function clamp (value, min, max) { return Math.max(min, Math.min(max, value)) }

function editorClock (seconds) {
  const value = Math.max(0, Number(seconds) || 0)
  const minutes = Math.floor(value / 60)
  return `${minutes}:${String(Math.floor(value % 60)).padStart(2, '0')}.${String(Math.floor((value % 1) * 10))}`
}

function Waveform ({ buffer, start, end, position, onSeek, onTrimStart, onTrimEnd, view, onViewChange }) {
  const canvas = useRef(null)
  const shell = useRef(null)
  const drag = useRef(null)
  const wheelHandler = useRef(null)
  const [panning, setPanning] = useState(false)
  useEffect(() => {
    const el = canvas.current
    if (!el || !buffer) return
    const ratio = window.devicePixelRatio || 1
    const w = el.clientWidth * ratio; const h = el.clientHeight * ratio
    el.width = w; el.height = h
    const ctx = el.getContext('2d'); ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#101014'; ctx.fillRect(0, 0, w, h)
    const data = buffer.getChannelData(0)
    const firstSample = Math.max(0, Math.floor(view.start * buffer.sampleRate))
    const lastSample = Math.min(data.length, Math.ceil(view.end * buffer.sampleRate))
    const step = Math.max(1, Math.floor((lastSample - firstSample) / w))
    ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = ratio
    for (let line = 1; line < 10; line++) { const x = w * line / 10; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke() }
    ctx.strokeStyle = '#ffd21f'; ctx.lineWidth = Math.max(1, ratio)
    ctx.beginPath()
    for (let x = 0; x < w; x++) {
      let min = 1; let max = -1
      const from = firstSample + x * step
      for (let i = 0; i < step && from + i < lastSample; i++) { const v = data[from + i]; if (v < min) min = v; if (v > max) max = v }
      ctx.moveTo(x, (1 + min) * h / 2); ctx.lineTo(x, (1 + max) * h / 2)
    }
    ctx.stroke()
    const span = Math.max(0.001, view.end - view.start)
    const xFor = time => w * (time - view.start) / span
    ctx.fillStyle = 'rgba(5,5,7,.68)'
    if (start > view.start) ctx.fillRect(0, 0, Math.min(w, xFor(start)), h)
    if (end < view.end) ctx.fillRect(Math.max(0, xFor(end)), 0, w, h)
  }, [buffer, start, end, view.start, view.end])

  const pointerTime = (event, element = event.currentTarget) => {
    const box = element.getBoundingClientRect()
    return view.start + clamp((event.clientX - box.left) / box.width, 0, 1) * (view.end - view.start)
  }
  const pointerDown = event => {
    const shell = event.currentTarget
    if (event.button === 1) {
      event.preventDefault(); shell.setPointerCapture(event.pointerId); setPanning(true)
      drag.current = { mode: 'pan', x: event.clientX, start: view.start, span: view.end - view.start, width: shell.clientWidth }
      return
    }
    if (event.button !== 0) return
    const trim = event.target?.closest?.('[data-trim]')?.dataset?.trim
    shell.setPointerCapture(event.pointerId)
    drag.current = { mode: trim || 'seek' }
    const time = pointerTime(event, shell)
    if (trim === 'start') onTrimStart(clamp(time, 0, end - 0.01))
    else if (trim === 'end') onTrimEnd(clamp(time, start + 0.01, buffer.duration))
    else onSeek(clamp(time, start, end))
  }
  const pointerMove = event => {
    if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const action = drag.current
    if (action.mode === 'pan') {
      const seconds = -(event.clientX - action.x) / Math.max(1, action.width) * action.span
      const bounded = clamp(action.start + seconds, 0, Math.max(0, buffer.duration - action.span))
      onViewChange({ start: bounded, end: bounded + action.span })
      return
    }
    const time = pointerTime(event)
    if (action.mode === 'start') onTrimStart(clamp(time, 0, end - 0.01))
    else if (action.mode === 'end') onTrimEnd(clamp(time, start + 0.01, buffer.duration))
    else onSeek(clamp(time, start, end))
  }
  const pointerUp = event => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    drag.current = null; setPanning(false)
  }
  const zoom = event => {
    event.preventDefault()
    const span = view.end - view.start
    const minimum = Math.min(buffer.duration, Math.max(0.1, buffer.duration / 200))
    const nextSpan = clamp(span * Math.exp(event.deltaY * 0.0015), minimum, buffer.duration)
    const box = event.currentTarget.getBoundingClientRect()
    const ratio = clamp((event.clientX - box.left) / box.width, 0, 1)
    const anchor = view.start + ratio * span
    let nextStart = anchor - ratio * nextSpan
    nextStart = clamp(nextStart, 0, Math.max(0, buffer.duration - nextSpan))
    onViewChange({ start: nextStart, end: nextStart + nextSpan })
  }
  wheelHandler.current = zoom
  useEffect(() => {
    const element = shell.current
    if (!element) return
    const onWheel = event => wheelHandler.current?.(event)
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => element.removeEventListener('wheel', onWheel)
  }, [])
  const percent = time => (time - view.start) / Math.max(0.001, view.end - view.start) * 100
  const zoomed = view.end - view.start < buffer.duration - 0.001
  return <div className="waveform-wrap">
    <div
      ref={shell}
      className={`waveform-shell ${panning ? 'panning' : ''}`} role="slider" tabIndex="0" aria-label="Replacement audio timeline"
      aria-valuemin={start} aria-valuemax={end} aria-valuenow={position}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}
      onAuxClick={event => event.preventDefault()}
    >
      <canvas className="waveform" ref={canvas} />
      {start >= view.start && start <= view.end && <i data-trim="start" className="wave-trim start" style={{ left: `${percent(start)}%` }}><span>START</span></i>}
      {end >= view.start && end <= view.end && <i data-trim="end" className="wave-trim end" style={{ left: `${percent(end)}%` }}><span>END</span></i>}
      {position >= view.start && position <= view.end && <i className="wave-playhead" style={{ left: `${percent(position)}%` }} />}
    </div>
    <div className="waveform-tools"><span>{editorClock(view.start)} - {editorClock(view.end)}</span><span>Space play · wheel zoom · middle-drag pan · gold handles trim</span>{zoomed && <button type="button" onClick={() => onViewChange({ start: 0, end: buffer.duration })}>Reset zoom</button>}</div>
  </div>
}

function ReplacementTransport ({ buffer, edit, onEditChange }) {
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(edit.start)
  const [view, setView] = useState({ start: 0, end: buffer.duration })
  const context = useRef(null)
  const source = useRef(null)
  const gain = useRef(null)
  const clock = useRef({ at: edit.start, contextTime: 0 })
  const generation = useRef(0)
  const playingRef = useRef(false)
  const editRef = useRef(edit)
  const toggleRef = useRef(null)
  const pauseRef = useRef(null)
  const controller = useRef({ toggle: () => toggleRef.current?.(), pause: () => pauseRef.current?.() })
  editRef.current = edit

  const stopSource = useCallback(() => {
    generation.current++
    if (source.current) {
      source.current.onended = null
      try { source.current.stop() } catch { /* already stopped */ }
      try { source.current.disconnect() } catch { /* already disconnected */ }
    }
    source.current = null; gain.current = null
  }, [])

  const currentPosition = useCallback(() => {
    if (!playingRef.current || !context.current) return clock.current.at
    return clock.current.at + context.current.currentTime - clock.current.contextTime
  }, [])

  const launch = useCallback((ctx, requested) => {
    claimAudioController(controller.current)
    stopSource()
    const range = editRef.current
    const at = clamp(requested, range.start, range.end)
    const node = ctx.createBufferSource(); const volume = ctx.createGain()
    node.buffer = buffer; node.connect(volume); volume.connect(ctx.destination)
    const token = ++generation.current
    node.onended = () => {
      if (token !== generation.current) return
      playingRef.current = false; setPlaying(false); setPosition(editRef.current.end)
    }
    source.current = node; gain.current = volume
    clock.current = { at, contextTime: ctx.currentTime }
    playingRef.current = true; setPlaying(true); setPosition(at)
    node.start(0, at)
  }, [buffer, stopSource])

  const pause = useCallback(() => {
    const at = clamp(currentPosition(), editRef.current.start, editRef.current.end)
    stopSource(); playingRef.current = false; setPlaying(false); setPosition(at)
    clock.current = { at, contextTime: context.current?.currentTime || 0 }
  }, [currentPosition, stopSource])
  pauseRef.current = pause

  const toggle = async () => {
    if (playingRef.current) return pause()
    if (!context.current || context.current.state === 'closed') context.current = new AudioContext()
    await context.current.resume()
    const at = position >= edit.end - 0.01 || position < edit.start ? edit.start : position
    launch(context.current, at)
  }
  toggleRef.current = toggle
  useEffect(() => registerAudioController(controller.current), [])

  const seek = useCallback(nextValue => {
    const next = clamp(Number(nextValue) || 0, editRef.current.start, editRef.current.end)
    const resume = playingRef.current && context.current
    stopSource(); playingRef.current = false
    clock.current = { at: next, contextTime: context.current?.currentTime || 0 }
    setPosition(next)
    if (resume) launch(context.current, next)
  }, [launch, stopSource])

  useEffect(() => {
    setPosition(value => clamp(value, edit.start, edit.end))
    clock.current.at = clamp(clock.current.at, edit.start, edit.end)
  }, [edit.start, edit.end])

  useEffect(() => setView({ start: 0, end: buffer.duration }), [buffer])

  useEffect(() => {
    if (!playing) return
    let frame = 0
    const tick = () => {
      const range = editRef.current
      let at = currentPosition()
      if (at < range.start) { launch(context.current, range.start); at = range.start }
      if (at >= range.end) { pause(); setPosition(range.end); return }
      let liveGain = range.volume
      if (range.fadeIn > 0) liveGain *= Math.min(1, Math.max(0, (at - range.start) / range.fadeIn))
      if (range.fadeOut > 0) liveGain *= Math.min(1, Math.max(0, (range.end - at) / range.fadeOut))
      gain.current?.gain.setValueAtTime(liveGain, context.current.currentTime)
      setPosition(at)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [playing, currentPosition, launch, pause])

  useEffect(() => () => {
    stopSource(); playingRef.current = false
    if (context.current && context.current.state !== 'closed') context.current.close()
  }, [buffer, stopSource])

  const selectedDuration = Math.max(0, edit.end - edit.start)
  return <div className="replacement-preview" onPointerDown={() => activateAudioController(controller.current)} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Waveform
      buffer={buffer} start={edit.start} end={edit.end} position={position} onSeek={seek}
      view={view} onViewChange={setView}
      onTrimStart={value => onEditChange(current => ({ ...current, start: Math.min(value, current.end - 0.01) }))}
      onTrimEnd={value => onEditChange(current => ({ ...current, end: Math.max(value, current.start + 0.01) }))}
    />
    <div className="replacement-transport">
      <button type="button" className="replacement-play" onClick={toggle}><Icon name={playing ? 'pause' : 'play'} size={16} /> {playing ? 'Pause' : 'Play'}</button>
      <span>{editorClock(position)}</span>
      <input type="range" min={edit.start} max={edit.end} step="0.01" value={position} onChange={event => seek(event.target.value)} aria-label="Seek replacement audio" />
      <span>-{editorClock(Math.max(0, edit.end - position))}</span>
      <em>{selectedDuration.toFixed(2)}s selected</em>
    </div>
  </div>
}

function renderPcm (buffer, options, wantedChannels) {
  const outRate = 48000
  const channels = Math.max(1, Math.min(2, wantedChannels || buffer.numberOfChannels || 1))
  const duration = Math.max(0.01, options.end - options.start)
  const frames = Math.max(1, Math.floor(duration * outRate))
  const output = new Uint8Array(frames * channels * 2)
  const view = new DataView(output.buffer)
  const source = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i))
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / outRate
    const sourcePos = (options.start + t) * buffer.sampleRate
    const lo = Math.min(source[0].length - 1, Math.floor(sourcePos)); const hi = Math.min(source[0].length - 1, lo + 1); const mix = sourcePos - lo
    let gain = options.volume
    if (options.fadeIn > 0) gain *= Math.min(1, t / options.fadeIn)
    if (options.fadeOut > 0) gain *= Math.min(1, (duration - t) / options.fadeOut)
    for (let channel = 0; channel < channels; channel++) {
      const samples = source[Math.min(channel, source.length - 1)]
      const sample = Math.max(-1, Math.min(1, (samples[lo] + (samples[hi] - samples[lo]) * mix) * gain))
      view.setInt16((frame * channels + channel) * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
    }
  }
  return { pcm: output, channels }
}

function cleanOutputBase (value) {
  return String(value || '').replace(/\.pak$/i, '').replace(/_9999999_p$/i, '').trim()
}

function suggestedName (item, fileName = '') {
  const clip = item?.spoken || item?.label || item?.event || cleanOutputBase(fileName) || 'Audio Replacement'
  return cleanOutputBase([item?.hero, clip].filter(Boolean).join(' - '))
}

export default function AudioEditorPage ({ onLibraryChanged }) {
  const toast = useToast()
  const [summary, setSummary] = useState(null)
  const [results, setResults] = useState({ items: [], total: 0 })
  const [heroId, setHeroId] = useState('')
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(null)
  const [bank, setBank] = useState(null)
  const [entry, setEntry] = useState(null)
  const [tools, setTools] = useState(null)
  const [busy, setBusy] = useState('')
  const [progress, setProgress] = useState(null)
  const [originalUrl, setOriginalUrl] = useState('')
  const [originalInfo, setOriginalInfo] = useState(null)
  const [originalError, setOriginalError] = useState('')
  const [reloadOriginal, setReloadOriginal] = useState(0)
  const [custom, setCustom] = useState(null)
  const [customName, setCustomName] = useState('')
  const [outputName, setOutputName] = useState('Audio Replacement')
  const [edit, setEdit] = useState({ start: 0, end: 1, fadeIn: 0, fadeOut: 0, volume: 1 })
  const originalRequest = useRef(0)

  const loadBasics = useCallback(async () => {
    const [s, t] = await Promise.all([api.audioCatalogSummary(), api.toolsStatus()])
    setSummary(s); setTools(t)
  }, [])

  const search = useCallback(async () => {
    const res = await api.audioCatalogQuery({ heroId: heroId || null, kind, query, pageSize: 120 })
    setResults(res)
  }, [heroId, kind, query])

  useEffect(() => { loadBasics().catch(e => toast.err('Audio Editor unavailable', e.message)) }, [loadBasics, toast])
  useEffect(() => { const t = setTimeout(() => search().catch(e => toast.err('Search failed', e.message)), 180); return () => clearTimeout(t) }, [search, toast])
  useEffect(() => api.onToolProgress(setProgress), [])

  const installTools = async () => {
    setBusy('tools')
    try {
      const r = await api.installTools(['vgmstream', 'uassettool'])
      setTools(r.status)
      toast.ok('Tools ready', 'Audio previews, extraction and PAK building are enabled.')
    } catch (e) { toast.err('Tool install failed', e.message) } finally { setBusy('') }
  }

  const pickTarget = item => {
    setSelected(item); setOriginalUrl(''); setOriginalInfo(null); setOriginalError('')
    setOutputName(suggestedName(item, customName))
  }

  const readCustom = async file => {
    if (!file) return
    try {
      const context = new AudioContext()
      const decoded = await context.decodeAudioData(await file.arrayBuffer())
      await context.close()
      setCustom(decoded); setCustomName(file.name)
      if (!selected) setOutputName(suggestedName(null, file.name))
      setEdit({ start: 0, end: decoded.duration, fadeIn: 0, fadeOut: 0, volume: 1 })
    } catch (e) { toast.err('Audio could not be decoded', e.message) }
  }

  const build = async install => {
    if (!bank || !entry || !custom) return
    const outputDir = install ? null : await api.chooseDirectory('Choose where to export the audio mod PAK')
    if (!install && !outputDir) return
    setBusy('build')
    try {
      const rendered = renderPcm(custom, edit, entry.channels || custom.numberOfChannels)
      const result = await api.buildAudioMod({
        bankPath: bank.path, wemId: entry.id, pcm: rendered.pcm, channels: rendered.channels,
        modName: `${selected?.hero || 'Rivals'} ${selected?.spoken || selected?.label || customName || 'Audio Replacement'}`,
        fileName: outputName, outputDir, install
      })
      toast.ok(install ? 'Audio mod installed' : 'Audio mod exported', result.outputPath)
      if (install) onLibraryChanged()
    } catch (e) { toast.err('Build failed', e.message) } finally { setBusy('') }
  }

  const selectedTitle = selected ? `${selected.hero ? `${selected.hero} · ` : ''}${selected.spoken || selected.label || selected.event || selected.wemId}` : ''
  const duration = custom?.duration || 0
  const toolReady = tools?.vgmstream?.installed && tools?.uassettool?.installed
  const bankEntries = useMemo(() => bank?.entries || [], [bank])
  const canBuild = bank && entry && custom && outputName.trim() && tools?.uassettool?.installed && busy !== 'build'

  useEffect(() => {
    const request = ++originalRequest.current
    if (!selected || !toolReady) return
    let active = true
    setBusy('original'); setOriginalUrl(''); setOriginalInfo(null); setOriginalError('')
    setBank(null); setEntry(null)
    ;(async () => {
      let loaded = null
      let match = null
      if (selected.bank) {
        loaded = await api.extractAudioBank(selected.bank)
        match = loaded.entries.find(item => item.id === selected.wemId) || null
      }
      const preview = await api.previewWem(loaded?.path || '', selected.wemId, selected.bank || '')
      if (!active || request !== originalRequest.current) return
      setBank(loaded); setEntry(match); setOriginalUrl(preview.url); setOriginalInfo(preview)
      if (selected.bank && !match) setOriginalError('This clip is not in the current bank, so it cannot be replaced yet.')
    })().catch(error => {
      if (!active || request !== originalRequest.current) return
      setOriginalError(error.message || 'The original game sound could not be loaded.')
    }).finally(() => {
      if (active && request === originalRequest.current) setBusy('')
    })
    return () => { active = false }
  }, [selected, toolReady, reloadOriginal])

  const chooseBankEntry = value => {
    const next = bankEntries.find(x => x.id === Number(value)) || null
    setEntry(next); setOriginalUrl(''); setOriginalInfo(null)
    if (next?.catalog) setSelected(next.catalog)
  }

  if (!summary || !tools) return <div className="center-load"><Spinner /></div>
  return (
    <>
      <div className="page-title" style={{ marginBottom: 16 }}>Audio Editor</div>

      {!toolReady && (
        <div className="tool-banner" style={{ marginBottom: 14 }}>
          <Icon name="bolt" size={20} style={{ color: 'var(--gold)' }} />
          <div className="txt">
            <b>Setup needed</b>
            <span>Install two small helper tools to enable previews and building.</span>
          </div>
          <button className="btn btn-primary" onClick={installTools} disabled={!!busy}>
            <Icon name="download" size={14} /> {busy === 'tools' ? 'Installing…' : 'Install tools'}
          </button>
        </div>
      )}

      {progress && busy && (
        <div className="progress-banner">
          <div className="spinner" />
          <span>{progress.message || `${progress.tool || 'Tools'}: ${progress.status}`}</span>
          {progress.total > 0 && <b>{Math.round(progress.received / progress.total * 100)}%</b>}
        </div>
      )}

      <div className="audio-grid">
        <section className="panel">
          <div className="panel-head">Sounds <span className="end">{results.total.toLocaleString()} matches</span></div>
          <div className="audio-filters">
            <select className="input" value={heroId} onChange={e => setHeroId(e.target.value)}>
              <option value="">All heroes &amp; UI</option>
              {summary.characters.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="input" value={kind} onChange={e => setKind(e.target.value)}>
              <option value="all">All sounds</option>
              <option value="ultimate">Ultimates</option>
              <option value="ability">Abilities</option>
              <option value="voice">Voice lines</option>
              <option value="ui">UI / global</option>
            </select>
            <input className="input" placeholder="Search…" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
          <div className="audio-target-list">
            {results.items.map(item => (
              <button
                key={`${item.bank}-${item.wemId}`}
                className={`audio-target ${selected?.wemId === item.wemId && selected?.bank === item.bank ? 'active' : ''}`}
                onClick={() => pickTarget(item)}
              >
                <span className={`audio-kind ${item.kind}`}>{item.usage || item.kind}</span>
                <b>{item.hero || (item.bank ? item.bank.replace(/\.bnk$/i, '') : 'Global')}</b>
                <span>{item.spoken || item.label || item.event}</span>
                <code title="Internal game audio ID">{item.wemId}</code>
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          {!selected ? (
            <Empty title="Pick a sound" />
          ) : (
            <div className="audio-work">
              <div className="selected-sound">
                <span className={`audio-kind ${selected.kind}`}>{selected.usage || selected.kind}</span>
                <div className="txt">
                  <b>{selectedTitle}</b>
                  <small>{selected.bank || 'Loose game media'} · {selected.wemId}</small>
                </div>
                <button className="icon-btn" title="Reload original" onClick={() => setReloadOriginal(v => v + 1)} disabled={!toolReady || busy === 'original'}>
                  <Icon name="refresh" size={14} />
                </button>
              </div>

              {busy === 'original' && (
                <div className="progress-banner" style={{ marginBottom: 0 }}>
                  <div className="spinner" />
                  <span>Loading the original sound…</span>
                </div>
              )}

              {originalUrl && (
                <AudioPlayer
                  src={originalUrl}
                  title={selected?.spoken || selected?.label || selected?.event || 'Original game sound'}
                  subtitle={`${selected?.bank || 'game media'} · ${entry?.id || selected?.wemId}.wem${Number.isFinite(originalInfo?.duration) ? ` · ${originalInfo.duration.toFixed(2)}s` : ''}`}
                  badge="Original"
                  autoPlay
                  onSave={() => api.savePreviewAsset(originalUrl, `${selected?.wemId}.wav`).then(p => p && toast.ok('Saved', p)).catch(e => toast.err('Save failed', e.message))}
                />
              )}

              {bank && bankEntries.length > 1 && (
                <div className="field">
                  <label>Clip inside {bank.name}</label>
                  <select className="input" value={entry?.id || ''} onChange={e => chooseBankEntry(e.target.value)}>
                    {!entry && <option value="">Selected sound is not in this bank</option>}
                    {bankEntries.map(x => <option key={x.id} value={x.id}>{x.catalog?.spoken || x.catalog?.label || `Unlabeled ${x.id}`}</option>)}
                  </select>
                </div>
              )}

              {!selected.bank && <div className="note warn">This sound can be previewed but not replaced yet.</div>}
              {!toolReady && <div className="note warn">Install the helper tools above to preview game audio.</div>}
              {originalError && <div className="note warn">{originalError}</div>}

              <label className={`audio-drop ${custom ? 'loaded' : ''}`} onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); e.stopPropagation(); readCustom(e.dataTransfer.files[0]) }}>
                <input type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a" onChange={e => readCustom(e.target.files[0])} />
                <Icon name={custom ? 'check' : 'plus'} size={22} />
                <b>{custom ? customName : 'Drop your replacement audio here'}</b>
                <span>{custom ? `${custom.duration.toFixed(2)}s · ${custom.numberOfChannels} ch · ${custom.sampleRate} Hz` : 'WAV · MP3 · OGG · FLAC · M4A'}</span>
              </label>

              {custom && (
                <div className="wave-editor">
                  <ReplacementTransport buffer={custom} edit={edit} onEditChange={setEdit} />
                  <div className="edit-controls">
                    <label><span>Trim start <b>{edit.start.toFixed(2)}s</b></span><input type="range" min="0" max={Math.max(0.01, duration - 0.01)} step="0.01" value={edit.start} onChange={e => setEdit(v => ({ ...v, start: Math.min(Number(e.target.value), v.end - 0.01) }))} /></label>
                    <label><span>Trim end <b>{edit.end.toFixed(2)}s</b></span><input type="range" min="0.01" max={duration} step="0.01" value={edit.end} onChange={e => setEdit(v => ({ ...v, end: Math.max(Number(e.target.value), v.start + 0.01) }))} /></label>
                    <label><span>Fade in <b>{edit.fadeIn.toFixed(2)}s</b></span><input type="range" min="0" max={Math.min(5, edit.end - edit.start)} step="0.05" value={edit.fadeIn} onChange={e => setEdit(v => ({ ...v, fadeIn: Number(e.target.value) }))} /></label>
                    <label><span>Fade out <b>{edit.fadeOut.toFixed(2)}s</b></span><input type="range" min="0" max={Math.min(5, edit.end - edit.start)} step="0.05" value={edit.fadeOut} onChange={e => setEdit(v => ({ ...v, fadeOut: Number(e.target.value) }))} /></label>
                    <label className="volume-control"><span>Volume <b>{Math.round(edit.volume * 100)}%</b></span><input type="range" min="0" max="2" step="0.05" value={edit.volume} onChange={e => setEdit(v => ({ ...v, volume: Number(e.target.value) }))} /></label>
                  </div>
                </div>
              )}

              {custom && (
                <div className="build-bar">
                  <div className="field">
                    <label>Mod file name</label>
                    <div className="output-suffix">
                      <input className="input" value={outputName} onChange={event => setOutputName(cleanOutputBase(event.target.value))} placeholder="My audio replacement" />
                      <small>_9999999_P.pak</small>
                    </div>
                  </div>
                  <div className="btn-row">
                    <button className="btn btn-ghost" onClick={() => build(false)} disabled={!canBuild}>
                      <Icon name="save" size={14} /> Export…
                    </button>
                    <button className="btn btn-primary" onClick={() => build(true)} disabled={!canBuild}>
                      <Icon name="bolt" size={14} /> {busy === 'build' ? 'Building…' : 'Build & install'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
