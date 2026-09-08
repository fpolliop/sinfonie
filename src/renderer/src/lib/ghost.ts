import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { StateEffect, StateField, type Extension } from '@codemirror/state'

/**
 * Inline suggestions as ghost text: after the user pauses, `fetch` is asked for the code that
 * should follow the cursor; the answer is drawn in muted italics at the cursor, Tab inserts it,
 * Escape (or any edit or cursor move) drops it.
 */
export interface GhostOptions {
  fetch: (prefix: string, suffix: string) => Promise<string>
  enabled: () => boolean
  delayMs?: number
}

const setGhost = StateEffect.define<{ from: number; text: string } | null>()

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super()
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span')
    span.className = 'cm-ghost'
    span.textContent = this.text
    return span
  }
  ignoreEvent(): boolean {
    return false
  }
}

const ghostField = StateField.define<{ from: number; text: string } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value
    // Any change or cursor move invalidates the suggestion.
    if (tr.docChanged || tr.selection) return null
    return value
  },
  provide: (f) =>
    EditorView.decorations.from(f, (g): DecorationSet => {
      if (!g || !g.text) return Decoration.none
      return Decoration.set([Decoration.widget({ widget: new GhostWidget(g.text), side: 1 }).range(g.from)])
    })
})

export function acceptGhost(view: EditorView): boolean {
  const g = view.state.field(ghostField, false)
  if (!g || !g.text) return false
  view.dispatch({ changes: { from: g.from, insert: g.text }, selection: { anchor: g.from + g.text.length }, effects: setGhost.of(null) })
  return true
}
export function dismissGhost(view: EditorView): boolean {
  const g = view.state.field(ghostField, false)
  if (!g) return false
  view.dispatch({ effects: setGhost.of(null) })
  return true
}

export function ghostText(opts: GhostOptions): Extension {
  const delay = opts.delayMs ?? 350
  let timer: ReturnType<typeof setTimeout> | null = null
  let seq = 0
  const plugin = EditorView.updateListener.of((update) => {
    if (!update.docChanged && !update.selectionSet) return
    if (timer) clearTimeout(timer)
    if (!opts.enabled() || !update.view.hasFocus) return
    // Only after typing (not after a bare cursor move) and only at a collapsed cursor.
    if (!update.docChanged) return
    const view = update.view
    timer = setTimeout(() => {
      const sel = view.state.selection.main
      if (!sel.empty || !opts.enabled()) return
      const pos = sel.head
      const doc = view.state.doc
      const mine = ++seq
      const prefix = doc.sliceString(0, pos)
      const suffix = doc.sliceString(pos)
      void opts
        .fetch(prefix, suffix)
        .then((text) => {
          if (mine !== seq || !text) return
          const now = view.state.selection.main
          if (!now.empty || now.head !== pos || view.state.doc.length !== doc.length) return
          view.dispatch({ effects: setGhost.of({ from: pos, text }) })
        })
        .catch(() => undefined)
    }, delay)
  })
  return [
    ghostField,
    plugin,
    keymap.of([
      { key: 'Tab', run: acceptGhost },
      { key: 'Escape', run: dismissGhost }
    ]),
    EditorView.theme({ '.cm-ghost': { color: '#6b7280', fontStyle: 'italic', opacity: '0.9', whiteSpace: 'pre' } })
  ]
}
