import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { crsQuad, quadGrid, quadLabel } from './crs'
import { MapLibreView } from './MapLibreView'
import { byRel, chooseStyleSource, discover, ensureProjection, loadMatrixSet } from './ogc'
import { readUrlState, writeUrlState } from './urlState'
import { capabilitiesEntries, loadCapabilities, loadCswCatalog, planRaster } from './wmts'
import type { ActiveLayer, ActiveRaster, AppliedStyle, Choice, Diagnostic, Engine, RasterEntry, ReportError, StyleDocument, Tileset, WorldCrs } from './types'
import './App.css'

type RasterMode = 'wmts' | 'csw'
// AUTO lets the layers choose the MapLibre world CRS; the others pin it.
type CrsMode = 'auto' | WorldCrs

const storedKey = 'ogc-tiles-viewer-state'
const storedEngineKey = 'ogc-tiles-viewer-engine'
const storedCrsKey = 'ogc-tiles-viewer-crs'
const storedRasterKey = 'ogc-tiles-viewer-raster'
// OpenLayers is the alternative engine, so it is only downloaded when selected.
const OpenLayersView = lazy(() => import('./OpenLayersView').then((module) => ({ default: module.OpenLayersView })))
const hueFor = (key: string) => [...key].reduce((hue, character) => (hue * 31 + character.charCodeAt(0)) % 360, 7)
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
const initialState = readUrlState()
const readStored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const initialEngine = (): Engine => ((initialState.engine ?? readStored(storedEngineKey)) === 'openlayers' ? 'openlayers' : 'maplibre')
const crsModes = ['auto', 'WorldCRS84Quad', 'WebMercatorQuad'] as const
const crsModeLabel: Record<CrsMode, string> = { auto: 'AUTO', WorldCRS84Quad: 'EPSG:4326', WebMercatorQuad: 'EPSG:3857' }
const initialCrsMode = (): CrsMode => crsModes.find((mode) => mode === (initialState.crs ?? readStored(storedCrsKey))) ?? 'auto'
const initialRaster = (): { mode: RasterMode; url: string } => {
  const { csw, wmts } = initialState
  if (csw) return { mode: 'csw', url: csw }
  if (wmts) return { mode: 'wmts', url: wmts }
  try { return { mode: 'wmts', url: '', ...JSON.parse(readStored(storedRasterKey) ?? '{}') } } catch { return { mode: 'wmts', url: '' } }
}
// Whether the MapLibre map can draw a raster in the given world CRS, natively or reprojected.
const drawableIn = (raster: ActiveRaster, worldCrs: WorldCrs) => { try { planRaster(raster, worldCrs); return true } catch { return false } }
const rasterKey = (entry: RasterEntry) => `raster:${entry.capabilitiesUrl}#${entry.wmtsLayerId}`
const matchesQuery = (entry: RasterEntry, query: string) => [entry.title, entry.id, entry.wmtsLayerId, ...entry.matrixSets].some((text) => text.toLocaleLowerCase().includes(query))
const otherCrs = (crs: WorldCrs): WorldCrs => (crs === 'WorldCRS84Quad' ? 'WebMercatorQuad' : 'WorldCRS84Quad')
const vectorFits = (layer: ActiveLayer, crs: WorldCrs) => typeof layer.grid !== 'string' && layer.grid.quad === crs
// The world CRS a raster is drawn in without reprojection, preferring the current one when it has both grids.
const rasterNative = (raster: ActiveRaster, current: WorldCrs) => { try { if (!planRaster(raster, current).reprojected) return current } catch { /* not drawable in the current CRS */ } return otherCrs(current) }
// In AUTO, the first vector layer chooses the CRS, since vectors are never reprojected; otherwise the first raster does.
function autoCrs(layers: ActiveLayer[], rasters: ActiveRaster[], current: WorldCrs) {
  const vector = layers.find((layer) => typeof layer.grid !== 'string')
  if (vector && typeof vector.grid !== 'string') return vector.grid.quad
  return rasters.length ? rasterNative(rasters[0], current) : current
}
const keepIn = (crs: WorldCrs, layers: ActiveLayer[], rasters: ActiveRaster[]) => {
  const keptLayers = layers.filter((layer) => vectorFits(layer, crs))
  const keptRasters = rasters.filter((entry) => drawableIn(entry, crs))
  return { keptLayers, keptRasters, dropped: layers.length - keptLayers.length + rasters.length - keptRasters.length }
}

