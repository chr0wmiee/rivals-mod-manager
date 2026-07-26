import Icon from './Icon.jsx'
import { formatNumber, timeAgo } from '../util.js'

export default function NexusModCard ({ mod, onOpen, favSet, isFavorite, onToggleFavorite, blurAdult, installedIds, style }) {
  const blur = mod.adult && blurAdult
  const fav = isFavorite ?? favSet?.has(mod.modId)
  const installed = installedIds?.has(mod.modId)
  return (
    <div className="card" style={style} onClick={() => onOpen(mod)}>
      <div className={`card-img ${blur ? 'blur' : ''}`}>
        {mod.adult && <span className="adult-tag">18+</span>}
        {installed && <span className="installed-tag"><Icon name="check" size={10} />Installed</span>}
        {mod.thumbnailUrl
          ? <img src={mod.thumbnailUrl} alt="" loading="lazy" />
          : <div className="ph">{(mod.name || '?').charAt(0)}</div>}
        {onToggleFavorite && (
          <button
            className={`icon-btn ${fav ? 'on' : ''}`}
            style={{ position: 'absolute', right: 8, bottom: 8, zIndex: 2, background: 'rgba(10,10,12,0.75)' }}
            title={fav ? 'Remove from favorites' : 'Add to favorites'}
            onClick={e => { e.stopPropagation(); onToggleFavorite(mod) }}
          >
            <Icon name="star" size={15} />
          </button>
        )}
      </div>
      <div className="card-body">
        <div className="card-name">{mod.name}</div>
        {mod.category && <div className="chips"><span className="chip cat">{mod.category}</span></div>}
        <div className="card-meta">
          <span className="by">{mod.author || '-'}</span>
          <span className="stat" title="Downloads"><Icon name="download" size={11} />{formatNumber(mod.downloads)}</span>
          <span className="stat" title="Endorsements"><Icon name="heart" size={11} />{formatNumber(mod.endorsements)}</span>
          <span style={{ marginLeft: 'auto' }}>{timeAgo(mod.updatedAt || mod.createdAt)}</span>
        </div>
      </div>
    </div>
  )
}
