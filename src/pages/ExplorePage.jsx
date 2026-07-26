import { useCallback, useEffect, useRef, useState } from 'react'
import api from '../api.js'
import Icon from '../components/Icon.jsx'
import NexusModCard from '../components/NexusModCard.jsx'
import { useToast, Empty, Toggle, Skeletons, Seg } from '../components/ui.jsx'

const SORTS = [
  ['popular', 'Most endorsed'],
  ['downloads', 'Most downloaded'],
  ['newest', 'Newest'],
  ['updated', 'Recently updated']
]

const PERIODS = [
  ['', 'Any time'],
  ['1d', 'Today'],
  ['1w', 'This week'],
  ['1m', 'This month'],
  ['6m', 'Last 6 months'],
  ['1y', 'This year']
]

function Row ({ title, mods, delayBase = 0, ...cardProps }) {
  if (!mods || mods.length === 0) return null
  return (
    <>
      <div className="section-title"><span className="tag">//</span>{title}</div>
      <div className="row-scroll">
        {mods.map((m, i) => (
          <NexusModCard key={m.modId} mod={m} style={{ animationDelay: `${delayBase + Math.min(i, 10) * 40}ms` }} {...cardProps} />
        ))}
      </div>
    </>
  )
}

export default function ExplorePage ({ settings, favorites, installedIds, onToggleFavorite, onOpenMod }) {
  const toast = useToast()
  const [view, setView] = useState('browse')
  const [home, setHome] = useState(null)
  const [homeLoading, setHomeLoading] = useState(false)
  const [categories, setCategories] = useState([])
  const [showAdult, setShowAdult] = useState(!!settings.showAdult)

  const [terms, setTerms] = useState('')
  const [category, setCategory] = useState('')
  const [hero, setHero] = useState('')
  const [sort, setSort] = useState('popular')
  const [period, setPeriod] = useState('')
  const [results, setResults] = useState([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [searching, setSearching] = useState(false)
  const searchSeq = useRef(0)

  const favSet = new Set(favorites.map(f => f.modId))
  const filtering = !!(terms.trim() || category || hero || period || sort !== 'popular')

  const loadHome = useCallback(async adult => {
    setHomeLoading(true)
    try {
      setHome(await api.nexusHome(adult))
    } catch (e) {
      toast.err('Could not reach Nexus', e.message)
    } finally {
      setHomeLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadHome(showAdult)
    api.nexusCategories().then(setCategories).catch(() => {})
  }, []) // eslint-disable-line

  const runSearch = useCallback(async (overrides = {}) => {
    const seq = ++searchSeq.current
    const p = overrides.page ?? 0
    const opts = {
      terms: [overrides.hero ?? hero, overrides.terms ?? terms].filter(Boolean).join(' '),
      sort: overrides.sort ?? sort,
      category: overrides.category ?? category,
      period: overrides.period ?? period,
      includeAdult: overrides.showAdult ?? showAdult,
      page: p,
      pageSize: 24
    }
    setSearching(true)
    try {
      const res = await api.nexusSearch(opts)
      if (seq !== searchSeq.current) return
      setTotal(res.totalCount)
      setPage(p)
      setResults(prev => (p === 0 ? res.mods : [...prev, ...res.mods]))
    } catch (e) {
      if (seq === searchSeq.current) toast.err('Search failed', e.message)
    } finally {
      if (seq === searchSeq.current) setSearching(false)
    }
  }, [terms, hero, sort, category, period, showAdult, toast])

  // react to filter changes (not free-typed terms — those go on Enter)
  const applyFilter = (setter, key) => value => {
    setter(value)
    runSearch({ [key]: value, page: 0 })
  }

  const onAdultToggle = async v => {
    setShowAdult(v)
    await api.patchSettings({ showAdult: v })
    if (filtering) runSearch({ showAdult: v, page: 0 })
    loadHome(v)
  }

  const cardProps = {
    onOpen: onOpenMod,
    onToggleFavorite,
    blurAdult: !showAdult,
    installedIds,
    favSet
  }

  const favList = favorites

  return (
    <>
      <div className="page-title">Explore</div>

      <div className="toolbar">
        <Seg options={[['browse', 'Browse'], ['favorites', `Favorites${favList.length ? ` (${favList.length})` : ''}`]]} value={view} onChange={setView} />
        {view === 'browse' && (
          <>
            <div className="search-wrap">
              <Icon name="search" size={15} />
              <input
                className="input"
                placeholder="Search mods… (Enter)"
                value={terms}
                onChange={e => setTerms(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch({ page: 0 }) }}
              />
            </div>
            <select className="input" value={category} onChange={e => applyFilter(setCategory, 'category')(e.target.value)} style={{ width: 150 }} title="Category">
              <option value="">All categories</option>
              {categories.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
            <select className="input" value={hero} onChange={e => applyFilter(setHero, 'hero')(e.target.value)} style={{ width: 150 }} title="Hero">
              <option value="">All heroes</option>
              {(settings.characters || []).map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
            </select>
            <select className="input" value={sort} onChange={e => applyFilter(setSort, 'sort')(e.target.value)} style={{ width: 160 }} title="Sort by">
              {SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <select className="input" value={period} onChange={e => applyFilter(setPeriod, 'period')(e.target.value)} style={{ width: 140 }} title="Uploaded within">
              {PERIODS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <Toggle on={showAdult} onChange={onAdultToggle} label="Adult" />
          </>
        )}
      </div>

      {view === 'favorites' && (
        favList.length === 0 ? (
          <Empty title="Nothing saved yet">Hit the ★ on any mod to keep it here.</Empty>
        ) : (
          <div className="grid-cards">
            {favList.map((f, i) => (
              <NexusModCard key={f.modId} mod={f} style={{ animationDelay: `${Math.min(i, 12) * 30}ms` }} {...cardProps} />
            ))}
          </div>
        )
      )}

      {view === 'browse' && !filtering && (
        homeLoading || !home ? (
          <>
            <div className="section-title"><span className="tag">//</span>Most popular</div>
            <div className="row-scroll"><Skeletons kind="card" count={6} /></div>
            <div className="section-title"><span className="tag">//</span>Recently added</div>
            <div className="row-scroll"><Skeletons kind="card" count={6} /></div>
          </>
        ) : (
          <>
            <Row title="Most popular" mods={home.trending} {...cardProps} />
            <Row title="Recently added" mods={home.newest} delayBase={80} {...cardProps} />
            <Row title="Recently updated" mods={home.updated} delayBase={160} {...cardProps} />
          </>
        )
      )}

      {view === 'browse' && filtering && (
        <>
          {total > 0 && (
            <div className="section-title">
              <span className="tag">//</span>Results
              <span className="end">{total.toLocaleString()} mods</span>
            </div>
          )}
          {searching && results.length === 0 ? (
            <div className="grid-cards"><Skeletons kind="card" count={12} /></div>
          ) : results.length === 0 ? (
            <Empty title="No results">Try different search terms or filters.</Empty>
          ) : (
            <>
              <div className="grid-cards">
                {results.map((m, i) => (
                  <NexusModCard key={`${m.modId}-${i}`} mod={m} style={{ animationDelay: `${Math.min(i % 24, 12) * 30}ms` }} {...cardProps} />
                ))}
              </div>
              {results.length < total && (
                <div className="loadmore">
                  <button className="btn btn-ghost" disabled={searching} onClick={() => runSearch({ page: page + 1 })}>
                    {searching ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </>
  )
}