function App() {
  const [endpoint, setEndpoint] = useState(() => initialState.endpoint ?? readStored(storedKey) ?? '')
  const [engine, setEngine] = useState<Engine>(initialEngine)
  const [crsMode, setCrsMode] = useState<CrsMode>(initialCrsMode)
  const [worldCrs, setWorldCrs] = useState<WorldCrs>(() => { const mode = initialCrsMode(); return mode === 'auto' ? 'WorldCRS84Quad' : mode })
  const [tilesets, setTilesets] = useState<Tileset[]>([])
  const [active, setActive] = useState<ActiveLayer[]>([])
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [message, setMessage] = useState('Enter an OGC API Tiles landing-page URL, or a WMTS or CSW URL, to begin.')
  const [loading, setLoading] = useState(false)
  const [metadata, setMetadata] = useState<Tileset | null>(null)
  const [openMatrixSets, setOpenMatrixSets] = useState<Record<string, boolean>>({})
  const [styleInput, setStyleInput] = useState('')
  const [appliedStyle, setAppliedStyle] = useState<AppliedStyle | null>(null)
  const [showTileDebug, setShowTileDebug] = useState(true)
  const [raster, setRaster] = useState(initialRaster)
  const [apiKey, setApiKey] = useState('')
  const [rasterCatalog, setRasterCatalog] = useState<RasterEntry[]>([])
  const [rasterLoading, setRasterLoading] = useState(false)
  const [rasters, setRasters] = useState<ActiveRaster[]>([])
  const [rasterQuery, setRasterQuery] = useState('')
  const [rasterDrawerOpen, setRasterDrawerOpen] = useState(true)
  // Draw order of every active layer, topmost first; layers missing from it are drawn beneath the rest.
  const [layerOrder, setLayerOrder] = useState<string[]>([])
  const [dragging, setDragging] = useState<{ key: string; over?: string } | null>(null)
  const layerCount = active.length + rasters.length
  // Stable between renders, so the maps only restack when the layers or their order change.
  const order = useMemo(() => {
    const activeKeys = [...active.map((layer) => layer.key), ...rasters.map((entry) => entry.key)]
    return [...layerOrder.filter((key) => activeKeys.includes(key)), ...activeKeys.filter((key) => !layerOrder.includes(key))]
  }, [active, rasters, layerOrder])
  const query = rasterQuery.trim().toLocaleLowerCase()
  const visibleRasters = query ? rasterCatalog.filter((entry) => matchesQuery(entry, query)) : rasterCatalog
  const groupedTilesets = tilesets.reduce<Record<string, Tileset[]>>((groups, set) => {
    const matrixSet = set.tileMatrixSetId ?? 'Unspecified tile matrix set'
    ;(groups[matrixSet] ??= []).push(set)
    return groups
  }, {})

  const reportError = useCallback<ReportError>((diagnostic, nextMessage) => {
    setDiagnostics((current) => [...current, { at: new Date().toLocaleTimeString(), ...diagnostic }])
    if (nextMessage) setMessage(nextMessage)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem(storedKey, endpoint)
      localStorage.setItem(storedEngineKey, engine)
      localStorage.setItem(storedCrsKey, crsMode)
      localStorage.setItem(storedRasterKey, JSON.stringify(raster))
    } catch { /* the viewer works without persisted state */ }
    writeUrlState({
      endpoint,
      engine: engine === 'maplibre' ? undefined : engine,
      crs: engine === 'maplibre' && crsMode !== 'auto' ? crsMode : undefined,
      wmts: raster.mode === 'wmts' ? raster.url : undefined,
      csw: raster.mode === 'csw' ? raster.url : undefined,
    })
  }, [endpoint, engine, crsMode, raster])

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setDiagnostics([]); setTilesets([]); setActive([])
    try {
      const url = new URL(endpoint).toString()
      const nextDiagnostics: Diagnostic[] = []
      const found = await discover(url, nextDiagnostics)
      setDiagnostics(nextDiagnostics); setTilesets(found)
      setMessage(found.length ? `Discovered ${found.length} vector tileset${found.length === 1 ? '' : 's'}. Choose a tile matrix set to add one.` : 'No usable vector tilesets were advertised by this API.')
    } catch (error) { reportError({ url: endpoint, status: 'Discovery failed', detail: describe(error) }, `Discovery failed: ${describe(error)}`) } finally { setLoading(false) }
  }

  // The MapLibre map works in one world CRS at a time; switching it drops the layers the new CRS cannot draw.
  function switchWorldCrs(target: WorldCrs) {
    const kept = keepIn(target, active, rasters)
    if (kept.dropped && !confirm(`Switch the map from ${worldCrs} to ${target}? ${kept.dropped} layer${kept.dropped === 1 ? '' : 's'} that cannot be drawn in ${target} will be removed.`)) return null
    setWorldCrs(target)
    return { ...kept, crs: target }
  }

  // Chooses the world CRS once a layer is added. In AUTO the new layer's own grid wins when every other layer can
  // follow it; otherwise the map stays put if it can draw the layer, reprojecting a raster, and asks before dropping
  // layers only when it cannot. A pinned CRS changes only when the layer cannot be drawn in it at all.
  function placeLayer(native: WorldCrs, fits: (crs: WorldCrs) => boolean, title: string) {
    if (crsMode === 'auto') {
      const kept = keepIn(native, active, rasters)
      if (!kept.dropped) { setWorldCrs(native); return { ...kept, crs: native } }
      if (fits(worldCrs)) return { ...keepIn(worldCrs, active, rasters), crs: worldCrs }
      return switchWorldCrs(native)
    }
    if (fits(worldCrs)) return { ...keepIn(worldCrs, active, rasters), crs: worldCrs }
    const kept = keepIn(native, active, rasters)
    if (!confirm(`${title} cannot be drawn in ${worldCrs}. Switch the map to ${native}?${kept.dropped ? ` ${kept.dropped} layer${kept.dropped === 1 ? '' : 's'} that cannot be drawn there will be removed.` : ''}`)) return null
    setWorldCrs(native); setCrsMode(native)
    return { ...kept, crs: native }
  }

  // A new vector layer goes on top; a new raster goes above the other rasters but beneath the vector layers.
  function placeOnTop(key: string, kind: 'vector' | 'raster') {
    setLayerOrder(() => {
      const rest = order.filter((item) => item !== key)
      const firstRaster = rest.findIndex((item) => rasters.some((entry) => entry.key === item))
      const at = kind === 'vector' ? 0 : firstRaster < 0 ? rest.length : firstRaster
      return [...rest.slice(0, at), key, ...rest.slice(at)]
    })
  }

  function moveLayer(key: string, to: number) {
    const rest = order.filter((item) => item !== key)
    const at = Math.max(0, Math.min(rest.length, to))
    setLayerOrder([...rest.slice(0, at), key, ...rest.slice(at)])
  }

  function removeLayers(layers: ActiveLayer[], remaining: ActiveRaster[]) {
    // In AUTO, the map returns to the remaining layers' own grid when they can all be drawn there.
    const target = engine === 'maplibre' && crsMode === 'auto' ? autoCrs(layers, remaining, worldCrs) : worldCrs
    if (target !== worldCrs && !keepIn(target, layers, remaining).dropped) setWorldCrs(target)
    setActive(layers); setRasters(remaining)
  }

  function changeCrsMode(mode: CrsMode) {
    const target = mode === 'auto' ? autoCrs(active, rasters, worldCrs) : mode
    if (target !== worldCrs) {
      const kept = mode === 'auto' ? keepIn(target, active, rasters) : switchWorldCrs(target)
      if (!kept) return
      // AUTO never drops layers; it keeps the current CRS when the layers disagree.
      if (!kept.dropped) { setWorldCrs(target); setActive(kept.keptLayers); setRasters(kept.keptRasters) }
    }
    setCrsMode(mode)
  }

  async function addLayer(tileset: Tileset) {
    const nextDiagnostics = [...diagnostics]
    try {
      const choice = choices[tileset.id]
      const matrixSet = await loadMatrixSet(tileset, choice?.matrixUrl, nextDiagnostics)
      setDiagnostics(nextDiagnostics)
      const grid = quadGrid(matrixSet.crs, matrixSet.tileMatrices.map((matrix) => ({ id: matrix.id, matrixWidth: matrix.matrixWidth, matrixHeight: matrix.matrixHeight, tileWidth: matrix.tileWidth, tileHeight: matrix.tileHeight, origin: matrix.pointOfOrigin, scaleDenominator: matrix.scaleDenominator, cellSize: matrix.cellSize })))
      const tileLink = choice ? { href: choice.tileUrl } : byRel(tileset.links, ['item', 'tile', 'http://www.opengis.net/def/rel/ogc/1.0/tiles'])
      if (!tileLink) throw new Error('This tileset does not advertise a tile URL template.')
      const key = `${tileset.id}:${matrixSet.id}`
      if (engine === 'maplibre') {
        if (typeof grid === 'string') throw new Error(`MapLibre draws WorldCRS84Quad and WebMercatorQuad tile matrix sets only. ${grid} Switch the engine to OpenLayers to draw it.`)
        // OpenLayers knows EPSG:4326 and EPSG:3857 under every name, so the layer stays usable after an engine switch.
        const projectionCode = (await ensureProjection(matrixSet.crs, nextDiagnostics).catch(() => undefined)) ?? matrixSet.crs
        const next: ActiveLayer = { key, tileset, matrixSet: { ...matrixSet, crs: projectionCode }, tileUrl: tileLink.href, grid }
        const kept = placeLayer(grid.quad, (crs) => crs === grid.quad, tileset.title)
        if (!kept) return
        setRasters(kept.keptRasters)
        setActive([...kept.keptLayers.filter((layer) => layer.key !== key), next])
        placeOnTop(key, 'vector')
        return
      }
      const projectionCode = (await ensureProjection(matrixSet.crs, nextDiagnostics)) ?? matrixSet.crs
      const existingProjection = active[0]?.matrixSet.crs
      if (existingProjection && existingProjection !== projectionCode && !confirm(`Switch the map from ${existingProjection} to ${matrixSet.crs}? Active layers will be removed.`)) return
      const next: ActiveLayer = { key, tileset, matrixSet: { ...matrixSet, crs: projectionCode }, tileUrl: tileLink.href, grid }
      const replacing = existingProjection && existingProjection !== projectionCode
      setActive((previous) => replacing ? [next] : [...previous.filter((layer) => layer.key !== key), next])
      placeOnTop(key, 'vector')
    } catch (error) { setDiagnostics(nextDiagnostics); setMessage(`Could not add ${tileset.title}: ${describe(error)}`) }
  }

  async function loadRasterCatalog(event: FormEvent) {
    event.preventDefault(); setRasterLoading(true); setRasterCatalog([])
    const nextDiagnostics: Diagnostic[] = []
    try {
      const url = new URL(raster.url).toString()
      const entries = raster.mode === 'csw' ? await loadCswCatalog(url, apiKey, nextDiagnostics) : capabilitiesEntries(await loadCapabilities(url, apiKey, nextDiagnostics), url)
      setRasterCatalog(entries)
      setMessage(entries.length ? `Found ${entries.length} raster layer${entries.length === 1 ? '' : 's'}. Select + to add one.` : `The ${raster.mode === 'csw' ? 'CSW catalog' : 'WMTS service'} lists no raster layers.`)
    } catch (error) { setMessage(`Could not load the ${raster.mode === 'csw' ? 'CSW catalog' : 'WMTS capabilities'}: ${describe(error)}`) } finally {
      setDiagnostics((current) => [...current, ...nextDiagnostics]); setRasterLoading(false)
    }
  }

  async function addRaster(entry: RasterEntry) {
    const nextDiagnostics: Diagnostic[] = []
    try {
      const capabilities = await loadCapabilities(entry.capabilitiesUrl, apiKey, nextDiagnostics)
      const next: ActiveRaster = { key: rasterKey(entry), title: entry.title, capabilities, wmtsLayerId: entry.wmtsLayerId, apiKey }
      let kept = { keptLayers: active, keptRasters: rasters }
      let note = ''
      if (engine === 'maplibre') {
        const native = rasterNative(next, worldCrs)
        // planRaster explains why a raster cannot be drawn by MapLibre at all.
        try { planRaster(next, native) } catch (error) { throw new Error(`${describe(error)} Switch the engine to OpenLayers to draw it.`) }
        const placed = placeLayer(native, (crs) => drawableIn(next, crs), entry.title)
        if (!placed) return
        kept = placed
        const plan = planRaster(next, placed.crs)
        if (plan.tiles.kind === 'plate-carree') note = ` Its ${plan.tiles.matrixSet} tiles do not follow the ${placed.crs} grid, so they are resampled in the browser.`
        else if (plan.reprojected) note = ` Its EPSG:4326 tiles are reprojected to Web Mercator in the browser${apiKey ? '; the reprojection plugin fetches them without the x-api-key header' : ''}.`
      }
      setActive(kept.keptLayers)
      setRasters([...kept.keptRasters.filter((item) => item.key !== next.key), next])
      placeOnTop(next.key, 'raster')
      setMessage(`Added ${entry.title}.${note}`)
    } catch (error) { setMessage(`Could not add ${entry.title}: ${describe(error)}`) } finally { setDiagnostics((current) => [...current, ...nextDiagnostics]) }
  }

  function changeEngine(next: Engine) {
    if (next === engine) return
    if (next === 'maplibre') {
      const quad = crsMode === 'auto' ? autoCrs(active, rasters, worldCrs) : worldCrs
      const kept = keepIn(quad, active, rasters)
      if (kept.dropped && !confirm(`MapLibre draws one of WorldCRS84Quad or WebMercatorQuad at a time. Remove the ${kept.dropped} layer${kept.dropped === 1 ? '' : 's'} it cannot draw in ${quad}?`)) return
      setWorldCrs(quad); setActive(kept.keptLayers); setRasters(kept.keptRasters)
    }
    setEngine(next)
  }

  async function loadStyle() {
    const value = styleInput.trim()
    if (!value) {
      setAppliedStyle(null)
      setMessage('Style cleared. Active layers use the generated geometry style.')
      return
    }
    try {
      let styleDocument: StyleDocument
      let styleUrl: string | undefined
      if (value.startsWith('{')) styleDocument = JSON.parse(value) as StyleDocument
      else {
        styleUrl = new URL(value).toString()
        const response = await fetch(styleUrl)
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
        styleDocument = (await response.json()) as StyleDocument
      }
      const chosen = chooseStyleSource(styleDocument)
      setAppliedStyle({ document: styleDocument, styleUrl, ...chosen })
      const drawn = `${chosen.layerCount} style layer${chosen.layerCount === 1 ? '' : 's'} from source “${chosen.source}”`
      const expects = chosen.sourceLayers.length ? ` It draws source-layers ${chosen.sourceLayers.slice(0, 8).join(', ')}; a tileset without them renders empty.` : ''
      setMessage(active.length ? `Applied ${drawn}.${expects}` : `Loaded ${drawn}. Add a tileset to draw it.`)
    } catch (error) { setMessage(`Could not load style: ${describe(error)}`) }
  }

  const viewProps = { layers: active, rasters, order, appliedStyle, showTileDebug, hueFor, onError: reportError }
  return <main className="app">
    <header><div className="brand"><span>OGC</span> TILES / VECTOR + RASTER WORKBENCH</div><div className="status"><i /> {layerCount ? `${layerCount} ACTIVE LAYER${layerCount > 1 ? 'S' : ''}` : 'NO LAYERS ACTIVE'}</div></header>
    <aside className="sidebar">
      <section className="map-settings"><h2>MAP</h2>
        <div className="segmented" role="radiogroup" aria-label="Map engine">{(['maplibre', 'openlayers'] as const).map((option) => <button type="button" key={option} role="radio" aria-checked={engine === option} className={engine === option ? 'selected' : ''} onClick={() => changeEngine(option)}>{option === 'maplibre' ? 'MAPLIBRE' : 'OPENLAYERS'}</button>)}</div>
        {engine === 'maplibre'
          ? <><div className="segmented" role="radiogroup" aria-label="Map CRS">{crsModes.map((mode) => <button type="button" key={mode} role="radio" aria-checked={crsMode === mode} title={mode === 'auto' ? 'Follow the layers' : quadLabel[mode]} className={crsMode === mode ? 'selected' : ''} onClick={() => changeCrsMode(mode)}>{crsModeLabel[mode]}</button>)}</div>
            <small>{crsMode === 'auto' ? `Follows the layers, now ${quadLabel[worldCrs]}. Each layer is drawn in its own grid when the others allow it; otherwise EPSG:4326 rasters are reprojected.` : worldCrs === 'WorldCRS84Quad' ? 'Tiles are requested and drawn natively in EPSG:4326.' : 'EPSG:4326 rasters are reprojected to Web Mercator in the browser.'}</small></>
          : <small>OpenLayers follows the first layer&apos;s advertised CRS and grid, for any EPSG code.</small>}
      </section>
      <form onSubmit={submit}><label htmlFor="endpoint">API LANDING PAGE</label><div className="endpoint"><input id="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://example.org/ogc" /><button disabled={loading}>{loading ? '...' : 'DISCOVER'}</button></div></form>
      <p className="message">{message}</p><section><h2>STYLE {appliedStyle && <b>{appliedStyle.layerCount}</b>}</h2><div className="endpoint style"><textarea aria-label="MapLibre style URL or document" value={styleInput} onChange={(event) => setStyleInput(event.target.value)} placeholder="MapLibre style URL, or paste a style JSON document" spellCheck={false} /><button type="button" onClick={() => void loadStyle()}>APPLY</button></div><small>{appliedStyle ? `Drawing source “${appliedStyle.source}”. Empty the field and select APPLY for the generated style.` : 'Blank uses a generated style colored by geometry type.'}</small></section><label className="debug-toggle"><input type="checkbox" checked={showTileDebug} onChange={(event) => setShowTileDebug(event.target.checked)} /> SHOW Z/X/Y TILE GRID</label><section><h2>CATALOG <b>{tilesets.length}</b></h2>{Object.entries(groupedTilesets).sort(([a], [b]) => a.localeCompare(b)).map(([matrixSet, entries]) => <details className="matrix-group" key={matrixSet} open={openMatrixSets[matrixSet] ?? true} onToggle={(event) => { const isOpen = event.currentTarget.open; setOpenMatrixSets((current) => ({ ...current, [matrixSet]: isOpen })) }}><summary>{matrixSet} <b>{entries.length}</b></summary>{entries.map((set) => { const tileLinks = set.links.filter((link) => ['item', 'tile', 'http://www.opengis.net/def/rel/ogc/1.0/tiles'].includes(link.rel ?? '')); const matrixLinks = set.links.filter((link) => ['http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'tiling-scheme', 'tileMatrixSet'].includes(link.rel ?? '')); const choice = choices[set.id]; return <article className="tileset catalog-item" key={set.id}><div><strong>{set.title}</strong><small>{set.dataType ?? 'vector'} · {set.crs ?? 'CRS from matrix set'}</small>{tileLinks.length > 0 && <select aria-label={`Tile format for ${set.title}`} value={choice?.tileUrl ?? tileLinks[0].href} onChange={(e) => setChoices((old) => ({ ...old, [set.id]: { tileUrl: e.target.value, matrixUrl: choice?.matrixUrl ?? matrixLinks[0]?.href ?? '' } }))}>{tileLinks.map((link) => <option key={link.href} value={link.href}>{link.title ? `${link.title} (${link.type ?? 'format unspecified'})` : link.type ?? 'Format unspecified'}</option>)}</select>}{matrixLinks.length > 1 && <select value={choice?.matrixUrl ?? matrixLinks[0].href} onChange={(e) => setChoices((old) => ({ ...old, [set.id]: { tileUrl: choice?.tileUrl ?? tileLinks[0]?.href ?? '', matrixUrl: e.target.value } }))}>{matrixLinks.map((link) => <option key={link.href} value={link.href}>{link.title ?? link.href}</option>)}</select>}</div><button className="info" onClick={() => setMetadata(set)}>i</button><button className="add" onClick={() => void addLayer(set)} aria-label={`Add ${set.title}`}>+</button></article> })}</details>)}</section>
      <section><h2>RASTER <b>{rasterCatalog.length}</b></h2>
        <form onSubmit={loadRasterCatalog}>
          <div className="segmented" role="radiogroup" aria-label="Raster catalog type">{([['wmts', 'WMTS CAPABILITIES'], ['csw', 'MAPCOLONIES CSW']] as const).map(([mode, label]) => <button type="button" key={mode} role="radio" aria-checked={raster.mode === mode} className={raster.mode === mode ? 'selected' : ''} onClick={() => { setRaster((current) => ({ ...current, mode })); setRasterCatalog([]) }}>{label}</button>)}</div>
          <div className="endpoint"><input aria-label={raster.mode === 'csw' ? 'CSW URL' : 'WMTS capabilities URL'} value={raster.url} onChange={(e) => setRaster((current) => ({ ...current, url: e.target.value }))} placeholder={raster.mode === 'csw' ? 'https://example.org/raster-catalog/csw' : 'https://example.org/wmts/1.0.0/WMTSCapabilities.xml'} /><button disabled={rasterLoading}>{rasterLoading ? '...' : 'LOAD'}</button></div>
          <div className="endpoint"><input type="password" aria-label="API key" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optional x-api-key" /></div>
        </form>
        {rasterCatalog.length > 0 && <details className="raster-drawer" open={rasterDrawerOpen} onToggle={(event) => { const isOpen = event.currentTarget.open; setRasterDrawerOpen(isOpen) }}>
          <summary>AVAILABLE LAYERS <b>{query ? `${visibleRasters.length}/${rasterCatalog.length}` : rasterCatalog.length}</b></summary>
          <input type="search" className="raster-search" aria-label="Search raster layers" placeholder="Search by title, identifier or matrix set" value={rasterQuery} onChange={(e) => setRasterQuery(e.target.value)} />
          <div className="raster-list" role="group" aria-label="Raster layers">
            {visibleRasters.map((entry) => { const selected = rasters.some((item) => item.key === rasterKey(entry)); return <label className={selected ? 'tileset raster-option selected' : 'tileset raster-option'} key={`${entry.capabilitiesUrl}#${entry.id}`}><input type="checkbox" checked={selected} onChange={() => { if (selected) removeLayers(active, rasters.filter((item) => item.key !== rasterKey(entry))); else void addRaster(entry) }} aria-label={`Show ${entry.title}`} /><div><strong>{entry.title}</strong><small>{entry.matrixSets.length ? entry.matrixSets.join(', ') : entry.wmtsLayerId}</small></div></label> })}
            {!visibleRasters.length && <p className="empty">No raster layer matches “{rasterQuery.trim()}”.</p>}
          </div>
        </details>}
      </section>
      <section><h2>LAYERS <b>{layerCount}</b></h2>
        {layerCount > 1 && <small className="hint">Drag the handle, or focus it and use the arrow keys, to reorder. The top layer is drawn above the others.</small>}
        <ol className="layer-order">{order.map((key, index) => {
          const vector = active.find((layer) => layer.key === key)
          const entry = rasters.find((item) => item.key === key)
          const title = vector?.tileset.title ?? entry?.title ?? key
          const remove = () => (vector ? removeLayers(active.filter((item) => item.key !== key), rasters) : removeLayers(active, rasters.filter((item) => item.key !== key)))
          const classes = ['tileset', 'active', entry ? 'raster' : '', dragging?.key === key ? 'dragging' : '', dragging && dragging.over === key && dragging.key !== key ? (order.indexOf(dragging.key) < index ? 'drop-below' : 'drop-above') : ''].filter(Boolean).join(' ')
          return <li key={key} className={classes} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', key); setDragging({ key }) }} onDragOver={(event) => { if (!dragging) return; event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (dragging.over !== key) setDragging({ ...dragging, over: key }) }} onDrop={(event) => { event.preventDefault(); if (dragging) moveLayer(dragging.key, index); setDragging(null) }} onDragEnd={() => setDragging(null)}>
            <button type="button" className="drag-handle" aria-label={`Reorder ${title}, position ${index + 1} of ${order.length}`} title="Drag to reorder, or use the arrow keys" onKeyDown={(event) => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); moveLayer(key, index + (event.key === 'ArrowUp' ? -1 : 1)) } }}>⠿</button>
            <div><strong>{title}</strong><small>{vector ? `${vector.matrixSet.id} · ${vector.matrixSet.crs}` : `raster · WMTS ${entry?.wmtsLayerId}`}</small></div>
            <button className="remove" onClick={remove}>REMOVE</button>
          </li>
        })}</ol>
      </section>
      <details><summary>DEVELOPER DIAGNOSTICS <b>{diagnostics.length}</b></summary>{diagnostics.length ? diagnostics.map((d, i) => <pre key={i}>{d.at} {d.status}\n{d.url}\n{d.detail}</pre>) : <p>No request failures recorded.</p>}</details></aside>
    <div className="map-wrap">{engine === 'maplibre' ? <MapLibreView key={worldCrs} worldCrs={worldCrs} {...viewProps} /> : <Suspense fallback={<div className="map" />}><OpenLayersView {...viewProps} /></Suspense>}</div>
    {metadata && <div className="modal-backdrop" onClick={() => setMetadata(null)}><section className="modal" onClick={(e) => e.stopPropagation()}><button onClick={() => setMetadata(null)}>CLOSE</button><h2>{metadata.title}</h2><p>{metadata.description ?? 'No description advertised.'}</p><dl><dt>CRS</dt><dd>{metadata.crs ?? 'Advertised by selected tile matrix set'}{engine === 'maplibre' && metadata.crs && !crsQuad(metadata.crs) ? ' (not drawable by MapLibre; switch to OpenLayers)' : ''}</dd><dt>EXTENT</dt><dd>{metadata.boundingBox ? `${metadata.boundingBox.lowerLeft.join(', ')} / ${metadata.boundingBox.upperRight.join(', ')}` : 'Not advertised'}</dd><dt>LINKS</dt><dd>{metadata.links.map((link) => `${link.rel ?? 'link'}: ${link.title ?? link.href}`).join('\n')}</dd></dl></section></div>}
  </main>
}

export default App
