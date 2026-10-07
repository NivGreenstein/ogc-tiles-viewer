import type { WorldCrs } from './types'

export const quadLabel: Record<WorldCrs, string> = { WorldCRS84Quad: 'WorldCRS84Quad · EPSG:4326', WebMercatorQuad: 'WebMercatorQuad · EPSG:3857' }
export type Bounds = [west: number, south: number, east: number, north: number]
// The grid a MapLibre source can address: tile matrix level L is `${prefix}${L}` in the service's own identifiers.
export type QuadGrid = { quad: WorldCrs; prefix: string; minLevel: number; maxLevel: number; tileSize: number }
type GridMatrix = { id: string; matrixWidth: number; matrixHeight: number; tileWidth: number; tileHeight: number; origin: number[]; scaleDenominator: number; cellSize?: number }

const mercatorEdge = 20037508.342789244
// OGC scale denominators assume 0.28 mm pixels; a degree is converted at the WGS 84 equator.
export const metersPerDegree = 2 * Math.PI * 6378137 / 360
const mercatorCodes = ['3857', '900913', '3785', '102100', '102113']
const epsgCode = (crs: string) => crs.match(/EPSG.*?[:/](\d+)$/i)?.[1] ?? crs.match(/^\d+$/)?.[0]
const near = (value: number, target: number, tolerance: number) => Math.abs(Math.abs(value) - target) <= tolerance

export function crsQuad(crs: string | undefined): WorldCrs | null {
  if (!crs) return null
  if (/CRS:?84$/i.test(crs) || epsgCode(crs) === '4326') return 'WorldCRS84Quad'
  return mercatorCodes.includes(epsgCode(crs) ?? '') ? 'WebMercatorQuad' : null
}

// Recognises a tile matrix set as WorldCRS84Quad or WebMercatorQuad from its CRS and matrix shapes rather than its
// identifier, since services publish the same grid under many names. Returns the reason when it is neither.
export function quadGrid(crs: string, matrices: GridMatrix[]): QuadGrid | string {
  const quad = crsQuad(crs)
  if (!quad) return `${crs || 'An unspecified CRS'} is neither EPSG:4326 nor EPSG:3857.`
  if (!matrices.length) return 'The tile matrix set lists no tile matrices.'
  const tileSize = matrices[0].tileWidth
  const levels: number[] = []
  let prefix: string | undefined
  for (const matrix of matrices) {
    const level = Math.log2(quad === 'WorldCRS84Quad' ? matrix.matrixHeight : matrix.matrixWidth)
    const columnsPerRow = quad === 'WorldCRS84Quad' ? 2 : 1
    if (!Number.isInteger(level) || matrix.matrixWidth !== matrix.matrixHeight * columnsPerRow) return `Tile matrix ${matrix.id} is ${matrix.matrixWidth}x${matrix.matrixHeight}, which is not a ${quad} level.`
    if (matrix.tileWidth !== tileSize || matrix.tileHeight !== tileSize) return 'Tile matrices use differing or non-square tile sizes.'
    const [x = NaN, y = NaN] = matrix.origin
    const originOk = quad === 'WorldCRS84Quad' ? (near(x, 180, 1e-6) && near(y, 90, 1e-6)) || (near(x, 90, 1e-6) && near(y, 180, 1e-6)) : near(x, mercatorEdge, 1) && near(y, mercatorEdge, 1)
    if (!originOk) return `Tile matrix ${matrix.id} has its origin at ${matrix.origin.join(', ')}, not the corner of the ${quad} world.`
    // A matrix of the right shape can still span more than the world, as NASA GIBS' 512 px EPSG:4326 tiles do.
    const pixelSize = matrix.cellSize || matrix.scaleDenominator * 0.00028 / (quad === 'WorldCRS84Quad' ? metersPerDegree : 1)
    const expected = (quad === 'WorldCRS84Quad' ? 180 : 2 * mercatorEdge) / tileSize / 2 ** level
    if (!(Math.abs(pixelSize / expected - 1) < 0.01)) return `Tile matrix ${matrix.id} tiles span ${(pixelSize * tileSize).toPrecision(4)} ${quad === 'WorldCRS84Quad' ? 'degrees' : 'metres'}, not the ${(expected * tileSize).toPrecision(4)} of ${quad} level ${level}.`
    if (!matrix.id.endsWith(String(level))) return `Tile matrix ${matrix.id} is level ${level}, so its identifier cannot be derived from the level.`
    const matrixPrefix = matrix.id.slice(0, matrix.id.length - String(level).length)
    if (prefix !== undefined && matrixPrefix !== prefix) return 'Tile matrix identifiers do not follow one naming pattern.'
    prefix = matrixPrefix
    levels.push(level)
  }
  return { quad, prefix: prefix ?? '', minLevel: Math.min(...levels), maxLevel: Math.max(...levels), tileSize }
}

