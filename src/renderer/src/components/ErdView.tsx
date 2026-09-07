import React, { useEffect, useMemo, useRef, useState } from 'react'
import { X, Key, Link2, Play } from 'lucide-react'
import type { DbKind, DbSchema, DbTable } from '@shared/types'

interface Node {
  key: string
  table: DbTable
  x: number
  y: number
  w: number
  h: number
}
const ROW_H = 16
const HEAD_H = 22
const COL_W = 200
const MAX_COLS = 14

/** Simple force layout: tables as boxes, foreign keys as edges. Enough for a schema of a few dozen tables. */
function layout(tables: DbTable[], edges: [string, string][]): Node[] {
  const nodes: Node[] = tables.map((t, i) => {
    const cols = Math.min(MAX_COLS, (t.columns ?? []).length) + ((t.columns ?? []).length > MAX_COLS ? 1 : 0)
    const cols0 = Math.ceil(Math.sqrt(tables.length))
    return { key: `${t.schema}.${t.name}`, table: t, x: (i % cols0) * (COL_W + 80) + Math.random() * 20, y: Math.floor(i / cols0) * 260 + Math.random() * 20, w: COL_W, h: HEAD_H + cols * ROW_H + 6 }
  })
  const idx = new Map(nodes.map((n, i) => [n.key, i]))
  const linked = edges.map(([a, b]) => [idx.get(a), idx.get(b)] as const).filter(([a, b]) => a !== undefined && b !== undefined && a !== b) as [number, number][]
  for (let iter = 0; iter < 250; iter++) {
    const k = iter < 150 ? 0.08 : 0.03
    const fx = new Array(nodes.length).fill(0) as number[]
    const fy = new Array(nodes.length).fill(0) as number[]
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]
        const b = nodes[j]
        const dx = a.x + a.w / 2 - (b.x + b.w / 2)
        const dy = a.y + a.h / 2 - (b.y + b.h / 2)
        const minX = (a.w + b.w) / 2 + 40
        const minY = (a.h + b.h) / 2 + 30
        const ox = minX - Math.abs(dx)
        const oy = minY - Math.abs(dy)
        if (ox > 0 && oy > 0) {
          // Overlapping boxes push apart along the shallower axis.
          if (ox < oy) {
            const s = (dx >= 0 ? 1 : -1) * ox * 0.5
            fx[i] += s
            fx[j] -= s
          } else {
            const s = (dy >= 0 ? 1 : -1) * oy * 0.5
            fy[i] += s
            fy[j] -= s
          }
        }
        const d2 = dx * dx + dy * dy + 1
        const rep = 40000 / d2
        fx[i] += (dx / Math.sqrt(d2)) * rep
        fx[j] -= (dx / Math.sqrt(d2)) * rep
        fy[i] += (dy / Math.sqrt(d2)) * rep
        fy[j] -= (dy / Math.sqrt(d2)) * rep
      }
    for (const [a, b] of linked) {
      const na = nodes[a]
      const nb = nodes[b]
      const dx = nb.x + nb.w / 2 - (na.x + na.w / 2)
      const dy = nb.y + nb.h / 2 - (na.y + na.h / 2)
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const want = 320
      const f = (d - want) * 0.02
      fx[a] += (dx / d) * f
      fx[b] -= (dx / d) * f
      fy[a] += (dy / d) * f
      fy[b] -= (dy / d) * f
    }
    nodes.forEach((n, i) => {
      n.x += Math.max(-40, Math.min(40, fx[i] * k))
      n.y += Math.max(-40, Math.min(40, fy[i] * k))
    })
  }
  const minX = Math.min(...nodes.map((n) => n.x)) - 40
  const minY = Math.min(...nodes.map((n) => n.y)) - 40
  for (const n of nodes) {
    n.x -= minX
    n.y -= minY
  }
  return nodes
}

