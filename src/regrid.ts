import type { AddProtocolAction } from '@nivgreen/maplibre-gl-js-crs84'
import type { PlateCarreeTiles } from './wmts'
import { apiKeyHeaders } from './wmts'
import type { WorldCrs } from './types'

// Draws plate carrée WMTS tiles that do not line up with the map's tile grid, such as NASA GIBS' 512 px EPSG:4326
// tiles, by cropping and scaling the source tiles covering each map tile. On a WorldCRS84Quad map both grids are
// plate carrée, so one scaled copy is exact; on a Web Mercator map the tile is resampled one pixel row at a time.
export const regridProtocol = 'regrid'
const tileSize = 256
type Entry = { tiles: PlateCarreeTiles; apiKey: string; worldCrs: WorldCrs }
const sources = new Map<string, Entry>()
const images = new Map<string, Promise<ImageBitmap | null>>()

export function registerRegrid(key: string, entry: Entry) {
  sources.set(key, entry)
  return `${regridProtocol}://${encodeURIComponent(key)}/{bbox-epsg-4326}`
}

// The zoom past which the finest source matrix has no more detail: tile matrix levels on a WorldCRS84Quad map,
// Web Mercator zooms otherwise, as the MapLibre fork reads a source's maxzoom.
export function regridMaxZoom(tiles: PlateCarreeTiles, worldCrs: WorldCrs) {
  const finest = Math.min(...tiles.matrices.map((matrix) => matrix.pixelSize))
  return Math.max(0, Math.ceil(Math.log2((worldCrs === 'WorldCRS84Quad' ? 180 : 360) / tileSize / finest)))
}

function loadImage(url: string, apiKey: string) {
  let image = images.get(url)
  if (!image) {
    // A tile outside the service's coverage fails or is empty; the rest of the map tile is still drawn. The request is
    // shared by every map tile that needs it, so one map tile being cancelled does not abort it.
    image = fetch(url, { headers: apiKeyHeaders(apiKey) }).then(async (response) => (response.ok ? createImageBitmap(await response.blob()) : null)).catch(() => null)
    images.set(url, image)
    // Neighbouring map tiles share source tiles, so recent ones are kept.
    if (images.size > 96) images.delete(images.keys().next().value!)
  }
  return image
}

const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))
const latitudeOf = (y: number) => (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * 180 / Math.PI

export const regridLoader: AddProtocolAction = async ({ url }, abortController) => {
  const [key, bbox] = url.slice(regridProtocol.length + 3).split('/')
  const entry = sources.get(decodeURIComponent(key))
  if (!entry) throw new Error('This raster is no longer on the map.')
  const [west, south, east, north] = bbox.split(',').map(Number)
  const destinationPixel = (east - west) / tileSize
  // The coarsest matrix at least as detailed as the map tile, or the finest there is.
  const byDetail = [...entry.tiles.matrices].sort((a, b) => b.pixelSize - a.pixelSize)
  const matrix = byDetail.find((candidate) => candidate.pixelSize <= destinationPixel * 1.001) ?? byDetail[byDetail.length - 1]
  const span = matrix.pixelSize * matrix.tileSize
  const clampColumn = (value: number) => Math.min(matrix.matrixWidth - 1, Math.max(0, value))
  const clampRow = (value: number) => Math.min(matrix.matrixHeight - 1, Math.max(0, value))
  const firstColumn = clampColumn(Math.floor((west + 180) / span))
  const lastColumn = clampColumn(Math.ceil((east + 180) / span) - 1)
  const firstRow = clampRow(Math.floor((90 - north) / span))
  const lastRow = clampRow(Math.ceil((90 - south) / span) - 1)
  const requests: Promise<void>[] = []
  const mosaic = document.createElement('canvas')
  mosaic.width = (lastColumn - firstColumn + 1) * matrix.tileSize
  mosaic.height = (lastRow - firstRow + 1) * matrix.tileSize
  const mosaicContext = mosaic.getContext('2d')!
  for (let row = firstRow; row <= lastRow; row++) for (let column = firstColumn; column <= lastColumn; column++) {
    requests.push(loadImage(entry.tiles.matrixUrl(matrix.id, String(column), String(row)), entry.apiKey).then((image) => {
      if (image) mosaicContext.drawImage(image, (column - firstColumn) * matrix.tileSize, (row - firstRow) * matrix.tileSize, matrix.tileSize, matrix.tileSize)
    }))
  }
  await Promise.all(requests)
  if (abortController.signal.aborted) return { data: null }
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = tileSize
  const context = canvas.getContext('2d')!
  const sourceX = (west + 180) / matrix.pixelSize - firstColumn * matrix.tileSize
  const sourceY = (latitude: number) => (90 - latitude) / matrix.pixelSize - firstRow * matrix.tileSize
  const mercator = entry.worldCrs === 'WebMercatorQuad'
  const strips = mercator ? tileSize : 1
  const top = mercatorY(north)
  const bottom = mercatorY(south)
  for (let strip = 0; strip < strips; strip++) {
    const upper = mercator ? latitudeOf(top - (top - bottom) * strip / strips) : north
    const lower = mercator ? latitudeOf(top - (top - bottom) * (strip + 1) / strips) : south
    context.drawImage(mosaic, sourceX, sourceY(upper), (east - west) / matrix.pixelSize, (upper - lower) / matrix.pixelSize, 0, strip * tileSize / strips, tileSize, tileSize / strips)
  }
  return { data: await createImageBitmap(canvas) }
}
