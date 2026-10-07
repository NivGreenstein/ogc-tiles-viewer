import { useState } from 'react'

export type Hit = { layer?: string; properties: Record<string, unknown> }

// Rendered through a portal into an element the map engine owns, so the engine can move it freely.
export function FeaturePopup({ hits }: { hits: Hit[] }) {
  const [selected, setSelected] = useState(0)
  if (!hits.length) return null
  const index = Math.min(selected, hits.length - 1)
  return <div className="popup"><header><strong>{hits.length} FEATURE{hits.length > 1 ? 'S' : ''}</strong><select value={index} onChange={(e) => setSelected(Number(e.target.value))}>{hits.map((hit, i) => <option key={i} value={i}>Feature {i + 1}{hit.layer ? ` · ${hit.layer}` : ''}</option>)}</select></header><pre>{JSON.stringify(hits[index].properties, null, 2)}</pre></div>
}
