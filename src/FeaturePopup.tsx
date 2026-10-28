export type Hit = { layer?: string; properties: Record<string, unknown> }

// Both engines outline the selected feature with a glow in the interface's accent color.
export const glowColor = '#c8f261'

// Rendered through a portal into an element the map engine owns, so the engine can move it freely.
// The map view holds the selection, since it also draws the selected feature's outline.
export function FeaturePopup({ hits, selected, onSelect }: { hits: Hit[]; selected: number; onSelect: (index: number) => void }) {
  if (!hits.length) return null
  const index = Math.min(selected, hits.length - 1)
  return <div className="popup"><header><strong>{hits.length} FEATURE{hits.length > 1 ? 'S' : ''}</strong><select value={index} onChange={(e) => onSelect(Number(e.target.value))}>{hits.map((hit, i) => <option key={i} value={i}>Feature {i + 1}{hit.layer ? ` · ${hit.layer}` : ''}</option>)}</select></header><pre>{JSON.stringify(hits[index].properties, null, 2)}</pre></div>
}
