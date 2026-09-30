/**
 * A CodeMirror theme that follows the app's light and dark theme: built for the theme on screen when an editor is
 * created, and swapped in every open editor when the theme changes (CodeMirror's base styles depend on `dark`).
 */
import { Compartment, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin } from '@codemirror/view'
import { currentTheme, onThemeChange } from './theme'

type Spec = Parameters<typeof EditorView.theme>[0]

export function themedEditor(spec: Spec): () => Extension {
  const slot = new Compartment()
  const views = new Set<EditorView>()
  const make = (): Extension => EditorView.theme(spec, { dark: currentTheme() === 'dark' })
  onThemeChange(() => {
    const next = make()
    for (const v of views) v.dispatch({ effects: slot.reconfigure(next) })
  })
  const track = ViewPlugin.define((view) => {
    views.add(view)
    return { destroy: () => void views.delete(view) }
  })
  return () => [slot.of(make()), track]
}
