# OGC API Tiles Vector Workbench

A desktop-first, browser-only viewer for discovering and inspecting vector tiles exposed through [OGC API - Tiles](https://ogcapi.ogc.org/tiles/). It is a lightweight online GIS workspace built with React, Vite, and OpenLayers.

The viewer does not need a backend or proxy. It follows links advertised by an OGC API landing page and makes requests directly from the browser, so the target API must allow CORS.

## Features

- Discover vector tilesets from an OGC API landing page.
- Follow advertised `data`, collections, and `tilesets-vector` links without guessing endpoint paths.
- Group discovered layers by advertised tile matrix set, with collapsible catalog sections.
- Select an advertised tile representation, including MVT, PBF, or another advertised media type.
- Render vector tiles using their advertised tile matrix set, origin, resolutions, tile size, and CRS.
- Never assume Web Mercator. Missing EPSG definitions are requested from `epsg.io` and registered with `proj4`.
- Prompt before switching to a tileset with a different map CRS; accepting clears incompatible active layers.
- Inspect all vector features hit by a map click and view their raw properties.
- Show metadata, request diagnostics, scale, CRS, and a Z/X/Y debug grid.
- Use a generated geometry-aware style when no style URL is supplied.

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

## Tile Matrix Debugging

**SHOW Z/X/Y TILE GRID** is enabled by default. It renders OpenLayers' tile-debug overlay above the vector layers using the active layer's advertised matrix grid. Use it to compare browser tile coordinates with the OGC URL template substitutions:

```text
{tileMatrix} / {tileRow} / {tileCol}
```

The overlay uses OpenLayers tile-coordinate notation: `z/x/y`, where `z` is the matrix level, `x` is tile column, and `y` is tile row.

## CRS Behavior

The first active layer establishes the map projection. When adding a layer with a different advertised CRS, the viewer asks for confirmation before clearing active layers and switching projection.

For an EPSG code that OpenLayers does not include, the viewer fetches its Proj4 definition from `https://epsg.io/<code>.proj4`. The browser must be able to reach that service.

## Styles

Leave the style URL empty to use a random local style. It assigns colors based on geometry type without changing the tileset source.

The **STYLE** URL field currently validates a MapLibre style JSON document but intentionally keeps the OGC API Tiles source and its native grid authoritative. MapLibre source definitions are not applied because they can overwrite the discovered OGC tile template.

## Diagnostics And Browser Constraints

The developer diagnostics panel records failed discovery, tile-matrix, and projection-definition requests.

- The app accepts both `http` and `https` endpoints.
- If the viewer is served over HTTPS, browsers block HTTP APIs as mixed content.
- A target API must permit browser CORS requests.
- Feature information is limited to properties present in loaded vector tiles; this app does not call OGC API Features.

## Project Structure

```text
src/App.tsx    Discovery, CRS registration, OpenLayers map, and UI state
src/index.css  Desktop GIS workspace styling
```
