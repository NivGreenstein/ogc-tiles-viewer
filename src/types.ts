import type { WorldCRSName } from '@nivgreen/maplibre-gl-js-crs84'
import type { QuadGrid } from './crs'

export type Link = { href: string; rel?: string; type?: string; title?: string; templated?: boolean }
export type Tileset = { id: string; title: string; description?: string; dataType?: string; crs?: string; tileMatrixSetId?: string; boundingBox?: { lowerLeft: number[]; upperRight: number[]; crs?: string }; links: Link[] }
export type TileMatrix = { id: string; scaleDenominator: number; cellSize?: number; pointOfOrigin: number[]; tileWidth: number; tileHeight: number; matrixWidth: number; matrixHeight: number }
export type MatrixSet = { id: string; title?: string; crs: string; tileMatrices: TileMatrix[] }
export type Diagnostic = { at: string; url: string; status: string; detail: string }
// The two tile matrix sets the MapLibre fork can work in.
export type WorldCrs = WorldCRSName
export type ActiveLayer = { key: string; tileset: Tileset; matrixSet: MatrixSet; tileUrl: string; grid: QuadGrid | string }
export type Choice = { tileUrl: string; matrixUrl: string }
export type StyleDocument = Record<string, unknown>
export type AppliedStyle = { document: StyleDocument; source: string; styleUrl?: string; layerCount: number; sourceLayers: string[] }
// A parsed WMTS GetCapabilities document, as ol/format/WMTSCapabilities reads it.
export type Capabilities = Record<string, unknown>
export type RasterEntry = { id: string; title: string; capabilitiesUrl: string; wmtsLayerId: string; matrixSets: string[] }
export type ActiveRaster = { key: string; title: string; capabilities: Capabilities; wmtsLayerId: string; apiKey: string }
export type Engine = 'maplibre' | 'openlayers'
export type ReportError = (diagnostic: Omit<Diagnostic, 'at'>, message?: string) => void