export function ErdView({ schema, kind, onPreview, onClose }: { schema: DbSchema; kind: DbKind; onPreview: (t: DbTable) => void; onClose: () => void }): React.JSX.Element {
  const schemas = useMemo(() => Array.from(new Set(schema.tables.map((t) => t.schema))).sort((a, b) => (a === 'public' || a === 'main' ? -1 : b === 'public' || b === 'main' ? 1 : a.localeCompare(b))), [schema])
  const [which, setWhich] = useState(schemas[0] ?? '')
  const [onlyLinked, setOnlyLinked] = useState(schema.tables.length > 40)
  const [zoom, setZoom] = useState(0.8)
  const [pan, setPan] = useState({ x: 20, y: 20 })
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null)
  const { nodes, edges } = useMemo(() => {
    let tables = schema.tables.filter((t) => t.schema === which && t.kind === 'table')
    const allEdges: { from: string; to: string; col: string }[] = []
    for (const t of tables) for (const c of t.columns ?? []) if (c.fk) allEdges.push({ from: `${t.schema}.${t.name}`, to: c.fk.table, col: c.name })
    if (onlyLinked) {
      const linked = new Set(allEdges.flatMap((e) => [e.from, e.to]))
      tables = tables.filter((t) => linked.has(`${t.schema}.${t.name}`))
    }
    tables = tables.slice(0, 80)
    const keys = new Set(tables.map((t) => `${t.schema}.${t.name}`))
    const edges = allEdges.filter((e) => keys.has(e.from) && keys.has(e.to))
    return { nodes: layout(tables, edges.map((e) => [e.from, e.to])), edges }
  }, [schema, which, onlyLinked])
  useEffect(() => setPan({ x: 20, y: 20 }), [which, onlyLinked])
  const byKey = new Map(nodes.map((n) => [n.key, n]))
  const rowY = (n: Node, col: string): number => {
    const i = (n.table.columns ?? []).findIndex((c) => c.name === col)
    return n.y + HEAD_H + (i >= 0 && i < MAX_COLS ? i : MAX_COLS) * ROW_H + ROW_H / 2
  }
  const total = nodes.reduce((m, n) => ({ w: Math.max(m.w, n.x + n.w + 40), h: Math.max(m.h, n.y + n.h + 40) }), { w: 400, h: 300 })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-2 py-1.5 text-[12px]">
        <span className="font-medium">Diagram</span>
        <select className="rounded-md border border-border bg-bg px-1.5 py-1 text-[12px]" value={which} onChange={(e) => setWhich(e.target.value)}>
          {schemas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1 text-muted">
          <input type="checkbox" checked={onlyLinked} onChange={(e) => setOnlyLinked(e.target.checked)} /> only tables with relations
        </label>
        <span className="text-muted">
          {nodes.length} table{nodes.length === 1 ? '' : 's'} · {edges.length} relation{edges.length === 1 ? '' : 's'}
          {kind === 'mongodb' || kind === 'bigquery' ? ' · this engine has no declared foreign keys' : ''}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <button className="rounded border border-border px-1.5 text-[11px] hover:bg-panel-2" onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}>
            −
          </button>
          <span className="w-10 text-center text-[11px] text-muted">{Math.round(zoom * 100)}%</span>
          <button className="rounded border border-border px-1.5 text-[11px] hover:bg-panel-2" onClick={() => setZoom((z) => Math.min(2, z + 0.1))}>
            +
          </button>
          <button className="ml-2 rounded p-1 text-muted hover:text-text" onClick={onClose}>
            <X size={13} />
          </button>
        </span>
      </div>
      <div
        className="relative min-h-0 flex-1 cursor-grab overflow-hidden bg-bg active:cursor-grabbing"
        onMouseDown={(e) => (drag.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y })}
        onMouseMove={(e) => drag.current && setPan({ x: drag.current.px + e.clientX - drag.current.x, y: drag.current.py + e.clientY - drag.current.y })}
        onMouseUp={() => (drag.current = null)}
        onMouseLeave={() => (drag.current = null)}
        onWheel={(e) => {
          if (e.metaKey || e.ctrlKey) setZoom((z) => Math.min(2, Math.max(0.3, z - e.deltaY * 0.002)))
          else setPan((p) => ({ x: p.x - e.deltaX, y: p.y - e.deltaY }))
        }}
      >
        {nodes.length === 0 && <div className="absolute inset-0 flex items-center justify-center text-[12px] text-muted">{onlyLinked ? 'No foreign keys in this schema. Untick “only tables with relations” to see every table.' : 'No tables in this schema.'}</div>}
        <div style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`, transformOrigin: '0 0', width: total.w, height: total.h, position: 'relative' }}>
          <svg width={total.w} height={total.h} className="absolute left-0 top-0" style={{ overflow: 'visible' }}>
            <defs>
              <marker id="erd-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#7c9cff" />
              </marker>
            </defs>
            {edges.map((e, i) => {
              const a = byKey.get(e.from)
              const b = byKey.get(e.to)
              if (!a || !b) return null
              const y1 = rowY(a, e.col)
              const targetCol = (b.table.columns ?? []).find((c) => c.pk)?.name ?? ''
              const y2 = rowY(b, targetCol)
              const leftToRight = a.x + a.w / 2 <= b.x + b.w / 2
              const x1 = leftToRight ? a.x + a.w : a.x
              const x2 = leftToRight ? b.x : b.x + b.w
              const dx = Math.max(40, Math.abs(x2 - x1) / 2)
              const c1 = leftToRight ? x1 + dx : x1 - dx
              const c2 = leftToRight ? x2 - dx : x2 + dx
              return <path key={i} d={`M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`} fill="none" stroke="#7c9cff" strokeOpacity={0.7} strokeWidth={1.2} markerEnd="url(#erd-arrow)" />
            })}
          </svg>
          {nodes.map((n) => (
            <div key={n.key} className="group absolute overflow-hidden rounded-md border border-border bg-panel text-[11px] shadow" style={{ left: n.x, top: n.y, width: n.w }}>
              <div className="flex items-center gap-1 border-b border-border bg-panel-2 px-2 font-semibold" style={{ height: HEAD_H }}>
                <span className="truncate">{n.table.name}</span>
                {n.table.rows !== undefined && <span className="ml-auto font-normal text-muted">{n.table.rows}</span>}
                <button className="rounded p-0.5 text-muted opacity-0 hover:text-text group-hover:opacity-100" title="Preview rows" onMouseDown={(e) => e.stopPropagation()} onClick={() => onPreview(n.table)}>
                  <Play size={10} />
                </button>
              </div>
              {(n.table.columns ?? []).slice(0, MAX_COLS).map((c) => (
                <div key={c.name} className="flex items-center gap-1 px-2 font-mono" style={{ height: ROW_H }}>
                  {c.pk ? <Key size={8} className="shrink-0 text-warn" /> : c.fk ? <Link2 size={8} className="shrink-0 text-accent" /> : <span className="w-2 shrink-0" />}
                  <span className="truncate">{c.name}</span>
                  <span className="ml-auto truncate pl-1 text-[9px] text-muted">{c.type}</span>
                </div>
              ))}
              {(n.table.columns ?? []).length > MAX_COLS && (
                <div className="px-2 text-[10px] text-muted" style={{ height: ROW_H }}>
                  … {(n.table.columns ?? []).length - MAX_COLS} more
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
