// Request headers the user sets once, like Postman's header list, and that every request to another site carries:
// discovery, capabilities, CSW, styles, glyphs, sprites and tiles, whichever engine or plugin makes them.
export type HeaderRow = { id: string; enabled: boolean; name: string; value: string; host: string }

let rows: HeaderRow[] = []

export const setRequestHeaders = (next: HeaderRow[]) => { rows = next }

// A header with a host only goes to that host and its subdomains; without one it goes to every other site.
const hostMatches = (requestHost: string, host: string) => {
  const wanted = host.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  return !wanted || requestHost === wanted || requestHost.endsWith(`.${wanted}`)
}

export function headersFor(url: string): [string, string][] {
  let target: URL
  try { target = new URL(url, location.href) } catch { return [] }
  // The viewer's own files (its worker and the RTL text plugin) never need them.
  if (!/^https?:$/.test(target.protocol) || target.origin === location.origin) return []
  return rows.filter((row) => row.enabled && row.name.trim() && hostMatches(target.host.toLowerCase(), row.host)).map((row) => [row.name.trim(), row.value])
}

// Every fetch in the page goes through here, including the ones libraries make themselves, such as the raster
// reprojection plugin's source tiles, which offer no way to pass headers.
const nativeFetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = input instanceof Request ? input.url : String(input)
  const extra = headersFor(url)
  if (!extra.length) return nativeFetch(input, init)
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  // A header the request already sets wins over the global one.
  for (const [name, value] of extra) if (!headers.has(name)) headers.set(name, value)
  return nativeFetch(input, { ...init, headers })
}
