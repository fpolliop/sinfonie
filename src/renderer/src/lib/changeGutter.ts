import { EditorView, GutterMarker, gutter, showTooltip, type Tooltip } from '@codemirror/view'
import { StateEffect, StateField, type Extension, RangeSet } from '@codemirror/state'

/**
 * Change markers in the gutter, the way IntelliJ shows them: a green bar next to added lines, a
 * blue bar next to modified ones, a red wedge where lines were deleted, all relative to the
 * committed version of the file. Clicking a marker shows the old text with a Revert button.
 */
export interface Hunk {
  /** 1-based line range in the current document (fromLine..toLine inclusive). For deletions the range is empty and fromLine is the line the text was removed after (0 = before the first line). */
  fromLine: number
  toLine: number
  /** Lines of the committed version this hunk replaced (empty for pure additions). */
  oldLines: string[]
  kind: 'added' | 'modified' | 'deleted'
}

/** Myers line diff, small and good enough for source files; returns hunks against `base`. */
export function lineHunks(base: string, current: string): Hunk[] {
  const a = base.split('\n')
  const b = current.split('\n')
  if (a.length + b.length > 20_000) return []
  const n = a.length
  const m = b.length
  const max = n + m
  const v = new Map<number, number>()
  const trace: Map<number, number>[] = []
  v.set(1, 0)
  let found = false
  for (let d = 0; d <= max && !found; d++) {
    trace.push(new Map(v))
    for (let k = -d; k <= d; k += 2) {
      let x: number
      if (k === -d || (k !== d && (v.get(k - 1) ?? 0) < (v.get(k + 1) ?? 0))) x = v.get(k + 1) ?? 0
      else x = (v.get(k - 1) ?? 0) + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) {
        x++
        y++
      }
      v.set(k, x)
      if (x >= n && y >= m) {
        found = true
        break
      }
    }
  }
  // Walk back to build an edit script.
  type Op = { t: 'eq' | 'del' | 'ins'; ai: number; bi: number }
  const ops: Op[] = []
  let x = n
  let y = m
  for (let d = trace.length - 1; d >= 0; d--) {
    const vv = trace[d]
    const k = x - y
    let prevK: number
    if (k === -d || (k !== d && (vv.get(k - 1) ?? 0) < (vv.get(k + 1) ?? 0))) prevK = k + 1
    else prevK = k - 1
    const prevX = vv.get(prevK) ?? 0
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      ops.push({ t: 'eq', ai: x - 1, bi: y - 1 })
      x--
      y--
    }
    if (d > 0) {
      if (x === prevX) ops.push({ t: 'ins', ai: x, bi: y - 1 })
      else ops.push({ t: 'del', ai: x - 1, bi: y })
    }
    x = prevX
    y = prevY
  }
  ops.reverse()
  // Group consecutive non-equal ops into hunks.
  const hunks: Hunk[] = []
  let i = 0
  while (i < ops.length) {
    if (ops[i].t === 'eq') {
      i++
      continue
    }
    const dels: number[] = []
    const ins: number[] = []
    let j = i
    while (j < ops.length && ops[j].t !== 'eq') {
      if (ops[j].t === 'del') dels.push(ops[j].ai)
      else ins.push(ops[j].bi)
      j++
    }
    const oldLines = dels.map((ai) => a[ai])
    if (ins.length) hunks.push({ fromLine: ins[0] + 1, toLine: ins[ins.length - 1] + 1, oldLines, kind: dels.length ? 'modified' : 'added' })
    else {
      // Pure deletion: fromLine is the current line the text was removed after (0 = before the first line).
      const after = ops[i].bi
      hunks.push({ fromLine: after, toLine: after - 1, oldLines, kind: 'deleted' })
    }
    i = j
  }
  return hunks
}

class Bar extends GutterMarker {
  constructor(
    readonly kind: Hunk['kind'],
    readonly hunk: Hunk
  ) {
    super()
  }
  eq(other: Bar): boolean {
    return other.kind === this.kind && other.hunk === this.hunk
  }
  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = `cm-change cm-change-${this.kind}`
    el.title = this.kind === 'deleted' ? `${this.hunk.oldLines.length} line${this.hunk.oldLines.length === 1 ? '' : 's'} deleted here. Click to see them.` : this.kind === 'modified' ? 'Modified. Click to see the committed text.' : 'Added.'
    return el
  }
}

