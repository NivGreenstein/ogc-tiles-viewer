import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorTileLayer from 'ol/layer/VectorTile'
import TileLayer from 'ol/layer/Tile'
import VectorTileSource from 'ol/source/VectorTile'
import TileDebug from 'ol/source/TileDebug'
import MVT from 'ol/format/MVT'
import Style from 'ol/style/Style'
import Fill from 'ol/style/Fill'
import Stroke from 'ol/style/Stroke'
import CircleStyle from 'ol/style/Circle'
import TileGrid from 'ol/tilegrid/TileGrid'
import Overlay from 'ol/Overlay'
import { defaults as defaultControls, ScaleLine } from 'ol/control'
import { register } from 'ol/proj/proj4'
import { get as getProjection } from 'ol/proj'
import proj4 from 'proj4'
import './App.css'

type Link = { href: string; rel?: string; type?: string; title?: string; templated?: boolean }
type Tileset = { id: string; title: string; description?: string; dataType?: string; crs?: string; tileMatrixSetId?: string; boundingBox?: { lowerLeft: number[]; upperRight: number[]; crs?: string }; links: Link[] }
type TileMatrix = { id: string; scaleDenominator: number; cellSize?: number; pointOfOrigin: number[]; tileWidth: number; tileHeight: number; matrixWidth: number; matrixHeight: number }
type MatrixSet = { id: string; title?: string; crs: string; tileMatrices: TileMatrix[] }
type Diagnostic = { at: string; url: string; status: string; detail: string }
type ActiveLayer = { key: string; tileset: Tileset; matrixSet: MatrixSet; tileUrl: string }
type Choice = { tileUrl: string; matrixUrl: string }

const storedKey = 'ogc-tiles-viewer-state'
const absolute = (href: string, base: string) => new URL(href, base).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
const byRel = (links: Link[], rels: string[]) => links.find((link) => rels.includes(link.rel ?? ''))
const title = (value: Record<string, unknown>, fallback: string) => String(value.title ?? value.id ?? value.name ?? fallback)

function withTileFormat(template: string, format: string) {
  const url = new URL(template)
  url.searchParams.set('f', format)
  return url.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
}

