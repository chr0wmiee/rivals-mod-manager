import { useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import { activateAudioController, claimAudioController, registerAudioController } from '../audioHotkeys.js'

function clock (seconds) {
  if (!Number.isFinite(seconds)) return '-:--'
  const whole = Math.max(0, Math.floor(seconds))
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
}

/**
 * Compact single-row audio player: play, title, seek, time, optional save.
 */
export default function AudioPlayer ({ src, title, subtitle, autoPlay = false, preload = 'metadata', badge = '', onSave }) {
  const player = useRef(null)
  const [playing, setPlaying] = useState(false)
  const [current, setCurrent] = useState(0)
  const [duration, setDuration] = useState(null)
  const [error, setError] = useState('')
  const toggleRef = useRef(null)
  const controller = useRef({ toggle: () => toggleRef.current?.(), pause: () => player.current?.pause() })

  useEffect(() => { setPlaying(false); setCurrent(0); setDuration(null); setError('') }, [src])

  const playOnlyThis = () => {
    for (const other of document.querySelectorAll('audio')) if (other !== player.current) other.pause()
    setPlaying(true)
  }
  const toggle = async () => {
    const audio = player.current
    if (!audio) return
    if (!audio.paused) return audio.pause()
    if (Number.isFinite(audio.duration) && audio.currentTime >= audio.duration - 0.02) audio.currentTime = 0
    try { await audio.play() } catch { setError('Could not play this sound.') }
  }
  toggleRef.current = toggle
  useEffect(() => registerAudioController(controller.current), [])

  const seek = event => {
    const audio = player.current
    const next = Number(event.target.value)
    if (!audio || !Number.isFinite(next)) return
    audio.currentTime = next
    setCurrent(next)
  }

  return (
    <div className="player" onPointerDown={() => activateAudioController(controller.current)}>
      <button type="button" className="player-play" onClick={toggle} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <div className="player-top">
        <span className="player-title" title={[title, subtitle].filter(Boolean).join('\n')}>{title || 'Game audio'}</span>
        {badge && <span className="player-badge">{badge}</span>}
        {onSave && (
          <button type="button" className="player-save" title="Save audio file…" onClick={onSave}>
            <Icon name="save" size={14} />
          </button>
        )}
      </div>
      <audio
        ref={player} autoPlay={autoPlay} preload={preload} src={src}
        onPlay={() => { claimAudioController(controller.current); playOnlyThis() }}
        onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)}
        onTimeUpdate={e => setCurrent(e.currentTarget.currentTime || 0)}
        onLoadedMetadata={e => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
        onDurationChange={e => setDuration(Number.isFinite(e.currentTarget.duration) ? e.currentTarget.duration : null)}
        onError={() => setError('This sound could not be loaded.')}
      />
      <div className="player-bottom">
        <span className="time">{clock(current)}</span>
        <input type="range" min="0" max={duration || 0} step="0.01" value={Math.min(current, duration || 0)} onChange={seek} disabled={!duration} aria-label="Seek" />
        <span className="time">{clock(duration)}</span>
      </div>
      {error && <small className="player-error">{error}</small>}
    </div>
  )
}