const clampBounds = ([west, south, east, north]: Bounds): Bounds => [Math.max(-180, west), Math.max(-90, south), Math.min(180, east), Math.min(90, north)]

// Converts an advertised bounding box into longitude/latitude. EPSG:4326 is latitude-first by definition, but a box
// whose first ordinate exceeds 90 degrees can only be longitude-first, as many services publish it.
export function lonLatBounds(lowerLeft: number[], upperRight: number[], crs: string | undefined): Bounds | undefined {
  if (lowerLeft.length < 2 || upperRight.length < 2) return undefined
  const quad = crsQuad(crs)
  if (quad === 'WebMercatorQuad') {
    const toLonLat = ([x, y]: number[]) => [x / mercatorEdge * 180, Math.atan(Math.sinh(y / mercatorEdge * Math.PI)) * 180 / Math.PI]
    const [west, south] = toLonLat(lowerLeft)
    const [east, north] = toLonLat(upperRight)
    return clampBounds([west, south, east, north])
  }
  if (quad !== 'WorldCRS84Quad') return undefined
  const latitudeFirst = epsgCode(crs ?? '') === '4326' && Math.abs(lowerLeft[0]) <= 90 && Math.abs(upperRight[0]) <= 90
  return clampBounds(latitudeFirst ? [lowerLeft[1], lowerLeft[0], upperRight[1], upperRight[0]] : [lowerLeft[0], lowerLeft[1], upperRight[0], upperRight[1]])
}

// A plate carrée tile matrix: EPSG:4326 pixels of `pixelSize` degrees counted from (-180, 90). NASA GIBS publishes
// such sets whose tiles do not divide the world by powers of two, so they are resampled rather than addressed.
export type PlateCarreeMatrix = { id: string; pixelSize: number; tileSize: number; matrixWidth: number; matrixHeight: number }

export function plateCarreeMatrices(crs: string, matrices: GridMatrix[]): PlateCarreeMatrix[] | string {
  if (crsQuad(crs) !== 'WorldCRS84Quad') return `${crs || 'An unspecified CRS'} is not EPSG:4326.`
  if (!matrices.length) return 'The tile matrix set lists no tile matrices.'
  const result: PlateCarreeMatrix[] = []
  for (const matrix of matrices) {
    const [x = NaN, y = NaN] = matrix.origin
    // EPSG:4326 corners may be written latitude-first.
    if (!((near(x, 180, 1e-6) && x < 0 && near(y, 90, 1e-6) && y > 0) || (near(x, 90, 1e-6) && x > 0 && near(y, 180, 1e-6) && y < 0))) return `Tile matrix ${matrix.id} does not start at the north-west corner of the world.`
    if (matrix.tileWidth !== matrix.tileHeight) return `Tile matrix ${matrix.id} has non-square tiles.`
    result.push({ id: matrix.id, pixelSize: matrix.cellSize || matrix.scaleDenominator * 0.00028 / metersPerDegree, tileSize: matrix.tileWidth, matrixWidth: matrix.matrixWidth, matrixHeight: matrix.matrixHeight })
  }
  return result
}
