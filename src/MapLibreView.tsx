import { useEffect, useReducer, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Map as MapLibreMap, NavigationControl, Popup, ScaleControl, addProtocol, setWorkerUrl, setWorldCRS } from '@nivgreen/maplibre-gl-js-crs84'
import { createProtocol, epsg4326ToEpsg3857Presets } from '@nivgreen/maplibre-gl-raster-reprojection'
import '@nivgreen/maplibre-gl-js-crs84/dist/maplibre-gl.css'
// MapLibre v6 cannot locate its worker inside a bundle; Vite emits it as a self-contained chunk.
import workerUrl from '@nivgreen/maplibre-gl-js-crs84/dist/maplibre-gl-worker.mjs?worker&url'
import { lonLatBounds, quadLabel } from './crs'
import type { Bounds } from './crs'
import { FeaturePopup } from './FeaturePopup'
import type { Hit } from './FeaturePopup'
import { viewMemory } from './viewMemory'
import { absolute } from './ogc'
import { regridLoader, regridMaxZoom, regridProtocol, registerRegrid } from './regrid'
import { apiKeyHeaders, planRaster } from './wmts'
import type { RasterPlan } from './wmts'
import type { ActiveLayer, ActiveRaster, AppliedStyle, ReportError, WorldCrs } from './types'

type StyleSpecification = Exclude<Parameters<MapLibreMap['setStyle']>[0], string | null>
type LayerSpecification = StyleSpecification['layers'][number]
type Props = { worldCrs: WorldCrs; layers: ActiveLayer[]; rasters: ActiveRaster[]; appliedStyle: AppliedStyle | null; showTileDebug: boolean; hueFor: (key: string) => number; onError: ReportError }

setWorkerUrl(workerUrl)

const mercatorLatitude = 85.051129
const vectorProtocol = 'ogc-vector'
const vectorSourceId = (key: string) => `ogc:${key}`
const rasterSourceId = (key: string) => `wmts:${key}`

// Every OGC vector tile is fetched through this protocol so the source-layer names inside it can be read:
// MapLibre only draws a source-layer a style layer names, and an OGC tileset need not list them.
const sourceLayers = new Map<string, Set<string>>()
const sourceLayerListeners = new Set<() => void>()

function mvtLayerNames(bytes: Uint8Array) {
  let position = 0
  const varint = () => {
    let value = 0
    for (let shift = 0; position < bytes.length; shift += 7) {
      const byte = bytes[position++]
      value += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) break
    }
    return value
  }
  // Walks the fields in [position, end), handing each length-delimited field to `onField`.
  const fields = (end: number, onField: (field: number, start: number, length: number) => void) => {
    while (position < end) {
      const key = varint()
      const wire = key & 7
      if (wire === 2) { const length = varint(); const start = position; position += length; onField(key >> 3, start, length) }
      else if (wire === 0) varint()
      else if (wire === 1) position += 8
      else if (wire === 5) position += 4
      else break
    }
  }
  const names: string[] = []
  fields(bytes.length, (field, start, length) => {
    if (field !== 3) return
    const after = position
    position = start
    fields(start + length, (layerField, nameStart, nameLength) => { if (layerField === 1) names.push(new TextDecoder().decode(bytes.subarray(nameStart, nameStart + nameLength))) })
    position = after
  })
  return names
}

