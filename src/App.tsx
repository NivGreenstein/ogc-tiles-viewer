import { Suspense, lazy, useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { crsQuad, quadGrid, quadLabel } from './crs'
import { MapLibreView } from './MapLibreView'
import { byRel, chooseStyleSource, discover, ensureProjection, loadMatrixSet } from './ogc'
import { capabilitiesEntries, loadCapabilities, loadCswCatalog, planRaster } from './wmts'
import type { ActiveLayer, ActiveRaster, AppliedStyle, Choice, Diagnostic, Engine, RasterEntry, ReportError, StyleDocument, Tileset, WorldCrs } from './types'
import './App.css'

type RasterMode = 'wmts' | 'csw'

const storedKey = 'ogc-tiles-viewer-state'
const storedEngineKey = 'ogc-tiles-viewer-engine'
const storedCrsKey = 'ogc-tiles-viewer-crs'
const storedRasterKey = 'ogc-tiles-viewer-raster'
// OpenLayers is the alternative engine, so it is only downloaded when selected.
const OpenLayersView = lazy(() => import('./OpenLayersView').then((module) => ({ default: module.OpenLayersView })))
const hueFor = (key: string) => [...key].reduce((hue, character) => (hue * 31 + character.charCodeAt(0)) % 360, 7)
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error))
const initialParams = new URLSearchParams(location.search)
const readStored = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }
const initialEngine = (): Engine => ((initialParams.get('engine') ?? readStored(storedEngineKey)) === 'openlayers' ? 'openlayers' : 'maplibre')
const initialCrs = (): WorldCrs => ((initialParams.get('crs') ?? readStored(storedCrsKey)) === 'WebMercatorQuad' ? 'WebMercatorQuad' : 'WorldCRS84Quad')
const initialRaster = (): { mode: RasterMode; url: string } => {
  const csw = initialParams.get('csw')
  const wmts = initialParams.get('wmts')
  if (csw) return { mode: 'csw', url: csw }
  if (wmts) return { mode: 'wmts', url: wmts }
  try { return { mode: 'wmts', url: '', ...JSON.parse(readStored(storedRasterKey) ?? '{}') } } catch { return { mode: 'wmts', url: '' } }
}
// Whether the MapLibre map can draw a raster in the given world CRS, natively or reprojected.
const drawableIn = (raster: ActiveRaster, worldCrs: WorldCrs) => { try { planRaster(raster, worldCrs); return true } catch { return false } }