const setHunks = StateEffect.define<Hunk[]>()
const hunksField = StateField.define<Hunk[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setHunks)) return e.value
    return value
  }
})
const setTip = StateEffect.define<{ hunk: Hunk; pos: number } | null>()
const tipField = StateField.define<{ hunk: Hunk; pos: number } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setTip)) return e.value
    if (tr.docChanged) return null
    return value
  },
  provide: (f) =>
    showTooltip.from(f, (t): Tooltip | null => {
      if (!t) return null
      return {
        pos: t.pos,
        above: false,
        strictSide: true,
        arrow: false,
        create: (view) => {
          const dom = document.createElement('div')
          dom.className = 'cm-change-tip'
          const head = document.createElement('div')
          head.className = 'cm-change-tip-head'
          head.textContent = t.hunk.kind === 'added' ? 'Added lines' : t.hunk.kind === 'deleted' ? 'Deleted lines' : 'Committed version'
          dom.appendChild(head)
          if (t.hunk.oldLines.length) {
            const pre = document.createElement('pre')
            pre.textContent = t.hunk.oldLines.join('\n')
            dom.appendChild(pre)
          }
          const bar = document.createElement('div')
          bar.className = 'cm-change-tip-bar'
          const revert = document.createElement('button')
          revert.textContent = 'Revert'
          revert.onclick = () => {
            revertHunk(view, t.hunk)
          }
          const close = document.createElement('button')
          close.textContent = 'Close'
          close.onclick = () => view.dispatch({ effects: setTip.of(null) })
          bar.append(revert, close)
          dom.appendChild(bar)
          return { dom }
        }
      }
    })
})

/** Puts the committed text back for one hunk. */
export function revertHunk(view: EditorView, hunk: Hunk): void {
  const doc = view.state.doc
  const old = hunk.oldLines.join('\n')
  if (hunk.kind === 'deleted') {
    // Put the removed lines back after `fromLine`, or at the top when they came before the first line.
    if (hunk.fromLine <= 0) view.dispatch({ changes: { from: 0, insert: `${old}\n` }, effects: setTip.of(null) })
    else view.dispatch({ changes: { from: doc.line(Math.min(hunk.fromLine, doc.lines)).to, insert: `\n${old}` }, effects: setTip.of(null) })
    return
  }
  const from = doc.line(hunk.fromLine).from
  const to = doc.line(hunk.toLine).to
  view.dispatch({ changes: { from, to, insert: old }, effects: setTip.of(null) })
}

/** The gutter extension; call `setChangeBase(view, base)` whenever the committed text or the doc changes. */
export function changeGutter(): Extension {
  return [
    hunksField,
    tipField,
    gutter({
      class: 'cm-change-gutter',
      markers: (view) => {
        const hunks = view.state.field(hunksField)
        const doc = view.state.doc
        const ranges: { from: number; marker: Bar }[] = []
        for (const h of hunks) {
          if (h.kind === 'deleted') {
            const line = Math.min(Math.max(1, h.fromLine === 0 ? 1 : h.fromLine), doc.lines)
            ranges.push({ from: doc.line(line).from, marker: new Bar('deleted', h) })
            continue
          }
          for (let l = h.fromLine; l <= Math.min(h.toLine, doc.lines); l++) ranges.push({ from: doc.line(l).from, marker: new Bar(h.kind, h) })
        }
        ranges.sort((a, b) => a.from - b.from)
        return RangeSet.of(ranges.map((r) => r.marker.range(r.from)), true)
      },
      domEventHandlers: {
        mousedown(view, line) {
          const hunks = view.state.field(hunksField)
          const lineNo = view.state.doc.lineAt(line.from).number
          const hit = hunks.find((h) => (h.kind === 'deleted' ? Math.max(1, h.fromLine) === lineNo : lineNo >= h.fromLine && lineNo <= h.toLine))
          if (!hit) return false
          view.dispatch({ effects: setTip.of({ hunk: hit, pos: line.from }) })
          return true
        }
      }
    }),
    EditorView.theme({
      '.cm-change-gutter': { width: '4px', marginLeft: '2px' },
      '.cm-change': { width: '3px', height: '100%', borderRadius: '2px', cursor: 'pointer' },
      '.cm-change-added': { background: '#4ade80' },
      '.cm-change-modified': { background: '#7c9cff' },
      '.cm-change-deleted': { width: '0', height: '0', borderLeft: '5px solid transparent', borderRight: '5px solid transparent', borderTop: '6px solid #ff6b6b', marginLeft: '-3px', marginTop: '-2px', borderRadius: '0', background: 'none' },
      '.cm-tooltip.cm-change-tip, .cm-change-tip': { background: '#141821', border: '1px solid #2d3546', borderRadius: '8px', padding: '6px 8px', maxWidth: '640px', fontSize: '11.5px', color: '#e6e8ec' },
      '.cm-change-tip-head': { color: '#8f97a8', fontSize: '11px', marginBottom: '4px' },
      '.cm-change-tip pre': { margin: '0 0 6px', maxHeight: '220px', overflow: 'auto', background: '#0b0d11', padding: '6px 8px', borderRadius: '6px', fontFamily: 'ui-monospace, Menlo, monospace' },
      '.cm-change-tip-bar': { display: 'flex', gap: '6px' },
      '.cm-change-tip button': { background: '#1b2030', border: '1px solid #2d3546', color: '#e6e8ec', borderRadius: '6px', padding: '2px 8px', fontSize: '11px', cursor: 'pointer' }
    })
  ]
}

export function setChangeBase(view: EditorView, base: string | null): void {
  const hunks = base === null ? [] : lineHunks(base, view.state.doc.toString())
  view.dispatch({ effects: setHunks.of(hunks) })
}
