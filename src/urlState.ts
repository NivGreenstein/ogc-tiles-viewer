import { Inflate, deflate } from 'pako'

// The shareable viewer state, kept in the URL as one `s` parameter: JSON with short keys, zlib-compressed and
// base64url-encoded, so a link carrying several service URLs stays short.
export type UrlState = { endpoint?: string; engine?: string; crs?: string; wmts?: string; csw?: string }

const parameter = 's'
const shortKeys = { endpoint: 'e', engine: 'g', crs: 'c', wmts: 'w', csw: 'k' } as const
// zlib's preset dictionary: substrings common in this state, so a short link does not grow past its plain form.
// Links depend on it, so it must never change; the zlib header records its checksum, and a link made with another
// dictionary fails to decode rather than decoding wrongly.
const dictionary = new TextEncoder().encode('{"c":"WorldCRS84Quad","g":"openlayers","k":"https://catalog/api/raster/v1/csw","w":"https://wmts?SERVICE=WMTS&REQUEST=GetCapabilities/1.0.0/WMTSCapabilities.xml?token=","e":"http://localhost:https://api/ogc/tiles/collections?f=json"}')
// Links made before the state was compressed carry these as plain parameters.
const legacyKeys = Object.keys(shortKeys) as (keyof UrlState)[]

const toBase64Url = (bytes: Uint8Array) => {
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

const fromBase64Url = (value: string) => {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)), (character) => character.charCodeAt(0))
}

export const encodeState = (state: UrlState) => {
  const compact = Object.fromEntries(legacyKeys.flatMap((key) => (state[key] ? [[shortKeys[key], state[key]]] : [])))
  return Object.keys(compact).length ? toBase64Url(deflate(new TextEncoder().encode(JSON.stringify(compact)), { dictionary })) : ''
}

// pako's inflate() takes a dictionary too, but only the Inflate class is typed to accept one.
function inflateWithDictionary(bytes: Uint8Array) {
  const inflater = new Inflate({ dictionary })
  inflater.push(bytes, true)
  if (inflater.err) throw new Error(inflater.msg)
  return inflater.result as Uint8Array
}

export function decodeState(value: string): UrlState {
  const compact = JSON.parse(new TextDecoder().decode(inflateWithDictionary(fromBase64Url(value)))) as Record<string, unknown>
  return Object.fromEntries(legacyKeys.flatMap((key) => (typeof compact[shortKeys[key]] === 'string' ? [[key, compact[shortKeys[key]]]] : [])))
}

export function readUrlState(search = location.search): UrlState {
  const params = new URLSearchParams(search)
  const encoded = params.get(parameter)
  if (encoded) {
    try { return decodeState(encoded) } catch { /* a damaged link falls back to any plain parameters */ }
  }
  return Object.fromEntries(legacyKeys.flatMap((key) => (params.get(key) ? [[key, params.get(key)]] : [])))
}

// Replaces the state in the address bar, keeping any parameters that are not the viewer's.
export function writeUrlState(state: UrlState) {
  const params = new URLSearchParams(location.search)
  legacyKeys.forEach((key) => params.delete(key))
  const encoded = encodeState(state)
  if (encoded) params.set(parameter, encoded)
  else params.delete(parameter)
  const query = params.toString()
  history.replaceState(null, '', `${location.pathname}${query ? `?${query}` : ''}${location.hash}`)
}
