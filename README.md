# OGC API Tiles Vector Workbench

A desktop-first, browser-only viewer for discovering and inspecting vector tiles exposed through [OGC API - Tiles](https://ogcapi.ogc.org/tiles/), and raster tiles exposed through WMTS or a MapColonies CSW catalog. It is a lightweight online GIS workspace built with React and Vite.

The map is drawn by [`@nivgreen/maplibre-gl-js-crs84`](https://www.npmjs.com/package/@nivgreen/maplibre-gl-js-crs84), a MapLibre GL JS fork that works in the OGC `WorldCRS84Quad` tile matrix set (EPSG:4326) by default, so EPSG:4326 tiles are requested and drawn with no reprojection. OpenLayers remains available as an alternative engine for tilesets in any other CRS.

The viewer does not need a backend or proxy. It follows links advertised by an OGC API landing page, WMTS capabilities document, or CSW catalog and makes requests directly from the browser, so the target services must allow CORS.

## Features

- Draw with MapLibre in `WorldCRS84Quad` (EPSG:4326) by default, or switch the map to `WebMercatorQuad` (EPSG:3857).
- Switch to OpenLayers to draw a tileset in any CRS and tile matrix set.
- Load WMTS raster layers from a WMTS GetCapabilities URL, or from a MapColonies CSW raster catalog.
- Reproject EPSG:4326 WMTS rasters to Web Mercator in the browser with [`@nivgreen/maplibre-gl-raster-reprojection`](https://www.npmjs.com/package/@nivgreen/maplibre-gl-raster-reprojection).
- Discover vector tilesets from an OGC API landing page.
- Follow advertised `data`, collections, and `tilesets-vector` links without guessing endpoint paths.
- Group discovered layers by advertised tile matrix set, with collapsible catalog sections.
- Select an advertised tile representation, including MVT, PBF, or another advertised media type.
- Render vector tiles using their advertised tile matrix set, origin, resolutions, tile size, and CRS.
- Never assume Web Mercator. Missing EPSG definitions are requested from `epsg.io` and registered with `proj4`.
- Prompt before switching to a tileset with a different map CRS; accepting clears incompatible active layers.
- Inspect all vector features hit by a map click and view their raw properties.
- Show metadata, request diagnostics, scale, CRS, and a tile debug grid.
- Apply a MapLibre style, pasted or fetched from a URL, without replacing the discovered OGC source.
- Use a generated geometry-aware style when no style is supplied.

## Run Locally

Requirements: Node.js 20 or later and npm.

```bash
npm install
npm run dev
```

Open the address printed by Vite, normally `http://localhost:5173`.

To produce a production build:

```bash
npm run build
npm run preview
```

Run linting with:

```bash
npm run lint
```

## Connect An API

1. Paste an OGC API landing-page URL into **API LANDING PAGE**.
2. Select **DISCOVER**.
3. Open a tile matrix set group in the catalog.
4. Choose an advertised representation if more than one is available.
5. Select `+` to add the tileset to the map.

For the local Tegola service used during development, use:

```text
http://localhost:8081
```

Its discovery path is followed as advertised:

```text
landing page -> data link -> collections -> tilesets-vector -> tileset
```

The viewer deliberately does not infer a `/tiles` route from a landing page.

## Map Engines

The **MAP** section selects the engine. The choice is kept in the `engine` query parameter when it is not the default.

**MAPLIBRE** is the default. It works in one of the two tile matrix sets the MapLibre fork supports, chosen under the engine:

- **WorldCRS84Quad · EPSG:4326**, the default. Tiles are requested in EPSG:4326 and drawn in plate carrée with no reprojection.
- **WebMercatorQuad · EPSG:3857**. Kept in the `crs` query parameter.

The fork's world CRS is a process-wide setting, so changing it recreates the map. A vector tileset is drawn natively when its tile matrix set is one of those two grids, recognised from its CRS, the shape of each tile matrix, and its origin rather than from its identifier. The tile matrix identifiers must be the level number, optionally behind a fixed prefix such as `EPSG:4326:`. Adding a tileset in the other grid asks before switching the map and removing the layers the new grid cannot draw. A tileset in any other grid is refused with a hint to switch engines.

MapLibre only draws a vector `source-layer` that a style layer names. Every OGC vector tile is fetched through a custom protocol that reads the layer names inside it, so the generated style grows as tiles arrive.

**OPENLAYERS** follows the first layer's advertised CRS and tile matrix set for any EPSG code, as described under [CRS Behavior](#crs-behavior). Switching back to MapLibre keeps the layers it can draw and asks before removing the rest.

## Raster (WMTS And CSW)

The **RASTER** section loads raster layers from either source:

- **WMTS CAPABILITIES**: a WMTS GetCapabilities URL. Every layer in the document is listed. Kept in the `wmts` query parameter.
- **MAPCOLONIES CSW**: a MapColonies raster catalog CSW endpoint. The viewer posts a `GetRecords` request for `mc:MCRasterRecord` records of type `RECORD_RASTER`, following `nextRecord` to page through the catalog. Each record's `WMTS` link (or `WMTS_KVP`) names the capabilities URL and, in its `name` attribute, the WMTS layer. The capabilities are loaded when the layer is added. Kept in the `csw` query parameter.

An optional API key is sent as the `x-api-key` header on CSW, capabilities, and tile requests. It is held in memory only and is never written to the URL or local storage.

A layer's tile URL comes from its RESTful `ResourceURL` template, or from the KVP `GetTile` endpoint when there is none, with the default style and dimension values filled in. `TileMatrixSetLimits` and `WGS84BoundingBox` limit the levels and area requested.

Our WMTS raster provider serves EPSG:4326 `WorldCRS84Quad` tiles only:

- On a **WorldCRS84Quad** map the tiles are drawn natively.
- On a **WebMercatorQuad** map a layer's EPSG:3857 matrix set is used when it has one. Otherwise its EPSG:4326 tiles are reprojected in the browser by [`@nivgreen/maplibre-gl-raster-reprojection`](https://github.com/NivGreenstein/maplibre-gl-raster-reprojection), which requests the level below each mercator tile. The plugin fetches source tiles itself and does not send the `x-api-key` header, so a raster behind an API-key header draws only on a WorldCRS84Quad map.
- A raster with only an EPSG:3857 matrix set cannot be drawn on a WorldCRS84Quad map, so adding one asks before switching the map to WebMercatorQuad.
- A matrix set is only drawn by MapLibre when its tile sizes and scale denominators match the standard grid, not just its CRS and matrix counts. NASA GIBS' EPSG:4326 sets, for example, use 512 px tiles that span 288 degrees at level 0, so MapLibre refuses them and OpenLayers draws them.

OpenLayers draws WMTS rasters with `ol/source/WMTS`, preferring a matrix set in the map's projection and otherwise reprojecting.

## Tile Matrix Debugging

**SHOW Z/X/Y TILE GRID** is enabled by default. With MapLibre it draws each loaded tile's boundary, labelled `level/column/row` with the tile matrix level the tile was requested with. With OpenLayers it renders the tile-debug overlay above the vector layers using the active layer's advertised matrix grid. Use it to compare browser tile coordinates with the OGC URL template substitutions:

```text
{tileMatrix} / {tileRow} / {tileCol}
```

The overlay uses OpenLayers tile-coordinate notation: `z/x/y`, where `z` is the matrix level, `x` is tile column, and `y` is tile row.

## CRS Behavior

This section describes the OpenLayers engine; see [Map Engines](#map-engines) for MapLibre. The first active layer establishes the map projection. When adding a layer with a different advertised CRS, the viewer asks for confirmation before clearing active layers and switching projection.

For an EPSG code that OpenLayers does not include, the viewer fetches its Proj4 definition from `https://epsg.io/<code>.proj4`. The browser must be able to reach that service.

## Styles

The **STYLE** field accepts a MapLibre style URL or a pasted MapLibre style document. Selecting **APPLY** draws every active vector layer with that style: MapLibre draws the style layers directly, and OpenLayers draws them through `ol-mapbox-style`. With MapLibre, the style's `background` layers, `glyphs`, and `sprite` are used too; text layers are skipped when the style has no `glyphs`.

Only the style layers of a single source are applied, because one OGC tileset backs one vector tile source. The source that the most style layers draw from is chosen, and its id is reported next to the **STYLE** heading. The `source-layer` names it references must match the layer names inside the vector tiles; when they do not, the style draws nothing, so the referenced source-layers are listed in the message area to make a mismatch visible.

While a style is applied the map backdrop turns white, because MapLibre styles are written for a light background. The generated style keeps the dark workspace backdrop.

The OGC API Tiles source and its native grid stay authoritative. MapLibre `sources` definitions are never applied, so the advertised tile template, tile matrix set, and CRS are preserved.

Empty the field and select **APPLY** to return to the generated style. It colors features by geometry type, using a hue derived from the layer key so a layer keeps the same color across re-renders.

## Diagnostics And Browser Constraints

The developer diagnostics panel records failed discovery, tile-matrix, capabilities, CSW, and projection-definition requests, and the first failed tile of each MapLibre source.

- The app accepts both `http` and `https` endpoints.
- If the viewer is served over HTTPS, browsers block HTTP APIs as mixed content.
- A target API must permit browser CORS requests.
- Feature information is limited to properties present in loaded vector tiles; this app does not call OGC API Features.

## Project Structure

```text
src/App.tsx             UI state, layer management, and engine and CRS switching
src/MapLibreView.tsx    MapLibre map (the default engine), vector tile protocol, raster reprojection
src/OpenLayersView.tsx  OpenLayers map, loaded only when selected
src/ogc.ts              OGC API Tiles discovery, tile matrix sets, and projection registration
src/wmts.ts             WMTS capabilities, MapColonies CSW, and WMTS tile URL resolution
src/crs.ts              WorldCRS84Quad and WebMercatorQuad recognition and bounding boxes
src/index.css           Desktop GIS workspace styling
```
