import { register } from 'ol/proj/proj4'
import { get as getProjection } from 'ol/proj'
import proj4 from 'proj4'
import type { AppliedStyle, Diagnostic, Link, MatrixSet, Tileset } from './types'

export const absolute = (href: string, base: string) => new URL(href, base).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
export const byRel = (links: Link[], rels: string[]) => links.find((link) => rels.includes(link.rel ?? ''))
const title = (value: Record<string, unknown>, fallback: string) => String(value.title ?? value.id ?? value.name ?? fallback)

function withTileFormat(template: string, format: string) {
  const url = new URL(template)
  url.searchParams.set('f', format)
  return url.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')
}

// A MapLibre document can declare several sources, but one OGC tileset backs one vector tile layer,
// so the style layers of a single source are applied and the advertised tile template is kept.
export function chooseStyleSource(styleDocument: Record<string, unknown>): Omit<AppliedStyle, 'document' | 'styleUrl'> {
  const sources = (styleDocument.sources as Record<string, Record<string, unknown>> | undefined) ?? {}
  const styleLayers = (styleDocument.layers as Record<string, unknown>[] | undefined) ?? []
  const ids = Object.keys(sources)
  if (!ids.length) throw new Error('This document declares no sources, so it is not a MapLibre style.')
  const vectorIds = ids.filter((id) => (sources[id]?.type ?? 'vector') === 'vector')
  const ranked = (vectorIds.length ? vectorIds : ids)
    .map((id) => ({ id, drawn: styleLayers.filter((styleLayer) => styleLayer.source === id) }))
    .sort((a, b) => b.drawn.length - a.drawn.length)
  const [best] = ranked
  if (!best.drawn.length) throw new Error(`No style layer draws from \u201C${best.id}\u201D, so this style would render nothing.`)
  const sourceLayers = [...new Set(best.drawn.map((styleLayer) => String(styleLayer['source-layer'] ?? '')).filter(Boolean))]
  return { source: best.id, layerCount: best.drawn.length, sourceLayers }
}

export async function getJson(url: string, diagnostics: Diagnostic[]) {
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

export async function discover(endpoint: string, diagnostics: Diagnostic[]) {
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

export async function loadMatrixSet(tileset: Tileset, matrixUrl: string | undefined, diagnostics: Diagnostic[]) {
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
  // Tile Matrix Set 2.0 allows the CRS as an object carrying its URI.
  const rawCrs = raw.crs && typeof raw.crs === 'object' ? (raw.crs as { uri?: unknown }).uri : raw.crs
  const matrices = (raw.tileMatrices as Record<string, unknown>[] | undefined) ?? []
  return {
    id: String(raw.id ?? link.title ?? 'Tile matrix set'), title: typeof raw.title === 'string' ? raw.title : link.title,
    crs: String(rawCrs ?? inheritedCrs ?? ''),
    tileMatrices: matrices.map((m) => ({ id: String(m.id), scaleDenominator: Number(m.scaleDenominator), cellSize: Number(m.cellSize), pointOfOrigin: m.pointOfOrigin as number[], tileWidth: Number(m.tileWidth), tileHeight: Number(m.tileHeight), matrixWidth: Number(m.matrixWidth), matrixHeight: Number(m.matrixHeight) })),
  } satisfies MatrixSet
}

export async function ensureProjection(crs: string, diagnostics: Diagnostic[]) {
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
