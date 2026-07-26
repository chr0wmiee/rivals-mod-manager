import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import Icon from './Icon.jsx'
import api from '../api.js'
import { TYPE_LABELS } from '../util.js'

// ---------- toasts ----------

const ToastCtx = createContext(null)

export function ToastProvider ({ children }) {
  const [toasts, setToasts] = useState([])
  const idRef = useRef(0)
  const push = useCallback((kind, title, body, ttl = 5200) => {
    const id = ++idRef.current
    setToasts(t => [...t, { id, kind, title, body }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), ttl)
  }, [])
  const value = {
    ok: (t, b) => push('ok', t, b),
    err: (t, b) => push('err', t, b, 8000),
    warn: (t, b) => push('warn', t, b, 7000),
    info: (t, b) => push('info', t, b)
  }
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="toasts">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.title && <b>{t.title}</b>}
            {t.body}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)

// ---------- primitives ----------

export function Toggle ({ on, onChange, label, hint, disabled }) {
  return (
    <div className="switch-row" onClick={() => !disabled && onChange(!on)} style={disabled ? { opacity: 0.5, cursor: 'not-allowed' } : null}>
      <div className={`switch ${on ? 'on' : ''}`} />
      {label && (
        <div>
          <div className="lbl">{label}</div>
          {hint && <div className="hint">{hint}</div>}
        </div>
      )}
    </div>
  )
}

export function Seg ({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map(([k, label]) => (
        <button key={k} className={value === k ? 'active' : ''} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  )
}

export function Modal ({ onClose, children, width }) {
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modal" style={width ? { width } : null}>
        <button className="icon-btn modal-close" onClick={onClose} title="Close"><Icon name="x" /></button>
        {children}
      </div>
    </div>
  )
}

export function Spinner () {
  return <div className="spinner" />
}

export function Empty ({ title, children }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <div>{children}</div>
    </div>
  )
}

export function Skeletons ({ kind = 'card', count = 8 }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className={`skeleton ${kind}-sk`} style={{ animationDelay: `${i * 60}ms` }} />
  ))
}

export function TypeChips ({ detection }) {
  if (!detection) return null
  const types = detection.types && detection.types.length ? detection.types : null
  return (
    <div className="chips">
      {(detection.characters || []).map(c => (
        <span key={c.id} className="chip char" title={detection.charSource === 'name' ? 'Guessed from the mod name' : `Character ID ${c.id}`}>
          {c.name}{detection.charSource === 'name' ? ' ?' : ''}
        </span>
      ))}
      {types
        ? types.map(t => <span key={t} className={`chip ${t}`}>{TYPE_LABELS[t] || t}</span>)
        : <span className="chip unknown">{detection.label || 'Unknown'}</span>}
    </div>
  )
}

export function ConfirmButton ({ onConfirm, title, children, className }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const t = setTimeout(() => setArmed(false), 2600)
    return () => clearTimeout(t)
  }, [armed])
  return (
    <button
      className={className || 'btn btn-danger btn-sm'}
      title={armed ? 'Click again to confirm' : title}
      onClick={() => {
        if (armed) { setArmed(false); onConfirm() } else setArmed(true)
      }}
    >
      {armed ? <Icon name="check" size={14} /> : children}
    </button>
  )
}

export function ExtLink ({ href, children, className }) {
  return (
    <a
      href={href}
      className={className}
      onClick={e => { e.preventDefault(); api.openExternal(href) }}
    >
      {children}
    </a>
  )
}
