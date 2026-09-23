import WMTSCapabilities from 'ol/format/WMTSCapabilities'
import { lonLatBounds, plateCarreeMatrices, quadGrid } from './crs'
import type { Bounds, PlateCarreeMatrix, QuadGrid } from './crs'
import type { ActiveRaster, Capabilities, Diagnostic, RasterEntry, WorldCrs } from './types'

// The parts of ol/format/WMTSCapabilities output this viewer reads.
type WmtsLayer = {
  Identifier: string; Title?: string; WGS84BoundingBox?: number[]; Format?: string[]
  Style?: { Identifier: string; isDefault?: boolean }[]
  Dimension?: { Identifier: string; Default?: string; Value?: string[] }[]
  TileMatrixSetLink?: { TileMatrixSet: string; TileMatrixSetLimits?: { TileMatrix: string }[] }[]
  ResourceURL?: { format: string; template: string; resourceType: string }[]
}
type WmtsMatrixSet = { Identifier: string; SupportedCRS?: string; TileMatrix?: { Identifier: string; ScaleDenominator: number; TopLeftCorner: number[]; TileWidth: number; TileHeight: number; MatrixWidth: number; MatrixHeight: number }[] }
type GetTileDcp = { href: string; Constraint?: { name: string; AllowedValues?: { Value?: string[] } }[] }
export type QuadTiles = QuadGrid & { kind: 'quad'; matrixSet: string; bounds?: Bounds; tileUrl: (level: string, col: string, row: string) => string }
export type PlateCarreeTiles = { kind: 'plate-carree'; matrixSet: string; matrices: PlateCarreeMatrix[]; bounds?: Bounds; matrixUrl: (matrix: string, col: string, row: string) => string }
export type WmtsTiles = QuadTiles | PlateCarreeTiles

export const apiKeyHeaders = (apiKey: string): Record<string, string> => (apiKey ? { 'x-api-key': apiKey } : {})
const capabilitiesCache = new Map<string, Promise<Capabilities>>()
const layersOf = (capabilities: Capabilities) => ((capabilities.Contents as { Layer?: WmtsLayer[] } | undefined)?.Layer ?? []).filter((layer) => layer.Identifier)
const matrixSetsOf = (capabilities: Capabilities) => (capabilities.Contents as { TileMatrixSet?: WmtsMatrixSet[] } | undefined)?.TileMatrixSet ?? []

async function fetchText(url: string, apiKey: string, diagnostics: Diagnostic[], init?: RequestInit) {
  try {
    const response = await fetch(url, { ...init, headers: { ...apiKeyHeaders(apiKey), ...init?.headers } })
    const text = await response.text()
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 500)}`)
    return text
  } catch (error) {
    diagnostics.push({ at: new Date().toLocaleTimeString(), url, status: 'Request failed', detail: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

export function loadCapabilities(url: string, apiKey: string, diagnostics: Diagnostic[]) {
  const cacheKey = `${url}::${apiKey}`
  let loading = capabilitiesCache.get(cacheKey)
  if (!loading) {
    loading = fetchText(url, apiKey, diagnostics).then((text) => {
      const parsed = new WMTSCapabilities().read(text) as Capabilities | null
      if (!parsed || !layersOf(parsed).length) throw new Error('The response is not a WMTS capabilities document with layers.')
      return parsed
    })
    loading.catch(() => capabilitiesCache.delete(cacheKey))
    capabilitiesCache.set(cacheKey, loading)
  }
  return loading
}

export const capabilitiesEntries = (capabilities: Capabilities, capabilitiesUrl: string): RasterEntry[] => layersOf(capabilities).map((layer) => ({
  id: layer.Identifier, title: layer.Title ?? layer.Identifier, capabilitiesUrl, wmtsLayerId: layer.Identifier, matrixSets: (layer.TileMatrixSetLink ?? []).map((link) => link.TileMatrixSet),
}))

// MapColonies raster catalog: every RECORD_RASTER record links to the WMTS capabilities that serve it.
const getRecordsRequest = (startPosition: number, maxRecords: number) => `<?xml version="1.0" encoding="UTF-8"?>
<csw:GetRecords xmlns:csw="http://www.opengis.net/cat/csw/2.0.2" service="CSW" maxRecords="${maxRecords}" startPosition="${startPosition}" outputSchema="http://schema.mapcolonies.com/raster" version="2.0.2" xmlns:mc="http://schema.mapcolonies.com/raster">
  <csw:Query typeNames="mc:MCRasterRecord">
    <csw:ElementSetName>full</csw:ElementSetName>
    <csw:Constraint version="1.1.0">
      <Filter xmlns="http://www.opengis.net/ogc">
        <PropertyIsEqualTo>
          <PropertyName>mc:type</PropertyName>
          <Literal>RECORD_RASTER</Literal>
        </PropertyIsEqualTo>
      </Filter>
    </csw:Constraint>
  </csw:Query>
