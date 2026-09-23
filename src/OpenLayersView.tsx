import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Map from 'ol/Map'
import View from 'ol/View'
import VectorTileLayer from 'ol/layer/VectorTile'
import TileLayer from 'ol/layer/Tile'
import VectorTileSource from 'ol/source/VectorTile'
import TileDebug from 'ol/source/TileDebug'
import WMTS, { optionsFromCapabilities } from 'ol/source/WMTS'
import MVT from 'ol/format/MVT'
import Style from 'ol/style/Style'
import Fill from 'ol/style/Fill'
import Stroke from 'ol/style/Stroke'
import CircleStyle from 'ol/style/Circle'
import TileGrid from 'ol/tilegrid/TileGrid'
import Overlay from 'ol/Overlay'
import TileState from 'ol/TileState'
import type ImageTile from 'ol/ImageTile'
import { defaults as defaultControls, ScaleLine } from 'ol/control'
import { get as getProjection } from 'ol/proj'
import { applyStyle } from 'ol-mapbox-style'
import 'ol/ol.css'
import { FeaturePopup } from './FeaturePopup'
import type { Hit } from './FeaturePopup'
import { apiKeyHeaders, findLayer } from './wmts'
import type { ActiveLayer, ActiveRaster, AppliedStyle, ReportError } from './types'

type GlStyle = Parameters<typeof applyStyle>[1]
type Props = { layers: ActiveLayer[]; rasters: ActiveRaster[]; appliedStyle: AppliedStyle | null; showTileDebug: boolean; hueFor: (key: string) => number; onError: ReportError }

function wmtsSource(raster: ActiveRaster, projection: string | undefined) {
  const layer = findLayer(raster.capabilities, raster.wmtsLayerId)
  if (!layer) throw new Error(`Layer ${raster.wmtsLayerId} is not in the WMTS capabilities.`)
  // Prefer a matrix set in the map's projection; OpenLayers reprojects any other one.
  const options = (projection && optionsFromCapabilities(raster.capabilities, { layer: layer.Identifier, projection })) || optionsFromCapabilities(raster.capabilities, { layer: layer.Identifier })
  if (!options) throw new Error(`OpenLayers could not build WMTS options for ${raster.title}.`)
  return new WMTS({
    ...options, crossOrigin: 'anonymous', wrapX: true,
    ...(raster.apiKey ? {
      tileLoadFunction: (tile, src) => {
        const image = (tile as ImageTile).getImage() as HTMLImageElement
        fetch(src, { headers: apiKeyHeaders(raster.apiKey) }).then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.blob()
        }).then((blob) => {
          const objectUrl = URL.createObjectURL(blob)
          image.onload = () => URL.revokeObjectURL(objectUrl)
          image.src = objectUrl
        }).catch(() => tile.setState(TileState.ERROR))
      },
    } : {}),
  })
}

