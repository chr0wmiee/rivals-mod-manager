import { formatBytes } from '../util.js'

export default function DownloadTray ({ downloads }) {
  if (!downloads.length) return null
  return (
    <div className="dl-tray">
      {downloads.map(d => {
        const pct = d.total > 0 ? Math.min(100, Math.round((d.received / d.total) * 100)) : null
        const statusText =
          d.status === 'starting' ? 'Contacting Nexus…'
            : d.status === 'downloading' ? `${formatBytes(d.received)}${d.total ? ' / ' + formatBytes(d.total) : ''}${pct != null ? ` · ${pct}%` : ''}`
              : d.status === 'installing' ? 'Installing…'
                : d.status === 'previewing' ? 'Extracting preview…'
                  : d.status === 'done' ? 'Done ✓'
                    : d.status === 'error' ? (d.error || 'Failed') : d.status
        return (
          <div key={d.id} className="dl-item">
            <div className="nm">{d.name}</div>
            <div className="st">{statusText}</div>
            {(d.status === 'downloading' || d.status === 'starting' || d.status === 'installing' || d.status === 'previewing') && (
              <div className={`bar ${pct == null || d.status !== 'downloading' ? 'indet' : ''}`}>
                <div style={{ width: pct != null ? pct + '%' : '40%' }} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