async function getJson(url: string, diagnostics: Diagnostic[]) {
  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`)
    return JSON.parse(text) as Record<string, unknown>
  } catch (error) {
    diagnostics.push({ at: new Date().toLocaleTimeString(), url, status: 'Request failed', detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

function parseTileset(raw: Record<string, unknown>, base: string): Tileset {
  const bbox = raw.boundingBox as Record<string, unknown> | undefined
  return {
    id: String(raw.id ?? raw.title ?? crypto.randomUUID()), title: title(raw, 'Untitled tileset'), description: typeof raw.description === 'string' ? raw.description : undefined,
    dataType: typeof raw.dataType === 'string' ? raw.dataType : undefined, crs: typeof raw.crs === 'string' ? raw.crs : undefined, tileMatrixSetId: typeof raw.tileMatrixSetId === 'string' ? raw.tileMatrixSetId : undefined,
    boundingBox: bbox ? { lowerLeft: (bbox.lowerLeft as number[]) ?? [], upperRight: (bbox.upperRight as number[]) ?? [], crs: typeof bbox.crs === 'string' ? bbox.crs : undefined } : undefined,
    links: ((raw.links as Link[] | undefined) ?? []).map((link) => ({ ...link, href: absolute(link.href, base) })),
  }
}

async function discover(endpoint: string, diagnostics: Diagnostic[]) {
  const landing = await getJson(endpoint, diagnostics)
  const links = (landing.links as Link[] | undefined) ?? []
  const serviceDescription = byRel(links, ['service-desc'])
  let tileFormats: string[] = []
  if (serviceDescription) {
    try {
      const api = await getJson(absolute(serviceDescription.href, endpoint), diagnostics)
      const parameters = ((api.components as Record<string, unknown> | undefined)?.parameters as Record<string, Record<string, unknown>> | undefined)
      const tileFormat = parameters?.fTile
      const schema = tileFormat?.schema as Record<string, unknown> | undefined
      tileFormats = ((schema?.enum as unknown[] | undefined) ?? []).filter((format): format is string => typeof format === 'string')
    } catch { /* discovery remains usable when the optional OpenAPI document cannot be read */ }
  }
  const tilesetsLink = byRel(links, ['http://www.opengis.net/def/rel/ogc/1.0/tilesets', 'tilesets', 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector', 'tilesets-vector'])
  const collectionLinks = links.filter((link) => link.rel === 'item' || link.rel === 'collection')
  const dataLink = byRel(links, ['data'])
  const sets: Tileset[] = []
  if (tilesetsLink) {
    const catalogUrl = absolute(tilesetsLink.href, endpoint)
    const catalog = await getJson(catalogUrl, diagnostics)
    const rawSets = (catalog.tilesets as Record<string, unknown>[] | undefined) ?? []
    sets.push(...rawSets.map((raw) => parseTileset(raw, catalogUrl)))
  }
  const collectionUrls = [...collectionLinks.map((link) => absolute(link.href, endpoint))]
  if (dataLink) {
    const collectionsUrl = absolute(dataLink.href, endpoint)
    const collectionCatalog = await getJson(collectionsUrl, diagnostics)
    for (const collection of (collectionCatalog.collections as Record<string, unknown>[] | undefined) ?? []) {
      const self = byRel((collection.links as Link[] | undefined) ?? [], ['self'])
      if (self) collectionUrls.push(absolute(self.href, collectionsUrl))
    }
  }
  if (!sets.length && collectionUrls.length) {
    for (const collectionUrl of collectionUrls) {
      try {
        const collection = await getJson(collectionUrl, diagnostics)
        const collectionTiles = byRel((collection.links as Link[] | undefined) ?? [], ['http://www.opengis.net/def/rel/ogc/1.0/tilesets', 'tilesets', 'http://www.opengis.net/def/rel/ogc/1.0/tilesets-vector', 'tilesets-vector'])
        if (collectionTiles) {
          const tilesUrl = absolute(collectionTiles.href, collectionUrl)
          const tileCatalog = await getJson(tilesUrl, diagnostics)
          sets.push(...((tileCatalog.tilesets as Record<string, unknown>[] | undefined) ?? []).map((tile) => parseTileset(tile, tilesUrl)))
        }
      } catch { /* diagnostics records the failed collection request */ }
    }
  }
  return sets.filter((set) => !set.dataType || set.dataType.toLowerCase() === 'vector').map((set) => {
    if (!tileFormats.length) return set
    return {
      ...set,
      links: set.links.flatMap((link) => link.rel === 'item' && link.templated
        ? tileFormats.map((format) => ({ ...link, href: withTileFormat(link.href, format), type: link.type ?? `application/x-${format}`, title: format.toUpperCase() }))
        : [link]),
    }
  })
}

async function loadMatrixSet(tileset: Tileset, matrixUrl: string | undefined, diagnostics: Diagnostic[]) {
  let links = tileset.links
  let inheritedCrs = tileset.crs
  if (!matrixUrl) {
    const self = byRel(links, ['self'])
    if (self) {
      const detail = await getJson(self.href, diagnostics)
      links = ((detail.links as Link[] | undefined) ?? []).map((link) => ({ ...link, href: absolute(link.href, self.href) }))
      inheritedCrs = typeof detail.crs === 'string' ? detail.crs : inheritedCrs
    }
  }
  const link = matrixUrl ? { href: matrixUrl } : byRel(links, ['http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'tiling-scheme', 'tileMatrixSet'])
  if (!link) throw new Error('This tileset does not advertise a tile matrix set link.')
  const raw = await getJson(link.href, diagnostics)
  const matrices = (raw.tileMatrices as Record<string, unknown>[] | undefined) ?? []
  return {
    id: String(raw.id ?? link.title ?? 'Tile matrix set'), title: typeof raw.title === 'string' ? raw.title : link.title,
    crs: String(raw.crs ?? inheritedCrs ?? ''),
    tileMatrices: matrices.map((m) => ({ id: String(m.id), scaleDenominator: Number(m.scaleDenominator), cellSize: Number(m.cellSize), pointOfOrigin: m.pointOfOrigin as number[], tileWidth: Number(m.tileWidth), tileHeight: Number(m.tileHeight), matrixWidth: Number(m.matrixWidth), matrixHeight: Number(m.matrixHeight) })),
  } satisfies MatrixSet
}

async function ensureProjection(crs: string, diagnostics: Diagnostic[]) {
  if (getProjection(crs)) return
  const code = crs.match(/(?:EPSG[:/]|::)(\d+)$/i)?.[1] ?? crs.match(/(\d+)$/)?.[1]
  if (!code) throw new Error(`Cannot obtain a projection definition for “${crs}”.`)
  const url = `https://epsg.io/${code}.proj4`
  let response: Response
  try { response = await fetch(url) } catch (error) { diagnostics.push({ at: new Date().toLocaleTimeString(), url, status: 'Projection request failed', detail: String(error) }); throw error }
  if (!response.ok) throw new Error(`epsg.io could not provide a definition for EPSG:${code}.`)
  proj4.defs(`EPSG:${code}`, await response.text())
  register(proj4)
  if (!getProjection(`EPSG:${code}`)) throw new Error(`OpenLayers could not register EPSG:${code}.`)
  return `EPSG:${code}`
}