</csw:GetRecords>`

const byTag = (parent: Element | Document, names: string[]) => names.map((name) => [...parent.getElementsByTagName(name)]).find((nodes) => nodes.length) ?? []
const firstText = (parent: Element, names: string[]) => byTag(parent, names).map((node) => node.textContent?.trim() ?? '').find(Boolean) ?? ''

export async function loadCswCatalog(url: string, apiKey: string, diagnostics: Diagnostic[]) {
  const entries = new Map<string, RasterEntry>()
  const maxRecords = 100
  for (let startPosition = 1; startPosition > 0;) {
    const text = await fetchText(url, apiKey, diagnostics, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body: getRecordsRequest(startPosition, maxRecords) })
    const document = new DOMParser().parseFromString(text, 'application/xml')
    if (document.getElementsByTagName('parsererror').length) throw new Error('The CSW response is not valid XML.')
    for (const record of byTag(document, ['mc:MCRasterRecord', 'MCRasterRecord'])) {
      const id = firstText(record, ['mc:productId', 'productId'])
      const links = byTag(record, ['mc:links', 'links'])
      const link = links.find((node) => node.getAttribute('scheme') === 'WMTS') ?? links.find((node) => node.getAttribute('scheme') === 'WMTS_KVP')
      const capabilitiesUrl = (link?.textContent ?? '').trim().replace(/^['"]+|['"]+$/g, '')
      if (!id || !capabilitiesUrl || entries.has(id)) continue
      entries.set(id, { id, title: firstText(record, ['mc:productName', 'productName']) || id, capabilitiesUrl, wmtsLayerId: link?.getAttribute('name') || id, matrixSets: [] })
    }
    const results = byTag(document, ['csw:SearchResults', 'SearchResults'])[0]
    const matched = Number(results?.getAttribute('numberOfRecordsMatched')) || 0
    const returned = Number(results?.getAttribute('numberOfRecordsReturned')) || 0
    const nextRecord = Number(results?.getAttribute('nextRecord')) || 0
    startPosition = matched && returned && nextRecord > startPosition && nextRecord <= matched ? nextRecord : 0
  }
  return [...entries.values()]
}

// Finds the capabilities layer for a catalog entry; a single-layer document is accepted whatever its identifier.
export function findLayer(capabilities: Capabilities, wmtsLayerId: string) {
  const layers = layersOf(capabilities)
  return layers.find((layer) => layer.Identifier === wmtsLayerId) ?? (layers.length === 1 ? layers[0] : undefined)
}

function getTileKvpUrl(capabilities: Capabilities) {
  const operations = capabilities.OperationsMetadata as { GetTile?: { DCP?: { HTTP?: { Get?: GetTileDcp[] } } } } | undefined
  const endpoints = operations?.GetTile?.DCP?.HTTP?.Get ?? []
  const kvp = endpoints.find((endpoint) => !endpoint.Constraint || endpoint.Constraint.some((constraint) => constraint.name === 'GetEncoding' && constraint.AllowedValues?.Value?.includes('KVP')))
  return kvp?.href
}

// Builds a layer's tile URL for one matrix set, from its RESTful template or else its KVP GetTile endpoint, with the
// default style and dimension values filled in; {TileMatrix}, {TileCol} and {TileRow} are left to the caller.
function tileTemplate(capabilities: Capabilities, layer: WmtsLayer, matrixSet: string) {
  const style = (layer.Style ?? []).find((entry) => entry.isDefault)?.Identifier ?? layer.Style?.[0]?.Identifier ?? 'default'
  const resources = (layer.ResourceURL ?? []).filter((resource) => resource.resourceType === 'tile')
  const resource = resources.find((entry) => entry.format === layer.Format?.[0]) ?? resources[0]
  let template: string
  if (resource) template = resource.template.replace(/\{Style\}/gi, encodeURIComponent(style)).replace(/\{TileMatrixSet\}/gi, encodeURIComponent(matrixSet))
  else {
    const href = getTileKvpUrl(capabilities)
    if (!href) throw new Error(`${layer.Identifier} has neither a RESTful tile template nor a KVP GetTile endpoint.`)
    const url = new URL(href, location.href)
    for (const [key, value] of Object.entries({ SERVICE: 'WMTS', REQUEST: 'GetTile', VERSION: '1.0.0', LAYER: layer.Identifier, STYLE: style, FORMAT: layer.Format?.[0] ?? 'image/png', TILEMATRIXSET: matrixSet })) url.searchParams.set(key, value)
    template = `${url}&TILEMATRIX={TileMatrix}&TILEROW={TileRow}&TILECOL={TileCol}`
  }
  for (const dimension of layer.Dimension ?? []) template = template.replace(new RegExp(`\\{${dimension.Identifier}\\}`, 'gi'), encodeURIComponent(dimension.Default ?? dimension.Value?.[0] ?? ''))
  return (matrix: string, col: string, row: string) => template.replace(/\{TileMatrix\}/gi, matrix).replace(/\{TileCol\}/gi, col).replace(/\{TileRow\}/gi, row)
}

// Resolves how a WMTS layer's tiles are drawn: addressed directly when it advertises one of the preferred quad grids,
// otherwise resampled from an EPSG:4326 plate carrée matrix set such as NASA GIBS publishes.
export function resolveWmtsTiles(capabilities: Capabilities, wmtsLayerId: string, preferred: WorldCrs[]): WmtsTiles {
  const layer = findLayer(capabilities, wmtsLayerId)
  if (!layer) throw new Error(`Layer ${wmtsLayerId} is not in the WMTS capabilities.`)
  const reasons: string[] = []
  const links = (layer.TileMatrixSetLink ?? []).flatMap((link) => {
    const matrixSet = matrixSetsOf(capabilities).find((set) => set.Identifier === link.TileMatrixSet)
    if (!matrixSet) return []
    // TileMatrixSetLimits narrows the levels the layer actually has tiles for.
    const limited = new Set((link.TileMatrixSetLimits ?? []).map((limit) => limit.TileMatrix))
    const matrices = (matrixSet.TileMatrix ?? []).map((matrix) => ({ id: matrix.Identifier, matrixWidth: matrix.MatrixWidth, matrixHeight: matrix.MatrixHeight, tileWidth: matrix.TileWidth, tileHeight: matrix.TileHeight, origin: matrix.TopLeftCorner, scaleDenominator: matrix.ScaleDenominator }))
    return [{ link, crs: matrixSet.SupportedCRS ?? '', matrices, limited }]
  })
  const quads = links.flatMap(({ link, crs, matrices, limited }) => {
    const grid = quadGrid(crs, matrices)
    if (typeof grid === 'string') { reasons.push(`${link.TileMatrixSet}: ${grid}`); return [] }
    const levels = [...limited].map((id) => Number(id.slice(grid.prefix.length))).filter(Number.isInteger)
    return [{ ...grid, matrixSet: link.TileMatrixSet, ...(levels.length ? { minLevel: Math.min(...levels), maxLevel: Math.max(...levels) } : {}) }]
  })
  const box = layer.WGS84BoundingBox
  const bounds = box ? lonLatBounds(box.slice(0, 2), box.slice(2, 4), 'CRS84') : undefined
  const grid = preferred.map((quad) => quads.find((candidate) => candidate.quad === quad)).find(Boolean)
  if (grid) {
    const url = tileTemplate(capabilities, layer, grid.matrixSet)
    return { ...grid, kind: 'quad', bounds, tileUrl: (level, col, row) => url(`${grid.prefix}${level}`, col, row) }
  }
  for (const { link, crs, matrices, limited } of links) {
    const plateCarree = plateCarreeMatrices(crs, matrices)
    if (typeof plateCarree === 'string') continue
    const usable = plateCarree.filter((matrix) => !limited.size || limited.has(matrix.id))
    if (usable.length) return { kind: 'plate-carree', matrixSet: link.TileMatrixSet, matrices: usable, bounds, matrixUrl: tileTemplate(capabilities, layer, link.TileMatrixSet) }
  }
  throw new Error(`${layer.Title ?? layer.Identifier} advertises no ${preferred.join(' or ')} or EPSG:4326 tile matrix set.${reasons.length ? ` ${reasons.join(' ')}` : ''}`)
}

export type RasterPlan = { raster: ActiveRaster; tiles: WmtsTiles; reprojected: boolean }

// Our WMTS rasters are WorldCRS84Quad: native on a WorldCRS84Quad map, reprojected on a Web Mercator one. A plate
// carrée raster is resampled, which a WorldCRS84Quad map does without reprojecting.
export function planRaster(raster: ActiveRaster, worldCrs: WorldCrs): RasterPlan {
  const preferred: WorldCrs[] = worldCrs === 'WorldCRS84Quad' ? ['WorldCRS84Quad'] : ['WebMercatorQuad', 'WorldCRS84Quad']
  const tiles = resolveWmtsTiles(raster.capabilities, raster.wmtsLayerId, preferred)
  return { raster, tiles, reprojected: (tiles.kind === 'quad' ? tiles.quad : 'WorldCRS84Quad') !== worldCrs }
}
