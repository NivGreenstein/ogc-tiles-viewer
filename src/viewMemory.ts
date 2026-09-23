// The last map view, in longitude/latitude and a MapLibre zoom, so a map rebuilt for another world CRS or engine
// opens where the previous one was instead of resetting.
export type RememberedView = { center: [number, number]; zoom: number }

export const viewMemory: { current: RememberedView | null } = { current: null }

// Both world CRSs span the equator in 512 px at zoom 0, so an equatorial pixel size maps to one zoom in either.
const equatorMeters = 2 * Math.PI * 6378137
export const zoomFromMetersPerPixel = (metersPerPixel: number) => Math.log2(equatorMeters / 512 / metersPerPixel)
export const metersPerPixelFromZoom = (zoom: number) => equatorMeters / 512 / 2 ** zoom