function App() {
  const mapElement = useRef<HTMLDivElement>(null)
  const popupElement = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const [endpoint, setEndpoint] = useState(() => new URLSearchParams(location.search).get('endpoint') ?? localStorage.getItem(storedKey) ?? '')
  const [tilesets, setTilesets] = useState<Tileset[]>([])
  const [active, setActive] = useState<ActiveLayer[]>([])
  const [choices, setChoices] = useState<Record<string, Choice>>({})
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([])
  const [message, setMessage] = useState('Enter an OGC API Tiles landing-page URL to begin.')
  const [loading, setLoading] = useState(false)
  const [metadata, setMetadata] = useState<Tileset | null>(null)
  const [hits, setHits] = useState<Record<string, unknown>[]>([])
  const [selectedHit, setSelectedHit] = useState(0)
  const [openMatrixSets, setOpenMatrixSets] = useState<Record<string, boolean>>({})
  const [styleUrl, setStyleUrl] = useState('')
  const [styleVersion, setStyleVersion] = useState(0)
  const [showTileDebug, setShowTileDebug] = useState(true)
  const groupedTilesets = tilesets.reduce<Record<string, Tileset[]>>((groups, set) => {
    const matrixSet = set.tileMatrixSetId ?? 'Unspecified tile matrix set'
    ;(groups[matrixSet] ??= []).push(set)
    return groups
  }, {})

  useEffect(() => {
    const map = new Map({ target: mapElement.current!, controls: defaultControls().extend([new ScaleLine({ units: 'metric' })]), view: new View({ center: [0, 0], zoom: 2 }) })
    mapRef.current = map
    const overlay = new Overlay({ element: popupElement.current!, autoPan: { animation: { duration: 150 } } })
    map.addOverlay(overlay)
    map.on('singleclick', (event) => {
      const found: Record<string, unknown>[] = []
      map.forEachFeatureAtPixel(event.pixel, (feature) => { found.push(feature.getProperties()); return undefined })
      setHits(found); setSelectedHit(0); overlay.setPosition(found.length ? event.coordinate : undefined)
    })
    return () => map.setTarget(undefined)
  }, [])

  useEffect(() => {
    localStorage.setItem(storedKey, endpoint)
    const params = new URLSearchParams(location.search)
    if (endpoint) params.set('endpoint', endpoint)
    else params.delete('endpoint')
    history.replaceState(null, '', `${location.pathname}?${params}`)
  }, [endpoint])

  async function submit(event: FormEvent) {
    event.preventDefault(); setLoading(true); setDiagnostics([]); setTilesets([]); setActive([])
    try {
      const url = new URL(endpoint).toString()
      const nextDiagnostics: Diagnostic[] = []
      const found = await discover(url, nextDiagnostics)
      setDiagnostics(nextDiagnostics); setTilesets(found)
      setMessage(found.length ? `Discovered ${found.length} vector tileset${found.length === 1 ? '' : 's'}. Choose a tile matrix set to add one.` : 'No usable vector tilesets were advertised by this API.')
    } catch (error) { setDiagnostics((current) => [...current, { at: new Date().toLocaleTimeString(), url: endpoint, status: 'Discovery failed', detail: error instanceof Error ? error.message : String(error) }]); setMessage(`Discovery failed: ${error instanceof Error ? error.message : String(error)}`) } finally { setLoading(false) }
  }

  async function addLayer(tileset: Tileset) {
    const nextDiagnostics = [...diagnostics]
    try {
      const choice = choices[tileset.id]
      const matrixSet = await loadMatrixSet(tileset, choice?.matrixUrl, nextDiagnostics)
      setDiagnostics(nextDiagnostics)
      const projectionCode = (await ensureProjection(matrixSet.crs, nextDiagnostics)) ?? matrixSet.crs
      const existingProjection = active[0]?.matrixSet.crs
      if (existingProjection && existingProjection !== matrixSet.crs && !confirm(`Switch the map from ${existingProjection} to ${matrixSet.crs}? Active layers will be removed.`)) return
      const tileLink = choice ? { href: choice.tileUrl } : byRel(tileset.links, ['item', 'tile', 'http://www.opengis.net/def/rel/ogc/1.0/tiles'])
      if (!tileLink) throw new Error('This tileset does not advertise a tile URL template.')
      const key = `${tileset.id}:${matrixSet.id}`
      const next: ActiveLayer = { key, tileset, matrixSet: { ...matrixSet, crs: projectionCode }, tileUrl: tileLink.href }
      const replacing = existingProjection && existingProjection !== matrixSet.crs
      setActive((previous) => replacing ? [next] : [...previous.filter((layer) => layer.key !== key), next])
    } catch (error) { setDiagnostics(nextDiagnostics); setMessage(`Could not add ${tileset.title}: ${error instanceof Error ? error.message : String(error)}`) }
  }

  async function loadStyle() {
    if (!styleUrl) return
    try {
      const response = await fetch(styleUrl)
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
      await response.json()
      setStyleUrl('')
      setStyleVersion((version) => version + 1)
      setMessage('Style document is valid. This viewer keeps its OGC API Tiles source and applied a random local style.')
    } catch (error) { setMessage(`Could not load style: ${error instanceof Error ? error.message : String(error)}`) }
  }

  useEffect(() => {
    const map = mapRef.current
    if (!map || !active.length) return
    const projection = getProjection(active[0].matrixSet.crs)
    if (!projection) return
    map.setView(new View({ projection, center: active[0].tileset.boundingBox?.lowerLeft ?? [0, 0], zoom: 0 }))
    map.getLayers().clear()
    for (const layer of active) {
      const matrices = layer.matrixSet.tileMatrices
      const meters = projection.getMetersPerUnit() ?? 1
      const grid = new TileGrid({ extent: layer.tileset.boundingBox && (!layer.tileset.boundingBox.crs || layer.tileset.boundingBox.crs === layer.matrixSet.crs) ? [...layer.tileset.boundingBox.lowerLeft, ...layer.tileset.boundingBox.upperRight] : undefined, origins: matrices.map((m) => m.pointOfOrigin), resolutions: matrices.map((m) => m.cellSize || m.scaleDenominator * 0.00028 / meters), tileSizes: matrices.map((m) => [m.tileWidth, m.tileHeight]) })
      const vectorLayer = new VectorTileLayer({ source: new VectorTileSource({ format: new MVT(), projection, tileGrid: grid, tileUrlFunction: ([z, x, y]) => layer.tileUrl.replace(/\{tileMatrix\}/gi, matrices[z].id).replace(/\{tileCol\}/gi, String(x)).replace(/\{tileRow\}/gi, String(y)) }) })
      if (!styleUrl) {
        const hue = Math.floor(Math.random() * 360)
        vectorLayer.setStyle((feature) => {
          const geometry = feature.getGeometry()?.getType()
          const color = `hsl(${hue}, 68%, 54%)`
          if (geometry?.includes('Point')) return new Style({ image: new CircleStyle({ radius: 5, fill: new Fill({ color }), stroke: new Stroke({ color: '#1a1e1b', width: 1 }) }) })
          if (geometry?.includes('Line')) return new Style({ stroke: new Stroke({ color, width: 2 }) })
          return new Style({ fill: new Fill({ color: `hsla(${hue}, 68%, 54%, .55)` }), stroke: new Stroke({ color, width: 1 }) })
        })
      }
      map.addLayer(vectorLayer)
    }
    if (showTileDebug) {
      const matrices = active[0].matrixSet.tileMatrices
      const meters = projection.getMetersPerUnit() ?? 1
      const grid = new TileGrid({ origins: matrices.map((matrix) => matrix.pointOfOrigin), resolutions: matrices.map((matrix) => matrix.cellSize || matrix.scaleDenominator * 0.00028 / meters), tileSizes: matrices.map((matrix) => [matrix.tileWidth, matrix.tileHeight]) })
      map.addLayer(new TileLayer({ source: new TileDebug({ projection, tileGrid: grid }) }))
    }
    const box = active[0].tileset.boundingBox
    if (box?.lowerLeft.length === 2 && box.upperRight.length === 2 && (!box.crs || box.crs === active[0].matrixSet.crs)) map.getView().fit([...box.lowerLeft, ...box.upperRight], { padding: [50, 50, 50, 330], duration: 300 })
  }, [active, styleUrl, styleVersion, showTileDebug])

  return <main className="app">
    <header><div className="brand"><span>OGC</span> TILES / VECTOR WORKBENCH</div><div className="status"><i /> {active.length ? `${active.length} ACTIVE LAYER${active.length > 1 ? 'S' : ''}` : 'NO LAYERS ACTIVE'}</div></header>
    <aside className="sidebar"><form onSubmit={submit}><label htmlFor="endpoint">API LANDING PAGE</label><div className="endpoint"><input id="endpoint" value={endpoint} onChange={(e) => setEndpoint(e.target.value)} placeholder="https://example.org/ogc" /><button disabled={loading}>{loading ? '...' : 'DISCOVER'}</button></div></form>
      <p className="message">{message}</p><section><h2>STYLE</h2><div className="endpoint"><input aria-label="MapLibre style URL" value={styleUrl} onChange={(event) => setStyleUrl(event.target.value)} placeholder="Optional MapLibre style URL" /><button type="button" onClick={() => void loadStyle()}>APPLY</button></div><small>Blank uses a random local style.</small></section><label className="debug-toggle"><input type="checkbox" checked={showTileDebug} onChange={(event) => setShowTileDebug(event.target.checked)} /> SHOW Z/X/Y TILE GRID</label><section><h2>CATALOG <b>{tilesets.length}</b></h2>{Object.entries(groupedTilesets).sort(([a], [b]) => a.localeCompare(b)).map(([matrixSet, entries]) => <details className="matrix-group" key={matrixSet} open={openMatrixSets[matrixSet] ?? true} onToggle={(event) => { const isOpen = event.currentTarget.open; setOpenMatrixSets((current) => ({ ...current, [matrixSet]: isOpen })) }}><summary>{matrixSet} <b>{entries.length}</b></summary>{entries.map((set) => { const tileLinks = set.links.filter((link) => ['item', 'tile', 'http://www.opengis.net/def/rel/ogc/1.0/tiles'].includes(link.rel ?? '')); const matrixLinks = set.links.filter((link) => ['http://www.opengis.net/def/rel/ogc/1.0/tiling-scheme', 'tiling-scheme', 'tileMatrixSet'].includes(link.rel ?? '')); const choice = choices[set.id]; return <article className="tileset catalog-item" key={set.id}><div><strong>{set.title}</strong><small>{set.dataType ?? 'vector'} · {set.crs ?? 'CRS from matrix set'}</small>{tileLinks.length > 0 && <select aria-label={`Tile format for ${set.title}`} value={choice?.tileUrl ?? tileLinks[0].href} onChange={(e) => setChoices((old) => ({ ...old, [set.id]: { tileUrl: e.target.value, matrixUrl: choice?.matrixUrl ?? matrixLinks[0]?.href ?? '' } }))}>{tileLinks.map((link) => <option key={link.href} value={link.href}>{link.title ? `${link.title} (${link.type ?? 'format unspecified'})` : link.type ?? 'Format unspecified'}</option>)}</select>}{matrixLinks.length > 1 && <select value={choice?.matrixUrl ?? matrixLinks[0].href} onChange={(e) => setChoices((old) => ({ ...old, [set.id]: { tileUrl: choice?.tileUrl ?? tileLinks[0]?.href ?? '', matrixUrl: e.target.value } }))}>{matrixLinks.map((link) => <option key={link.href} value={link.href}>{link.title ?? link.href}</option>)}</select>}</div><button className="info" onClick={() => setMetadata(set)}>i</button><button className="add" onClick={() => void addLayer(set)} aria-label={`Add ${set.title}`}>+</button></article> })}</details>)}</section>
      <section><h2>LAYERS <b>{active.length}</b></h2>{active.map((layer) => <article className="tileset active" key={layer.key}><div><strong>{layer.tileset.title}</strong><small>{layer.matrixSet.id} · {layer.matrixSet.crs}</small></div><button className="remove" onClick={() => setActive((layers) => layers.filter((item) => item.key !== layer.key))}>REMOVE</button></article>)}</section>
      <details><summary>DEVELOPER DIAGNOSTICS <b>{diagnostics.length}</b></summary>{diagnostics.length ? diagnostics.map((d, i) => <pre key={i}>{d.at} {d.status}\n{d.url}\n{d.detail}</pre>) : <p>No request failures recorded.</p>}</details></aside>
    <div className="map-wrap"><div ref={mapElement} className="map" /><div className="map-caption">{active[0]?.matrixSet.crs ?? 'NO ACTIVE CRS'}</div><div ref={popupElement} className="popup">{hits.length > 0 && <><header><strong>{hits.length} FEATURE{hits.length > 1 ? 'S' : ''}</strong><select value={selectedHit} onChange={(e) => setSelectedHit(Number(e.target.value))}>{hits.map((_, i) => <option key={i} value={i}>Feature {i + 1}</option>)}</select></header><pre>{JSON.stringify(hits[selectedHit], null, 2)}</pre></>}</div></div>
    {metadata && <div className="modal-backdrop" onClick={() => setMetadata(null)}><section className="modal" onClick={(e) => e.stopPropagation()}><button onClick={() => setMetadata(null)}>CLOSE</button><h2>{metadata.title}</h2><p>{metadata.description ?? 'No description advertised.'}</p><dl><dt>CRS</dt><dd>{metadata.crs ?? 'Advertised by selected tile matrix set'}</dd><dt>EXTENT</dt><dd>{metadata.boundingBox ? `${metadata.boundingBox.lowerLeft.join(', ')} / ${metadata.boundingBox.upperRight.join(', ')}` : 'Not advertised'}</dd><dt>LINKS</dt><dd>{metadata.links.map((link) => `${link.rel ?? 'link'}: ${link.title ?? link.href}`).join('\n')}</dd></dl></section></div>}
  </main>
}

export default App