function App() {
  const [endpoint, setEndpoint] = useState(() => initialParams.get('endpoint') ?? readStored(storedKey) ?? '')
  const [engine, setEngine] = useState<Engine>(initialEngine)
  const [worldCrs, setWorldCrs] = useState<WorldCrs>(initialCrs)
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
  const layerCount = active.length + rasters.length
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
      localStorage.setItem(storedCrsKey, worldCrs)
      localStorage.setItem(storedRasterKey, JSON.stringify(raster))
    } catch { /* the viewer works without persisted state */ }
    const params = new URLSearchParams(location.search)
    const set = (key: string, value: string | undefined) => { if (value) params.set(key, value); else params.delete(key) }
    set('endpoint', endpoint)
    set('engine', engine === 'maplibre' ? undefined : engine)
    set('crs', engine === 'maplibre' && worldCrs !== 'WorldCRS84Quad' ? worldCrs : undefined)
    set('wmts', raster.mode === 'wmts' ? raster.url : undefined)
    set('csw', raster.mode === 'csw' ? raster.url : undefined)
    history.replaceState(null, '', `${location.pathname}?${params}`)
  }, [endpoint, engine, worldCrs, raster])

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
    const keptLayers = active.filter((layer) => typeof layer.grid !== 'string' && layer.grid.quad === target)
    const keptRasters = rasters.filter((entry) => drawableIn(entry, target))
    const dropped = active.length - keptLayers.length + rasters.length - keptRasters.length
    if (dropped && !confirm(`Switch the map from ${worldCrs} to ${target}? ${dropped} layer${dropped === 1 ? '' : 's'} that cannot be drawn in ${target} will be removed.`)) return null
    setWorldCrs(target)
    return { keptLayers, keptRasters }
  }

  async function addLayer(tileset: Tileset) {
    const nextDiagnostics = [...diagnostics]
    try {
      const choice = choices[tileset.id]
      const matrixSet = await loadMatrixSet(tileset, choice?.matrixUrl, nextDiagnostics)
      setDiagnostics(nextDiagnostics)
      const grid = quadGrid(matrixSet.crs, matrixSet.tileMatrices.map((matrix) => ({ id: matrix.id, matrixWidth: matrix.matrixWidth, matrixHeight: matrix.matrixHeight, tileWidth: matrix.tileWidth, tileHeight: matrix.tileHeight, origin: matrix.pointOfOrigin })))
      const tileLink = choice ? { href: choice.tileUrl } : byRel(tileset.links, ['item', 'tile', 'http://www.opengis.net/def/rel/ogc/1.0/tiles'])
      if (!tileLink) throw new Error('This tileset does not advertise a tile URL template.')
      const key = `${tileset.id}:${matrixSet.id}`
      if (engine === 'maplibre') {
        if (typeof grid === 'string') throw new Error(`MapLibre draws WorldCRS84Quad and WebMercatorQuad tile matrix sets only. ${grid} Switch the engine to OpenLayers to draw it.`)
        // OpenLayers knows EPSG:4326 and EPSG:3857 under every name, so the layer stays usable after an engine switch.
        const projectionCode = (await ensureProjection(matrixSet.crs, nextDiagnostics).catch(() => undefined)) ?? matrixSet.crs
        const next: ActiveLayer = { key, tileset, matrixSet: { ...matrixSet, crs: projectionCode }, tileUrl: tileLink.href, grid }
        const kept = grid.quad === worldCrs ? { keptLayers: active, keptRasters: rasters } : switchWorldCrs(grid.quad)
        if (!kept) return
        setRasters(kept.keptRasters)
        setActive([...kept.keptLayers.filter((layer) => layer.key !== key), next])
        return
      }
      const projectionCode = (await ensureProjection(matrixSet.crs, nextDiagnostics)) ?? matrixSet.crs
      const existingProjection = active[0]?.matrixSet.crs
      if (existingProjection && existingProjection !== projectionCode && !confirm(`Switch the map from ${existingProjection} to ${matrixSet.crs}? Active layers will be removed.`)) return
      const next: ActiveLayer = { key, tileset, matrixSet: { ...matrixSet, crs: projectionCode }, tileUrl: tileLink.href, grid }
      const replacing = existingProjection && existingProjection !== projectionCode
      setActive((previous) => replacing ? [next] : [...previous.filter((layer) => layer.key !== key), next])
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
      const next: ActiveRaster = { key: `raster:${entry.capabilitiesUrl}#${entry.wmtsLayerId}`, title: entry.title, capabilities, wmtsLayerId: entry.wmtsLayerId, apiKey }
      let kept = { keptLayers: active, keptRasters: rasters }
      let note = ''
      if (engine === 'maplibre') {
        let crs = worldCrs
        if (!drawableIn(next, worldCrs)) {
          // A raster with only a Web Mercator grid cannot be drawn on a WorldCRS84Quad map; planRaster explains why otherwise.
          crs = worldCrs === 'WorldCRS84Quad' ? 'WebMercatorQuad' : 'WorldCRS84Quad'
          planRaster(next, crs)
          const switched = switchWorldCrs(crs)
          if (!switched) return
          kept = switched
        }
        if (planRaster(next, crs).reprojected) note = ` Its EPSG:4326 tiles are reprojected to Web Mercator in the browser${apiKey ? '; the reprojection plugin fetches them without the x-api-key header' : ''}.`
      }
      setActive(kept.keptLayers)
      setRasters([...kept.keptRasters.filter((item) => item.key !== next.key), next])
      setMessage(`Added ${entry.title}.${note}`)
    } catch (error) { setMessage(`Could not add ${entry.title}: ${describe(error)}`) } finally { setDiagnostics((current) => [...current, ...nextDiagnostics]) }
  }

  function changeEngine(next: Engine) {
    if (next === engine) return
    if (next === 'maplibre') {
      const drawable = active.flatMap((layer) => (typeof layer.grid === 'string' ? [] : [{ layer, quad: layer.grid.quad }]))
      const quad = drawable[0]?.quad ?? worldCrs
      const keptLayers = drawable.filter((entry) => entry.quad === quad).map((entry) => entry.layer)
      const keptRasters = rasters.filter((entry) => drawableIn(entry, quad))
      const dropped = active.length - keptLayers.length + rasters.length - keptRasters.length
      if (dropped && !confirm(`MapLibre draws one of WorldCRS84Quad or WebMercatorQuad at a time. Remove the ${dropped} layer${dropped === 1 ? '' : 's'} it cannot draw in ${quad}?`)) return
      setWorldCrs(quad); setActive(keptLayers); setRasters(keptRasters)
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

  const viewProps = { layers: active, rasters, appliedStyle, showTileDebug, hueFor, onError: reportError }
  return <main className="app">
    <header><div className="brand"><span>OGC</span> TILES / VECTOR + RASTER WORKBENCH</div><div className="status"><i /> {layerCount ? `${layerCount} ACTIVE LAYER${layerCount > 1 ? 'S' : ''}` : 'NO LAYERS ACTIVE'}</div></header>
    <aside className="sidebar">
      <section className="map-settings"><h2>MAP</h2>
        <div className="segmented" role="radiogroup" aria-label="Map engine">{(['maplibre', 'openlayers'] as const).map((option) => <button type="button" key={option} role="radio" aria-checked={engine === option} className={engine === option ? 'selected' : ''} onClick={() => changeEngine(option)}>{option === 'maplibre' ? 'MAPLIBRE' : 'OPENLAYERS'}</button>)}</div>
        {engine === 'maplibre'
          ? <><div className="segmented" role="radiogroup" aria-label="Map CRS">{(['WorldCRS84Quad', 'WebMercatorQuad'] as const).map((option) => <button type="button" key={option} role="radio" aria-checked={worldCrs === option} className={worldCrs === option ? 'selected' : ''} onClick={() => { const kept = option !== worldCrs && switchWorldCrs(option); if (kept) { setActive(kept.keptLayers); setRasters(kept.keptRasters) } }}>{quadLabel[option]}</button>)}</div>
            <small>{worldCrs === 'WorldCRS84Quad' ? 'Tiles are requested and drawn natively in EPSG:4326.' : 'EPSG:4326 rasters are reprojected to Web Mercator in the browser.'}</small></>
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
        {rasterCatalog.map((entry) => <article className="tileset catalog-item" key={`${entry.capabilitiesUrl}#${entry.id}`}><div><strong>{entry.title}</strong><small>{entry.matrixSets.length ? entry.matrixSets.join(', ') : entry.wmtsLayerId}</small></div><button className="add" onClick={() => void addRaster(entry)} aria-label={`Add ${entry.title}`}>+</button></article>)}
      </section>
      <section><h2>LAYERS <b>{layerCount}</b></h2>
        {active.map((layer) => <article className="tileset active" key={layer.key}><div><strong>{layer.tileset.title}</strong><small>{layer.matrixSet.id} · {layer.matrixSet.crs}</small></div><button className="remove" onClick={() => setActive((layers) => layers.filter((item) => item.key !== layer.key))}>REMOVE</button></article>)}
        {rasters.map((entry) => <article className="tileset active raster" key={entry.key}><div><strong>{entry.title}</strong><small>raster · WMTS {entry.wmtsLayerId}</small></div><button className="remove" onClick={() => setRasters((items) => items.filter((item) => item.key !== entry.key))}>REMOVE</button></article>)}
      </section>
      <details><summary>DEVELOPER DIAGNOSTICS <b>{diagnostics.length}</b></summary>{diagnostics.length ? diagnostics.map((d, i) => <pre key={i}>{d.at} {d.status}\n{d.url}\n{d.detail}</pre>) : <p>No request failures recorded.</p>}</details></aside>
    <div className="map-wrap">{engine === 'maplibre' ? <MapLibreView key={worldCrs} worldCrs={worldCrs} {...viewProps} /> : <Suspense fallback={<div className="map" />}><OpenLayersView {...viewProps} /></Suspense>}</div>
    {metadata && <div className="modal-backdrop" onClick={() => setMetadata(null)}><section className="modal" onClick={(e) => e.stopPropagation()}><button onClick={() => setMetadata(null)}>CLOSE</button><h2>{metadata.title}</h2><p>{metadata.description ?? 'No description advertised.'}</p><dl><dt>CRS</dt><dd>{metadata.crs ?? 'Advertised by selected tile matrix set'}{engine === 'maplibre' && metadata.crs && !crsQuad(metadata.crs) ? ' (not drawable by MapLibre; switch to OpenLayers)' : ''}</dd><dt>EXTENT</dt><dd>{metadata.boundingBox ? `${metadata.boundingBox.lowerLeft.join(', ')} / ${metadata.boundingBox.upperRight.join(', ')}` : 'Not advertised'}</dd><dt>LINKS</dt><dd>{metadata.links.map((link) => `${link.rel ?? 'link'}: ${link.title ?? link.href}`).join('\n')}</dd></dl></section></div>}
  </main>
}

export default App
