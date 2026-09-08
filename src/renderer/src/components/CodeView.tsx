import React, { useEffect, useRef } from 'react'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import { defaultKeymap } from '@codemirror/commands'
import { HighlightStyle, LanguageDescription, type LanguageSupport, type TagStyle, bracketMatching, defaultHighlightStyle, foldGutter, foldKeymap, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'

type Tag = Exclude<TagStyle['tag'], readonly unknown[]>

/**
 * `@lezer/highlight` is not a direct dependency (it only lives inside pnpm's
 * virtual store), so the tag objects are collected from the default style
 * (and their parents) and remapped by name to the app's palette.
 */
const appHighlightStyle = ((): HighlightStyle => {
  const byName = new Map<string, Tag>()
  for (const spec of defaultHighlightStyle.specs) {
    const list: readonly Tag[] = 'set' in spec.tag ? [spec.tag] : spec.tag
    for (const t of list) for (const p of t.set) byName.set(String(p), p)
  }
  const palette: Array<[string[], Omit<TagStyle, 'tag'>]> = [
    [['keyword'], { color: '#a78bfa' }],
    [['string', 'special(string)', 'inserted'], { color: '#4ade80' }],
    [['literal', 'atom', 'bool', 'labelName'], { color: '#fbbf24' }],
    [['regexp', 'escape', 'url'], { color: '#f472b6' }],
    [['comment'], { color: '#8f97a8', fontStyle: 'italic' }],
    [['meta'], { color: '#8f97a8' }],
    [['typeName', 'namespace', 'className'], { color: '#7c9cff' }],
    [['definition(variableName)', 'macroName'], { color: '#f472b6' }],
    [['special(variableName)'], { color: '#7c9cff' }],
    [['propertyName', 'definition(propertyName)'], { color: '#c7cede' }],
    [['deleted', 'invalid'], { color: '#ff6b6b' }],
    [['link'], { color: '#7c9cff', textDecoration: 'underline' }],
    [['heading'], { color: '#e6e8ec', fontWeight: 'bold' }],
    [['emphasis'], { fontStyle: 'italic' }],
    [['strong'], { fontWeight: 'bold' }],
    [['strikethrough'], { textDecoration: 'line-through' }]
  ]
  const specs: TagStyle[] = []
  for (const [names, style] of palette) {
    const tag = names.map((n) => byName.get(n)).filter((t): t is Tag => Boolean(t))
    if (tag.length) specs.push({ tag, ...style })
  }
  return specs.length ? HighlightStyle.define(specs, { themeType: 'dark' }) : defaultHighlightStyle
})()

const theme = EditorView.theme(
  {
    '&': { backgroundColor: 'transparent', color: '#e6e8ec', fontSize: '11.5px', height: '100%' },
    '.cm-scroller': { fontFamily: 'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)', lineHeight: '1.5', overflow: 'auto' },
    '.cm-content': { padding: '6px 0' },
    '.cm-line': { padding: '0 12px' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5f6776', borderRight: '1px solid var(--color-border, #262b35)', minWidth: '44px' },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 6px' },
    '.cm-foldGutter .cm-gutterElement': { color: '#5f6776' },
    '.cm-activeLine': { backgroundColor: 'rgba(255,255,255,0.03)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8f97a8' },
    '&.cm-focused': { outline: 'none' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(124,156,255,0.25)' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'rgba(124,156,255,0.18)', outline: '1px solid rgba(124,156,255,0.4)' }
  },
  { dark: true }
)

const langCache = new Map<string, Promise<LanguageSupport>>()
const loadLanguage = (desc: LanguageDescription): Promise<LanguageSupport> => {
  let p = langCache.get(desc.name)
  if (!p) {
    p = desc.load()
    langCache.set(desc.name, p)
  }
  return p
}

/** Read-only CodeMirror viewer: line numbers, folding, and syntax colours picked from the file name. */
export function CodeView({ text, filename }: { text: string; filename: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const langConf = useRef(new Compartment())
  const langExt = useRef<Extension>([])

  useEffect(() => {
    if (!host.current || viewRef.current) return
    viewRef.current = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          foldGutter(),
          highlightSpecialChars(),
          drawSelection(),
          highlightActiveLine(),
          highlightActiveLineGutter(),
          bracketMatching(),
          keymap.of([...defaultKeymap, ...foldKeymap]),
          langConf.current.of(langExt.current),
          syntaxHighlighting(appHighlightStyle),
          theme
        ]
      }),
      parent: host.current
    })
    return () => {
      viewRef.current?.destroy()
      viewRef.current = null
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const v = viewRef.current
    if (!v || v.state.doc.toString() === text) return
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text }, selection: { anchor: 0 } })
    v.scrollDOM.scrollTop = 0
  }, [text])

  useEffect(() => {
    const desc = LanguageDescription.matchFilename(languages, filename)
    if (!desc) {
      langExt.current = []
      viewRef.current?.dispatch({ effects: langConf.current.reconfigure([]) })
      return
    }
    let cancelled = false
    loadLanguage(desc)
      .then((support) => {
        if (cancelled) return
        langExt.current = support
        viewRef.current?.dispatch({ effects: langConf.current.reconfigure(support) })
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [filename])

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />
}