addProtocol(vectorProtocol, async ({ url }, abortController) => {
  const rest = url.slice(vectorProtocol.length + 3)
  const separator = rest.indexOf('@')
  const key = decodeURIComponent(rest.slice(0, separator))
  const response = await fetch(rest.slice(separator + 1), { signal: abortController.signal })
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`)
  let data = await response.arrayBuffer()
  let bytes = new Uint8Array(data)
  // A tile stored gzipped but served without Content-Encoding reaches the browser still compressed.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    data = await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
    bytes = new Uint8Array(data)
  }
  const known = sourceLayers.get(key) ?? new Set<string>()
  sourceLayers.set(key, known)
  const added = mvtLayerNames(bytes).filter((name) => !known.has(name))
  if (added.length) { added.forEach((name) => known.add(name)); sourceLayerListeners.forEach((listener) => listener()) }
  return { data }
})

// EPSG:4326 raster tiles are drawn on a Web Mercator map by reprojecting them in the browser.
const reprojection = createProtocol({ ...epsg4326ToEpsg3857Presets })
addProtocol(reprojection.protocol, reprojection.loader)
addProtocol(regridProtocol, regridLoader)

function rasterSource({ raster, tiles, reprojected }: RasterPlan, worldCrs: WorldCrs): StyleSpecification['sources'][string] {
  const bounds: Bounds | undefined = tiles.bounds && (reprojected ? [tiles.bounds[0], Math.max(tiles.bounds[1], -mercatorLatitude), tiles.bounds[2], Math.min(tiles.bounds[3], mercatorLatitude)] : tiles.bounds)
  if (tiles.kind === 'plate-carree') return { type: 'raster', tiles: [registerRegrid(raster.key, { tiles, apiKey: raster.apiKey, worldCrs })], tileSize: 256, minzoom: 0, maxzoom: regridMaxZoom(tiles, worldCrs), ...(bounds ? { bounds } : {}) }
  if (!reprojected) return { type: 'raster', tiles: [tiles.tileUrl('{z}', '{x}', '{y}')], tileSize: tiles.tileSize, minzoom: tiles.minLevel, maxzoom: tiles.maxLevel, ...(bounds ? { bounds } : {}) }
  // The plugin requests source level z - 1 for a mercator tile at z, which keeps the pixel sizes alike.
  const size = tiles.tileSize === 256 ? '' : `&ssize=${tiles.tileSize}`
  return { type: 'raster', tiles: [`${reprojection.protocol}://bbox={bbox-epsg-3857}&z={z}&x={x}&y={y}${size}://${tiles.tileUrl('{sz}', '{sx}', '{sy}')}`], tileSize: 256, minzoom: tiles.minLevel + 1, maxzoom: tiles.maxLevel + 1, ...(bounds ? { bounds } : {}) }
}

const polygonTypes = ['literal', ['Polygon', 'MultiPolygon']]
const generatedLayers = (key: string, sourceLayer: string, hue: number): LayerSpecification[] => {
  const color = `hsl(${hue}, 68%, 54%)`
  const base = { source: vectorSourceId(key), 'source-layer': sourceLayer }
  return [
    { ...base, id: `${key}::${sourceLayer}::fill`, type: 'fill', filter: ['in', ['geometry-type'], polygonTypes], paint: { 'fill-color': `hsla(${hue}, 68%, 54%, .55)`, 'fill-outline-color': color } },
    { ...base, id: `${key}::${sourceLayer}::line`, type: 'line', filter: ['in', ['geometry-type'], ['literal', ['LineString', 'MultiLineString']]], paint: { 'line-color': color, 'line-width': 2 } },
    { ...base, id: `${key}::${sourceLayer}::point`, type: 'circle', filter: ['in', ['geometry-type'], ['literal', ['Point', 'MultiPoint']]], paint: { 'circle-radius': 5, 'circle-color': color, 'circle-stroke-color': '#1a1e1b', 'circle-stroke-width': 1 } },
  ] as LayerSpecification[]
}

function buildStyle(layers: ActiveLayer[], plans: RasterPlan[], appliedStyle: AppliedStyle | null, hueFor: (key: string) => number, worldCrs: WorldCrs): StyleSpecification {
  const style: StyleSpecification = { version: 8, sources: {}, layers: [] }
  const document = appliedStyle?.document
  const resolve = (href: string) => (appliedStyle?.styleUrl ? absolute(href, appliedStyle.styleUrl) : href)
  if (typeof document?.glyphs === 'string') style.glyphs = resolve(document.glyphs)
  if (typeof document?.sprite === 'string') style.sprite = resolve(document.sprite)
  else if (Array.isArray(document?.sprite)) style.sprite = (document.sprite as { id: string; url: string }[]).map((sprite) => ({ ...sprite, url: resolve(sprite.url) }))
  const styleLayers = ((document?.layers as LayerSpecification[] | undefined) ?? [])
  style.layers.push(...styleLayers.filter((layer) => layer.type === 'background'))
  for (const plan of plans) {
    style.sources[rasterSourceId(plan.raster.key)] = rasterSource(plan, worldCrs)
    style.layers.push({ id: rasterSourceId(plan.raster.key), type: 'raster', source: rasterSourceId(plan.raster.key) })
  }
  for (const layer of layers) {
    if (typeof layer.grid === 'string') continue
    const grid = layer.grid
    const tiles = layer.tileUrl.replace(/\{tileMatrix\}/gi, `${grid.prefix}{z}`).replace(/\{tileCol\}/gi, '{x}').replace(/\{tileRow\}/gi, '{y}')
    const box = layer.tileset.boundingBox
    const bounds = box && lonLatBounds(box.lowerLeft, box.upperRight, box.crs ?? layer.matrixSet.crs)
    style.sources[vectorSourceId(layer.key)] = { type: 'vector', tiles: [`${vectorProtocol}://${encodeURIComponent(layer.key)}@${tiles}`], minzoom: grid.minLevel, maxzoom: grid.maxLevel, ...(bounds ? { bounds } : {}) }
    // MapLibre only loads a source that a layer draws, and the generated layers wait for the names the tiles carry.
    style.layers.push({ id: `${layer.key}::probe`, type: 'fill', source: vectorSourceId(layer.key), 'source-layer': 'ogc-tiles-viewer-probe' })
    if (appliedStyle) {
      // Text needs glyphs, and a style without them would fail validation as a whole.
      const drawn = styleLayers.filter((styleLayer) => 'source' in styleLayer && styleLayer.source === appliedStyle.source && (style.glyphs || !(styleLayer.type === 'symbol' && styleLayer.layout?.['text-field'])))
      style.layers.push(...drawn.map((styleLayer) => ({ ...styleLayer, id: `${layer.key}::${styleLayer.id}`, source: vectorSourceId(layer.key) }) as LayerSpecification))
    } else for (const sourceLayer of sourceLayers.get(layer.key) ?? []) style.layers.push(...generatedLayers(layer.key, sourceLayer, hueFor(layer.key)))
  }
  return style
}

export function MapLibreView({ worldCrs, layers, rasters, appliedStyle, showTileDebug, hueFor, onError }: Props) {
  const mapElement = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const apiKeysRef = useRef<{ prefix: string; apiKey: string }[]>([])
  const layerCountRef = useRef<number | null>(null)
  const onErrorRef = useRef(onError)
  const [popupElement] = useState(() => document.createElement('div'))
  const [hits, setHits] = useState<{ click: number; hits: Hit[] }>({ click: 0, hits: [] })
  const [layerNamesVersion, layerNamesChanged] = useReducer((version: number) => version + 1, 0)
  onErrorRef.current = onError

  useEffect(() => {
    sourceLayerListeners.add(layerNamesChanged)
    return () => { sourceLayerListeners.delete(layerNamesChanged) }
  }, [])

  useEffect(() => {
    // The world CRS is process-wide and baked into tile coordinates, so it is set before the map exists.
    setWorldCRS(worldCrs)
    const map = new MapLibreMap({
      container: mapElement.current!, center: viewMemory.current?.center ?? [0, 0], zoom: viewMemory.current?.zoom ?? 1, attributionControl: false,
      transformRequest: (url) => {
        const apiKey = apiKeysRef.current.find((entry) => url.startsWith(entry.prefix))?.apiKey
        return apiKey ? { url, headers: apiKeyHeaders(apiKey) } : { url }
      },
    })
    map.addControl(new NavigationControl({ showCompass: false }), 'top-left')
    map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right')
    mapRef.current = map
    map.on('moveend', () => { viewMemory.current = { center: map.getCenter().toArray(), zoom: map.getZoom() } })
    const popup = new Popup({ closeButton: false, closeOnClick: false, maxWidth: 'none', className: 'feature-popup' }).setDOMContent(popupElement)
    let click = 0
    map.on('click', (event) => {
      const seen = new Set<string>()
      const found = map.queryRenderedFeatures(event.point).filter((feature) => feature.source.startsWith('ogc:')).flatMap((feature) => {
        const identity = `${feature.source}|${feature.sourceLayer}|${feature.id ?? ''}|${JSON.stringify(feature.properties)}`
        if (seen.has(identity)) return []
        seen.add(identity)
        return [{ layer: feature.sourceLayer, properties: feature.properties }]
      })
      setHits({ click: ++click, hits: found })
      if (found.length) popup.setLngLat(event.lngLat).addTo(map)
      else popup.remove()
    })
    const reported = new Set<string>()
    map.on('error', (event) => {
      const sourceId = (event as { sourceId?: string }).sourceId
      // A tileset with holes fails many tiles; one diagnostic per source is enough to explain an empty area.
      if (sourceId && reported.has(sourceId)) return
      if (sourceId) reported.add(sourceId)
      onErrorRef.current({ url: sourceId ?? 'MapLibre', status: sourceId ? 'Tile request failed' : 'MapLibre error', detail: event.error?.message ?? String(event.error) })
    })
    return () => { popup.remove(); map.remove(); mapRef.current = null; layerCountRef.current = null }
  }, [worldCrs, popupElement])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const plans = rasters.flatMap((raster) => {
      try { return [planRaster(raster, worldCrs)] } catch (error) {
        onErrorRef.current({ url: raster.title, status: 'Raster could not be drawn', detail: error instanceof Error ? error.message : String(error) }, `Could not draw ${raster.title}: ${error instanceof Error ? error.message : String(error)}`)
        return []
      }
    })
    // Resampled tiles are fetched by their own protocols, which send the key themselves where they can.
    apiKeysRef.current = plans.flatMap(({ raster, tiles, reprojected }) => (raster.apiKey && !reprojected && tiles.kind === 'quad' ? [{ prefix: tiles.tileUrl('{z}', '{x}', '{y}').split('{')[0], apiKey: raster.apiKey }] : []))
    map.setStyle(buildStyle(layers, plans, appliedStyle, hueFor, worldCrs), { diff: true })
    map.showTileBoundaries = showTileDebug
    const extents: { key: string; bounds?: Bounds }[] = [
      ...layers.map((layer) => ({ key: layer.key, bounds: layer.tileset.boundingBox && lonLatBounds(layer.tileset.boundingBox.lowerLeft, layer.tileset.boundingBox.upperRight, layer.tileset.boundingBox.crs ?? layer.matrixSet.crs) })),
      ...plans.map((plan) => ({ key: plan.raster.key, bounds: plan.tiles.bounds })),
    ]
    const previousCount = layerCountRef.current
    layerCountRef.current = extents.length
    // Frame the first layer put on an empty map. Adding more layers, or rebuilding the map for another world CRS,
    // keeps the view the user is looking at.
    const target = previousCount === 0 || (previousCount === null && !viewMemory.current) ? extents.findLast((extent) => extent.bounds)?.bounds : undefined
    const worldEdge = worldCrs === 'WebMercatorQuad' ? mercatorLatitude : 90
    if (target) map.fitBounds([target[0], Math.max(target[1], -worldEdge), target[2], Math.min(target[3], worldEdge)], { padding: 50, duration: 300 })
  }, [layers, rasters, appliedStyle, showTileDebug, hueFor, worldCrs, layerNamesVersion])

  return <>
    <div ref={mapElement} className={appliedStyle ? 'map styled' : 'map'} />
    <div className="map-caption">{quadLabel[worldCrs]}</div>
    {createPortal(<FeaturePopup key={hits.click} hits={hits.hits} />, popupElement)}
  </>
}