export function OpenLayersView({ layers, rasters, appliedStyle, showTileDebug, hueFor, onError }: Props) {
  const mapElement = useRef<HTMLDivElement>(null)
  const mapRef = useRef<Map | null>(null)
  const viewKeyRef = useRef('')
  const onErrorRef = useRef(onError)
  const [popupElement] = useState(() => document.createElement('div'))
  const [hits, setHits] = useState<{ click: number; hits: Hit[] }>({ click: 0, hits: [] })
  const [crs, setCrs] = useState('')
  onErrorRef.current = onError

  useEffect(() => {
    const map = new Map({ target: mapElement.current!, controls: defaultControls().extend([new ScaleLine({ units: 'metric' })]), view: new View({ center: [0, 0], zoom: 2 }) })
    mapRef.current = map
    const overlay = new Overlay({ element: popupElement, autoPan: { animation: { duration: 150 } } })
    map.addOverlay(overlay)
    let click = 0
    map.on('singleclick', (event) => {
      const found: Hit[] = []
      map.forEachFeatureAtPixel(event.pixel, (feature) => { found.push({ properties: feature.getProperties() }); return undefined })
      setHits({ click: ++click, hits: found }); overlay.setPosition(found.length ? event.coordinate : undefined)
    })
    return () => { map.setTarget(undefined); mapRef.current = null; viewKeyRef.current = '' }
  }, [popupElement])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    map.getLayers().clear()
    // The first vector layer's matrix set decides the projection; with rasters alone, the first raster's does.
    let rasterProjection: string | undefined
    const rasterLayers = rasters.flatMap((raster) => {
      try {
        const source = wmtsSource(raster, layers[0]?.matrixSet.crs ?? rasterProjection)
        rasterProjection ??= source.getProjection()?.getCode()
        return [new TileLayer({ source })]
      } catch (error) {
        onErrorRef.current({ url: raster.title, status: 'Raster could not be drawn', detail: error instanceof Error ? error.message : String(error) })
        return []
      }
    })
    const crsCode = layers[0]?.matrixSet.crs ?? rasterProjection
    setCrs(crsCode ?? '')
    const projection = crsCode ? getProjection(crsCode) : null
    if (!projection) return
    let stale = false
    const box = layers[0]?.tileset.boundingBox
    const viewKey = `${crsCode}|${[...layers, ...rasters].map((layer) => layer.key).join(',')}`
    if (viewKeyRef.current !== viewKey) {
      viewKeyRef.current = viewKey
      map.setView(new View({ projection, center: box?.lowerLeft ?? [0, 0], zoom: layers.length ? 0 : 2 }))
      if (box?.lowerLeft.length === 2 && box.upperRight.length === 2 && (!box.crs || box.crs === crsCode)) map.getView().fit([...box.lowerLeft, ...box.upperRight], { padding: [50, 50, 50, 330], duration: 300 })
    }
    rasterLayers.forEach((layer) => map.addLayer(layer))
    for (const layer of layers) {
      const matrices = layer.matrixSet.tileMatrices
      const meters = projection.getMetersPerUnit() ?? 1
      const grid = new TileGrid({ extent: layer.tileset.boundingBox && (!layer.tileset.boundingBox.crs || layer.tileset.boundingBox.crs === layer.matrixSet.crs) ? [...layer.tileset.boundingBox.lowerLeft, ...layer.tileset.boundingBox.upperRight] : undefined, origins: matrices.map((m) => m.pointOfOrigin), resolutions: matrices.map((m) => m.cellSize || m.scaleDenominator * 0.00028 / meters), tileSizes: matrices.map((m) => [m.tileWidth, m.tileHeight]) })
      const source = new VectorTileSource({ format: new MVT(), projection, tileGrid: grid, tileUrlFunction: ([z, x, y]) => layer.tileUrl.replace(/\{tileMatrix\}/gi, matrices[z].id).replace(/\{tileCol\}/gi, String(x)).replace(/\{tileRow\}/gi, String(y)) })
      const tileUrlFunction = source.getTileUrlFunction()
      const vectorLayer = new VectorTileLayer({ source, declutter: Boolean(appliedStyle) })
      const hue = hueFor(layer.key)
      vectorLayer.setStyle((feature) => {
        const geometry = feature.getGeometry()?.getType()
        const color = `hsl(${hue}, 68%, 54%)`
        if (geometry?.includes('Point')) return new Style({ image: new CircleStyle({ radius: 5, fill: new Fill({ color }), stroke: new Stroke({ color: '#1a1e1b', width: 1 }) }) })
        if (geometry?.includes('Line')) return new Style({ stroke: new Stroke({ color, width: 2 }) })
        return new Style({ fill: new Fill({ color: `hsla(${hue}, 68%, 54%, .55)` }), stroke: new Stroke({ color, width: 1 }) })
      })
      if (appliedStyle) {
        const options = { source: appliedStyle.source, updateSource: false, ...(appliedStyle.styleUrl ? { styleUrl: appliedStyle.styleUrl } : {}) }
        void applyStyle(vectorLayer, appliedStyle.document as GlStyle, options).then(() => {
          if (stale) return
          // The advertised OGC template stays authoritative, so a MapLibre source definition never replaces it.
          if (vectorLayer.getSource() !== source) vectorLayer.setSource(source)
          if (source.getTileUrlFunction() !== tileUrlFunction) source.setTileUrlFunction(tileUrlFunction)
        }).catch((error: unknown) => {
          if (stale) return
          const detail = error instanceof Error ? error.message : String(error)
          onErrorRef.current({ url: appliedStyle.styleUrl ?? 'pasted style document', status: 'Style could not be applied', detail }, `Could not apply the style to ${layer.tileset.title}: ${detail}`)
        })
      }
      map.addLayer(vectorLayer)
    }
    if (showTileDebug && layers.length) {
      const matrices = layers[0].matrixSet.tileMatrices
      const meters = projection.getMetersPerUnit() ?? 1
      const grid = new TileGrid({ origins: matrices.map((matrix) => matrix.pointOfOrigin), resolutions: matrices.map((matrix) => matrix.cellSize || matrix.scaleDenominator * 0.00028 / meters), tileSizes: matrices.map((matrix) => [matrix.tileWidth, matrix.tileHeight]) })
      map.addLayer(new TileLayer({ source: new TileDebug({ projection, tileGrid: grid }) }))
    } else if (showTileDebug) {
      const grid = rasterLayers[0]?.getSource()?.getTileGrid()
      if (grid) map.addLayer(new TileLayer({ source: new TileDebug({ projection, tileGrid: grid }) }))
    }
    return () => { stale = true }
  }, [layers, rasters, appliedStyle, showTileDebug, hueFor])

  return <>
    <div ref={mapElement} className={appliedStyle ? 'map styled' : 'map'} />
    <div className="map-caption">{crs || 'NO ACTIVE CRS'}</div>
    {createPortal(<FeaturePopup key={hits.click} hits={hits.hits} />, popupElement)}
  </>
}
